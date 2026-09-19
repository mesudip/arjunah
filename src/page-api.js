(() => {
  "use strict";
  const CHANNEL = "arjunah-v0.1";
  const nonce = document.currentScript?.dataset.arjunahNonce;
  const pending = new Map();
  const pendingToolInputs = new Map();
  const handlers = new Map();
  let activeRegistration = null;
  let controlListener = null;
  let controlValues = {};

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

  function clearPendingToolInputs(message) {
    for (const entry of pendingToolInputs.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    pendingToolInputs.clear();
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
        ? entry.resolve(message.result)
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
        const result = await handler(message.args, {
          id: message.invocationId,
          name: message.name,
          controls: { ...(message.controls ?? controlValues) },
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
        const encoded = JSON.stringify(result);
        if (
          encoded === undefined ||
          new TextEncoder().encode(encoded).byteLength > 65536
        )
          throw new Error("Invalid or oversized tool result.");
        window.postMessage(
          {
            channel: CHANNEL,
            direction: "page-to-extension",
            nonce,
            kind: "tool-result",
            id: message.id,
            ok: true,
            result: JSON.parse(encoded),
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
    version: "1.0.0",
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
        if (
          manifest.onControlChange != null &&
          typeof manifest.onControlChange !== "function"
        )
          throw errorFrom({
            code: "INVALID_REQUEST",
            message: "onControlChange must be a function.",
          });
        const id = crypto.randomUUID();
        // Local functions never cross the bridge.
        const { onControlChange, ...serializable } = manifest;
        const wire = {
          ...serializable,
          tools: (manifest?.tools ?? []).map(
            ({ handler, ...definition }) => definition,
          ),
        };
        const result = await request("site.register", { id, manifest: wire });
        clearPendingToolInputs("Assistant registration changed.");
        handlers.clear();
        for (const tool of manifest?.tools ?? [])
          if (typeof tool.handler === "function")
            handlers.set(tool.name, tool.handler);
        activeRegistration = id;
        controlListener = onControlChange ?? null;
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
