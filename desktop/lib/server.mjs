import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "./store.mjs";
import { Pairing } from "./pairing.mjs";
import { SessionRegistry } from "./sessions.mjs";
import { LogBuffer } from "./logs.mjs";
import {
  detectProviders,
  adapterFor,
  invalidateProviderCache,
} from "./providers/index.mjs";
import {
  buildPrompt,
  buildContinuation,
  collectImages,
  splitMessages,
  trailingToolResults,
  IMAGE_LIMITS,
  IMAGE_MEDIA_TYPES,
} from "./transcript.mjs";
import { EFFORTS, scratchDirectory } from "./providers/common.mjs";
import {
  exchangePairingToken,
  fetchT3Providers,
  t3Origin,
  T3Error,
} from "./t3/client.mjs";
import { enrichProviders, mapT3Providers } from "./t3/catalog.mjs";

export const APP_NAME = "arjunah-desktop";
export const APP_VERSION = "1.0.0";
export const PROTOCOL_VERSION = "1.0.0";
// Matches the extension's own request ceiling (LIMITS.requestBytes), so a turn
// carrying the maximum image payload is not cut off at this hop.
const BODY_LIMIT = 12_000_000;
const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\/[a-z0-9-]+$/i;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_PROTOCOL = "arjunah.v1";
const here = dirname(fileURLToPath(import.meta.url));

function websocketFrame(payload, opcode = 1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > 65_535) throw new Error("WebSocket event is too large.");
  const header = Buffer.alloc(body.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  if (body.length < 126) header[1] = body.length;
  else {
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  }
  return Buffer.concat([header, body]);
}

function observeWebsocket(socket, onClose) {
  let pending = Buffer.alloc(0);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    onClose();
  };
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = pending[0] & 0x0f;
      const masked = Boolean(pending[1] & 0x80);
      let length = pending[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) return socket.destroy();
      if (length > 16_384 || !masked) return socket.destroy();
      if (pending.length < offset + 4 + length) return;
      const mask = pending.subarray(offset, offset + 4);
      const body = Buffer.from(
        pending.subarray(offset + 4, offset + 4 + length),
      );
      for (let index = 0; index < body.length; index++)
        body[index] ^= mask[index % 4];
      pending = pending.subarray(offset + 4 + length);
      if (opcode === 8) {
        socket.end(websocketFrame(body, 8));
        return;
      }
      if (opcode === 9) socket.write(websocketFrame(body, 10));
    }
  });
  socket.on("close", close);
  socket.on("error", close);
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createDesktopApp({
  store = new Store(),
  log = () => {},
  adapters,
  detect = detectProviders,
  t3Fetch = fetchT3Providers,
} = {}) {
  const pairing = new Pairing();
  const sessions = new SessionRegistry();
  const dashboardToken = randomBytes(24).toString("base64url");
  const activity = [];
  // Diagnostics, separate from `activity`: activity is the short list of things
  // that happened to the user's account, the log is the running commentary a
  // paired browser or the dashboard shows when a run seems stuck.
  const logs = new LogBuffer({
    sink: (entry) =>
      log(
        `${entry.level === "info" ? "" : `${entry.level} `}${entry.source}: ${entry.message}`,
      ),
  });
  function note(level, source, message) {
    return logs.add(level, source, message);
  }
  // Live agent activity per browser turn, polled by the extension while a
  // generate call is in flight. Keyed by the browser-supplied progress id.
  const progress = new Map();
  const PROGRESS_TTL = 10 * 60_000;
  const PROGRESS_LIMIT = 100;
  function sweepProgress() {
    for (const [key, entry] of progress)
      if (Date.now() - entry.updatedAt > PROGRESS_TTL) progress.delete(key);
  }
  function progressFor(id) {
    sweepProgress();
    if (!id) return null;
    if (!progress.has(id)) {
      if (progress.size >= PROGRESS_LIMIT)
        progress.delete(progress.keys().next().value);
      progress.set(id, {
        items: [],
        updatedAt: Date.now(),
        done: false,
        // How many items the browser has already collected. Text is only ever
        // merged into an item it has not seen, so nothing appended after a poll
        // is silently lost.
        sent: 0,
      });
    }
    return progress.get(id);
  }
  function pushProgress(live, item) {
    if (!live || !item || typeof item !== "object") return;
    const last = live.items.at(-1);
    const unsent = live.items.length > live.sent;
    if (
      unsent &&
      ["output_delta", "reasoning_delta"].includes(item.type) &&
      last?.type === item.type &&
      typeof last.text === "string" &&
      last.text.length + String(item.text ?? "").length <= 4000
    )
      last.text += String(item.text ?? "");
    // A phase is the one-line answer to "what is it doing now"; repeating the
    // same line adds nothing.
    else if (
      item.type === "phase" &&
      last?.type === "phase" &&
      last.text === item.text
    )
      return;
    else if (live.items.length < 200) live.items.push(item);
    live.updatedAt = Date.now();
  }
  /** Says what the run is waiting on, both to the browser and to the log. */
  function phase(live, source, text) {
    note("debug", source, text);
    pushProgress(live, { type: "phase", text: String(text).slice(0, 200) });
  }
  const resolveAdapter = adapters ?? adapterFor;
  let server = null;
  let eventRevision = 0;
  const eventClients = new Set();
  let providerView = [];
  let providerRefresh = null;
  let providerFingerprint = "";
  let providerTimer = null;

  function scheduleProviderMonitor() {
    clearTimeout(providerTimer);
    providerTimer = setTimeout(async () => {
      if (eventClients.size)
        await refreshProviderView({ force: true }).catch(() => {});
      scheduleProviderMonitor();
    }, 30_000);
    providerTimer.unref?.();
  }

  function publish(topic) {
    const message = JSON.stringify({
      type: "state.changed",
      revision: ++eventRevision,
      topic,
    });
    const frame = websocketFrame(message);
    for (const client of eventClients) {
      if (client.socket.destroyed) eventClients.delete(client);
      else {
        client.socket.write(frame);
        if (
          client.role === "client" &&
          !store.listClients().some((item) => item.id === client.clientId)
        )
          client.socket.end(websocketFrame("", 8));
      }
    }
  }

  function stableProviders(providers) {
    return JSON.stringify(
      providers.map(({ detectedAt: _detectedAt, ...provider }) => provider),
    );
  }
  pairing.subscribe(() => publish("pairing"));
  // Optional T3 Code catalog source (docs/T3CODE.md): a paired T3 server
  // supplies richer model metadata, sign-in state, and usage windows for the
  // agents Arjunah runs itself, plus the agents only T3 can run.
  const T3_CACHE_MS = 20_000;
  let t3Cache = {
    at: 0,
    refresh: false,
    mapped: null,
    error: null,
    environment: null,
  };
  function t3Configured() {
    return Boolean(store.settings.t3Url && store.settings.t3Token);
  }
  async function t3Snapshot({ force = false, refreshModels = false } = {}) {
    if (!t3Configured()) return null;
    const fresh =
      Date.now() - t3Cache.at < T3_CACHE_MS &&
      (!refreshModels || t3Cache.refresh);
    if (!force && fresh) return t3Cache;
    try {
      const result = await t3Fetch(
        store.settings.t3Url,
        store.settings.t3Token,
        {
          refreshModels,
        },
      );
      t3Cache = {
        at: Date.now(),
        refresh: refreshModels,
        mapped: mapT3Providers(result.providers, {
          environmentLabel: result.environment?.label
            ? `T3 Code (${result.environment.label})`
            : "T3 Code",
        }),
        environment: result.environment ?? null,
        error: null,
      };
    } catch (error) {
      t3Cache = {
        ...t3Cache,
        at: Date.now(),
        error:
          error instanceof T3Error ? error.message : "T3 Code request failed.",
      };
      record("t3-error", t3Cache.error);
    }
    return t3Cache;
  }
  async function withT3(providers, options) {
    const snapshot = await t3Snapshot(options);
    if (!snapshot?.mapped) return providers;
    return enrichProviders(providers, snapshot.mapped);
  }

  async function refreshProviderView({
    force = false,
    refreshModels = false,
  } = {}) {
    if (providerRefresh) {
      if (!force && !refreshModels) return providerRefresh;
      await providerRefresh.catch(() => {});
      return refreshProviderView({ force, refreshModels });
    }
    providerRefresh = (async () => {
      const providers = await detect(store.settings, { force });
      const next = await withT3(
        providers.map(({ binary: _binary, ...item }) => withLearned(item)),
        { force, refreshModels },
      );
      const fingerprint = stableProviders(next);
      const changed = providerFingerprint !== fingerprint;
      providerView = next;
      providerFingerprint = fingerprint;
      if (changed) publish("providers");
      return providerView;
    })().finally(() => {
      providerRefresh = null;
    });
    return providerRefresh;
  }
  function t3Status() {
    return {
      configured: t3Configured(),
      url: store.settings.t3Url ?? null,
      environment: t3Cache.environment,
      error: t3Cache.error,
      checkedAt: t3Cache.at ? new Date(t3Cache.at).toISOString() : null,
      providers: t3Cache.mapped
        ? Object.keys(t3Cache.mapped.enrich).length +
          t3Cache.mapped.external.length
        : 0,
    };
  }
  // Persistent agent threads, one per browser conversation (SPEC 12.3). A thread
  // remembers the agent's own session handle so later turns send only the new
  // messages instead of the whole transcript.
  const threads = new Map();
  const THREAD_IDLE_MS = 30 * 60_000;
  const THREAD_ID = /^[A-Za-z0-9_-]{1,100}$/;
  const threadCleanups = new Set();
  function endThread(id) {
    const thread = threads.get(id);
    if (!thread) return false;
    threads.delete(id);
    try {
      const cleanup = () => thread.scratch.cleanup();
      const result = resolveAdapter(thread.providerId)?.endThread?.(
        thread.handle,
        thread.scratch.directory,
        thread.binary,
      );
      if (result && typeof result.finally === "function") {
        // An adapter that deletes a persisted session asynchronously must finish
        // before its scratch directory goes away; close() waits on this too.
        const pending = result
          .catch(() => {})
          .finally(cleanup)
          .finally(() => threadCleanups.delete(pending));
        threadCleanups.add(pending);
      } else cleanup();
    } catch {
      thread.scratch.cleanup();
    }
    record("thread-ended", `${thread.providerId} thread for ${id}`);
    return true;
  }
  function sweepThreads() {
    for (const [id, thread] of threads)
      if (Date.now() - thread.lastAt > THREAD_IDLE_MS) endThread(id);
  }
  // Facts providers report only after a run: subscription quota and the real
  // context window of the model that answered.
  const learned = { quota: new Map(), contextWindow: new Map() };
  function withLearned(provider) {
    return {
      ...provider,
      quota: learned.quota.get(provider.id) ?? provider.quota ?? null,
      models: (provider.models ?? []).map((model) => ({
        ...model,
        contextWindow:
          model.contextWindow ??
          learned.contextWindow.get(`${provider.id}/${model.id}`) ??
          null,
      })),
    };
  }

  const WARNING_KINDS = new Set(["pair-failed", "t3-error"]);
  function record(kind, detail) {
    activity.push({ at: new Date().toISOString(), kind, detail });
    if (activity.length > 100) activity.shift();
    note(
      kind === "error" ? "error" : WARNING_KINDS.has(kind) ? "warn" : "info",
      kind,
      detail,
    );
    publish("activity");
  }

  function own(request) {
    return `http://${request.headers.host}`;
  }

  function guard(request, response) {
    const host = String(request.headers.host ?? "");
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host))
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Requests must target the loopback host.",
      );
    const origin = request.headers.origin;
    if (origin != null) {
      const allowed = EXTENSION_ORIGIN.test(origin) || origin === own(request);
      if (!allowed)
        throw new HttpError(
          403,
          "FORBIDDEN",
          "This origin may not use the desktop app.",
        );
      if (EXTENSION_ORIGIN.test(origin)) {
        response.setHeader("Access-Control-Allow-Origin", origin);
        response.setHeader("Vary", "Origin");
        response.setHeader(
          "Access-Control-Allow-Headers",
          "authorization, content-type, x-arjunah-client",
        );
        response.setHeader(
          "Access-Control-Allow-Methods",
          "GET, POST, PUT, DELETE, OPTIONS",
        );
        response.setHeader("Access-Control-Max-Age", "600");
      }
    }
  }

  function bearer(request) {
    const header = String(request.headers.authorization ?? "");
    return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  }
  function requireClient(request) {
    const client = store.authenticate(bearer(request));
    if (!client)
      throw new HttpError(
        401,
        "UNAUTHORIZED",
        "Pair this browser with the desktop app first.",
      );
    return client;
  }
  function requireDashboard(request) {
    if (
      request.headers["x-dashboard-token"] !== dashboardToken ||
      (request.headers.origin != null &&
        request.headers.origin !== own(request))
    )
      throw new HttpError(
        403,
        "FORBIDDEN",
        "Dashboard session is invalid. Reload the dashboard.",
      );
  }

  function websocketIdentity(request) {
    const host = String(request.headers.host ?? "");
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return null;
    const origin = request.headers.origin;
    if (
      origin != null &&
      !EXTENSION_ORIGIN.test(origin) &&
      origin !== own(request)
    )
      return null;
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((item) => item.trim());
    for (const protocol of protocols) {
      const dashboardPrefix = `${WS_PROTOCOL}.dashboard.`;
      if (
        protocol.startsWith(dashboardPrefix) &&
        protocol.slice(dashboardPrefix.length) === dashboardToken &&
        (origin == null || origin === own(request))
      )
        return { protocol, role: "dashboard", clientId: null };
      const clientPrefix = `${WS_PROTOCOL}.client.`;
      if (
        protocol.startsWith(clientPrefix) &&
        (origin == null || EXTENSION_ORIGIN.test(origin))
      ) {
        const client = store.authenticate(protocol.slice(clientPrefix.length));
        if (client) return { protocol, role: "client", clientId: client.id };
      }
    }
    return null;
  }

  function upgradeWebsocket(request, socket) {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const identity =
        url.pathname === "/api/events" ? websocketIdentity(request) : null;
      const key = request.headers["sec-websocket-key"];
      if (!identity || typeof key !== "string") {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      const accept = createHash("sha1")
        .update(key + WS_GUID)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          `Sec-WebSocket-Protocol: ${identity.protocol}\r\n\r\n`,
      );
      socket.setNoDelay(true);
      const entry = { socket, ...identity };
      eventClients.add(entry);
      observeWebsocket(socket, () => eventClients.delete(entry));
      socket.write(
        websocketFrame(
          JSON.stringify({
            type: "hello",
            revision: eventRevision,
            protocol: PROTOCOL_VERSION,
          }),
        ),
      );
    } catch {
      socket.destroy();
    }
  }

  async function readBody(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > BODY_LIMIT)
        throw new HttpError(413, "INVALID_REQUEST", "Request body too large.");
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      return parsed;
    } catch {
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        "Request body must be a JSON object.",
      );
    }
  }

  function send(response, status, body, headers = {}) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    response.writeHead(status, {
      "Content-Type":
        typeof body === "string"
          ? (headers["Content-Type"] ?? "text/plain; charset=utf-8")
          : "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    });
    response.end(text);
  }

  /** Dashboard view of settings: the T3 bearer token is never sent back out. */
  function maskedSettings() {
    const { t3Token, ...rest } = store.settings;
    return { ...rest, t3Token: t3Token ? "•••••" : undefined };
  }

  function maskedSync() {
    const sync = store.sync;
    const config = sync.config ? structuredClone(sync.config) : null;
    if (config?.openai?.apiKey)
      config.openai.apiKey = `${config.openai.apiKey.slice(0, 3)}…${config.openai.apiKey.slice(-4)}`;
    return { ...sync, config };
  }

  function validateGenerate(body) {
    const providerId = String(body.providerId ?? "");
    const adapter = resolveAdapter(providerId);
    if (!adapter)
      throw new HttpError(400, "INVALID_REQUEST", "Unknown desktop provider.");
    const model =
      body.model == null ? "default" : String(body.model).slice(0, 200);
    if (
      !Array.isArray(body.messages) ||
      !body.messages.length ||
      body.messages.length > 300
    )
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        "messages must be a bounded non-empty array.",
      );
    const messages = body.messages.map((message) => {
      if (
        !message ||
        typeof message !== "object" ||
        !["system", "user", "assistant", "tool"].includes(message.role) ||
        typeof (message.content ?? "") !== "string"
      )
        throw new HttpError(400, "INVALID_REQUEST", "A message is invalid.");
      const item = {
        role: message.role,
        content: String(message.content ?? "").slice(0, 200_000),
      };
      if (message.tool_call_id != null)
        item.tool_call_id = String(message.tool_call_id).slice(0, 128);
      if (Array.isArray(message.images) && message.images.length) {
        if (message.role !== "user")
          throw new HttpError(
            400,
            "INVALID_REQUEST",
            "Only user messages can carry images.",
          );
        item.images = message.images
          .slice(0, IMAGE_LIMITS.perMessage)
          .map((image) => {
            const mediaType = String(image?.mediaType ?? "");
            const data = String(image?.data ?? "");
            if (
              !IMAGE_MEDIA_TYPES.includes(mediaType) ||
              !data ||
              data.length > IMAGE_LIMITS.dataChars ||
              !/^[A-Za-z0-9+/]+={0,2}$/.test(data)
            )
              throw new HttpError(
                400,
                "INVALID_REQUEST",
                "An image attachment is invalid.",
              );
            return { mediaType, data };
          });
      }
      if (Array.isArray(message.tool_calls))
        item.tool_calls = message.tool_calls.slice(0, 32).map((call) => ({
          id: String(call?.id ?? "").slice(0, 128),
          type: "function",
          function: {
            name: String(call?.function?.name ?? "").slice(0, 64),
            arguments: String(call?.function?.arguments ?? "{}").slice(
              0,
              65_536,
            ),
          },
        }));
      return item;
    });
    const tools = Array.isArray(body.tools) ? body.tools.slice(0, 64) : [];
    for (const tool of tools)
      if (
        !tool ||
        typeof tool.name !== "string" ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) ||
        (tool.inputSchema != null && typeof tool.inputSchema !== "object")
      )
        throw new HttpError(
          400,
          "INVALID_REQUEST",
          "A tool definition is invalid.",
        );
    return {
      adapter,
      providerId,
      model,
      messages,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: String(tool.description ?? "").slice(0, 500),
        inputSchema: tool.inputSchema ?? { type: "object" },
      })),
      threadId:
        typeof body.threadId === "string" && THREAD_ID.test(body.threadId)
          ? body.threadId
          : null,
      reasoning:
        typeof body.reasoning === "string" && EFFORTS.includes(body.reasoning)
          ? body.reasoning
          : null,
    };
  }

  async function providerInfo(providerId) {
    const providers = await detect(store.settings);
    return providers.find((item) => item.id === providerId) ?? null;
  }

  async function generate(body, client) {
    const { adapter, providerId, model, messages, tools, threadId, reasoning } =
      validateGenerate(body);
    sweepThreads();
    const progressId =
      typeof body.progressId === "string" &&
      /^[A-Za-z0-9_-]{1,100}$/.test(body.progressId)
        ? body.progressId
        : null;
    const live = progressFor(progressId);
    const results = trailingToolResults(messages);
    let session = results ? sessions.findByResults(results) : null;
    if (results && !session) {
      const stale = sessions.findByAnyResult(results);
      if (stale) {
        stale.end(true);
        if (stale.thread)
          for (const [id, item] of threads)
            if (item === stale.thread) endThread(id);
      }
    }
    if (session) {
      record(
        "tool-results",
        `${client.name}: ${results.length} result(s) returned to ${adapter.name}`,
      );
      phase(
        live,
        providerId,
        `Handing the tool result back to ${adapter.name}…`,
      );
      session.resume(results);
    } else {
      // Detection can be slow the first time (a version check, a login check,
      // and an account probe), and until now the browser saw only a spinner.
      phase(live, providerId, `Checking ${adapter.name} on this computer…`);
      const startedAt = Date.now();
      const info = await providerInfo(providerId);
      note(
        "debug",
        providerId,
        `detection finished in ${Date.now() - startedAt}ms (installed: ${Boolean(info?.installed)}, available: ${Boolean(info?.available)})`,
      );
      if (!info?.installed)
        throw new HttpError(
          400,
          "NOT_CONFIGURED",
          info?.reason ?? "Provider unavailable.",
        );
      if (!info.available)
        throw new HttpError(
          400,
          "NOT_CONFIGURED",
          info.reason ?? "Provider unavailable.",
        );
      const selectedModel =
        model === "default" ? (info.defaultModel ?? "default") : model;
      const { systemPrompt, prompt: fullPrompt } = buildPrompt(messages);
      const { conversation } = splitMessages(messages);
      const systemHash = createHash("sha256")
        .update(systemPrompt)
        .update("\n")
        .update(JSON.stringify(tools))
        .digest("hex");
      let thread = null;
      let prompt = fullPrompt;
      // Images belong to the messages this prompt actually carries, so a resumed
      // thread attaches only what arrived since the agent last saw the chat.
      let promptImages = collectImages(conversation);
      let resumeHandle = null;
      if (threadId && adapter.supportsThreads) {
        const existing = threads.get(threadId);
        if (
          existing &&
          (existing.providerId !== providerId ||
            existing.model !== selectedModel ||
            existing.systemHash !== systemHash ||
            !existing.handle ||
            conversation.length <= existing.seen)
        )
          endThread(threadId);
        thread = threads.get(threadId) ?? null;
        if (thread) {
          resumeHandle = thread.handle;
          prompt = buildContinuation(conversation.slice(thread.seen));
          promptImages = collectImages(conversation.slice(thread.seen));
        } else {
          thread = {
            providerId,
            model: selectedModel,
            systemHash,
            handle: null,
            binary: info.binary,
            scratch: scratchDirectory(`${providerId}-thread`),
            seen: 0,
            lastAt: Date.now(),
          };
          threads.set(threadId, thread);
        }
        thread.lastAt = Date.now();
      }
      session = sessions.create({ tools, model: selectedModel, providerId });
      session.thread = thread;
      session.conversationLength = conversation.length;
      const mcp = tools.length
        ? {
            url: `http://127.0.0.1:${server.address().port}/mcp/${session.id}`,
            token: session.token,
          }
        : null;
      record(
        "generate",
        `${client.name} → ${adapter.name} (${selectedModel})${tools.length ? `, ${tools.length} tool(s)` : ""}${info.supportsVision && promptImages.length ? `, ${promptImages.length} image(s)` : ""}${resumeHandle ? ", resumed thread" : thread ? ", new thread" : ""}${reasoning ? `, reasoning ${reasoning}` : ""}`,
      );
      phase(
        live,
        providerId,
        resumeHandle
          ? `Resuming the ${adapter.name} session…`
          : `Starting ${adapter.name}…`,
      );
      try {
        session.attach(
          adapter.start({
            binary: info.binary,
            model: selectedModel,
            systemPrompt,
            prompt,
            // The browser already refuses images for a provider without vision;
            // dropping them here too keeps the adapters free of that check.
            images: info.supportsVision ? promptImages : [],
            mcp,
            tools,
            reasoning,
            thread: thread ? { handle: resumeHandle } : null,
            scratch: thread ? thread.scratch : null,
            onThread: (handle) => {
              if (thread && typeof handle === "string") thread.handle = handle;
            },
            onProgress: live ? (item) => pushProgress(live, item) : undefined,
            onLog: (level, message) => note(level, providerId, message),
          }),
        );
      } catch (error) {
        session.end(true);
        if (thread) endThread(threadId);
        throw new HttpError(
          502,
          "PROVIDER_ERROR",
          `Could not start ${adapter.name}: ${error.message}`,
        );
      }
    }
    const event = await session.nextEvent();
    if (live && event.type !== "tool_calls") live.done = true;
    else if (live) phase(live, providerId, "Running the tools it asked for…");
    if (session.thread && (event.type === "error" || event.type === "timeout"))
      for (const [id, item] of threads)
        if (item === session.thread) endThread(id);
    if (event.type === "timeout")
      throw new HttpError(
        504,
        "TIMEOUT",
        `${adapter.name} did not answer in time.`,
      );
    if (event.type === "error") {
      record("error", `${adapter.name}: ${event.message}`);
      throw new HttpError(
        502,
        "PROVIDER_ERROR",
        `${adapter.name} failed: ${event.message}`,
      );
    }
    const base = {
      id: `desktop-${session.id}`,
      model: `${providerId}/${session.model}`,
      provider: providerId,
    };
    if (event.type === "tool_calls")
      return {
        ...base,
        message: { role: "assistant", content: "", toolCalls: event.calls },
        finishReason: "tool_calls",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      };
    record(
      "answer",
      `${adapter.name} answered (${event.usage?.totalTokens ?? 0} tokens)`,
    );
    if (session.thread) {
      // The browser appends this answer to its history, so the thread has now
      // seen the whole conversation plus one assistant message.
      session.thread.seen = session.conversationLength + 1;
      session.thread.lastAt = Date.now();
      if (!session.thread.handle && typeof event.thread === "string")
        session.thread.handle = event.thread.slice(0, 80);
    }
    if (event.quota && typeof event.quota === "object")
      learned.quota.set(providerId, event.quota);
    if (Number.isInteger(event.contextWindow))
      learned.contextWindow.set(
        `${providerId}/${session.model}`,
        event.contextWindow,
      );
    if (event.quota || Number.isInteger(event.contextWindow))
      void refreshProviderView().catch(() => {});
    return {
      ...base,
      model: event.model ? `${providerId}/${event.model}` : base.model,
      message: {
        role: "assistant",
        content: String(event.content ?? ""),
        toolCalls: [],
      },
      finishReason: "stop",
      usage: event.usage,
      // Commands the agent ran inside its own sandbox, for the browser's activity view.
      steps: Array.isArray(event.steps) ? event.steps.slice(0, 32) : [],
      reasoning: typeof event.reasoning === "string" ? event.reasoning : null,
      contextWindow: Number.isInteger(event.contextWindow)
        ? event.contextWindow
        : (learned.contextWindow.get(`${providerId}/${session.model}`) ?? null),
      quota: learned.quota.get(providerId) ?? null,
      thread: Boolean(session.thread),
    };
  }

  async function mcp(request, response, sessionId) {
    const session = sessions.get(sessionId);
    if (!session || bearer(request) !== session.token)
      throw new HttpError(401, "UNAUTHORIZED", "Unknown MCP session.");
    if (request.method === "DELETE") return send(response, 202, "");
    if (request.method !== "POST")
      return send(response, 405, "Method not allowed.");
    const rpc = await readBody(request);
    const reply = (result) =>
      send(
        response,
        200,
        { jsonrpc: "2.0", id: rpc.id, result },
        { "Mcp-Session-Id": session.id },
      );
    if (rpc.method === "initialize")
      return reply({
        protocolVersion:
          typeof rpc.params?.protocolVersion === "string"
            ? rpc.params.protocolVersion
            : "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: APP_NAME, version: APP_VERSION },
      });
    if (
      rpc.method === "notifications/initialized" ||
      (typeof rpc.method === "string" &&
        rpc.method.startsWith("notifications/"))
    )
      return send(response, 202, "");
    if (rpc.method === "ping") return reply({});
    if (rpc.method === "tools/list")
      return reply({
        tools: session.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
    if (rpc.method === "tools/call") {
      const name = rpc.params?.name;
      if (!session.tools.some((tool) => tool.name === name))
        return reply({
          content: [{ type: "text", text: "Unknown tool." }],
          isError: true,
        });
      const result = await session.call(name, rpc.params?.arguments ?? {});
      return reply({
        content: [{ type: "text", text: result.content }],
        isError: Boolean(result.isError),
      });
    }
    return send(response, 200, {
      jsonrpc: "2.0",
      id: rpc.id,
      error: { code: -32601, message: "Method not found" },
    });
  }

  function dashboardAsset(path) {
    const file = path === "/" ? "index.html" : path.slice(1);
    if (!["index.html", "app.js", "style.css"].includes(file)) return null;
    let text = readFileSync(join(here, "..", "dashboard", file), "utf8");
    if (file === "index.html")
      text = text.replace("__DASHBOARD_TOKEN__", dashboardToken);
    return {
      text,
      type: file.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : file.endsWith(".css")
          ? "text/css; charset=utf-8"
          : "text/html; charset=utf-8",
    };
  }

  async function route(request, response) {
    guard(request, response);
    const url = new URL(request.url, "http://127.0.0.1");
    const path = url.pathname;
    if (request.method === "OPTIONS") return send(response, 204, "");
    if (path.startsWith("/mcp/"))
      return mcp(request, response, path.slice(5).split("/")[0]);
    if (path === "/api/status" && request.method === "GET") {
      const client = store.authenticate(bearer(request));
      return send(response, 200, {
        app: APP_NAME,
        version: APP_VERSION,
        protocol: PROTOCOL_VERSION,
        device: store.data.deviceName,
        paired: Boolean(client),
        client: client ? { id: client.id, name: client.name } : null,
        sync: {
          revision: store.sync.revision,
          updatedAt: store.sync.updatedAt,
        },
        eventsRevision: eventRevision,
      });
    }
    if (path === "/api/pair" && request.method === "POST") {
      const body = await readBody(request);
      const attempt = pairing.attempt(body.code);
      if (!attempt.ok) {
        record("pair-failed", attempt.reason);
        throw new HttpError(403, "USER_DENIED", attempt.reason);
      }
      const { token, client } = store.addClient(body.client ?? {});
      record("paired", `${client.name} (${client.browser})`);
      publish("clients");
      return send(response, 200, {
        token,
        client,
        sync:
          maskedSync().revision != null
            ? { revision: store.sync.revision }
            : null,
      });
    }
    if (path === "/api/pair" && request.method === "DELETE") {
      const client = requireClient(request);
      store.revokeClient(client.id);
      record("unpaired", client.name);
      publish("clients");
      return send(response, 200, { ok: true });
    }
    if (path === "/api/providers" && request.method === "GET") {
      requireClient(request);
      const force = url.searchParams.get("refresh") === "1";
      return send(response, 200, {
        providers: await refreshProviderView({
          force,
          refreshModels: force,
        }),
        t3: t3Status(),
      });
    }
    if (path.startsWith("/api/threads/") && request.method === "DELETE") {
      requireClient(request);
      const id = path.slice("/api/threads/".length);
      return send(response, 200, {
        ended: THREAD_ID.test(id) ? endThread(id) : false,
      });
    }
    if (path.startsWith("/api/progress/") && request.method === "GET") {
      requireClient(request);
      sweepProgress();
      const id = path.slice("/api/progress/".length);
      const entry = /^[A-Za-z0-9_-]{1,100}$/.test(id) ? progress.get(id) : null;
      const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
      const items = entry ? entry.items.slice(after, after + 50) : [];
      if (entry) entry.sent = Math.max(entry.sent ?? 0, after + items.length);
      return send(response, 200, {
        items,
        total: entry ? entry.items.length : 0,
        done: entry ? entry.done : false,
      });
    }
    if (path === "/api/logs") {
      // Readable by a paired browser or by the dashboard: both are the person
      // sitting at this computer, and the buffer holds no prompts or secrets.
      if (request.headers["x-dashboard-token"] != null)
        requireDashboard(request);
      else requireClient(request);
      if (request.method === "GET") {
        const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
        const limit = Math.max(
          1,
          Math.min(500, Number(url.searchParams.get("limit")) || 200),
        );
        const entries = logs.since(after, limit);
        return send(response, 200, {
          entries,
          latest: logs.seq,
          version: APP_VERSION,
          device: store.data.deviceName,
        });
      }
      if (request.method === "DELETE") {
        logs.clear();
        note("info", "logs", "log cleared from the browser");
        return send(response, 200, { ok: true });
      }
      return send(response, 405, "Method not allowed.");
    }
    if (path === "/api/generate" && request.method === "POST") {
      const client = requireClient(request);
      return send(
        response,
        200,
        await generate(await readBody(request), client),
      );
    }
    if (path === "/api/sync" && request.method === "GET") {
      requireClient(request);
      return send(response, 200, store.sync);
    }
    if (path === "/api/sync" && request.method === "PUT") {
      const client = requireClient(request);
      const body = await readBody(request);
      if (!body.config || typeof body.config !== "object")
        throw new HttpError(
          400,
          "INVALID_REQUEST",
          "config must be an object.",
        );
      if (JSON.stringify(body.config).length > 100_000)
        throw new HttpError(413, "INVALID_REQUEST", "config too large.");
      const sync = store.updateSync(body.config, `browser:${client.name}`);
      record(
        "sync",
        `${client.name} pushed configuration revision ${sync.revision}`,
      );
      publish("sync");
      return send(response, 200, sync);
    }
    if (path.startsWith("/api/dashboard/")) {
      requireDashboard(request);
      if (path === "/api/dashboard/state" && request.method === "GET") {
        const force = url.searchParams.get("refresh") === "1";
        if (force)
          await refreshProviderView({ force: true, refreshModels: true });
        else if (!providerView.length)
          void refreshProviderView().catch(() => {});
        return send(response, 200, {
          app: APP_NAME,
          version: APP_VERSION,
          device: store.data.deviceName,
          port: server.address().port,
          pairing: pairing.current(),
          clients: store.listClients(),
          providers: providerView,
          providersRefreshing: Boolean(providerRefresh),
          eventsRevision: eventRevision,
          sync: maskedSync(),
          settings: maskedSettings(),
          t3: t3Status(),
          activity: [...activity].reverse(),
          logs: logs.since(0, 200),
          dataPath: store.path,
        });
      }
      if (path === "/api/dashboard/pairing/rotate" && request.method === "POST")
        return send(response, 200, { code: pairing.rotate() });
      if (
        path === "/api/dashboard/clients/revoke" &&
        request.method === "POST"
      ) {
        const body = await readBody(request);
        const ok = store.revokeClient(String(body.id ?? ""));
        if (ok) {
          record("revoked", `client ${body.id}`);
          publish("clients");
        }
        return send(response, 200, { ok });
      }
      if (path === "/api/dashboard/t3/pair" && request.method === "POST") {
        const body = await readBody(request);
        let paired;
        try {
          paired = await exchangePairingToken(body.baseUrl, body.pairingToken);
        } catch (error) {
          throw new HttpError(
            error instanceof T3Error && error.code === "INVALID_REQUEST"
              ? 400
              : 502,
            error instanceof T3Error ? error.code : "PROVIDER_ERROR",
            error instanceof T3Error
              ? error.message
              : "Could not pair with T3 Code.",
          );
        }
        store.updateSettings({
          t3Url: paired.baseUrl,
          t3Token: paired.accessToken,
        });
        t3Cache = {
          at: 0,
          refresh: false,
          mapped: null,
          error: null,
          environment: null,
        };
        invalidateProviderCache();
        record("t3-paired", paired.baseUrl);
        await t3Snapshot({ force: true });
        await refreshProviderView({ force: true });
        publish("settings");
        return send(response, 200, { t3: t3Status(), scope: paired.scope });
      }
      if (path === "/api/dashboard/t3" && request.method === "DELETE") {
        store.updateSettings({ t3Url: undefined, t3Token: undefined });
        t3Cache = {
          at: 0,
          refresh: false,
          mapped: null,
          error: null,
          environment: null,
        };
        invalidateProviderCache();
        record("t3-unpaired", "T3 Code connection removed");
        await refreshProviderView({ force: true });
        publish("settings");
        return send(response, 200, { t3: t3Status() });
      }
      if (path === "/api/dashboard/settings" && request.method === "PUT") {
        const body = await readBody(request);
        const patch = {};
        if (typeof body.experimentalCodex === "boolean")
          patch.experimentalCodex = body.experimentalCodex;
        if (typeof body.t3Url === "string") {
          patch.t3Url = body.t3Url ? t3Origin(body.t3Url) : undefined;
          t3Cache = {
            at: 0,
            refresh: false,
            mapped: null,
            error: null,
            environment: null,
          };
        }
        for (const key of ["claudePath", "codexPath", "opencodePath"])
          if (typeof body[key] === "string")
            patch[key] = body[key].slice(0, 500) || undefined;
        invalidateProviderCache();
        const settings = store.updateSettings(patch);
        publish("settings");
        void refreshProviderView({ force: true }).catch(() => {});
        return send(response, 200, settings);
      }
      if (path === "/api/dashboard/config" && request.method === "PUT") {
        const body = await readBody(request);
        const current = structuredClone(store.sync.config ?? {});
        const next = { ...current, ...(body.config ?? {}) };
        if (next.openai && body.config?.openai && !body.config.openai.apiKey)
          next.openai.apiKey = current.openai?.apiKey ?? null;
        const sync = store.updateSync(next, "desktop");
        record(
          "sync",
          `desktop dashboard saved configuration revision ${sync.revision}`,
        );
        publish("sync");
        return send(response, 200, maskedSync());
      }
      throw new HttpError(404, "NOT_FOUND", "Unknown dashboard operation.");
    }
    if (request.method === "GET") {
      const asset = dashboardAsset(path);
      if (asset)
        return send(response, 200, asset.text, {
          "Content-Type": asset.type,
          "Content-Security-Policy":
            "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:*; img-src 'self' data:",
        });
    }
    throw new HttpError(404, "NOT_FOUND", "Not found.");
  }

  server = createServer((request, response) => {
    route(request, response).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : "INTERNAL_ERROR";
      const message =
        error instanceof HttpError
          ? error.message
          : "The desktop app could not complete the request.";
      if (status === 500) log(`internal error: ${error?.stack ?? error}`);
      if (!response.headersSent)
        send(response, status, { error: { code, message } });
      else response.end();
    });
  });
  server.on("upgrade", upgradeWebsocket);
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  return {
    server,
    store,
    pairing,
    sessions,
    activity,
    logs,
    dashboardToken,
    providers(options) {
      return refreshProviderView(options);
    },
    listen(port = store.port, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          void refreshProviderView().catch(() => {});
          scheduleProviderMonitor();
          resolve(server.address());
        });
      });
    },
    async close() {
      clearTimeout(providerTimer);
      for (const client of eventClients) client.socket.destroy();
      eventClients.clear();
      for (const id of [...threads.keys()]) endThread(id);
      sessions.endAll();
      await Promise.all([...threadCleanups]);
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
