/**
 * Minimal client for a T3 Code server (https://github.com/pingdotgg/t3code).
 *
 * T3 Code publishes only its bundled server (`npx t3`), not a client library,
 * so Arjunah talks to it over its public surface: an RFC 8693 token exchange for
 * the pairing credential, a short-lived WebSocket ticket, and Effect RPC
 * messages serialized as JSON. Nothing here imports T3 code; the shapes are
 * documented in `packages/contracts` of that repository (MIT).
 *
 * Only read-oriented calls are used: `server.probe`, `server.getConfig`,
 * `server.refreshProviders`. Arjunah never starts T3 threads (they run coding
 * agents with tools); it uses T3 for the model catalog, sign-in state, and
 * subscription usage windows.
 */
const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const BOOTSTRAP_TOKEN = "urn:t3:params:oauth:token-type:environment-bootstrap";
const ACCESS_TOKEN = "urn:ietf:params:oauth:token-type:access_token";
const DEFAULT_TIMEOUT_MS = 8000;

export class T3Error extends Error {
  constructor(message, code = "T3_ERROR") {
    super(message);
    this.name = "T3Error";
    this.code = code;
  }
}

/** Accepts http(s) origins; T3 may run on another machine (LAN, Tailscale). */
export function t3Origin(input) {
  let url;
  try {
    url = new URL(String(input ?? ""));
  } catch {
    throw new T3Error("T3 Code address is invalid.", "INVALID_REQUEST");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new T3Error(
      "T3 Code address must be an http(s) origin without credentials.",
      "INVALID_REQUEST",
    );
  return url.origin;
}

async function request(base, path, init = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch (error) {
    throw new T3Error(
      error?.name === "TimeoutError"
        ? "T3 Code did not answer in time."
        : "T3 Code is not reachable at that address.",
      "UNREACHABLE",
    );
  }
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!response.ok)
    throw new T3Error(
      String(
        body?.reason ??
          body?.message ??
          body?.code ??
          `HTTP ${response.status}`,
      ).slice(0, 200),
      response.status === 401 || response.status === 403
        ? "UNAUTHORIZED"
        : "T3_ERROR",
    );
  return body;
}

/** Exchange a one-time pairing token (from `npx t3 serve` / `npx t3 pair`) for a bearer token. */
export async function exchangePairingToken(
  baseUrl,
  pairingToken,
  clientName = "अर्जुनः Desktop",
) {
  const base = t3Origin(baseUrl);
  const token = String(pairingToken ?? "")
    .trim()
    .replace(/^.*token=/, "");
  if (!/^[A-Za-z0-9_-]{6,200}$/.test(token))
    throw new T3Error(
      "Enter the pairing token printed by T3 Code.",
      "INVALID_REQUEST",
    );
  const form = new URLSearchParams({
    grant_type: TOKEN_EXCHANGE,
    subject_token: token,
    subject_token_type: BOOTSTRAP_TOKEN,
    requested_token_type: ACCESS_TOKEN,
    client_name: clientName,
  });
  const body = await request(base, "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (typeof body?.access_token !== "string" || !body.access_token)
    throw new T3Error("T3 Code did not return an access token.");
  return {
    baseUrl: base,
    accessToken: body.access_token,
    scope: String(body.scope ?? ""),
    expiresIn: Number(body.expires_in) || null,
  };
}

export async function sessionState(baseUrl, accessToken) {
  return request(t3Origin(baseUrl), "/api/auth/session", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

export async function websocketTicket(baseUrl, accessToken) {
  const body = await request(t3Origin(baseUrl), "/api/auth/websocket-ticket", {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (typeof body?.ticket !== "string")
    throw new T3Error("T3 Code did not issue a ticket.");
  return body.ticket;
}

/**
 * Effect RPC over WebSocket with JSON serialization. Frames are single
 * messages or arrays of messages: `Request`, `Chunk`, `Exit`, `Defect`,
 * `Ping`/`Pong`, `Ack`, `Interrupt`, `Eof`.
 */
export class T3Rpc {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.nextId = 1;
    socket.addEventListener("message", (event) => this.receive(event.data));
    socket.addEventListener("close", () =>
      this.fail(new T3Error("T3 Code closed the connection.")),
    );
    socket.addEventListener("error", () =>
      this.fail(new T3Error("T3 Code connection failed.")),
    );
  }

  static async connect(
    baseUrl,
    ticket,
    {
      WebSocketImpl = globalThis.WebSocket,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    } = {},
  ) {
    const url = new URL(t3Origin(baseUrl));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/ws";
    url.searchParams.set("wsTicket", ticket);
    url.searchParams.set("clientSurface", "web");
    url.searchParams.set("connectionMethod", "direct");
    const socket = new WebSocketImpl(url.toString());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new T3Error("T3 Code WebSocket timed out.")),
        timeoutMs,
      );
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new T3Error("T3 Code WebSocket failed."));
      });
      socket.addEventListener("close", () => {
        clearTimeout(timer);
        reject(new T3Error("T3 Code WebSocket closed during handshake."));
      });
    });
    return new T3Rpc(socket);
  }

  receive(raw) {
    let parsed;
    try {
      parsed = JSON.parse(
        typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"),
      );
    } catch {
      return;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (message?._tag === "Ping") {
        this.socket.send(JSON.stringify({ _tag: "Pong" }));
        continue;
      }
      const entry = this.pending.get(String(message?.requestId));
      if (!entry) continue;
      if (message._tag === "Chunk") {
        for (const value of message.values ?? []) entry.onChunk?.(value);
        entry.chunks.push(...(message.values ?? []));
      } else if (message._tag === "Exit") {
        this.pending.delete(String(message.requestId));
        clearTimeout(entry.timer);
        if (message.exit?._tag === "Success")
          entry.resolve(
            message.exit.value === undefined
              ? entry.chunks
              : message.exit.value,
          );
        else
          entry.reject(new T3Error(describeFailure(message.exit), "RPC_ERROR"));
      } else if (message._tag === "Defect") {
        this.pending.delete(String(message.requestId));
        clearTimeout(entry.timer);
        entry.reject(
          new T3Error(
            String(message.defect ?? "T3 Code failed.").slice(0, 300),
            "RPC_ERROR",
          ),
        );
      }
    }
  }

  fail(error) {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  call(tag, payload = {}, { timeoutMs = 60_000, onChunk } = {}) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.socket.send(JSON.stringify({ _tag: "Interrupt", requestId: id }));
        reject(
          new T3Error(`T3 Code did not answer ${tag} in time.`, "TIMEOUT"),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, chunks: [], timer, onChunk });
      this.socket.send(
        JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }),
      );
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

function describeFailure(exit) {
  const causes = Array.isArray(exit?.cause) ? exit.cause : [];
  for (const cause of causes) {
    const error = cause?.error ?? cause?.defect;
    if (error?._tag)
      return `${error._tag}${error.reason ? `: ${error.reason}` : ""}`.slice(
        0,
        300,
      );
    if (typeof error === "string") return error.slice(0, 300);
  }
  return "T3 Code rejected the request.";
}

/**
 * The provider snapshots T3 Code holds: one connection, `server.getConfig`,
 * optionally a model refresh (which may open agent sessions, so it is explicit).
 */
export async function fetchT3Providers(
  baseUrl,
  accessToken,
  { refreshModels = false, WebSocketImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const ticket = await websocketTicket(baseUrl, accessToken);
  const rpc = await T3Rpc.connect(baseUrl, ticket, {
    WebSocketImpl,
    timeoutMs,
  });
  try {
    const config = await rpc.call(
      "server.getConfig",
      {},
      { timeoutMs: 20_000 },
    );
    let providers = Array.isArray(config?.providers) ? config.providers : [];
    if (refreshModels) {
      const refreshed = await rpc
        .call(
          "server.refreshProviders",
          { refreshModels: true },
          { timeoutMs: 120_000 },
        )
        .catch(() => null);
      if (Array.isArray(refreshed?.providers)) providers = refreshed.providers;
    }
    return {
      environment: {
        id: String(config?.environment?.environmentId ?? ""),
        label: String(config?.environment?.label ?? ""),
        serverVersion: String(config?.environment?.serverVersion ?? ""),
      },
      providers,
    };
  } finally {
    rpc.close();
  }
}
