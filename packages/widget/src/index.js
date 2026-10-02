/**
 * अर्जुनः standalone widget (SPEC section 14).
 *
 * The same renderer the browser extension hosts, mounted by a site that owns
 * its own inference, tools and threads. There is no wallet here: no grants, no
 * consent, no provider credential. The site backend is already the page's own
 * trust domain, so this module is a view plus a bounded client for the backend
 * protocol. It never claims to be the extension. In bridged mode (SPEC 14.7)
 * it holds an ordinary level 1 or 2 session on `window.ai.arjunah` and relays
 * the backend's completions through it, exactly as any page may; it uses that
 * object's public API and nothing else. With `backend.fetch` (SPEC 14.1) the
 * page answers the backend routes itself and the widget makes no request of
 * its own; what the function returns is bounded exactly like a server's answer.
 */
import ArjunahRenderer from "./renderer.js";
import { validateCard } from "./cards.js";
import { validateSchema, validateArguments } from "./schema.js";

const STREAM_BYTES = 2_000_000;
const JSON_BYTES = 1_000_000;
const THREAD_ID = /^[A-Za-z0-9_-]{1,100}$/;
const MENTION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const LIMITS = {
  threads: 100,
  entries: 200,
  title: 120,
  preview: 2000,
  progress: 200,
  parts: 8,
  mentions: 16,
  entityQuery: 64,
  entityResults: 20,
  entityTitle: 80,
  entityGroup: 40,
  entityDescription: 120,
  callId: 128,
  bridgeTools: 32,
  toolDescription: 500,
  errorMessage: 300,
  // One relayed delta, as `reasoning.delta` is bounded on the turn stream.
  delta: 4000,
  // What one posted delta may coalesce to, and all of them per completion.
  deltaPost: 8000,
  deltaTotal: 200000,
};
// A completion may take this long (SPEC 5.3); the turn's stream stays open for
// it, and a page `generate` that outlives it is answered with TIMEOUT.
const COMPLETION_MS = 180_000;
const COMPLETION_GRACE_MS = 5_000;
const ERROR_CODE = /^[A-Z][A-Z_]{0,39}$/;
// Conversation ids are opaque (SPEC 5.4); the widget only bounds them.
const CONVERSATION_ID = /^[\x21-\x7e]{1,200}$/;
// An SSE event name `eventStreamResponse` may frame: no line breaks, ever.
const EVENT_TYPE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

class WidgetError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AIError";
    this.code = code;
  }
}

function endpoint(baseUrl, path) {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(path, new URL(base, location.href));
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      (url.origin === location.origin ||
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new WidgetError(
      "INVALID_REQUEST",
      "The backend must be same-origin or HTTPS.",
    );
  return url.toString();
}

/**
 * One chunk of a response body as bytes. A server's body only yields
 * `Uint8Array`s, but a page-built stream (`backend.fetch`) can enqueue
 * anything, and a chunk without a byte length would slip past every ceiling.
 */
function chunkBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new WidgetError("PROVIDER_ERROR", "The backend stream is malformed.");
}

/**
 * Cancels a body without waiting: a page stream's `cancel` may never settle,
 * and the widget must not hang on it.
 */
function cancelReader(reader) {
  try {
    void reader.cancel().catch(() => {});
  } catch {
    // Already released or errored; nothing more is read either way.
  }
}

/** Reads a bounded response body without buffering an unbounded string. */
async function readBounded(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const bytes = chunkBytes(value);
    total += bytes.byteLength;
    if (total > maxBytes) {
      cancelReader(reader);
      throw new WidgetError(
        "PROVIDER_ERROR",
        "The backend response was too large.",
      );
    }
    text += decoder.decode(bytes, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * What a `backend.fetch` function resolved to, as the widget reads it. Only
 * `status` and `body` are used, so a `Response` from another realm works, and
 * `ok` is derived from the status rather than trusted.
 */
function pageResponse(value) {
  let status;
  let body;
  try {
    status = value?.status;
    body = value?.body ?? null;
  } catch {
    status = undefined;
  }
  if (
    !Number.isInteger(status) ||
    status < 200 ||
    status > 599 ||
    (body !== null && typeof body?.getReader !== "function")
  )
    throw new WidgetError(
      "PROVIDER_ERROR",
      "The in-page backend returned an invalid response.",
    );
  return { status, ok: status < 300, body };
}

/**
 * `backend` is `{ baseUrl, headers?, credentials? }` or `{ fetch }`, exactly
 * one of the two (SPEC 14.1).
 */
function backendOptions(raw) {
  if (!plainObject(raw))
    throw new WidgetError("INVALID_REQUEST", "backend must be an object.");
  if ((raw.baseUrl != null) === (raw.fetch != null))
    throw new WidgetError(
      "INVALID_REQUEST",
      "backend needs exactly one of baseUrl or fetch.",
    );
  if (raw.fetch != null) {
    if (typeof raw.fetch !== "function")
      throw new WidgetError(
        "INVALID_REQUEST",
        "backend.fetch must be a function.",
      );
    // Nothing would send them, so accepting them would only mislead.
    if (raw.headers != null || raw.credentials != null)
      throw new WidgetError(
        "INVALID_REQUEST",
        "backend.headers and backend.credentials apply only to baseUrl.",
      );
    return { fetch: raw.fetch };
  }
  if (typeof raw.baseUrl !== "string" || !raw.baseUrl)
    throw new WidgetError(
      "INVALID_REQUEST",
      "backend.baseUrl must be a non-empty string.",
    );
  const headers = { ...(raw.headers ?? {}) };
  for (const key of Object.keys(headers))
    if (/^(cookie|set-cookie)$/i.test(key)) delete headers[key];
  return {
    baseUrl: raw.baseUrl,
    headers,
    credentials: raw.credentials ?? "same-origin",
  };
}

function boundedText(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function threadSummary(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.id !== "string" ||
    !THREAD_ID.test(value.id)
  )
    throw new WidgetError(
      "PROVIDER_ERROR",
      "The backend returned an invalid thread.",
    );
  return {
    id: value.id,
    title: boundedText(value.title, LIMITS.title),
    updatedAt:
      typeof value.updatedAt === "string"
        ? value.updatedAt.slice(0, 40)
        : new Date().toISOString(),
  };
}

function transcriptEntry(value) {
  if (!value || typeof value !== "object") return null;
  if (value.type === "message") {
    if (!["user", "assistant"].includes(value.role)) return null;
    const content =
      typeof value.content === "string"
        ? value.content.slice(0, 12000)
        : Array.isArray(value.content)
          ? contentParts(value.content)
          : null;
    if (content == null || (Array.isArray(content) && !content.length))
      return null;
    return {
      type: "message",
      id: THREAD_ID.test(String(value.id ?? "")) ? value.id : randomId(),
      role: value.role,
      content,
      ...(typeof value.reasoning === "string"
        ? { reasoning: value.reasoning.slice(0, 12000) }
        : {}),
      createdAt:
        typeof value.createdAt === "string"
          ? value.createdAt.slice(0, 40)
          : new Date().toISOString(),
    };
  }
  if (value.type === "activity" && Array.isArray(value.steps))
    return {
      type: "activity",
      id: THREAD_ID.test(String(value.id ?? "")) ? value.id : randomId(),
      turnId: boundedText(value.turnId, 100),
      steps: value.steps.slice(0, 32).flatMap((step) => {
        if (!step || typeof step !== "object") return [];
        let card;
        try {
          card = step.card ? validateCard(step.card, "step card") : undefined;
        } catch {
          card = undefined;
        }
        return [
          {
            id: boundedText(step.id, 100),
            name: boundedText(step.name, 128) || "tool",
            source: ["site", "mcp", "backend", "agent"].includes(step.source)
              ? step.source
              : "backend",
            status: step.status === "error" ? "error" : "ok",
            arguments: boundedText(step.arguments, LIMITS.preview),
            result: boundedText(step.result, LIMITS.preview),
            ...(card ? { card } : {}),
          },
        ];
      }),
    };
  return null;
}

/**
 * Section 5.3 parts of a stored user message. Mention parts are kept so a
 * replayed thread still shows the chips the visitor picked (SPEC 14.2).
 */
function contentParts(raw) {
  const parts = [];
  let plain = 0;
  let mentions = 0;
  for (const part of raw) {
    if (part?.type === "text" && typeof part.text === "string") {
      if (plain++ >= LIMITS.parts) continue;
      parts.push({ type: "text", text: part.text.slice(0, 12000) });
    } else if (
      part?.type === "image" &&
      ArjunahRenderer.IMAGE_TYPES.includes(part.mediaType) &&
      typeof part.data === "string"
    ) {
      if (plain++ >= LIMITS.parts) continue;
      parts.push(part);
    } else if (
      part?.type === "mention" &&
      MENTION_ID.test(String(part.id ?? "")) &&
      mentions++ < LIMITS.mentions
    ) {
      parts.push({
        type: "mention",
        id: part.id,
        label: boundedText(part.label, LIMITS.entityTitle),
      });
    }
  }
  return parts;
}

/** One entity from the backend route, bounded before the renderer sees it. */
function entity(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!MENTION_ID.test(String(raw.id ?? ""))) return null;
  const title = boundedText(raw.title, LIMITS.entityTitle);
  if (!title) return null;
  return {
    id: raw.id,
    title,
    group: boundedText(raw.group, LIMITS.entityGroup),
    description: boundedText(raw.description, LIMITS.entityDescription),
  };
}

function randomId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

function plainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** The id of a backend request the page answers on a route, or null. */
function callId(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= LIMITS.callId
    ? value
    : null;
}

/** A section 9 `{ code, message }` from whatever a completion rejected with. */
function errorBody(error, fallback = "INTERNAL_ERROR") {
  const code =
    typeof error?.code === "string" && ERROR_CODE.test(error.code)
      ? error.code
      : fallback;
  const message =
    typeof error?.message === "string" && error.message
      ? error.message.slice(0, LIMITS.errorMessage)
      : "The completion failed.";
  return { code, message };
}

/**
 * The mount's `bridge` option (SPEC 14.7): `generate` when the page answers
 * completions itself, which wins over `arjunah`; `arjunah` when the renderer
 * holds a session on the visitor's extension; otherwise there is no bridge.
 */
function bridgeOptions(raw, composer) {
  if (raw == null) return null;
  if (!plainObject(raw))
    throw new WidgetError("INVALID_REQUEST", "bridge must be an object.");
  if (raw.generate != null && typeof raw.generate !== "function")
    throw new WidgetError(
      "INVALID_REQUEST",
      "bridge.generate must be a function.",
    );
  if (
    raw.arjunah != null &&
    raw.arjunah !== true &&
    raw.arjunah !== false &&
    !plainObject(raw.arjunah)
  )
    throw new WidgetError(
      "INVALID_REQUEST",
      "bridge.arjunah must be true or an access request.",
    );
  if (raw.generate) return { mode: "generate", generate: raw.generate };
  if (raw.arjunah === true) return { mode: "arjunah", access: { composer } };
  if (plainObject(raw.arjunah))
    return { mode: "arjunah", access: { composer, ...raw.arjunah } };
  return null;
}

/**
 * Mounts the assistant into `mount` and returns a handle.
 *
 * `backend.baseUrl` must be same-origin or HTTPS; `backend.fetch` is a page
 * function that answers the same routes instead. `tools` are ordinary site
 * tools whose handlers run in the page when the backend asks for them with a
 * `tool.client` event; server-side tools need no declaration here because the
 * backend simply runs them inside the turn.
 */
export function mountAssistant(config = {}) {
  const mount = config.mount;
  if (!(mount instanceof Element))
    throw new WidgetError("INVALID_REQUEST", "mount must be an element.");
  const backend = backendOptions(config.backend);
  const widget = config.widget ?? {};
  const entities = config.entities ?? null;

  const tools = new Map();
  for (const tool of config.tools ?? []) {
    if (
      !tool ||
      typeof tool.name !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) ||
      typeof tool.handler !== "function"
    )
      throw new WidgetError(
        "INVALID_REQUEST",
        "Each client tool needs a name and a handler.",
      );
    tools.set(tool.name, {
      ...tool,
      inputSchema: validateSchema(tool.inputSchema ?? { type: "object" }),
    });
  }

  // A server composes behind `baseUrl`. Behind `fetch` the page usually runs
  // the loop itself (SPEC 15 mode 5); a page that forwards to its server says
  // so with `bridge.arjunah.composer`.
  const bridge = bridgeOptions(
    config.bridge,
    backend.fetch ? "webapp" : "server",
  );
  // Bridged-mode state for the life of the mount (SPEC 14.7). The session is
  // asked for once, on the first send; a refusal or a lost session leaves the
  // announced model null rather than asking again.
  const bridgeState = {
    session: null,
    refused: false,
    lost: false,
    entry: null,
    // Conversation handles by id, and which ids each thread used, so that
    // deleting a thread releases what it held and nothing else.
    handles: new Map(),
    byThread: new Map(),
  };

  const shadow = mount.shadowRoot ?? mount.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = ArjunahRenderer.STYLE;
  shadow.replaceChildren(style);

  let controller = null;
  let currentBackendTurn = null;
  // The running turn's relay state: its outstanding completions and prompts.
  let liveTurn = null;
  let destroyed = false;
  // `input.client` and `approval.client` prompts are shown one at a time.
  let promptChain = Promise.resolve();

  async function request(path, init = {}) {
    const response = backend.fetch
      ? await pageRequest(path, init)
      : await fetch(endpoint(backend.baseUrl, path), {
          ...init,
          headers: {
            ...backend.headers,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...(init.headers ?? {}),
          },
          credentials: backend.credentials,
          redirect: "error",
        });
    if (!response.ok) {
      try {
        void response.body?.cancel().catch(() => {});
      } catch {
        // A locked or foreign body: it is not read either way.
      }
      throw new WidgetError(
        "PROVIDER_ERROR",
        `The backend rejected the request (${response.status}).`,
      );
    }
    return response;
  }

  /**
   * One route answered by the page's own function (SPEC 14.1). It receives
   * the path relative to the routes of SPEC 14.4 and a fetch-shaped init, and
   * nothing it returns is trusted more than a server's answer.
   */
  async function pageRequest(path, init) {
    const pageInit = {
      method: init.method ?? "GET",
      headers: init.body ? { "Content-Type": "application/json" } : {},
      ...(init.body != null ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    };
    const answer = backend.fetch;
    let value;
    try {
      value = await answer(path, pageInit);
    } catch (error) {
      // A stop is a stop wherever it surfaces; anything else is the
      // backend failing, worded like a server's failure.
      if (error?.name === "AbortError" || init.signal?.aborted) throw error;
      throw new WidgetError("PROVIDER_ERROR", "The in-page backend failed.");
    }
    return pageResponse(value);
  }

  async function json(path, init) {
    const response = await request(path, init);
    if (response.status === 204) return null;
    const text = await readBounded(response, JSON_BYTES);
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new WidgetError(
        "PROVIDER_ERROR",
        "The backend returned invalid JSON.",
      );
    }
  }

  const threads = {
    async list() {
      const rows = await json("threads");
      if (!Array.isArray(rows))
        throw new WidgetError("PROVIDER_ERROR", "Invalid thread list.");
      return rows.slice(0, LIMITS.threads).map(threadSummary);
    },
    async create() {
      return threadSummary(
        await json("threads", { method: "POST", body: "{}" }),
      );
    },
    async load(id) {
      const rows = await json(`threads/${encodeURIComponent(id)}`);
      if (!Array.isArray(rows))
        throw new WidgetError("PROVIDER_ERROR", "Invalid transcript.");
      return rows.slice(0, LIMITS.entries).map(transcriptEntry).filter(Boolean);
    },
    // The backend stored this turn while it ran (SPEC 14.5), so there is
    // nothing to push back; the list refresh picks up the new title.
    async append() {},
    ...(config.allowRename === false
      ? {}
      : {
          async rename(id, title) {
            await json(`threads/${encodeURIComponent(id)}`, {
              method: "PATCH",
              body: JSON.stringify({
                title: String(title).slice(0, LIMITS.title),
              }),
            });
          },
        }),
    async remove(id) {
      await json(`threads/${encodeURIComponent(id)}`, { method: "DELETE" });
      // Its running completions end before the conversations they use do.
      if (liveTurn?.threadId === id) endTurn(liveTurn);
      releaseConversations(id);
    },
  };

  const view = ArjunahRenderer.createChatView({
    document,
    host: {
      threads,
      submit: (content, context) => runTurn(content, context),
      stop() {
        endTurn(liveTurn);
        controller?.abort();
        if (currentBackendTurn && view.activeThread())
          void json(
            `threads/${encodeURIComponent(view.activeThread())}/turns/${encodeURIComponent(currentBackendTurn)}/cancel`,
            { method: "POST", body: "{}" },
          ).catch(() => {});
      },
      close() {
        config.onClose?.();
      },
      reset() {
        void view.newThread();
      },
      controlChange(id, value, values) {
        config.onControlChange?.(id, value, values);
      },
      threadChanged(threadId) {
        config.onThreadChange?.({ threadId });
      },
      // The site owns inference here, so a switch always holds; the callback
      // is a report, not a veto (SPEC 8.2).
      modelChanged(selection) {
        config.onModelChange?.(selection);
        return true;
      },
      ...(entities
        ? {
            searchEntities: (query) => searchEntities(query),
            ...(entities.onActivate
              ? { activateEntity: (picked) => entities.onActivate(picked) }
              : {}),
          }
        : {}),
      async cardAction(detail) {
        const threadId = view.activeThread();
        if (!threadId) return null;
        const body = await json(
          `threads/${encodeURIComponent(threadId)}/actions`,
          { method: "POST", body: JSON.stringify(detail) },
        ).catch(() => null);
        if (!body?.card) return null;
        try {
          return validateCard(body.card, "card");
        } catch {
          return null;
        }
      },
    },
  });
  // With the visitor's session the catalog is the visitor's, filled once the
  // session exists; a site-supplied list is ignored there (SPEC 8.2).
  const visitorCatalog = bridge?.mode === "arjunah";
  if (!visitorCatalog) view.setModels(widget.models ?? [], widget.defaultModel);
  view.setOptions({
    name: widget.name ?? "Assistant",
    greeting: widget.greeting ?? "",
    placeholder: widget.placeholder ?? "",
    suggestions: (widget.suggestions ?? []).slice(0, 6),
    theme: widget.theme ?? null,
    toolCallView: widget.toolCallView === "detailed" ? "detailed" : "compact",
    controls: widget.controls ?? [],
  });
  if (widget.theme?.accent) {
    mount.style.setProperty("--accent", widget.theme.accent);
    mount.style.setProperty("--accent-ink", "#fff");
  }
  view.refs.sub.textContent = widget.subtitle ?? "";
  view.setAttachmentsEnabled(config.vision === true);
  shadow.append(view.panel);
  view.panel.hidden = false;
  void view.refreshThreads();

  function selectionFields() {
    const { model, reasoning } = view.selection();
    return { ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}) };
  }

  /**
   * Entity matches come from the site's own function when it supplies one and
   * from the backend route otherwise (SPEC 14.4). Either way a failure means
   * no matches, never an error in the transcript.
   */
  async function searchEntities(query) {
    const bounded = String(query ?? "").slice(0, LIMITS.entityQuery);
    let rows;
    if (typeof entities.search === "function")
      rows = await entities.search(bounded);
    else
      rows = await json(`entities?q=${encodeURIComponent(bounded)}`).catch(
        () => null,
      );
    return Array.isArray(rows)
      ? rows.slice(0, LIMITS.entityResults).map(entity).filter(Boolean)
      : [];
  }

  function report(callback, detail) {
    try {
      callback?.(detail);
    } catch {
      // A host callback is a report; a throwing one must not end the turn.
    }
  }

  /** One turn: POST it, then drive the renderer from the event stream. */
  async function runTurn(content, context) {
    const threadId = context?.threadId ?? view.activeThread();
    if (!threadId) return;
    view.setBusy(true);
    controller = new AbortController();
    const signal = controller.signal;
    const localTurn = randomId();
    view.startActivity(localTurn, threadId);
    const turn = {
      threadId,
      turnId: null,
      bridged: false,
      completions: new Map(),
      // Ids already answered on `model-results`, `inputs` and `approvals`.
      answered: new Set(),
      prompting: false,
      done: false,
    };
    liveTurn = turn;
    try {
      const announcement = await bridgeAnnouncement();
      if (signal.aborted) return view.finishActivity(false);
      turn.bridged = announcement != null;
      const response = await request(
        `threads/${encodeURIComponent(threadId)}/turns`,
        {
          method: "POST",
          body: JSON.stringify({
            content,
            controls: view.controls(),
            ...selectionFields(),
            ...(announcement ? { bridge: announcement } : {}),
          }),
          signal,
        },
      );
      await consume(response, turn, context, signal);
    } catch (error) {
      view.finishActivity(false);
      if (error?.name !== "AbortError")
        view.addBubble(
          "assistant",
          `Could not complete the request: ${error?.message ?? "unknown error"}`,
          { error: true, persist: false },
        );
      return;
    } finally {
      // Whatever the turn still had outstanding ends with it, silently: the
      // backend has stopped listening for those answers.
      endTurn(turn);
      if (liveTurn === turn) liveTurn = null;
      controller = null;
      currentBackendTurn = null;
      view.setBusy(false);
    }
  }

  /**
   * Aborts every completion the turn still has outstanding and closes its
   * open prompts. Nothing more is posted for any of them.
   */
  function endTurn(turn) {
    if (!turn || turn.done) return;
    turn.done = true;
    for (const completion of turn.completions.values()) {
      completion.cancelled = true;
      completion.controller.abort();
    }
    turn.completions.clear();
    if (turn.prompting) {
      view.cancelUserInput("The turn ended.");
      view.cancelApproval();
    }
  }

  // ------------------------------------------------------------ bridged mode

  /**
   * What this turn's body announces in bridged mode (SPEC 14.7), or null when
   * the mount has no bridge. The session is requested here, on the first send,
   * so the extension's consent follows the visitor's gesture.
   */
  async function bridgeAnnouncement() {
    if (!bridge) return null;
    const announced = [...tools.values()]
      .slice(0, LIMITS.bridgeTools)
      .map((tool) => ({
        name: tool.name,
        ...(typeof tool.description === "string"
          ? { description: tool.description.slice(0, LIMITS.toolDescription) }
          : {}),
        inputSchema: tool.inputSchema,
      }));
    if (bridge.mode === "generate") {
      // The page answers; the model is whatever the site's own picker names.
      const { model } = view.selection();
      const entry = (widget.models ?? []).find((item) => item?.id === model);
      return { model: entry ? copyJson(entry) : null, tools: announced };
    }
    return { model: await visitorModel(), tools: announced };
  }

  /** The visitor's model entry for this turn, or null without a session. */
  async function visitorModel() {
    if (!bridgeState.session && !bridgeState.refused && !bridgeState.lost) {
      const api = globalThis.ai?.arjunah;
      // No extension on this page is not a refusal; a later send looks again.
      if (typeof api?.enable !== "function") return null;
      view.applyEvent({ type: "agent.phase", text: "Waiting for अर्जुनः…" });
      try {
        bridgeState.session = await api.enable(bridge.access);
      } catch {
        bridgeState.refused = true;
        return null;
      }
    }
    const session = bridgeState.session;
    if (!session) return null;
    let list;
    try {
      list = await session.models.list();
    } catch {
      // Revoked or invalidated: the backend learns that from a null model.
      bridgeState.session = null;
      bridgeState.lost = true;
      bridgeState.entry = null;
      view.setModels([]);
      return null;
    }
    list = Array.isArray(list) ? list.filter((item) => plainObject(item)) : [];
    const fallback = list.find((item) => item.default === true) ?? list[0];
    const { model } = view.selection();
    view.setModels(
      list,
      list.some((item) => item.id === model) ? model : fallback?.id,
    );
    const chosen = view.selection().model;
    const entry = list.find((item) => item.id === chosen) ?? fallback ?? null;
    bridgeState.entry = entry ? copyJson(entry) : null;
    return bridgeState.entry;
  }

  function copyJson(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  }

  function turnPath(turn, route) {
    return `threads/${encodeURIComponent(turn.threadId)}/turns/${encodeURIComponent(
      turn.turnId ?? "",
    )}/${route}`;
  }

  function post(turn, route, body) {
    return json(turnPath(turn, route), {
      method: "POST",
      body: JSON.stringify(body),
    }).catch(() => {});
  }

  /**
   * The conversation a relayed completion continues. The backend owns the
   * mapping from its thread: it names the id it stored, and without one the
   * renderer creates a conversation and returns its id with the result.
   * Returns null when the session has no conversations, in which case the
   * completion goes to `models.generate` instead.
   */
  async function conversationFor(session, requested, threadId) {
    const api = session.conversations;
    if (!api || typeof api.create !== "function") return null;
    let handle = requested
      ? (bridgeState.handles.get(requested) ?? null)
      : null;
    if (!handle && requested && typeof api.open === "function")
      handle = await api.open(requested).catch(() => null);
    // An id the extension no longer knows starts a new conversation, and the
    // new id goes back to the backend in place of the old one.
    if (!handle) handle = await api.create();
    if (
      !handle ||
      typeof handle.id !== "string" ||
      !CONVERSATION_ID.test(handle.id) ||
      typeof handle.generate !== "function"
    )
      throw new WidgetError(
        "INTERNAL_ERROR",
        "The session returned an invalid conversation.",
      );
    bridgeState.handles.set(handle.id, handle);
    if (!bridgeState.byThread.has(threadId))
      bridgeState.byThread.set(threadId, new Set());
    bridgeState.byThread.get(threadId).add(handle.id);
    return handle;
  }

  /** A deleted thread's conversations end with it (SPEC 5.4, release). */
  function releaseConversations(threadId) {
    const ids = bridgeState.byThread.get(threadId);
    bridgeState.byThread.delete(threadId);
    for (const id of ids ?? []) {
      const handle = bridgeState.handles.get(id);
      bridgeState.handles.delete(id);
      Promise.resolve()
        .then(() => handle?.release?.())
        .catch(() => {});
    }
  }

  /**
   * Posts a completion's deltas to `model-results` in order (SPEC 15, with
   * `stream: true`). Deltas that arrive while a post is in flight coalesce
   * into one per type, so a fast stream costs few requests and none is lost.
   */
  function deltaPoster(turn, id, completion) {
    let queue = [];
    let running = null;
    let total = 0;
    async function drain() {
      while (queue.length) {
        const delta = queue.shift();
        if (turn.done || completion.cancelled) {
          queue = [];
          break;
        }
        await post(turn, "model-results", { id, delta });
      }
      running = null;
    }
    return {
      push(type, text) {
        if (total + text.length > LIMITS.deltaTotal) return;
        total += text.length;
        const last = queue.at(-1);
        if (
          last?.type === type &&
          last.text.length + text.length <= LIMITS.deltaPost
        )
          last.text += text;
        else queue.push({ type, text });
        running ??= drain();
      },
      async flush() {
        while (running) await running;
      },
    };
  }

  /**
   * Runs one round through `handle.stream`, drawing its deltas as provisional
   * text and, when the backend asked for them, posting them before the result.
   */
  async function streamRound(handle, request, signal, relay) {
    const poster = relay.poster;
    let result;
    for await (const event of handle.stream(request, { signal })) {
      if (signal.aborted) break;
      if (!plainObject(event)) continue;
      if (event.type === "result") {
        result = event.result;
        break;
      }
      if (event.type === "stalled") {
        view.applyEvent({ type: "model.stalled", turnId: undefined });
        continue;
      }
      if (event.type !== "output.delta" && event.type !== "reasoning.delta")
        continue;
      const text = boundedText(event.text, LIMITS.delta);
      if (!text) continue;
      if (event.type === "output.delta")
        view.applyEvent({ type: "output.delta", text, turnId: undefined });
      else
        view.applyEvent({
          type: "agent.reasoning.delta",
          text,
          provisional: true,
          provider: relay.label,
          turnId: undefined,
        });
      poster?.push(event.type, text);
    }
    if (signal.aborted)
      throw new WidgetError("ABORTED", "The completion was aborted.");
    if (!plainObject(result))
      throw new WidgetError(
        "PROVIDER_ERROR",
        "The completion ended without a result.",
      );
    await poster?.flush();
    return result;
  }

  /**
   * `model.client` (SPEC 14.7): the backend asks the page for one completion.
   * It runs beside the stream read, so a `model.cancel` for it can arrive.
   */
  async function runCompletion(data, turn) {
    const id = callId(data?.id);
    // Each id is answered once, however often the backend repeats it.
    if (!id || turn.done || turn.answered.has(`model:${id}`)) return;
    turn.answered.add(`model:${id}`);
    // A backend that asks without a bridge announced is a defect, and this
    // answer is final for it.
    if (!turn.bridged)
      return post(turn, "model-results", {
        id,
        error: { code: "NOT_SUPPORTED", message: "This turn has no bridge." },
      });
    if (
      !plainObject(data.request) ||
      !Array.isArray(data.request.messages) ||
      (data.conversation != null &&
        (typeof data.conversation !== "string" ||
          !CONVERSATION_ID.test(data.conversation))) ||
      (data.stream != null && typeof data.stream !== "boolean")
    )
      return post(turn, "model-results", {
        id,
        error: {
          code: "INVALID_REQUEST",
          message: "The model.client event is malformed.",
        },
      });
    const completion = {
      controller: new AbortController(),
      cancelled: false,
      timedOut: false,
    };
    turn.completions.set(id, completion);
    const signal = completion.controller.signal;
    const timer = setTimeout(() => {
      completion.timedOut = true;
      completion.controller.abort();
    }, COMPLETION_MS + COMPLETION_GRACE_MS);
    const label =
      bridge.mode === "arjunah"
        ? String(bridgeState.entry?.displayName ?? "your model").slice(0, 80)
        : "the model";
    view.applyEvent({ type: "agent.phase", text: `Asking ${label}…` });
    let conversation = null;
    const poster =
      data.stream === true ? deltaPoster(turn, id, completion) : null;
    try {
      let result;
      if (bridge.mode === "generate") {
        result = await bridge.generate(data.request, { signal });
      } else {
        const session = bridgeState.session;
        if (!session)
          throw new WidgetError(
            "NOT_CONFIGURED",
            "No model of the visitor's is available to this page.",
          );
        const handle = await conversationFor(
          session,
          data.conversation ?? null,
          turn.threadId,
        );
        conversation = handle?.id ?? null;
        if (typeof handle?.stream === "function")
          result = await streamRound(handle, data.request, signal, {
            label,
            poster,
          });
        else if (handle)
          result = await handle.generate(data.request, { signal });
        else result = await session.models.generate(data.request, { signal });
      }
      if (completion.cancelled || turn.done) return;
      if (completion.timedOut)
        throw new WidgetError("TIMEOUT", "The model did not answer in time.");
      if (!plainObject(result) || !plainObject(result.message))
        throw new WidgetError(
          "PROVIDER_ERROR",
          "The completion returned an invalid result.",
        );
      // Only the composer knows whether a round is the answer; a round that
      // ends in tool calls is not, so its provisional text goes now.
      if (
        Array.isArray(result.message.toolCalls) &&
        result.message.toolCalls.length
      )
        view.discardProvisional();
      await post(turn, "model-results", {
        id,
        result,
        ...(conversation ? { conversation } : {}),
      });
    } catch (error) {
      if (completion.cancelled || turn.done) return;
      view.discardProvisional();
      // Deltas already queued still go first, so the answer is always last.
      await poster?.flush();
      await post(turn, "model-results", {
        id,
        error: completion.timedOut
          ? { code: "TIMEOUT", message: "The model did not answer in time." }
          : errorBody(
              error,
              bridge.mode === "generate" ? "PROVIDER_ERROR" : "INTERNAL_ERROR",
            ),
        ...(conversation ? { conversation } : {}),
      });
    } finally {
      clearTimeout(timer);
      if (turn.completions.get(id) === completion) turn.completions.delete(id);
    }
  }

  /** `model.cancel`: abort that completion and post nothing more for it. */
  function cancelCompletion(data, turn) {
    const id = callId(data?.id);
    const completion = id ? turn.completions.get(id) : null;
    if (!completion) return;
    completion.cancelled = true;
    turn.completions.delete(id);
    completion.controller.abort();
    view.discardProvisional();
  }

  // ------------------------------------------------------- composer prompts

  /** Prompts open one at a time, in the order the backend asked. */
  function enqueuePrompt(task) {
    const next = promptChain.then(task, task);
    promptChain = next.catch(() => {});
    return next;
  }

  /**
   * `input.client` (SPEC 14.3): a tool the backend runs needs a value the
   * model must not supply. The value goes to `inputs` once and is kept
   * nowhere: not in the transcript, the DOM, or the stored thread.
   */
  async function runInputClient(data, turn) {
    const id = callId(data?.id);
    if (!id || turn.done || turn.answered.has(`input:${id}`)) return;
    turn.answered.add(`input:${id}`);
    const definition = ArjunahRenderer.userInputDeclaration(data.input);
    if (!definition) return post(turn, "inputs", { id, cancelled: true });
    turn.prompting = true;
    let answer;
    try {
      const value = await view.requestUserInput({
        toolName: view.stepName(data.toolId) ?? "A tool",
        origin: location.origin,
        definition,
      });
      answer = { id, value };
    } catch {
      answer = { id, cancelled: true };
    } finally {
      turn.prompting = false;
    }
    if (turn.done) return;
    await post(turn, "inputs", answer);
  }

  /**
   * `approval.client` (SPEC 7.8): the backend asks before it runs an
   * operation. Anything but the visitor choosing Approve answers false.
   */
  async function runApprovalClient(data, turn) {
    const id = callId(data?.id);
    if (!id || turn.done || turn.answered.has(`approval:${id}`)) return;
    turn.answered.add(`approval:${id}`);
    let approved = false;
    if (ArjunahRenderer.approvalPrompt(data.approval)) {
      turn.prompting = true;
      try {
        approved =
          (await view.requestApproval({
            origin: location.origin,
            toolName: view.stepName(data.toolId),
            approval: data.approval,
          })) === true;
      } catch {
        approved = false;
      } finally {
        turn.prompting = false;
      }
    }
    if (turn.done) return;
    view.markApproval(data.toolId, approved);
    await post(turn, "approvals", { id, approved });
  }

  // ------------------------------------------------------------ the stream

  async function consume(response, turn, context, signal) {
    const reader = response.body?.getReader();
    if (!reader)
      throw new WidgetError("PROVIDER_ERROR", "The backend sent no stream.");
    // A server's body errors when the turn is aborted; a page-built one need
    // not, so the stop cancels it, which also tells the page's loop.
    const stop = () => cancelReader(reader);
    signal?.addEventListener("abort", stop, { once: true });
    const decoder = new TextDecoder();
    let buffer = "";
    let total = 0;
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || signal?.aborted) break;
        const bytes = chunkBytes(value);
        total += bytes.byteLength;
        if (total > STREAM_BYTES) {
          cancelReader(reader);
          throw new WidgetError(
            "PROVIDER_ERROR",
            "The backend stream was too large.",
          );
        }
        buffer += decoder.decode(bytes, { stream: true });
        let split;
        while ((split = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const parsed = parseEvent(block);
          if (!parsed) continue;
          if (await handleEvent(parsed, turn, context)) finished = true;
        }
      }
    } catch (error) {
      cancelReader(reader);
      throw error;
    } finally {
      signal?.removeEventListener("abort", stop);
    }
    if (signal?.aborted)
      throw new DOMException("The turn was stopped.", "AbortError");
    if (!finished) view.finishActivity(true);
  }

  function parseEvent(block) {
    let type = "message";
    const data = [];
    for (const line of block.split(/\r\n|\r|\n/)) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:"))
        data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return null;
    try {
      const parsed = JSON.parse(data.join("\n"));
      return plainObject(parsed) ? { type, data: parsed } : null;
    } catch {
      return null;
    }
  }

  /** Returns true once the turn is over. */
  async function handleEvent({ type, data }, turn, context) {
    const threadId = turn.threadId;
    if (type === "turn.start") {
      currentBackendTurn = boundedText(data.turnId, 100) || null;
      turn.turnId = currentBackendTurn;
      report(config.onTurnStart, { threadId, turnId: currentBackendTurn });
      return false;
    }
    if (type === "error") {
      endTurn(turn);
      view.finishActivity(false);
      view.addBubble(
        "assistant",
        `The assistant reported an error: ${boundedText(data.message, 300)}`,
        { error: true, persist: false },
      );
      report(config.onError, {
        code: boundedText(data.code, 40) || "PROVIDER_ERROR",
        message: boundedText(data.message, 300),
      });
      return true;
    }
    if (type === "turn.end") {
      endTurn(turn);
      const finished = view.finishActivity(true);
      if (finished?.entry) context?.record(finished.entry);
      report(config.onTurnEnd, {
        threadId,
        turnId: currentBackendTurn,
        usage: data.usage ?? null,
      });
      return true;
    }
    if (type === "message") {
      const entry = transcriptEntry(data.entry ?? data);
      if (entry?.type === "message") {
        const live = view.currentTurn();
        const streamedNode = live?.outputNode ?? null;
        context?.record(
          view.addAssistantResult(
            {
              message: {
                content: Array.isArray(entry.content)
                  ? entry.content
                      .filter((part) => part.type === "text")
                      .map((part) => part.text)
                      .join("\n")
                  : entry.content,
                reasoning: entry.reasoning ?? null,
                attachments: Array.isArray(entry.content)
                  ? entry.content.filter((part) => part.type === "image")
                  : [],
              },
            },
            streamedNode,
          ),
        );
        // The composer's message is authoritative over a relayed round's
        // provisional text, which it replaces (SPEC 15).
        view.discardProvisional();
      }
      return false;
    }
    if (type === "tool.client") {
      await runClientTool(data, turn);
      return false;
    }
    if (type === "model.client") {
      void runCompletion(data, turn);
      return false;
    }
    if (type === "model.cancel") {
      cancelCompletion(data, turn);
      return false;
    }
    if (type === "input.client") {
      void enqueuePrompt(() => runInputClient(data, turn));
      return false;
    }
    if (type === "approval.client") {
      void enqueuePrompt(() => runApprovalClient(data, turn));
      return false;
    }
    if (type === "card" || type === "card.update" || type === "tool.end") {
      // Cards are bounded and validated here because no broker sits in front
      // of the renderer in standalone mode (SPEC 14.6).
      let card;
      try {
        card = data.card ? validateCard(data.card, "card") : undefined;
      } catch {
        card = undefined;
      }
      view.applyEvent({ ...data, type, card, turnId: undefined });
      return false;
    }
    if (type === "reasoning.delta") {
      view.applyEvent({
        type: "agent.reasoning.delta",
        text: boundedText(data.text, LIMITS.delta),
        turnId: undefined,
      });
      return false;
    }
    if (type === "progress") {
      view.applyEvent({
        type: "progress",
        toolId: data.toolId ?? data.id,
        text: boundedText(data.text, LIMITS.progress),
        turnId: undefined,
      });
      return false;
    }
    view.applyEvent({ ...data, type, turnId: undefined });
    return false;
  }

  /**
   * The backend asked the page to run one of its own declared tools. Arguments
   * are checked against the declared schema before the handler sees them, and
   * the result goes back on its own route while the stream stays open.
   */
  async function runClientTool(data, turn) {
    const id = boundedText(data.id, 128);
    const tool = tools.get(data.name);
    let result;
    try {
      if (!tool) throw new Error("Unknown client tool.");
      let args;
      try {
        args =
          typeof data.arguments === "string"
            ? JSON.parse(data.arguments)
            : (data.arguments ?? {});
      } catch {
        throw new Error("Invalid tool arguments.");
      }
      validateArguments(args, tool.inputSchema);
      let collected = 0;
      result = await tool.handler(args, {
        id,
        name: tool.name,
        controls: view.controls(),
        async requestInput(inputId) {
          const definition = (tool.userInputs ?? []).find(
            (item) => item.id === inputId,
          );
          if (!definition)
            throw new WidgetError(
              "INVALID_REQUEST",
              "This input was not declared for this tool.",
            );
          if (++collected > 4)
            throw new WidgetError(
              "INVALID_REQUEST",
              "This tool requested too many user inputs.",
            );
          return view.requestUserInput({
            toolName: tool.name,
            origin: location.origin,
            definition,
          });
        },
        reportProgress(text) {
          view.applyEvent({
            type: "progress",
            toolId: id,
            text: boundedText(text, LIMITS.progress),
            turnId: undefined,
          });
        },
      });
    } catch (error) {
      result = {
        isError: true,
        message: String(error?.message ?? "The tool failed.").slice(0, 300),
      };
    }
    await post(turn, "tool-results", { id, result });
  }

  return {
    panel: view.panel,
    view,
    open() {
      view.panel.hidden = false;
    },
    close() {
      view.panel.hidden = true;
    },
    openThread(id) {
      return view.selectThread(String(id));
    },
    newThread() {
      return view.newThread();
    },
    getControls() {
      return view.controls();
    },
    setControls(values) {
      return view.setControls(values ?? {});
    },
    setModels(models, selected) {
      // The visitor's catalog is not the site's to replace (SPEC 8.2).
      if (visitorCatalog) return view.selection().model;
      return view.setModels(models ?? [], selected);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      endTurn(liveTurn);
      controller?.abort();
      view.cancelUserInput("The assistant was closed.");
      view.cancelApproval();
      shadow.replaceChildren();
    },
  };
}

/**
 * Builds the `Response` a `backend.fetch` function returns for a turn
 * (SPEC 14.3): each item of `events`, a sync or async iterable, is one event
 * `{ type, ...data }` framed as `event: <type>` and a JSON `data:` line. The
 * stream pulls one event at a time, so a generator can wait for a tool result
 * between yields; when the widget stops reading (stop, destroy, a bound) the
 * iterator's `return()` runs, so a generator's `finally` sees the end. An item
 * without a valid `type` errors the stream, which fails the turn.
 */
export function eventStreamResponse(events) {
  const iterator =
    events?.[Symbol.asyncIterator]?.() ?? events?.[Symbol.iterator]?.();
  if (typeof iterator?.next !== "function")
    throw new WidgetError(
      "INVALID_REQUEST",
      "eventStreamResponse needs an iterable of events.",
    );
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async pull(stream) {
      const { done, value } = await iterator.next();
      if (done) return stream.close();
      if (!plainObject(value) || !EVENT_TYPE.test(String(value.type ?? "")))
        throw new WidgetError("INVALID_REQUEST", "An event needs a type.");
      const { type, ...data } = value;
      stream.enqueue(
        encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`),
      );
    },
    cancel(reason) {
      // Not awaited: a generator parked on a promise settles its return later.
      Promise.resolve()
        .then(() => iterator.return?.(reason))
        .catch(() => {});
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

export { ArjunahRenderer, validateCard };
export const PROTOCOL_VERSION = "1.0.0";
