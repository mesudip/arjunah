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
  // A hosted external loop (SPEC 15.1) and the site's own model function
  // (15.2): page functions the extension calls across the bridge, never
  // serialized. Each call in flight keeps its abort controller here.
  let loopFetch = null;
  let siteGenerate = null;
  const pageCalls = new Map();
  // The largest body one `loop.fetch` answer may carry: the event stream
  // bound of SPEC 14.3. The content script counts again.
  const LOOP_BYTES = 2000000;
  const LOOP_CHUNK = 65536;

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

  /** Every rejection carries a `details` object (SPEC 9). */
  function errorFrom(payload) {
    const error = new Error(payload?.message ?? "The AI request failed.");
    error.name = "AIError";
    error.code = payload?.code ?? "INTERNAL_ERROR";
    error.details =
      payload?.details &&
      typeof payload.details === "object" &&
      !Array.isArray(payload.details)
        ? payload.details
        : { requestId: null, retryable: false };
    return error;
  }

  /** An error raised here, before or instead of an extension answer. */
  function localError(id, code, message, retryable = false) {
    return errorFrom({
      code,
      message,
      details: { requestId: id, retryable },
    });
  }

  /** Duck-typed so a signal from another realm (an iframe's) still works. */
  function abortSignal(options) {
    if (options == null) return null;
    const signal = typeof options === "object" ? options.signal : undefined;
    if (signal == null) return null;
    if (
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function"
    )
      throw localError(
        null,
        "INVALID_REQUEST",
        "options.signal must be an AbortSignal.",
      );
    return signal;
  }

  function post(payload) {
    window.postMessage(
      {
        channel: CHANNEL,
        direction: "page-to-extension",
        nonce,
        ...payload,
      },
      "*",
    );
  }

  /**
   * `live`, for a streamed round, receives its events (`onEvent`) and gets
   * back the function that cancels it (`abort`), which is what aborting the
   * signal does.
   */
  function request(method, params = {}, signal = null, live = null) {
    const id = crypto.randomUUID();
    // Already aborted: nothing is sent, so nothing has to be cancelled.
    if (signal?.aborted)
      return Promise.reject(
        localError(id, "ABORTED", "The request was cancelled by the page."),
      );
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const entry = pending.get(id);
        if (!entry) return;
        entry.settle();
        // The extension ends the provider request; this promise does not
        // wait for it to confirm.
        post({ kind: "cancel", id });
        reject(
          localError(id, "ABORTED", "The request was cancelled by the page."),
        );
      };
      const timer = setTimeout(
        () => {
          if (!pending.has(id)) return;
          pending.get(id).settle();
          reject(localError(id, "TIMEOUT", "The AI request timed out.", true));
        },
        // Generation may run through a local subscription CLI, which is slower than a hosted API.
        method === "models.generate" || method === "models.stream"
          ? 180000
          : 30000,
      );
      if (live) live.abort = onAbort;
      pending.set(id, {
        resolve,
        reject,
        onEvent: live?.onEvent ?? null,
        settle() {
          clearTimeout(timer);
          pending.delete(id);
          signal?.removeEventListener("abort", onAbort);
        },
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      post({ kind: "request", id, method, params });
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

  /** Ends every loop fetch and site-model round still running. */
  function abortPageCalls() {
    for (const controller of pageCalls.values()) controller.abort();
    pageCalls.clear();
  }

  function postToExtension(payload) {
    window.postMessage(
      {
        channel: CHANNEL,
        direction: "page-to-extension",
        nonce,
        ...payload,
      },
      "*",
    );
  }

  /**
   * One section 14.4 route answered by the page's `loop.fetch` (SPEC 15.1).
   * The extension never reaches the site's server; this function decides
   * where the request goes. The body comes back in bounded text chunks as it
   * is read, so an event stream reaches the panel incrementally.
   */
  async function runLoopFetch(message) {
    const reply = (payload) => postToExtension({ id: message.id, ...payload });
    let headed = false;
    const controller = new AbortController();
    pageCalls.set(message.id, controller);
    try {
      if (message.registrationId !== activeRegistration || !loopFetch)
        throw new Error("The assistant registration changed.");
      const maxBytes = Math.min(
        Math.max(Number(message.maxBytes) || 0, 1),
        LOOP_BYTES,
      );
      const body = typeof message.body === "string" ? message.body : null;
      const response = await loopFetch(String(message.path ?? ""), {
        method: typeof message.method === "string" ? message.method : "GET",
        headers: body != null ? { "Content-Type": "application/json" } : {},
        ...(body != null ? { body } : {}),
        signal: controller.signal,
      });
      if (!response || typeof response.status !== "number")
        throw new Error("loop.fetch must resolve to a Response.");
      headed = true;
      reply({
        kind: "loop-head",
        ok: true,
        status: response.status,
        contentType: String(response.headers?.get?.("content-type") ?? "")
          .slice(0, 200)
          .toLowerCase(),
      });
      const send = (text) => {
        for (let at = 0; at < text.length; at += LOOP_CHUNK)
          reply({ kind: "loop-chunk", text: text.slice(at, at + LOOP_CHUNK) });
      };
      let total = 0;
      const reader = response.body?.getReader?.();
      if (reader) {
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (controller.signal.aborted) {
            await reader.cancel().catch(() => {});
            break;
          }
          const bytes =
            value instanceof Uint8Array
              ? value
              : new TextEncoder().encode(String(value ?? ""));
          total += bytes.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new Error("The loop answered with too much data.");
          }
          send(decoder.decode(bytes, { stream: true }));
        }
        send(decoder.decode());
      } else if (typeof response.text === "function") {
        const text = String(await response.text());
        if (new TextEncoder().encode(text).byteLength > maxBytes)
          throw new Error("The loop answered with too much data.");
        send(text);
      }
      reply({ kind: "loop-end" });
    } catch (error) {
      const text = String(error?.message ?? "loop.fetch failed.").slice(0, 300);
      reply(
        headed
          ? { kind: "loop-end", error: text }
          : { kind: "loop-head", ok: false, error: text },
      );
    } finally {
      pageCalls.delete(message.id);
    }
  }

  /** One round of the site's own model (SPEC 15.2), abortable by the extension. */
  async function runSiteGenerate(message) {
    const reply = (ok, payload) =>
      postToExtension({
        kind: "page-result",
        id: message.id,
        ok,
        ...(ok ? { result: payload } : { error: { message: payload } }),
      });
    const controller = new AbortController();
    pageCalls.set(message.id, controller);
    try {
      if (message.registrationId !== activeRegistration || !siteGenerate)
        throw new Error("The site's model is unavailable.");
      const result = await siteGenerate(message.request, {
        signal: controller.signal,
      });
      // Up to four attachments of 2,000,000 characters and the answer text.
      reply(true, bounded(result ?? null, 12000000));
    } catch (error) {
      reply(
        false,
        String(error?.message ?? "The site's model failed.").slice(0, 300),
      );
    } finally {
      pageCalls.delete(message.id);
    }
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
      entry.settle();
      message.ok
        ? entry.resolve(withoutWarnings(message.result))
        : entry.reject(errorFrom(message.error));
      return;
    }
    if (message.kind === "stream") {
      // One event of a round this page is streaming (SPEC 5.3), checked
      // again here: only the shapes the content script forwards, under the
      // id of a stream still waiting for its answer.
      const entry = pending.get(message.id);
      const event = message.event;
      if (!entry?.onEvent || !event || typeof event !== "object") return;
      if (event.type === "stalled") return entry.onEvent({ type: "stalled" });
      if (
        (event.type === "output.delta" || event.type === "reasoning.delta") &&
        typeof event.text === "string" &&
        event.text &&
        event.text.length <= 4000
      )
        entry.onEvent({ type: event.type, text: event.text });
      return;
    }
    if (message.kind === "grantchange") {
      // This origin's grant or site model changed (SPEC 3). Rebuilt here, in
      // the page's own world, from the three fields the event carries.
      const detail = message.detail ?? {};
      const levels = ["assistant", "completion", "catalog"];
      window.dispatchEvent(
        new CustomEvent("arjunah:grantchange", {
          detail: Object.freeze({
            level: levels.includes(detail.level) ? detail.level : null,
            model:
              typeof detail.model === "string"
                ? detail.model.slice(0, 264)
                : null,
            revoked: detail.revoked === true,
          }),
        }),
      );
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
    if (message.kind === "loop-fetch") return void runLoopFetch(message);
    if (message.kind === "site-generate") return void runSiteGenerate(message);
    if (message.kind === "page-call-abort") {
      pageCalls.get(message.id)?.abort();
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

  /**
   * A generate request bound to `extra`'s conversation, or to none. The
   * request's own `conversationId`, if it has one, is dropped: the only way
   * to continue a conversation is through its handle. Anything that is not
   * an object goes through untouched, for the extension to refuse.
   */
  function withMembers(input, extra) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      return input;
    const { conversationId: _ignored, ...rest } = input;
    return { ...rest, ...extra };
  }

  /**
   * A round streamed through the bridge (SPEC 5.3), as an async iterable:
   * `output.delta` and `reasoning.delta` events as the provider produces them,
   * `stalled` after a quiet stretch, and last `{ type: "result", result }`,
   * exactly what `generate` resolves to for the same request. A failure
   * rejects `next()` with the error `generate` would reject with. Leaving
   * the loop early (`return()`) cancels the round as aborting the signal does.
   */
  function roundStream(params, options) {
    const queue = [];
    const waiting = [];
    // What this round may still carry, per text: the result's own bounds.
    const room = { "output.delta": 120000, "reasoning.delta": 12000 };
    let done = false;
    let failure = null;
    let left = false;
    const live = {
      abort: null,
      onEvent(event) {
        if (done) return;
        if (event.type !== "stalled") {
          const text = event.text.slice(0, room[event.type]);
          if (!text) return;
          room[event.type] -= text.length;
          event = { type: event.type, text };
        }
        deliver(event);
      },
    };
    const deliver = (event) => {
      const next = waiting.shift();
      if (next) next.resolve({ value: event, done: false });
      else queue.push(event);
    };
    const finish = () => {
      done = true;
      for (const next of waiting.splice(0))
        next.resolve({ value: undefined, done: true });
    };
    const fail = (error) => {
      if (done) return;
      done = true;
      const next = waiting.shift();
      if (next) next.reject(error);
      else failure = error;
      finish();
    };
    let signal = null;
    try {
      signal = abortSignal(options);
    } catch (error) {
      fail(error);
    }
    if (!done)
      request("models.stream", params, signal, live).then(
        (result) => {
          if (done) return;
          // Already without `_warnings`, as every response is.
          deliver({ type: "result", result });
          finish();
        },
        (error) => {
          // A round this page left on purpose has nobody to tell.
          if (!left) fail(error);
        },
      );
    const iterator = {
      next() {
        if (queue.length)
          return Promise.resolve({ value: queue.shift(), done: false });
        if (failure) {
          const error = failure;
          failure = null;
          return Promise.reject(error);
        }
        if (done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) =>
          waiting.push({ resolve, reject }),
        );
      },
      return() {
        if (!done) {
          left = true;
          queue.length = 0;
          live.abort?.();
          finish();
        }
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return Object.freeze(iterator);
  }

  /**
   * One conversation the extension minted for this origin (SPEC 5.4). Its
   * rounds share the provider state their tool steps need; the id is the
   * only thing the page holds, and the extension checks it on every use.
   */
  function conversation(id) {
    return Object.freeze({
      id,
      generate: async (input, options) =>
        request(
          "models.generate",
          withMembers(input, { conversationId: id }),
          abortSignal(options),
        ),
      stream: (input, options) =>
        roundStream(withMembers(input, { conversationId: id }), options),
      release: () => request("conversations.release", { id }),
    });
  }

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
        /**
         * A one-off completion. `options.signal` aborts the call: the promise
         * rejects with ABORTED at once and the extension stops the provider
         * request (SPEC 10).
         */
        generate: async (input, options) =>
          request(
            "models.generate",
            withMembers(input, {}),
            abortSignal(options),
          ),
        /**
         * The same one-off completion, streamed: an async iterable of its
         * deltas and, last, its result (SPEC 5.3).
         */
        stream: (input, options) =>
          roundStream(withMembers(input, {}), options),
      }),
      conversations: Object.freeze({
        create: async () =>
          conversation((await request("conversations.create")).id),
        open: async (id) =>
          conversation((await request("conversations.open", { id })).id),
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
    /**
     * Opens the extension's own view of this site (the toolbar popup, or the
     * settings page where the popup cannot be opened). Only in response to a
     * user action; otherwise it rejects with PERMISSION_REQUIRED.
     */
    openSettings: () => request("settings.open"),
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
        // A hosted external loop (SPEC 15.1) is one page function; the site's
        // own models (15.2) may carry one that answers their rounds.
        const loop = manifest.loop ?? null;
        if (
          loop != null &&
          (typeof loop !== "object" ||
            Array.isArray(loop) ||
            typeof loop.fetch !== "function")
        )
          throw errorFrom({
            code: "INVALID_REQUEST",
            message: "loop.fetch must be a function.",
          });
        const models = manifest.models ?? null;
        if (
          models != null &&
          (typeof models !== "object" ||
            Array.isArray(models) ||
            (models.generate != null && typeof models.generate !== "function"))
        )
          throw errorFrom({
            code: "INVALID_REQUEST",
            message: "models.generate must be a function.",
          });
        const threads = manifest.threads ?? null;
        // With a loop the thread routes are the loop's (SPEC 15.1): `threads`
        // only declares that it answers them, so no callback is required.
        if (threads != null && loop) {
          if (
            threads !== true &&
            (typeof threads !== "object" || Array.isArray(threads))
          )
            throw errorFrom({
              code: "INVALID_REQUEST",
              message: "With a loop, threads must be true or { rename }.",
            });
        } else if (threads != null) {
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
          loop: _loop,
          models: _models,
          ...serializable
        } = manifest;
        const wire = {
          ...serializable,
          tools: (manifest?.tools ?? []).map(
            ({ handler, ...definition }) => definition,
          ),
          ...(threads
            ? {
                threads: {
                  rename: loop
                    ? threads !== true && Boolean(threads.rename)
                    : typeof threads.rename === "function",
                },
              }
            : {}),
          ...(loop
            ? {
                loop: {
                  composer: loop.composer,
                  level: loop.level,
                  ...(loop.inputs !== undefined ? { inputs: loop.inputs } : {}),
                },
              }
            : {}),
          ...(models
            ? {
                models: {
                  list: models.list,
                  generate: typeof models.generate === "function",
                },
              }
            : {}),
        };
        const result = await request("site.register", { id, manifest: wire });
        clearPendingToolInputs("Assistant registration changed.");
        abortPageCalls();
        handlers.clear();
        for (const tool of manifest?.tools ?? [])
          if (typeof tool.handler === "function")
            handlers.set(tool.name, tool.handler);
        activeRegistration = id;
        controlListener = onControlChange ?? null;
        cardActionListener = onCardAction ?? null;
        threadStore = loop ? null : threads;
        loopFetch = loop ? loop.fetch.bind(loop) : null;
        siteGenerate =
          typeof models?.generate === "function"
            ? models.generate.bind(models)
            : null;
        controlValues = result.controls ?? {};
        return Object.freeze({
          id: result.id,
          unregister: async () => {
            if (activeRegistration !== id) return false;
            const removed = await request("site.unregister", { id });
            if (removed && activeRegistration === id) {
              clearPendingToolInputs("Assistant registration ended.");
              abortPageCalls();
              handlers.clear();
              activeRegistration = null;
              controlListener = null;
              cardActionListener = null;
              threadStore = null;
              loopFetch = null;
              siteGenerate = null;
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
  window.addEventListener("pagehide", () => {
    clearPendingToolInputs("The page closed.");
    abortPageCalls();
  });
})();
