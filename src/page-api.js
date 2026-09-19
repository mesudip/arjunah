(() => {
  "use strict";
  const CHANNEL = "arjunah-v0.1";
  const nonce = document.currentScript?.dataset.arjunahNonce;
  const pending = new Map();
  const pendingToolInputs = new Map();
  const handlers = new Map();
  const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  let activeRegistration = null;
  let controlListener = null;
  let controlValues = {};
  let cardActionListener = null;
  let threadStore = null;

  // `window.ai` is a shared namespace; this broker owns only `window.ai.arjunah`.
  const namespace = "ai" in window ? window.ai : undefined;
  if (
    !nonce ||
    (namespace !== undefined &&
      (namespace === null ||
        typeof namespace !== "object" ||
        "arjunah" in namespace ||
        !Object.isExtensible(namespace)))
  ) {
    window.dispatchEvent(new CustomEvent("arjunah:conflict"));
    return;
  }

  function errorFrom(payload) {
    const error = new Error(payload?.message ?? "The AI request failed.");
    error.name = "AIError";
    error.code = payload?.code ?? "INTERNAL_ERROR";
    if (payload?.details !== undefined) error.details = payload.details;
    return error;
  }

  function request(method, params = {}) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(
            errorFrom({
              code: "TIMEOUT",
              message: "The AI request timed out.",
            }),
          );
        },
        // Generation may run through a local subscription CLI, which is slower than a hosted API.
        method === "models.generate" ? 180000 : 30000,
      );
      pending.set(id, { resolve, reject, timer });
      window.postMessage(
        {
          channel: CHANNEL,
          direction: "page-to-extension",
          nonce,
          kind: "request",
          id,
          method,
          params,
        },
        "*",
      );
    });
  }

  /**
   * `_warnings` carries broker notices meant for whoever wrote this page, not
   * for its users: it is logged and removed, so the public result shape stays
   * exactly what SPEC section 5 documents.
   */
  function withoutWarnings(result) {
    if (
      !result ||
      typeof result !== "object" ||
      !Array.isArray(result._warnings)
    )
      return result;
    const { _warnings, ...publicResult } = result;
    for (const warning of _warnings)
      if (typeof warning === "string") console.warn(`[अर्जुनः] ${warning}`);
    return publicResult;
  }

  /** Local callback results cross the bridge, so they must be plain JSON. */
  function bounded(value, maxBytes) {
    if (value == null) return null;
    let encoded;
    try {
      encoded = JSON.stringify(value);
    } catch {
      throw new Error("The site returned a value that is not JSON.");
    }
    if (
      encoded === undefined ||
      new TextEncoder().encode(encoded).byteLength > maxBytes
    )
      throw new Error("The site returned a value that is too large.");
    return JSON.parse(encoded);
  }

  function clearPendingToolInputs(message) {
    for (const entry of pendingToolInputs.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    pendingToolInputs.clear();
  }

  function validatedToolResult(value, outputContent = []) {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Invalid tool result.");
    if (!outputContent.length) {
      if (new TextEncoder().encode(encoded).byteLength > 65536)
        throw new Error("Invalid or oversized tool result.");
      return JSON.parse(encoded);
    }
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.kind !== "content" ||
      !Array.isArray(value.content) ||
      !value.content.length ||
      value.content.length > 8
    )
      throw new Error("Invalid content tool result.");
    let images = 0;
    let cards = 0;
    let hasText = false;
    const content = value.content.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part))
        throw new Error("Invalid content tool result.");
      if (part.type === "text") {
        if (
          !outputContent.includes("text") ||
          typeof part.text !== "string" ||
          part.text.length > 12000
        )
          throw new Error("Invalid text tool result.");
        hasText ||= part.text.trim().length > 0;
        return { type: "text", text: part.text };
      }
      if (part.type === "image") {
        if (
          !outputContent.includes("image") ||
          ++images > 4 ||
          !IMAGE_TYPES.includes(part.mediaType) ||
          typeof part.data !== "string" ||
          part.data.length > 2000000 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(part.data)
        )
          throw new Error("Invalid image tool result.");
        return { type: "image", mediaType: part.mediaType, data: part.data };
      }
      if (part.type === "card") {
        // Shape and size only; the extension runs the full SPEC 7.4 validator
        // before anything is drawn, and the model never sees this part.
        if (
          !outputContent.includes("card") ||
          ++cards > 1 ||
          !part.card ||
          typeof part.card !== "object" ||
          Array.isArray(part.card) ||
          part.card.type !== "card" ||
          new TextEncoder().encode(JSON.stringify(part.card)).byteLength > 65536
        )
          throw new Error("Invalid card tool result.");
        return { type: "card", card: JSON.parse(JSON.stringify(part.card)) };
      }
      throw new Error("Invalid content tool result.");
    });
    if ((images || cards) && !hasText)
      throw new Error(
        "Image and card tool results require a non-empty text fallback.",
      );
    return { kind: "content", content };
  }

  window.addEventListener("message", async (event) => {
    if (
      event.source !== window ||
      event.data?.channel !== CHANNEL ||
      event.data?.direction !== "extension-to-page" ||
      event.data?.nonce !== nonce
    )
      return;
    const message = event.data;
    if (message.kind === "response") {
      const entry = pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      message.ok
        ? entry.resolve(withoutWarnings(message.result))
        : entry.reject(errorFrom(message.error));
      return;
    }
    if (message.kind === "control-change") {
      // The user changed a widget option in the broker-owned panel.
      if (message.registrationId !== activeRegistration) return;
      controlValues =
        message.values && typeof message.values === "object"
          ? { ...message.values }
          : controlValues;
      try {
        controlListener?.(message.id, message.value, { ...controlValues });
      } catch {
        /* page listener errors stay in the page */
      }
      return;
    }
    if (message.kind === "tool-invoke") {
      const handler = handlers.get(message.name);
      try {
        if (message.registrationId !== activeRegistration)
          throw new Error("Assistant registration changed.");
        if (!handler) throw new Error("Tool handler is unavailable.");
        let inputRequests = 0;
        let progressReports = 0;
        const result = await handler(message.args, {
          id: message.invocationId,
          name: message.name,
          controls: { ...(message.controls ?? controlValues) },
          /**
           * Ephemeral status for a slow tool (SPEC 7.5). It is drawn under the
           * tool's step and never enters model messages or chat history, so a
           * dropped report changes nothing the model or the site can observe.
           */
          reportProgress(text) {
            if (typeof text !== "string" || !text) return;
            if (++progressReports > 50) return;
            window.postMessage(
              {
                channel: CHANNEL,
                direction: "page-to-extension",
                nonce,
                kind: "tool-progress",
                invocation: message.id,
                text: text.slice(0, 200),
              },
              "*",
            );
          },
          requestInput(inputId) {
            if (typeof inputId !== "string" || !inputId)
              return Promise.reject(new Error("Input id is required."));
            if (++inputRequests > 4)
              return Promise.reject(
                new Error("This tool requested too many user inputs."),
              );
            const requestId = crypto.randomUUID();
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                pendingToolInputs.delete(requestId);
                reject(new Error("The user input request timed out."));
              }, 120000);
              pendingToolInputs.set(requestId, { resolve, reject, timer });
              window.postMessage(
                {
                  channel: CHANNEL,
                  direction: "page-to-extension",
                  nonce,
                  kind: "tool-input-request",
                  id: requestId,
                  invocation: message.id,
                  inputId,
                },
                "*",
              );
            });
          },
        });
        const validated = validatedToolResult(
          result,
          message.outputContent ?? [],
        );
        window.postMessage(
          {
            channel: CHANNEL,
            direction: "page-to-extension",
            nonce,
            kind: "tool-result",
            id: message.id,
            ok: true,
            result: validated,
          },
          "*",
        );
      } catch (error) {
        window.postMessage(
          {
            channel: CHANNEL,
            direction: "page-to-extension",
            nonce,
            kind: "tool-result",
            id: message.id,
            ok: false,
            error: {
              code: "TOOL_ERROR",
              message: String(error?.message ?? "Site tool failed.").slice(
                0,
                300,
              ),
            },
          },
          "*",
        );
      }
      return;
    }
    if (message.kind === "card-action" || message.kind === "thread-call") {
      const reply = (ok, payload) =>
        window.postMessage(
          {
            channel: CHANNEL,
            direction: "page-to-extension",
            nonce,
            kind: "page-result",
            id: message.id,
            ok,
            ...(ok ? { result: payload } : { error: { message: payload } }),
          },
          "*",
        );
      if (message.registrationId !== activeRegistration)
        return reply(false, "Assistant registration changed.");
      try {
        if (message.kind === "card-action") {
          if (!cardActionListener) return reply(true, null);
          const detail = message.action ?? {};
          const replacement = await cardActionListener({
            cardId: detail.cardId ?? null,
            name: detail.name,
            payload: detail.payload,
            values: detail.values ?? null,
          });
          return reply(true, bounded(replacement ?? null, 65536));
        }
        const method = message.method;
        const handler =
          threadStore && typeof threadStore[method] === "function"
            ? threadStore[method]
            : null;
        if (!handler) return reply(false, `threads.${method} is unavailable.`);
        const result = await handler.apply(
          threadStore,
          Array.isArray(message.args) ? message.args : [],
        );
        return reply(true, bounded(result ?? null, 8 * 1024 * 1024));
      } catch (error) {
        return reply(
          false,
          String(error?.message ?? "The site callback failed.").slice(0, 300),
        );
      }
    }
    if (message.kind === "tool-input-result") {
      const entry = pendingToolInputs.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pendingToolInputs.delete(message.id);
      message.ok
        ? entry.resolve(message.value)
        : entry.reject(new Error(message.error ?? "The user cancelled."));
    }
  });

  /** The object a page uses once the user has enabled access. */
  function session(grant) {
    return Object.freeze({
      grant: Object.freeze(grant),
      permissions: Object.freeze({
        query: () => request("permissions.query"),
      }),
      providers: Object.freeze({
        list: () => request("providers.list"),
      }),
      models: Object.freeze({
        list: () => request("models.list"),
        generate: (options) => request("models.generate", options),
      }),
      context: Object.freeze({
        get: (options) => request("context.get", options),
      }),
    });
  }

  const api = {
    version: "1.2.0",
    isEnabled: async () => {
      const grant = await request("permissions.query");
      return grant != null && grant.level !== "assistant";
    },
    enable: async (options) => session(await request("enable", options)),
    disable: () => request("permissions.revoke"),
    site: Object.freeze({
      register: async (manifest) => {
        if (
          !manifest ||
          typeof manifest !== "object" ||
          !Array.isArray(manifest.tools ?? []) ||
          (manifest.tools ?? []).some(
            (tool) => !tool || typeof tool.handler !== "function",
          )
        )
          throw errorFrom({
            code: "INVALID_REQUEST",
            message: "Site tools require function handlers.",
          });
        for (const name of ["onControlChange", "onCardAction"])
          if (manifest[name] != null && typeof manifest[name] !== "function")
            throw errorFrom({
              code: "INVALID_REQUEST",
              message: `${name} must be a function.`,
            });
        const threads = manifest.threads ?? null;
        if (threads != null) {
          if (typeof threads !== "object" || Array.isArray(threads))
            throw errorFrom({
              code: "INVALID_REQUEST",
              message: "threads must be an object of functions.",
            });
          for (const name of ["list", "create", "load", "append", "delete"])
            if (typeof threads[name] !== "function")
              throw errorFrom({
                code: "INVALID_REQUEST",
                message: `threads.${name} must be a function.`,
              });
          if (threads.rename != null && typeof threads.rename !== "function")
            throw errorFrom({
              code: "INVALID_REQUEST",
              message: "threads.rename must be a function.",
            });
        }
        const id = crypto.randomUUID();
        // Local functions never cross the bridge; the contract carries only the
        // fact that the site stores conversations (SPEC 7.6).
        const {
          onControlChange,
          onCardAction,
          threads: _threads,
          ...serializable
        } = manifest;
        const wire = {
          ...serializable,
          tools: (manifest?.tools ?? []).map(
            ({ handler, ...definition }) => definition,
          ),
          ...(threads
            ? { threads: { rename: typeof threads.rename === "function" } }
            : {}),
        };
        const result = await request("site.register", { id, manifest: wire });
        clearPendingToolInputs("Assistant registration changed.");
        handlers.clear();
        for (const tool of manifest?.tools ?? [])
          if (typeof tool.handler === "function")
            handlers.set(tool.name, tool.handler);
        activeRegistration = id;
        controlListener = onControlChange ?? null;
        cardActionListener = onCardAction ?? null;
        threadStore = threads;
        controlValues = result.controls ?? {};
        return Object.freeze({
          id: result.id,
          unregister: async () => {
            if (activeRegistration !== id) return false;
            const removed = await request("site.unregister", { id });
            if (removed && activeRegistration === id) {
              clearPendingToolInputs("Assistant registration ended.");
              handlers.clear();
              activeRegistration = null;
              controlListener = null;
              cardActionListener = null;
              threadStore = null;
              controlValues = {};
            }
            return removed;
          },
        });
      },
    }),
    chat: Object.freeze({
      open: () => request("chat.open"),
      close: () => request("chat.close"),
      getControls: async () => {
        const values = await request("chat.getControls");
        controlValues = { ...values };
        return values;
      },
      setControls: async (values) => {
        const result = await request("chat.setControls", { values });
        controlValues = { ...result };
        return result;
      },
    }),
  };
  for (const value of Object.values(api))
    if (value && typeof value === "object") Object.freeze(value);
  const host = namespace ?? {};
  try {
    if (namespace === undefined)
      Object.defineProperty(window, "ai", {
        value: host,
        configurable: false,
        enumerable: false,
        writable: false,
      });
    Object.defineProperty(host, "arjunah", {
      value: Object.freeze(api),
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch {
    window.dispatchEvent(new CustomEvent("arjunah:conflict"));
    return;
  }
  window.dispatchEvent(
    new CustomEvent("arjunah:ready", {
      detail: { version: api.version },
    }),
  );
  window.addEventListener("pagehide", () =>
    clearPendingToolInputs("The page closed."),
  );
})();
