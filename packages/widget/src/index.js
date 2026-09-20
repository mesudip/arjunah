/**
 * अर्जुनः standalone widget (SPEC section 14).
 *
 * The same renderer the browser extension hosts, mounted by a site that owns
 * its own inference, tools and threads. There is no wallet here: no grants, no
 * consent, no provider credential. The site backend is already the page's own
 * trust domain, so this module is a view plus a bounded client for the backend
 * protocol. It never claims to be the extension and never touches
 * `window.ai.arjunah`.
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
};

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
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new WidgetError(
        "PROVIDER_ERROR",
        "The backend response was too large.",
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
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

/**
 * Mounts the assistant into `mount` and returns a handle.
 *
 * `backend.baseUrl` must be same-origin or HTTPS. `tools` are ordinary site
 * tools whose handlers run in the page when the backend asks for them with a
 * `tool.client` event; server-side tools need no declaration here because the
 * backend simply runs them inside the turn.
 */
export function mountAssistant(config = {}) {
  const mount = config.mount;
  if (!(mount instanceof Element))
    throw new WidgetError("INVALID_REQUEST", "mount must be an element.");
  const backend = config.backend ?? {};
  if (typeof backend.baseUrl !== "string" || !backend.baseUrl)
    throw new WidgetError("INVALID_REQUEST", "backend.baseUrl is required.");
  const headers = { ...(backend.headers ?? {}) };
  for (const key of Object.keys(headers))
    if (/^(cookie|set-cookie)$/i.test(key)) delete headers[key];
  const credentials = backend.credentials ?? "same-origin";
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

  const shadow = mount.shadowRoot ?? mount.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = ArjunahRenderer.STYLE;
  shadow.replaceChildren(style);

  let controller = null;
  let currentBackendTurn = null;
  let destroyed = false;

  async function request(path, init = {}) {
    const response = await fetch(endpoint(backend.baseUrl, path), {
      ...init,
      headers: {
        ...headers,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      credentials,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new WidgetError(
        "PROVIDER_ERROR",
        `The backend rejected the request (${response.status}).`,
      );
    }
    return response;
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
    },
  };

  const view = ArjunahRenderer.createChatView({
    document,
    host: {
      threads,
      submit: (content, context) => runTurn(content, context),
      stop() {
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
  view.setModels(widget.models ?? [], widget.defaultModel);
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
    const localTurn = randomId();
    view.startActivity(localTurn, threadId);
    let streamed = null;
    try {
      const response = await request(
        `threads/${encodeURIComponent(threadId)}/turns`,
        {
          method: "POST",
          body: JSON.stringify({
            content,
            controls: view.controls(),
            ...selectionFields(),
          }),
          signal: controller.signal,
        },
      );
      await consume(response, threadId, context);
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
      void streamed;
      controller = null;
      currentBackendTurn = null;
      view.setBusy(false);
    }
  }

  async function consume(response, threadId, context) {
    const reader = response.body?.getReader();
    if (!reader)
      throw new WidgetError("PROVIDER_ERROR", "The backend sent no stream.");
    const decoder = new TextDecoder();
    let buffer = "";
    let total = 0;
    let finished = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > STREAM_BYTES) {
        await reader.cancel().catch(() => {});
        throw new WidgetError(
          "PROVIDER_ERROR",
          "The backend stream was too large.",
        );
      }
      buffer += decoder.decode(value, { stream: true });
      let split;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const parsed = parseEvent(block);
        if (!parsed) continue;
        if (await handleEvent(parsed, threadId, context)) finished = true;
      }
    }
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
      return { type, data: JSON.parse(data.join("\n")) };
    } catch {
      return null;
    }
  }

  /** Returns true once the turn is over. */
  async function handleEvent({ type, data }, threadId, context) {
    if (type === "turn.start") {
      currentBackendTurn = boundedText(data.turnId, 100) || null;
      report(config.onTurnStart, { threadId, turnId: currentBackendTurn });
      return false;
    }
    if (type === "error") {
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
        const turn = view.currentTurn();
        const streamedNode = turn?.outputNode ?? null;
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
      }
      return false;
    }
    if (type === "tool.client") {
      await runClientTool(data, threadId);
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
        text: boundedText(data.text, 4000),
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
  async function runClientTool(data, threadId) {
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
    await json(
      `threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(
        currentBackendTurn ?? "",
      )}/tool-results`,
      { method: "POST", body: JSON.stringify({ id, result }) },
    ).catch(() => {});
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
      return view.setModels(models ?? [], selected);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      controller?.abort();
      view.cancelUserInput("The assistant was closed.");
      shadow.replaceChildren();
    },
  };
}

export { ArjunahRenderer, validateCard };
export const PROTOCOL_VERSION = "1.0.0";
