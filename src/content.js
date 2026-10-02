(() => {
  "use strict";
  const CHANNEL = "arjunah-v0.1";
  const R = ArjunahRenderer;
  const H = ArjunahHosted;
  const nonce = crypto.randomUUID();
  const toolPending = new Map();
  const pagePending = new Map();
  // Bridge ids of this document's `models.generate` calls still in flight: the
  // only ids a page `cancel` may name (SPEC 10).
  const generating = new Set();
  // The streamed ones among them (SPEC 5.3), with the text each has carried
  // so far: the only ids a round delta may be posted under.
  const streaming = new Map();
  // Whether this document ever called `models.generate`, so the broker knows
  // whether the document may have provider state to release (SPEC 5.4).
  let generated = false;
  const REQUEST_ID = /^[A-Za-z0-9-]{1,100}$/;
  // Mirrors src/lib/errors.js: codes whose failure is transient (SPEC 9).
  const RETRYABLE = new Set(["TIMEOUT", "RATE_LIMITED"]);
  const IMAGE_TYPES = R.IMAGE_TYPES;
  const HISTORY_LIMIT = 40;
  // A round stream's bounds (SPEC 5.3): one delta, and each text per round,
  // which is the result's own answer and reasoning bound.
  const ROUND_DELTA_UNITS = 4000;
  const ROUND_TEXT_UNITS = { output: 120000, reasoning: 12000 };
  let registration = null,
    view = null,
    host,
    root,
    panel,
    launcher,
    contextToggle,
    statusLine,
    contextGlance;
  let accessQueue = Promise.resolve();
  let pendingConsent = null;
  let panelEpoch = 0;
  let alive = true;
  let settings = null; // hosted.settings result: site model, switchable models, usage
  let live = null; // the running turn's latest model placement and loaded context
  let settingsAt = 0; // when `settings` was last read
  let pendingModel = null; // model chosen in the header before any grant exists
  let pendingReasoning = null; // and the effort chosen with it
  let controls = {};
  let session = { promptTokens: 0, completionTokens: 0, turns: 0 };
  let lastTurn = null;
  let conversationId = crypto.randomUUID(); // one agent thread per panel conversation
  let statePort = null;
  let stateRefreshTimer = null;
  let settingsRequest = 0;
  let threadsAttached = null; // which thread host is attached, if any
  let grantRevision = null; // the last grant.state revision, once read
  let grantCheck = Promise.resolve();
  let grantCheckTimer = null;
  // Hosted external loop (SPEC 15.1): `loop.fetch` calls in flight, the
  // rounds the extension is answering for the loop by broker request id,
  // the conversation minted per loop thread, the thread id used when the
  // manifest declares no thread routes, and the turn running now.
  const loopCalls = new Map();
  const loopRounds = new Map();
  const loopConversations = new Map();
  let loopLocalThread = crypto.randomUUID().replace(/-/g, "");
  let loopTurn = null;
  // Rounds of the site's own model (SPEC 15.2): broker id -> page call id.
  const siteRounds = new Map();
  // Approval and collected-input prompts open one at a time, in order.
  let promptChain = Promise.resolve();

  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("page-api.js");
  script.dataset.arjunahNonce = nonce;
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  function runtime(method, params = {}) {
    return new Promise((resolve, reject) =>
      chrome.runtime.sendMessage(
        { kind: "arjunah", method, params: { ...params, _session: nonce } },
        (reply) => {
          if (chrome.runtime.lastError)
            return reject(
              aiError("INTERNAL_ERROR", "The extension is unavailable."),
            );
          if (!reply?.ok)
            return reject(
              aiError(
                reply?.error?.code,
                reply?.error?.message,
                reply?.error?.details,
              ),
            );
          resolve(reply.result);
        },
      ),
    );
  }
  function connectStateStream() {
    if (!alive || statePort) return;
    try {
      const port = chrome.runtime.connect({ name: "arjunah-state" });
      statePort = port;
      port.onMessage.addListener((message) => {
        if (message?.kind !== "arjunah-state") return;
        clearTimeout(stateRefreshTimer);
        stateRefreshTimer = setTimeout(() => void refreshSettings(), 50);
        // The usage ledger moves on every reply and never changes a grant.
        if (message.reason !== "storage:usage") {
          clearTimeout(grantCheckTimer);
          grantCheckTimer = setTimeout(checkGrant, 50);
        }
      });
      port.onDisconnect.addListener(() => {
        if (statePort === port) statePort = null;
        if (alive) setTimeout(connectStateStream, 500);
      });
    } catch {
      if (alive) setTimeout(connectStateStream, 1000);
    }
  }
  /**
   * `arjunah:grantchange` (SPEC 3): this origin's grant or site model changed,
   * on whatever surface did it. The broker answers only for the sender's own
   * origin, and the page gets only `level`, `model`, and `revoked`. The first
   * read is the baseline and announces nothing.
   */
  function checkGrant() {
    grantCheck = grantCheck.then(async () => {
      if (!alive) return;
      let state;
      try {
        state = await runtime("grant.state");
      } catch {
        return;
      }
      if (!alive) return;
      const revision = String(state?.revision ?? "");
      if (grantRevision !== null && revision !== grantRevision)
        toPage({
          kind: "grantchange",
          detail: {
            level: state.revoked ? null : (state.level ?? null),
            model: state.revoked ? null : (state.model ?? null),
            revoked: state.revoked === true,
          },
        });
      grantRevision = revision;
    });
  }
  function aiError(
    code = "INTERNAL_ERROR",
    message = "The AI request failed.",
    details,
  ) {
    const error = new Error(message);
    error.name = "AIError";
    error.code = code;
    if (details !== undefined) error.details = details;
    return error;
  }
  function toPage(payload) {
    window.postMessage(
      {
        channel: CHANNEL,
        direction: "extension-to-page",
        nonce,
        ...payload,
      },
      "*",
    );
  }
  /**
   * Calls one of the page's local manifest functions (card actions and thread
   * storage) across the bridge, bounded like every other page round trip.
   */
  function callPage(
    kind,
    payload,
    timeoutMs = 30000,
    id = crypto.randomUUID(),
  ) {
    if (!registration)
      return Promise.reject(aiError("TOOL_ERROR", "No assistant is active."));
    const active = registration;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pagePending.delete(id);
        reject(aiError("TIMEOUT", "The site did not answer in time."));
      }, timeoutMs);
      pagePending.set(id, {
        resolve,
        reject,
        timer,
        registrationId: active.id,
      });
      toPage({ kind, id, registrationId: active.id, ...payload });
    });
  }
  function rejectPageCalls(message) {
    for (const entry of pagePending.values()) {
      clearTimeout(entry.timer);
      entry.reject(aiError("TOOL_ERROR", message));
    }
    pagePending.clear();
  }
  function validToolResult(value, outputContent = []) {
    let encoded;
    try {
      encoded = JSON.stringify(value);
    } catch {
      return false;
    }
    if (encoded === undefined) return false;
    if (!outputContent.length)
      return new TextEncoder().encode(encoded).byteLength <= 65536;
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.kind !== "content" ||
      !Array.isArray(value.content) ||
      !value.content.length ||
      value.content.length > 8
    )
      return false;
    let images = 0;
    let cards = 0;
    let text = false;
    for (const part of value.content) {
      if (part?.type === "text") {
        if (
          !outputContent.includes("text") ||
          typeof part.text !== "string" ||
          part.text.length > 12000
        )
          return false;
        text ||= part.text.trim().length > 0;
      } else if (part?.type === "image") {
        if (
          !outputContent.includes("image") ||
          ++images > 4 ||
          !IMAGE_TYPES.includes(part.mediaType) ||
          typeof part.data !== "string" ||
          part.data.length > 2000000 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(part.data)
        )
          return false;
      } else if (part?.type === "card") {
        // Shape only here; the broker runs the full section 7.4 validator.
        if (
          !outputContent.includes("card") ||
          ++cards > 1 ||
          !part.card ||
          typeof part.card !== "object" ||
          part.card.type !== "card"
        )
          return false;
      } else return false;
    }
    return (!images && !cards) || text;
  }
  /**
   * Every page-visible error carries the bridge id it answers and whether the
   * same request may succeed if sent again (SPEC 9), beside whatever members
   * the broker already put in `details`.
   */
  function respond(id, ok, value) {
    const code = value?.code ?? "INTERNAL_ERROR";
    const own =
      value?.details &&
      typeof value.details === "object" &&
      !Array.isArray(value.details)
        ? value.details
        : {};
    toPage({
      kind: "response",
      id,
      ok,
      ...(ok
        ? { result: value }
        : {
            error: {
              code,
              message: value?.message ?? "The AI request failed.",
              details: {
                ...own,
                requestId: typeof id === "string" ? id.slice(0, 100) : null,
                retryable:
                  typeof own.retryable === "boolean"
                    ? own.retryable
                    : RETRYABLE.has(code),
              },
            },
          }),
    });
  }

  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (
      event.source !== window ||
      data?.channel !== CHANNEL ||
      data?.direction !== "page-to-extension" ||
      data?.nonce !== nonce
    )
      return;
    if (data.kind === "tool-result") {
      const pending = toolPending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      toolPending.delete(data.id);
      data.ok && validToolResult(data.result, pending.outputContent)
        ? pending.resolve(data.result)
        : pending.reject(
            aiError("TOOL_ERROR", data.error?.message ?? "Site tool failed."),
          );
      return;
    }
    if (data.kind === "page-result") {
      const pending = pagePending.get(data.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pagePending.delete(data.id);
      data.ok
        ? pending.resolve(data.result)
        : pending.reject(
            aiError("TOOL_ERROR", data.error?.message ?? "The site failed."),
          );
      return;
    }
    if (
      data.kind === "loop-head" ||
      data.kind === "loop-chunk" ||
      data.kind === "loop-end"
    ) {
      // One `loop.fetch` answer arriving in pieces (SPEC 15.1), accepted only
      // for a call this document made under the registration still active.
      const call = typeof data.id === "string" ? loopCalls.get(data.id) : null;
      if (!call || call.active !== registration) return;
      if (data.kind === "loop-head") call.head(data);
      else if (data.kind === "loop-chunk") call.chunk(data.text);
      else call.end(data.error);
      return;
    }
    if (data.kind === "tool-progress") {
      // Ephemeral by contract (SPEC 7.5): shown, never stored or sent onward.
      const pending = toolPending.get(data.invocation);
      if (!pending || ++pending.progressReports > 50) return;
      view?.applyEvent({
        type: "progress",
        turnId: view.currentTurn()?.id,
        toolId: pending.callId,
        text: String(data.text ?? "").slice(0, 200),
      });
      return;
    }
    if (data.kind === "tool-input-request") {
      const pending = toolPending.get(data.invocation);
      const definition = pending?.userInputs?.find(
        (item) => item.id === data.inputId,
      );
      const fail = (message) =>
        toPage({
          kind: "tool-input-result",
          id: data.id,
          ok: false,
          error: message,
        });
      if (!pending || !definition)
        return fail("This input was not declared for the active tool.");
      if (++pending.inputRequests > 4)
        return fail("This tool requested too many user inputs.");
      try {
        const value = await showToolInput(pending.name, definition);
        toPage({
          kind: "tool-input-result",
          id: data.id,
          ok: true,
          value,
        });
      } catch (error) {
        fail(error?.message ?? "The user cancelled.");
      }
      return;
    }
    if (data.kind === "cancel") {
      // The page aborted a generate it started here; the broker ends the turn
      // and the provider request with it. The page already settled its own
      // promise, so nothing is answered.
      if (typeof data.id === "string" && generating.has(data.id))
        void runtime("models.cancel", { request: data.id }).catch(() => {});
      return;
    }
    if (data.kind !== "request") return;
    try {
      respond(
        data.id,
        true,
        await handlePageRequest(data.method, data.params ?? {}, data.id),
      );
    } catch (error) {
      respond(data.id, false, error);
    }
  });

  async function handlePageRequest(method, params, requestId) {
    if (method === "enable") return enableAccess(params);
    if (method === "permissions.query") return runtime("grant.query");
    if (method === "permissions.revoke") return runtime("grant.revoke");
    if (method === "settings.open") {
      // Only in answer to the user (SPEC 3): a click or key press the page
      // is still handling, which this isolated world can see but not fake.
      if (navigator.userActivation?.isActive !== true)
        throw aiError(
          "PERMISSION_REQUIRED",
          "openSettings() works only in response to a user action such as a click.",
        );
      return runtime("ui.openSettings");
    }
    if (method === "models.list") return runtime("models.list");
    if (method === "providers.list") return runtime("providers.list");
    if (method === "models.generate" || method === "models.stream") {
      // The bridge id travels with the call so a later cancel can name it,
      // and so the broker's log line for it matches the page's error details.
      const id =
        typeof requestId === "string" && REQUEST_ID.test(requestId)
          ? requestId
          : null;
      // A stream is a generate whose deltas are posted under its id before
      // the answer; without a usable id there is nothing to post them under.
      const stream = method === "models.stream" && id !== null;
      if (id) generating.add(id);
      if (stream) streaming.set(id, { output: 0, reasoning: 0 });
      generated = true;
      try {
        return await runtime("models.generate", {
          ...params,
          _request: id ?? undefined,
          _stream: stream,
        });
      } finally {
        if (id) generating.delete(id);
        if (id) streaming.delete(id);
      }
    }
    // Conversations are minted and verified by the broker (SPEC 5.4); only
    // the id crosses, never anything the broker keeps for it.
    if (method === "conversations.create")
      return runtime("conversations.create");
    if (method === "conversations.open" || method === "conversations.release")
      return runtime(method, { id: params.id });
    if (method === "context.get") {
      await runtime("context.authorize", params);
      return snapshot(params.fields);
    }
    if (method === "site.register") {
      const validated = await runtime("site.register", params);
      const replaced = registration?.id && registration.id !== validated.id;
      cancelSession();
      releaseLoopConversations();
      conversationId = crypto.randomUUID();
      registration = {
        id: validated.id,
        manifest: validated.manifest,
        fingerprint: validated.fingerprint,
      };
      controls = defaultControls(validated.manifest.widget.controls);
      ensureUi();
      if (replaced) view.clear();
      syncLauncher();
      applyManifest();
      // The page only finishes wiring its thread callbacks once register()
      // resolves, so the first read of its store waits for the next task.
      if (validated.manifest.threads)
        setTimeout(() => {
          if (registration?.id === validated.id) void view.refreshThreads();
        }, 0);
      // Warm the wallet's answer now, while the panel is still shut. Waiting
      // until openPanel() meant the model picker drew itself empty and filled
      // in a second later, every single time the widget was opened.
      void refreshSettings();
      if (registration.manifest.widget.autoShow) openPanel();
      return { id: validated.id, controls: { ...controls } };
    }
    if (method === "site.unregister") {
      if (registration?.id !== params.id) return false;
      cancelSession();
      releaseLoopConversations();
      conversationId = crypto.randomUUID();
      registration = null;
      controls = {};
      if (view) {
        view.clear();
        view.setOptions({ controls: [], suggestions: [] });
      }
      if (panel) panel.hidden = true;
      syncLauncher();
      return true;
    }
    if (method === "chat.open") {
      ensureUi();
      openPanel();
      return true;
    }
    if (method === "chat.close") {
      if (panel) panel.hidden = true;
      syncLauncher();
      return true;
    }
    if (method === "chat.getControls") return { ...controls };
    if (method === "chat.setControls") {
      if (!registration)
        throw aiError("INVALID_REQUEST", "No assistant is registered.");
      const values = params.values;
      if (!values || typeof values !== "object" || Array.isArray(values))
        throw aiError("INVALID_REQUEST", "Control values must be an object.");
      for (const control of registration.manifest.widget.controls) {
        if (!Object.hasOwn(values, control.id) || control.type === "button")
          continue;
        const value = values[control.id];
        if (control.type === "toggle" && typeof value !== "boolean")
          throw aiError(
            "INVALID_REQUEST",
            `Control ${control.id} expects a boolean.`,
          );
        if (
          control.type === "select" &&
          !control.options.some((option) => option.value === value)
        )
          throw aiError(
            "INVALID_REQUEST",
            `Control ${control.id} received an unknown option.`,
          );
        controls[control.id] = value;
      }
      view?.setControls(controls);
      return { ...controls };
    }
    throw aiError(
      "NOT_SUPPORTED",
      "The requested AI operation is not supported.",
    );
  }

  function defaultControls(list) {
    const values = {};
    for (const control of list ?? [])
      if (control.type !== "button") values[control.id] = control.default;
    return values;
  }

  function cancelSession() {
    panelEpoch++;
    pendingConsent?.(false);
    view?.cancelUserInput("The page or assistant changed.");
    view?.cancelApproval();
    endLoopTurn(loopTurn);
    abortLoopCalls();
    for (const pending of toolPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(aiError("TOOL_ERROR", "The page or assistant changed."));
    }
    toolPending.clear();
    rejectPageCalls("The page or assistant changed.");
    void runtime("session.end", {
      conversationId,
      ...(generated ? { generated: true } : {}),
    }).catch(() => {});
  }
  window.addEventListener("pagehide", () => {
    alive = false;
    statePort?.disconnect();
    statePort = null;
    cancelSession();
  });
  window.addEventListener("pageshow", () => {
    alive = true;
    connectStateStream();
    // A grant can change while the document sits in the back/forward cache.
    checkGrant();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && panel && !panel.hidden)
      void refreshSettings();
  });
  connectStateStream();
  checkGrant();

  function assertRegistration(contract) {
    if (!alive || (contract && registration !== contract))
      throw aiError(
        "PERMISSION_REQUIRED",
        "The assistant changed. Start a new request.",
      );
  }

  /**
   * `mode` describes the panel's own requests for the consent sheet (SPEC
   * 15.3): `{ loop, siteModel }`, the manifest's loop and the site model the
   * visitor picked, if any. A page's own `enable()` passes none.
   */
  function enableAccess(
    raw,
    resources = {},
    contract = null,
    tools = null,
    preparedId = null,
    mode = null,
  ) {
    const next = accessQueue.then(() =>
      enableAccessNow(raw, resources, contract, tools, preparedId, mode),
    );
    accessQueue = next.catch(() => undefined);
    return next;
  }

  async function enableAccessNow(
    raw,
    resources,
    contract,
    tools,
    preparedId,
    mode,
  ) {
    assertRegistration(contract);
    const request = await runtime("grant.preview", raw);
    const current = await runtime("grant.details");
    assertRegistration(contract);
    const missingCapability = request.capabilities.some(
      (item) => !current?.capabilities?.includes(item),
    );
    const missingContext = request.context.some(
      (item) => !current?.context?.includes(item),
    );
    const missingMcpOrigin = (resources.mcpOrigins ?? []).some(
      (item) => !current?.resources?.mcpOrigins?.includes(item),
    );
    const missingContract =
      resources.contractFingerprint &&
      !current?.resources?.contractFingerprints?.includes(
        resources.contractFingerprint,
      );
    const missingTools =
      resources.toolFingerprint &&
      !current?.resources?.toolFingerprints?.includes(
        resources.toolFingerprint,
      );
    // A changed `require` (SPEC 4) asks again, since the site model may no
    // longer qualify; a request without one keeps the stored constraint.
    const changedRequire =
      Object.hasOwn(request, "require") &&
      requireKey(request.require) !== requireKey(current?.require);
    // Who composes the site's rounds changes what consent said (SPEC 15.3),
    // so a request naming another composer than the grant's asks again.
    const changedComposer =
      request.capabilities.includes("models.generate") &&
      current?.capabilities?.includes("models.generate") &&
      (request.composer ?? "webapp") !== (current?.composer ?? "webapp");
    if (
      !missingCapability &&
      !missingContext &&
      !missingMcpOrigin &&
      !missingContract &&
      !missingTools &&
      !changedRequire &&
      !changedComposer
    )
      return runtime("grant.query");
    const status = await runtime("broker.status", {
      model: pendingModel ?? undefined,
      ...(Object.hasOwn(request, "require")
        ? { require: request.require }
        : {}),
    }).catch(() => null);
    assertRegistration(contract);
    const answer = await showConsent(
      request,
      current,
      contract?.manifest,
      tools,
      status,
      mode,
    );
    if (answer.unavailable)
      throw aiError(
        "NOT_CONFIGURED",
        "None of the user's models is one this site accepts.",
      );
    if (!answer.allowed)
      throw aiError("USER_DENIED", "The user denied this AI access request.");
    assertRegistration(contract);
    const grant = await runtime("grant.approve", {
      ...request,
      _resources: resources,
      registrationId: contract?.id,
      preparedId,
      ...(answer.model ? { model: answer.model } : {}),
      // The visitor's choice between the site's own models and theirs (SPEC
      // 15.2) is stored with the grant, so it holds across this origin.
      ...(mode?.siteModel
        ? { siteModel: mode.siteModel.id }
        : contract?.manifest.models
          ? { siteModel: null }
          : {}),
      // The consent sheet has no thinking control; this is the effort the user
      // set in the widget header before the site had a grant to store it on.
      ...(pendingReasoning ? { reasoning: pendingReasoning } : {}),
      ...(answer.providers ? { providers: answer.providers } : {}),
    });
    pendingModel = null;
    pendingReasoning = null;
    void refreshSettings();
    return grant;
  }

  /**
   * A normalized `require`, or none, as a comparable string. Built member by
   * member: a stored grant comes back with its keys in another order.
   */
  function requireKey(value) {
    if (!value || typeof value !== "object" || !Object.keys(value).length)
      return "";
    return JSON.stringify([
      Array.isArray(value.kinds) ? [...value.kinds].sort() : null,
      value.local === true,
      value.builtinTools === false,
    ]);
  }
  /** The site's constraint in the words the consent sheet uses. */
  function describeRequire(value) {
    const kinds = {
      "api-key": "API-key providers",
      subscription: "subscriptions on this computer",
      "self-hosted": "servers you run",
    };
    return [
      ...(value.kinds
        ? [`only ${value.kinds.map((kind) => kinds[kind]).join(" or ")}`]
        : []),
      ...(value.local
        ? ["only models running on this computer or your own network"]
        : []),
      ...(value.builtinTools === false
        ? ["no AI agent that runs tools of its own"]
        : []),
    ].join("; ");
  }

  const WALLET_CHROME = `<label class="context-toggle compose-control" title="Share page context"><input type="checkbox" aria-label="Share page context"><span>@</span></label>`;

  /**
   * The launcher wears the extension's own icon (`src/icons/arjunah.svg`), inlined
   * rather than loaded from the extension so a page can never read our id off an
   * image request. The mark carries its own background, so the button is the icon.
   */
  const LAUNCHER_HTML = `<button class="launcher" hidden title="Open \u0905\u0930\u094D\u091C\u0941\u0928\u0903" aria-label="Open \u0905\u0930\u094D\u091C\u0941\u0928\u0903"><svg viewBox="0 0 128 128" width="54" height="54" aria-hidden="true" focusable="false"><defs><linearGradient id="arjunah-bg" x1="15" y1="9" x2="111" y2="121" gradientUnits="userSpaceOnUse"><stop stop-color="#172A72"/><stop offset="0.52" stop-color="#2358C9"/><stop offset="1" stop-color="#102153"/></linearGradient><linearGradient id="arjunah-cyan" x1="27" y1="29" x2="97" y2="99" gradientUnits="userSpaceOnUse"><stop stop-color="#72F4FF"/><stop offset="1" stop-color="#24B9F2"/></linearGradient><linearGradient id="arjunah-gold" x1="51" y1="91" x2="92" y2="38" gradientUnits="userSpaceOnUse"><stop stop-color="#FF9B39"/><stop offset="1" stop-color="#FFD268"/></linearGradient></defs><rect width="128" height="128" rx="29" fill="url(#arjunah-bg)"/><path d="M26 64C39 37 67 25 96 31C83 38 75 51 72 66C68 82 57 94 40 99C47 85 47 74 42 63C38 71 33 77 27 80" fill="none" stroke="url(#arjunah-cyan)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><path d="M45 83L73 47" fill="none" stroke="url(#arjunah-gold)" stroke-width="6" stroke-linecap="round"/><path d="M69 44L91 37L82 58Z" fill="url(#arjunah-gold)"/><circle cx="28" cy="64" r="4.5" fill="#70F3FF"/><circle cx="40" cy="99" r="4.5" fill="#70F3FF"/><circle cx="96" cy="31" r="4.5" fill="#FFD268"/></svg></button>`;
  function ensureUi() {
    if (host) return;
    host = document.createElement("div");
    host.id = "arjunah-extension";
    for (const [key, value] of Object.entries({
      all: "initial",
      position: "fixed",
      inset: "0",
      "z-index": "2147483647",
      "pointer-events": "none",
    }))
      host.style.setProperty(key, value, "important");
    root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    // Wallet-only chrome: the line a panel driven by another composer carries.
    style.textContent = `${R.STYLE}\n.loop-line{display:block;margin:6px 4px 0;font-size:11.5px;line-height:1.4;color:var(--muted)}.loop-line[hidden]{display:none}`;
    root.append(style);
    root.append(R.build(document, LAUNCHER_HTML));
    // The renderer owns the conversation; the extension keeps consent, the
    // provider pickers and usage, which have no meaning outside wallet mode.
    view = R.createChatView({ document, host: walletHost() });
    root.append(view.panel);
    view.refs.composeLeftSlot.append(R.build(document, WALLET_CHROME));
    view.refs.composeRightSlot.append(
      R.build(
        document,
        `<details class="telemetry"><summary title="Context and usage" aria-label="Context and usage"><span class="usage-ring"></span></summary><div class="status"></div></details>`,
      ),
    );
    view.refs.composerFootSlot.append(
      R.build(
        document,
        `<span class="loop-line" role="note" hidden></span><button class="context-glance" title="Open context and usage details"><span>Context window<em class="processor" hidden></em></span><span class="context-track"><i></i></span><strong>—</strong></button>`,
      ),
    );
    panel = view.panel;
    launcher = root.querySelector(".launcher");
    contextToggle = panel.querySelector(".context-toggle input");
    statusLine = panel.querySelector(".status");
    contextGlance = panel.querySelector(".context-glance");
    launcher.addEventListener("click", openPanel);
    contextGlance.addEventListener("click", () => {
      const details = panel.querySelector(".telemetry");
      details.open = !details.open;
    });
    document.documentElement.appendChild(host);
  }

  /** Everything the shared renderer asks the wallet to do. */
  function walletHost() {
    return {
      // A manifest `loop` composes the turn itself (SPEC 15.1).
      submit: (content, context) =>
        registration?.manifest.loop
          ? runLoopTurn(content, context)
          : runTurn(content, context),
      stop() {
        // The loop learns of the stop on its own cancel route (SPEC 14.4).
        const stopping = loopTurn;
        if (stopping?.turnId)
          void loopJson(`${loopTurnPath(stopping, "cancel")}`, {
            method: "POST",
            body: "{}",
          }).catch(() => {});
        if (stopping) stopping.stopped = true;
        cancelSession();
        view.finishActivity(false);
        view.setBusy(false);
        view.addBubble("assistant", "Stopped.", { persist: false });
      },
      close: syncLauncher,
      reset() {
        cancelSession();
        if (registration?.manifest.loop) {
          // A loop thread the extension named itself ends with the panel's
          // conversation; with thread routes the renderer starts a new one.
          releaseLoopConversation(loopLocalThread);
          loopLocalThread = crypto.randomUUID().replace(/-/g, "");
          if (registration.manifest.threads) void view.newThread();
        }
        conversationId = crypto.randomUUID();
        lastTurn = null;
        live = null;
        session = { promptTokens: 0, completionTokens: 0, turns: 0 };
        renderStatus();
      },
      controlChange(id, value, values) {
        controls = { ...values };
        if (!registration) return;
        toPage({
          kind: "control-change",
          registrationId: registration.id,
          id,
          value,
          values: { ...controls },
        });
      },
      modelLabel: (id) =>
        [...(settings?.models ?? []), ...siteEntries()].find(
          (model) => model.id === id,
        )?.displayName ?? id,
      // The wallet resolves provider artwork once, from the one table in
      // lib/provider-icons.js, and ships it with the model list. A content
      // script cannot import that module, and a second copy of the table here
      // is exactly how the popup and the picker drift apart.
      modelIcon: ({ id, providerId }) =>
        settings?.models?.find(
          (model) => model.id === id || model.providerId === providerId,
        )?.icon ?? null,
      // The renderer drew the choice already; the wallet decides whether it
      // stands, and a false answer puts the previous model back (SPEC 8.2).
      modelChanged({ model, reasoning }) {
        return switchModel(model, reasoning);
      },
      busyChanged() {
        renderSetup();
      },
      async cardAction(detail) {
        // A loop's cards post their local actions to its actions route
        // (SPEC 14.4); otherwise the manifest callback answers.
        const card = registration?.manifest.loop
          ? ((
              await loopJson(
                `threads/${encodeURIComponent(view.activeThread() ?? loopLocalThread)}/actions`,
                { method: "POST", body: JSON.stringify(detail) },
              ).catch(() => null)
            )?.card ?? null)
          : await callPage("card-action", { action: detail }).catch(() => null);
        if (!card) return null;
        // Page-authored replacements go through the same section 7.4 validator
        // as the original card before anything is drawn.
        return runtime("cards.validate", {
          card,
          fingerprint: registration?.fingerprint,
        }).catch(() => null);
      },
      threadChanged(id) {
        const previous = conversationId;
        conversationId = crypto.randomUUID();
        if (!view?.isBusy())
          void runtime("thread.end", { conversationId: previous }).catch(
            () => {},
          );
        void id;
      },
      threads: null,
    };
  }

  /** The site's thread callbacks, validated before anything reaches the model. */
  function siteThreads() {
    const call = (method, args) =>
      callPage("thread-call", { method, args }, 30000);
    return {
      list: async () => threadSummaries(await call("list", [])),
      create: async () => threadSummary(await call("create", [])),
      load: async (id) => transcriptEntries(await call("load", [id])),
      append: async (id, entries) => {
        await call("append", [id, entries.map(wireEntry)]);
      },
      rename: registration?.manifest.threads?.rename
        ? async (id, title) => {
            await call("rename", [id, String(title).slice(0, 120)]);
          }
        : undefined,
      remove: async (id) => {
        await call("delete", [id]);
        void runtime("thread.end", { conversationId }).catch(() => {});
      },
    };
  }
  const THREAD_ID = /^[A-Za-z0-9_-]{1,100}$/;
  function threadSummary(value) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.id !== "string" ||
      !THREAD_ID.test(value.id)
    )
      throw aiError("INVALID_REQUEST", "The site returned an invalid thread.");
    return {
      id: value.id,
      title: String(value.title ?? "").slice(0, 120),
      updatedAt:
        typeof value.updatedAt === "string"
          ? value.updatedAt.slice(0, 40)
          : new Date().toISOString(),
    };
  }
  function threadSummaries(value) {
    if (!Array.isArray(value))
      throw aiError("INVALID_REQUEST", "The site returned an invalid list.");
    return value.slice(0, 100).map(threadSummary);
  }
  /** A card from the site's own store is re-validated before it is drawn. */
  async function storedCard(card) {
    if (!card || typeof card !== "object") return null;
    return runtime("cards.validate", {
      card,
      fingerprint: registration?.fingerprint,
    }).catch(() => null);
  }
  async function transcriptEntries(value) {
    if (!Array.isArray(value))
      throw aiError(
        "INVALID_REQUEST",
        "The site returned an invalid transcript.",
      );
    const out = [];
    for (const entry of value.slice(0, 200)) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.type === "message") {
        if (!["user", "assistant"].includes(entry.role)) continue;
        const content = entryContent(entry.content);
        if (content == null) continue;
        out.push({
          type: "message",
          id: THREAD_ID.test(String(entry.id ?? ""))
            ? entry.id
            : crypto.randomUUID(),
          role: entry.role,
          content,
          ...(typeof entry.reasoning === "string"
            ? { reasoning: entry.reasoning.slice(0, 12000) }
            : {}),
          createdAt:
            typeof entry.createdAt === "string"
              ? entry.createdAt.slice(0, 40)
              : new Date().toISOString(),
        });
      } else if (entry.type === "activity" && Array.isArray(entry.steps)) {
        const steps = await Promise.all(
          entry.steps.slice(0, 32).map(async (step) => {
            if (!step || typeof step !== "object") return [];
            const card = await storedCard(step.card);
            return [
              {
                id: String(step.id ?? "").slice(0, 100),
                name: String(step.name ?? "tool").slice(0, 128),
                source: ["site", "mcp", "backend", "agent"].includes(
                  step.source,
                )
                  ? step.source
                  : "site",
                status: step.status === "error" ? "error" : "ok",
                arguments: String(step.arguments ?? "").slice(0, 2000),
                result: String(step.result ?? "").slice(0, 2000),
                ...(card ? { card } : {}),
              },
            ];
          }),
        );
        out.push({
          type: "activity",
          id: THREAD_ID.test(String(entry.id ?? ""))
            ? entry.id
            : crypto.randomUUID(),
          turnId: String(entry.turnId ?? "").slice(0, 100),
          steps: steps.flat(),
        });
      }
    }
    return out;
  }
  function entryContent(content) {
    if (typeof content === "string") return content.slice(0, 12000);
    if (!Array.isArray(content) || !content.length || content.length > 8)
      return null;
    const parts = [];
    let images = 0;
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string")
        parts.push({ type: "text", text: part.text.slice(0, 12000) });
      else if (
        part?.type === "image" &&
        ++images <= 4 &&
        IMAGE_TYPES.includes(part.mediaType) &&
        typeof part.data === "string" &&
        part.data.length <= 2000000 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(part.data)
      )
        parts.push({
          type: "image",
          mediaType: part.mediaType,
          data: part.data,
        });
    }
    return parts.length ? parts : null;
  }
  /** Only the transcript shape crosses back to the site; nothing broker-owned. */
  function wireEntry(entry) {
    if (entry.type === "activity")
      return {
        type: "activity",
        id: entry.id,
        turnId: entry.turnId,
        steps: entry.steps.map((step) => ({
          id: step.id,
          name: step.name,
          source: step.source,
          status: step.status,
          arguments: String(step.arguments ?? "").slice(0, 2000),
          result: String(step.result ?? "").slice(0, 2000),
          ...(step.card ? { card: step.card } : {}),
        })),
      };
    return {
      type: "message",
      id: entry.id,
      role: entry.role,
      content: entry.content,
      ...(entry.reasoning ? { reasoning: entry.reasoning } : {}),
      createdAt: entry.createdAt,
    };
  }

  function applyManifest() {
    if (!view) return;
    const manifest = registration?.manifest;
    const theme = manifest?.widget.theme;
    host.style.setProperty("--accent", theme?.accent ?? "#3b5bdb");
    host.style.setProperty(
      "--accent-ink",
      theme?.accent && luminance(theme.accent) > 0.6 ? "#0f172a" : "#fff",
    );
    view.setOptions({
      name: manifest?.name ?? "AI assistant",
      greeting: manifest?.widget.greeting ?? "",
      placeholder: manifest?.widget.placeholder ?? "",
      suggestions: manifest?.widget.suggestions ?? [],
      theme: theme ?? null,
      toolCallView: manifest?.widget.toolCallView ?? "compact",
      controls: manifest?.widget.controls ?? [],
    });
    view.setControls(controls);
    // Page context cannot reach a conversation the extension does not
    // compose (SPEC 15.1), so the control is not offered with a loop.
    const loop = manifest?.loop ?? null;
    const contextControl = contextToggle?.closest("label");
    if (contextControl) contextControl.hidden = Boolean(loop);
    if (loop && contextToggle) contextToggle.checked = false;
    // Site-owned threads only exist while that contract is the active one;
    // a loop's threads are its own routes.
    const wantsThreads = manifest?.threads ? (loop ? "loop" : "site") : null;
    if (wantsThreads !== threadsAttached) {
      threadsAttached = wantsThreads;
      view.setThreadHost(
        wantsThreads === "loop"
          ? loopThreads()
          : wantsThreads === "site"
            ? siteThreads()
            : null,
      );
    }
    renderLoopLine();
  }
  /**
   * The persistent line naming the composer while a loop drives this panel
   * (SPEC 15.3, "Shown in"), so the extension's chrome never implies that
   * the extension wrote the conversation.
   */
  function renderLoopLine() {
    const line = panel?.querySelector(".loop-line");
    if (!line) return;
    const loop = registration?.manifest.loop ?? null;
    line.hidden = !loop;
    line.textContent = loop
      ? H.panelLine(loop.composer, Boolean(selectedSite()))
      : "";
  }
  /** The site's own models as picker entries (SPEC 15.2). */
  function siteEntries() {
    return H.siteModelEntries(registration?.manifest);
  }
  /** The model the picker should show selected. */
  function pickerChoice() {
    return H.pickerSelection({
      pending: pendingModel,
      siteChoice: settings?.siteModel ?? null,
      visitorModel: settings?.model?.id ?? null,
      siteModels: siteEntries(),
      visitorModels: settings?.models ?? [],
    });
  }
  /** The contract's entry of the selected site model, or null. */
  function selectedSite() {
    const id = view?.selection().model ?? pickerChoice();
    return (
      registration?.manifest.models?.list.find((entry) => entry.id === id) ??
      null
    );
  }
  function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map(
      (index) => parseInt(hex.slice(index, index + 2), 16) / 255,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  async function refreshSettings() {
    const request = ++settingsRequest;
    let next;
    try {
      next = await runtime("hosted.settings");
    } catch {
      next = null;
    }
    if (request !== settingsRequest) return;
    settings = next;
    settingsAt = Date.now();
    if (!view) return;
    renderModelSelect();
    renderStatus();
    renderSetup();
  }

  /**
   * Nothing can be typed until a model can actually answer. The card names the
   * one thing to fix (pair, start the desktop app, add a provider) and links to
   * settings; it disappears as soon as a model is available.
   */
  function renderSetup() {
    if (!view) return;
    view.refs.setupWrap.textContent = "";
    // Unknown state (settings not loaded) never blocks the composer, and
    // neither does a site that answers with its own models (SPEC 15.2).
    const blocked =
      settings !== null && !settings.model && !siteEntries().length;
    view.setComposerBlocked(
      blocked,
      blocked
        ? "Finish the setup above to start chatting"
        : registration?.manifest.widget.placeholder || "Ask about this site…",
    );
    if (!blocked) return;
    const desktop = settings.desktop ?? {};
    // A broken pairing is an error, not a to-do: mark it so it reads as one.
    const broken = Boolean(
      desktop.paired && !(desktop.running && desktop.accepted),
    );
    const problem = !desktop.paired
      ? {
          title: "No provider is set up yet",
          text: "Add an API key, connect your own Ollama server, or pair अर्जुनः Desktop to use a Claude, ChatGPT/Codex, or OpenCode subscription.",
        }
      : !desktop.running
        ? {
            title: "अर्जुनः Desktop is not running",
            text: "Start it with npm run desktop, then check again.",
          }
        : !desktop.accepted
          ? {
              title: "अर्जुनः Desktop needs pairing again",
              text: "The desktop app no longer recognises this browser (its data was reset or the pairing was revoked). Pair again in settings.",
            }
          : {
              title: "No model is available",
              text: "Your paired providers report no usable model. Sign in to one on the desktop dashboard or add an API key.",
            };
    const card = document.createElement("div");
    card.className = broken ? "setup blocked" : "setup";
    const title = document.createElement("strong");
    title.textContent = problem.title;
    const text = document.createElement("p");
    text.textContent = problem.text;
    const actions = document.createElement("div");
    actions.className = "setup-actions";
    const open = document.createElement("button");
    open.className = "primary";
    open.textContent = "Open अर्जुनः settings";
    open.addEventListener("click", () => {
      void runtime("ui.openOptions").catch(() => {});
    });
    const again = document.createElement("button");
    again.textContent = "Check again";
    again.addEventListener("click", () => void refreshSettings());
    actions.append(open, again);
    card.append(title, text, actions);
    view.refs.setupWrap.append(card);
  }
  function renderModelSelect() {
    if (!view) return;
    // The site's own models sit beside the visitor's, under the site's name
    // (SPEC 15.2); they are the default only when the visitor has none.
    const sites = siteEntries();
    const current = pickerChoice();
    const site = sites.find((entry) => entry.id === current) ?? null;
    // The catalog is the wallet's; the picker that draws it is the renderer's
    // (SPEC 8.2), so this hands over data and nothing else.
    view.setModels(
      [...(settings?.models ?? []), ...sites],
      current,
      // Only the wallet knows the site's saved effort; the widget starts blank
      // and would otherwise drop the setting on every reload.
      site ? null : (pendingReasoning ?? settings?.model?.reasoning ?? null),
    );
    const active = settings?.model;
    view.refs.sub.textContent = site
      ? `${registration?.manifest.name ?? "This site"} · ${site.displayName}`
      : active
        ? `${active.providerName} · ${active.displayName}${active.fallback ? " (default)" : ""}`
        : settings?.desktop?.paired && !settings.desktop.running
          ? "अर्जुनः Desktop is not running"
          : settings?.desktop?.paired && !settings.desktop.accepted
            ? "अर्जुनः Desktop needs pairing again"
            : "No provider configured";
    // A site model without a declared `vision` refuses images (SPEC 15.2).
    const vision = Boolean(
      site
        ? site.capabilities.vision
        : ((settings?.models ?? []).find((model) => model.id === current)
            ?.capabilities.vision ?? active?.capabilities.vision),
    );
    view.setAttachmentsEnabled(vision);
    renderLoopLine();
  }

  async function switchModel(id, reasoning) {
    if (!id) return false;
    const site = siteEntries().some((entry) => entry.id === id);
    const remember = () => {
      // No usable grant yet: remember the choice for the consent dialog.
      pendingModel = id;
      pendingReasoning = site ? null : (reasoning ?? null);
      renderModelSelect();
      return true;
    };
    if (!settings?.grant) return remember();
    try {
      const before = settings?.model?.id;
      settings = await runtime("hosted.model", {
        // A site model is stored as the visitor's choice of it; choosing one
        // of the visitor's own models clears that choice (SPEC 15.2).
        ...(site
          ? { siteModel: id }
          : {
              model: id,
              reasoning: reasoning || null,
              ...(siteEntries().length ? { siteModel: null } : {}),
            }),
        fingerprint: registration?.fingerprint,
      });
      settingsAt = Date.now();
      // Placement belongs to a model; a switched one reports its own.
      if (settings?.model?.id !== before) {
        live = null;
        if (lastTurn) lastTurn.processor = null;
      }
      pendingModel = null;
      pendingReasoning = null;
      renderModelSelect();
      renderStatus();
      return true;
    } catch (error) {
      // A grant this panel cannot change yet (a loop's contract not approved)
      // keeps the choice for the next consent instead.
      if (error?.code === "PERMISSION_REQUIRED") return remember();
      view.addBubble("assistant", `Could not switch model: ${error.message}`, {
        error: true,
        persist: false,
      });
      renderModelSelect();
      return false;
    }
  }

  function renderStatus() {
    if (!statusLine) return;
    statusLine.textContent = "";
    // A site model shows only the metadata the site gave (SPEC 15.2): no
    // meter without its contextWindow, and no provider limits.
    const site = selectedSite();
    const window_ =
      live?.contextWindow ??
      lastTurn?.contextWindow ??
      (site ? site.contextWindow : settings?.model?.contextWindow);
    const contextKnown = Number.isSafeInteger(lastTurn?.contextTokens);
    const prompt = contextKnown ? lastTurn.contextTokens : 0;
    const contextPercent =
      window_ && contextKnown ? Math.min(100, (prompt / window_) * 100) : 0;
    // The size alone is worth showing while the first count is pending: a
    // self-hosted model's loaded window arrives with its first round.
    const contextText =
      window_ && contextKnown
        ? `${compactNumber(prompt)} / ${compactNumber(window_)} (${Math.round(contextPercent)}%)`
        : window_
          ? `— / ${compactNumber(window_)}`
          : "Not reported";
    const contextSection = usageSection("Context window", contextText);
    contextSection.append(
      usageBar(
        contextPercent,
        contextPercent >= 85 ? "#d97706" : "var(--accent)",
      ),
    );
    const contextRows = document.createElement("div");
    contextRows.className = "usage-rows";
    if (contextKnown)
      contextRows.append(
        usageRow("Current prompt", compactNumber(prompt), "#3b82f6"),
      );
    if (lastTurn?.contextCachedTokens)
      contextRows.append(
        usageRow(
          "Cached portion",
          compactNumber(lastTurn.contextCachedTokens),
          "#10b981",
        ),
      );
    if (window_ && contextKnown)
      contextRows.append(
        usageRow(
          "Free space",
          compactNumber(Math.max(0, window_ - prompt)),
          "#d4d4d8",
        ),
      );
    // Where a self-hosted model runs: a split onto the CPU is usually why it
    // is slow, and is the first thing to check before the context size.
    const processor = currentProcessor();
    if (processor)
      contextRows.append(
        usageRow(
          "Running on",
          processor.label,
          processor.placement === "gpu"
            ? "#10b981"
            : processor.placement === "cpu"
              ? "#d97706"
              : "#3b82f6",
        ),
      );
    contextSection.append(contextRows);
    statusLine.append(contextSection);

    if ((lastTurn && lastTurn.usageReported !== false) || session.turns) {
      const response = usageSection("Token usage", "This conversation");
      const rows = document.createElement("div");
      rows.className = "usage-rows";
      if (lastTurn && lastTurn.usageReported !== false)
        rows.append(
          usageRow(
            "Last response",
            compactNumber(lastTurn.completionTokens),
            "#8b5cf6",
          ),
        );
      if (lastTurn?.reasoningTokens)
        rows.append(
          usageRow(
            "Thinking",
            compactNumber(lastTurn.reasoningTokens),
            "#ec4899",
          ),
        );
      const historyCount = (view?.modelHistory().messages ?? []).length;
      rows.append(
        usageRow(
          "Session total",
          compactNumber(session.promptTokens + session.completionTokens),
          "#64748b",
        ),
        usageRow(
          "Hosted history",
          `${Math.min(historyCount, HISTORY_LIMIT)} / ${HISTORY_LIMIT} messages`,
          "#a1a1aa",
        ),
      );
      response.append(rows);
      statusLine.append(response);
    }

    const model = site ? null : settings?.model;
    const quota = usageSection(
      "Your usage limits",
      site
        ? (registration?.manifest.name ?? "This site")
        : model?.plan || model?.providerName || "Provider",
    );
    if (site) {
      const note = document.createElement("p");
      note.className = "usage-note";
      note.textContent =
        "This site's own model answers. Your AI and its limits are not used.";
      quota.append(note);
    } else if (model?.quota?.windows?.length) {
      for (const windowItem of model.quota.windows) {
        const percent = Math.max(
          0,
          Math.min(100, Number(windowItem.usedPercent) || 0),
        );
        const row = document.createElement("div");
        row.className = "quota-row";
        const line = document.createElement("div");
        line.className = "quota-line";
        const label = document.createElement("span");
        label.textContent = windowItem.label;
        const value = document.createElement("span");
        value.textContent = `${resetLabel(windowItem.resetsAt)}${windowItem.resetsAt ? " · " : ""}${Math.round(percent)}%`;
        line.append(label, value);
        row.append(
          line,
          usageBar(
            percent,
            percent >= 90 ? "#dc3f4f" : percent >= 70 ? "#f2a900" : "#3b82f6",
          ),
        );
        quota.append(row);
      }
    } else if (model?.quota?.limit != null || model?.quota?.used != null) {
      const used = Number(model.quota.used) || 0;
      const limit = Number(model.quota.limit) || 0;
      const percent = limit ? Math.min(100, (used / limit) * 100) : used;
      const row = document.createElement("div");
      row.className = "quota-row";
      const line = document.createElement("div");
      line.className = "quota-line";
      const label = document.createElement("span");
      label.textContent = model.quota.label || "Provider quota";
      const value = document.createElement("span");
      value.textContent = limit
        ? `${compactNumber(used)} / ${compactNumber(limit)} ${model.quota.unit ?? ""}`.trim()
        : `${compactNumber(used)} ${model.quota.unit ?? ""}`.trim();
      line.append(label, value);
      row.append(
        line,
        usageBar(percent, percent >= 90 ? "#dc3f4f" : "#3b82f6"),
      );
      quota.append(row);
    } else {
      const empty = document.createElement("p");
      empty.className = "usage-note";
      empty.textContent = model
        ? `${model.providerName} does not report account limits.`
        : "Connect a provider to see its limits.";
      quota.append(empty);
    }
    if (model?.usage?.dayRequests) {
      const note = document.createElement("p");
      note.className = "usage-note";
      note.textContent = `Today: ${Number(model.usage.dayRequests).toLocaleString()} requests · ${compactNumber((model.usage.dayPromptTokens ?? 0) + (model.usage.dayCompletionTokens ?? 0))} locally recorded tokens`;
      quota.append(note);
    }
    statusLine.append(quota);

    const glance = contextGlance;
    glance.querySelector("strong").textContent = contextText;
    glance.querySelector(".context-track i").style.width = `${contextPercent}%`;
    const marker = glance.querySelector(".processor");
    marker.hidden = !processor;
    if (processor) {
      marker.textContent =
        processor.placement === "split"
          ? `CPU+GPU ${processor.gpuPercent}%`
          : processor.placement.toUpperCase();
      marker.dataset.placement = processor.placement;
      marker.title = `The model server holds this model ${processor.label}.`;
    }
    const quotaPercent = Math.max(
      0,
      ...(model?.quota?.windows ?? []).map(
        (item) => Number(item.usedPercent) || 0,
      ),
    );
    const ringPercent = quotaPercent || contextPercent;
    const ring = panel.querySelector(".usage-ring");
    ring.style.setProperty(
      "--usage-angle",
      `${Math.min(100, ringPercent) * 3.6}deg`,
    );
    ring.style.setProperty(
      "--usage-color",
      quotaPercent >= 90
        ? "#dc3f4f"
        : quotaPercent >= 70
          ? "#f2a900"
          : "var(--accent)",
    );
  }

  const compactNumber = R.compactNumber;

  /** The broker's processor summary, re-checked before it is drawn. */
  function validProcessor(value) {
    if (
      !value ||
      !["gpu", "cpu", "split"].includes(value.placement) ||
      typeof value.label !== "string" ||
      !Number.isInteger(value.gpuPercent) ||
      value.gpuPercent < 0 ||
      value.gpuPercent > 100
    )
      return null;
    const until =
      typeof value.until === "string" &&
      Number.isFinite(Date.parse(value.until))
        ? Date.parse(value.until)
        : null;
    return {
      placement: value.placement,
      gpuPercent: value.gpuPercent,
      label: value.label.slice(0, 40),
      until,
    };
  }

  /**
   * The placement to draw: the running turn's, else whichever of the last
   * turn and the widget settings was read more recently, and none once the
   * server's own unload time has passed. A timer redraws at that moment, so a
   * model Ollama unloaded stops being shown without anything polling for it.
   */
  let processorTimer = 0;
  function currentProcessor() {
    const fromSettings = validProcessor(settings?.model?.processor);
    const candidate =
      live?.processor ??
      (lastTurn && lastTurn.at > settingsAt
        ? (lastTurn.processor ?? fromSettings)
        : fromSettings);
    clearTimeout(processorTimer);
    if (!candidate) return null;
    if (candidate.until != null) {
      const left = candidate.until - Date.now();
      if (left <= 0) return null;
      processorTimer = setTimeout(
        renderStatus,
        Math.min(left + 50, 2 ** 31 - 1),
      );
    }
    return candidate;
  }

  function usageSection(label, value) {
    const section = document.createElement("section");
    section.className = "usage-section";
    const heading = document.createElement("div");
    heading.className = "usage-heading";
    const title = document.createElement("span");
    title.textContent = label;
    const metric = document.createElement("strong");
    metric.textContent = value;
    heading.append(title, metric);
    section.append(heading);
    return section;
  }
  function usageBar(percent, color) {
    const bar = document.createElement("div");
    bar.className = "usage-bar";
    bar.style.setProperty("--bar-color", color);
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(0, Math.min(100, percent || 0))}%`;
    bar.append(fill);
    return bar;
  }
  function usageRow(label, value, color) {
    const row = document.createElement("div");
    row.className = "usage-row";
    const name = document.createElement("span");
    name.className = "label";
    const swatch = document.createElement("i");
    swatch.className = "swatch";
    swatch.style.setProperty("--row-color", color);
    name.append(swatch, label);
    const metric = document.createElement("span");
    metric.className = "value";
    metric.textContent = value;
    row.append(name, metric);
    return row;
  }
  function resetLabel(value) {
    if (!value) return "";
    const milliseconds = new Date(value).getTime() - Date.now();
    if (!Number.isFinite(milliseconds)) return "";
    if (milliseconds <= 0) return "Resets soon";
    const minutes = Math.ceil(milliseconds / 60000);
    if (minutes < 60) return `Resets in ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 48) return `Resets in ${hours} hr${rest ? ` ${rest} min` : ""}`;
    return `Resets in ${Math.ceil(hours / 24)} days`;
  }

  /**
   * The launcher and the panel are two ways into the same conversation, so only
   * one is ever offered: with the panel open the bubble is dead weight over the
   * page, and it comes back the moment the panel closes.
   */
  function syncLauncher() {
    if (launcher) launcher.hidden = !registration || !panel?.hidden;
  }
  function openPanel() {
    ensureUi();
    panel.hidden = false;
    syncLauncher();
    applyManifest();
    if (registration?.manifest.threads) void view.refreshThreads();
    void refreshSettings();
    queueMicrotask(() => view.refs.input.focus());
  }

  /** One hosted turn: consent, tool preparation, generation, rendering. */
  async function runTurn(content, context) {
    if (!registration) {
      view.addBubble(
        "assistant",
        "This site has not registered an assistant.",
        {
          persist: false,
        },
      );
      return;
    }
    view.setBusy(true);
    const contract = registration;
    const epoch = panelEpoch;
    const { manifest, fingerprint } = contract;
    const turnHistory = view.modelHistory();
    // One of the site's own models may answer (SPEC 15.2); consent says so.
    const site = selectedSite();
    const mode = { loop: null, siteModel: site };
    const capabilities = ["chat.hosted"];
    if (manifest.tools.length) capabilities.push("tools.site");
    if (manifest.mcpServers.length) capabilities.push("tools.mcp");
    const contextFields = contextToggle.checked
      ? ["title", "url", "selection", "text"]
      : [];
    if (contextFields.length) capabilities.push("context.read");
    const request = {
      capabilities,
      context: contextFields,
      reason: `${manifest.name} wants to provide an AI chat on this site.`,
    };
    const resources = {
      contractFingerprint: fingerprint,
      mcpOrigins: manifest.mcpServers.map(
        (server) => new URL(server.url).origin,
      ),
    };
    const turnId = crypto.randomUUID();
    const turnConversationId = conversationId;
    try {
      await enableAccess(request, resources, contract, null, null, mode);
      assertRegistration(contract);
      const prepared = await runtime("chat.prepare", {
        manifest,
        registrationId: contract.id,
      });
      assertRegistration(contract);
      if (manifest.mcpServers.length && !prepared.declaredOnly)
        await enableAccess(
          request,
          { ...resources, toolFingerprint: prepared.toolFingerprint },
          contract,
          prepared.tools,
          prepared.id,
          mode,
        );
      assertRegistration(contract);
      if (epoch !== panelEpoch)
        throw aiError("PERMISSION_REQUIRED", "The chat was reset.");
      view.startActivity(turnId, context?.threadId ?? null);
      const result = await runtime("chat.complete", {
        preparedId: prepared.id,
        registrationId: contract.id,
        fingerprint,
        history: turnHistory.messages,
        untrustedPrefix: turnHistory.untrustedPrefix,
        context: contextFields.length ? snapshot(contextFields) : null,
        controls: { ...controls },
        turnId,
        conversationId: turnConversationId,
        ...(site ? { siteModel: site.id } : {}),
        ...(view.selection().reasoning
          ? { reasoning: view.selection().reasoning }
          : {}),
      });
      if (registration === contract && epoch === panelEpoch) {
        const turn = view.currentTurn();
        live = null;
        // A site model that reported no usage shows none (SPEC 15.2).
        const usage = result.usage ?? null;
        lastTurn = {
          at: Date.now(),
          usageReported: usage != null,
          promptTokens: usage ? turn?.promptTokens || usage.promptTokens : 0,
          completionTokens: usage
            ? turn?.completionTokens || usage.completionTokens
            : 0,
          cachedTokens: usage?.cachedTokens ?? 0,
          contextTokens: result.contextTokens ?? null,
          contextCachedTokens: result.contextCachedTokens ?? null,
          reasoningTokens: usage?.reasoningTokens ?? 0,
          contextWindow: result.contextWindow ?? null,
          processor: validProcessor(result.processor),
        };
        session.promptTokens += lastTurn.promptTokens;
        session.completionTokens += lastTurn.completionTokens;
        session.turns++;
        const streamed = turn?.outputNode ?? null;
        const finished = view.finishActivity(true);
        if (finished?.entry) context?.record(finished.entry);
        context?.record(view.addAssistantResult(result, streamed));
        void refreshSettings();
      }
    } catch (error) {
      view.finishActivity(false);
      if (registration === contract && epoch === panelEpoch)
        view.addBubble(
          "assistant",
          `Could not complete the request: ${error.message}`,
          { error: true, persist: false },
        );
    } finally {
      view.setBusy(false);
      renderStatus();
      view.refs.input.focus();
    }
  }

  // ------------------------------------------------- hosted external loop
  //
  // SPEC 15.1: with a manifest `loop`, this panel is the section 14 renderer
  // toward a loop the page runs or relays through `loop.fetch`, and the
  // section 14.7 bridge toward the visitor's model. The extension never
  // reaches the site's server: every route goes through the page function,
  // and every answer comes back through the page bridge, bounded here.
  const LOOP_STREAM_BYTES = 2000000;
  const LOOP_JSON_BYTES = 1000000;
  // How long `loop.fetch` may take to start answering, like any page callback.
  const LOOP_HEAD_MS = 30000;
  // A turn's stream may be quiet while the loop waits on its own model or
  // tools. Past this, with nothing owed by this side, the turn ends.
  const LOOP_IDLE_MS = 180000;
  const LOOP_DELTA_UNITS = 4000;
  const LOOP_DELTA_POST = 8000;
  const CONVERSATION_ID = /^[\x21-\x7e]{1,200}$/;
  const plainObject = (value) =>
    value != null && typeof value === "object" && !Array.isArray(value);
  const boundedText = (value, max) =>
    typeof value === "string" ? value.slice(0, max) : "";
  /** The id of a loop request this side answers on a route, or null. */
  const callId = (value) =>
    typeof value === "string" && value.length > 0 && value.length <= 128
      ? value
      : null;

  /**
   * Starts one `loop.fetch` call. Resolves once the page function answered
   * with a status, to `{ status, contentType, read(), cancel() }`; `read()`
   * resolves to the next text chunk or `null` at the end, and the body is
   * held to `maxBytes` UTF-8 bytes counted here, whatever the page claims.
   */
  function loopOpen(path, init = {}, maxBytes = LOOP_JSON_BYTES) {
    const active = registration;
    if (!active?.manifest.loop)
      return Promise.reject(
        aiError("NOT_SUPPORTED", "This assistant declared no loop."),
      );
    const id = crypto.randomUUID();
    const encoder = new TextEncoder();
    return new Promise((resolve, reject) => {
      const call = {
        active,
        bytes: 0,
        queue: [],
        waiter: null,
        ended: false,
        error: null,
        headed: false,
      };
      const settleWaiter = () => {
        const waiter = call.waiter;
        if (!waiter) return;
        if (call.queue.length) {
          call.waiter = null;
          waiter.resolve(call.queue.shift());
        } else if (call.error) {
          call.waiter = null;
          waiter.reject(call.error);
        } else if (call.ended) {
          call.waiter = null;
          waiter.resolve(null);
        }
      };
      const close = () => {
        clearTimeout(call.timer);
        loopCalls.delete(id);
      };
      call.fail = (error) => {
        if (!loopCalls.has(id)) return;
        close();
        toPage({ kind: "page-call-abort", id });
        if (!call.headed) return reject(error);
        call.error ??= error;
        settleWaiter();
      };
      call.timer = setTimeout(
        () =>
          call.fail(
            aiError("TIMEOUT", "The site's loop did not answer in time."),
          ),
        LOOP_HEAD_MS,
      );
      call.head = (data) => {
        if (call.headed) return;
        if (data.ok !== true || !Number.isInteger(data.status))
          return call.fail(
            aiError(
              "TOOL_ERROR",
              `The site's loop failed: ${boundedText(data.error, 300) || "no response"}`,
            ),
          );
        clearTimeout(call.timer);
        call.headed = true;
        resolve({
          status: data.status,
          contentType: boundedText(data.contentType, 200),
          read: () =>
            new Promise((resolveRead, rejectRead) => {
              call.waiter = { resolve: resolveRead, reject: rejectRead };
              settleWaiter();
            }),
          cancel: () =>
            call.fail(aiError("ABORTED", "The request was cancelled.")),
        });
      };
      call.chunk = (text) => {
        if (!call.headed || typeof text !== "string" || !text) return;
        call.bytes += encoder.encode(text).byteLength;
        if (call.bytes > maxBytes)
          return call.fail(
            aiError(
              "PROVIDER_ERROR",
              "The site's loop answered with too much data.",
            ),
          );
        call.queue.push(text);
        settleWaiter();
      };
      call.end = (error) => {
        if (!call.headed)
          return call.fail(
            aiError(
              "TOOL_ERROR",
              `The site's loop failed: ${boundedText(error, 300) || "no response"}`,
            ),
          );
        close();
        if (typeof error === "string")
          call.error = aiError(
            "TOOL_ERROR",
            `The site's loop failed: ${error.slice(0, 300)}`,
          );
        call.ended = true;
        settleWaiter();
      };
      loopCalls.set(id, call);
      toPage({
        kind: "loop-fetch",
        id,
        registrationId: active.id,
        path: String(path),
        method: init.method ?? "GET",
        ...(init.body != null ? { body: init.body } : {}),
        maxBytes,
      });
    });
  }
  function abortLoopCalls() {
    for (const call of [...loopCalls.values()])
      call.fail(aiError("ABORTED", "The page or assistant changed."));
  }
  /** One JSON route (SPEC 14.4): bounded to 1,000,000 bytes, 204 is null. */
  async function loopJson(path, init) {
    const response = await loopOpen(path, init, LOOP_JSON_BYTES);
    if (response.status < 200 || response.status > 299) {
      response.cancel();
      throw aiError(
        "TOOL_ERROR",
        `The site's loop refused the request (${response.status}).`,
      );
    }
    let text = "";
    for (;;) {
      const chunk = await response.read();
      if (chunk == null) break;
      text += chunk;
    }
    if (response.status === 204 || !text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw aiError("TOOL_ERROR", "The site's loop returned invalid JSON.");
    }
  }
  function loopTurnPath(turn, route) {
    return `threads/${encodeURIComponent(turn.threadId)}/turns/${encodeURIComponent(turn.turnId ?? "")}/${route}`;
  }
  /** An answer on one of the turn's routes; a failure to deliver is the loop's. */
  function loopPost(turn, route, body) {
    turn.lastActivity = Date.now();
    return loopJson(loopTurnPath(turn, route), {
      method: "POST",
      body: JSON.stringify(body),
    }).catch(() => null);
  }

  /** A loop's own thread routes (SPEC 14.4), validated like a site store's. */
  function loopThreads() {
    const at = (id) => `threads/${encodeURIComponent(id)}`;
    return {
      list: async () => threadSummaries(await loopJson("threads")),
      create: async () =>
        threadSummary(
          await loopJson("threads", { method: "POST", body: "{}" }),
        ),
      load: async (id) => transcriptEntries(await loopJson(at(id))),
      // The composer stores its own turns; nothing is pushed back to it.
      append: async () => {},
      rename: registration?.manifest.threads?.rename
        ? async (id, title) => {
            await loopJson(at(id), {
              method: "PATCH",
              body: JSON.stringify({ title: String(title).slice(0, 120) }),
            });
          }
        : undefined,
      remove: async (id) => {
        await loopJson(at(id), { method: "DELETE" });
        if (loopTurn?.threadId === id) endLoopTurn(loopTurn);
        releaseLoopConversation(id);
      },
    };
  }

  /**
   * The conversation a loop round runs in (SPEC 14.7, 5.4): the one the
   * loop named when the extension verifies it for this origin, else the one
   * this panel already made for the thread, else a new one, whose id goes
   * back to the loop on `model-results`.
   */
  async function loopConversation(threadId, requested) {
    if (requested) {
      const opened = await runtime("conversations.open", {
        id: requested,
      }).catch(() => null);
      if (typeof opened?.id === "string") {
        loopConversations.set(threadId, opened.id);
        return opened.id;
      }
    }
    const known = loopConversations.get(threadId);
    if (known) return known;
    const created = await runtime("conversations.create");
    if (loopConversations.size >= 100)
      releaseLoopConversation(loopConversations.keys().next().value);
    loopConversations.set(threadId, created.id);
    return created.id;
  }
  function releaseLoopConversation(threadId) {
    const id = loopConversations.get(threadId);
    loopConversations.delete(threadId);
    if (id) void runtime("conversations.release", { id }).catch(() => {});
  }
  function releaseLoopConversations() {
    for (const threadId of [...loopConversations.keys()])
      releaseLoopConversation(threadId);
  }

  /**
   * What the first message of a loop turn asks for (SPEC 15.1): a level 1
   * grant, or level 2 when the loop asks, with the loop's composer; or, when
   * the visitor picked one of the site's own models, only the hosted panel,
   * since none of the visitor's models is used.
   */
  function loopAccess(manifest, site) {
    const reason = `${manifest.name} wants to run its assistant in this panel.`;
    return site
      ? { capabilities: ["chat.hosted"], reason }
      : {
          level: manifest.loop.level === 2 ? "catalog" : "completion",
          composer: manifest.loop.composer,
          reason,
        };
  }

  /** The turn body's `bridge` (SPEC 14.7, 15.1, 15.2). */
  async function loopAnnouncement(contract, site, turn) {
    const tools = contract.manifest.tools.slice(0, 32).map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema,
    }));
    if (site) {
      turn.entry = H.bridgeEntry(site);
      return { model: turn.entry, tools };
    }
    const list = await runtime("models.list").catch(() => null);
    const entries = Array.isArray(list) ? list : [];
    const chosen = view.selection().model;
    turn.entry =
      entries.find((entry) => entry.id === chosen) ??
      entries.find((entry) => entry.default === true) ??
      null;
    return { model: turn.entry, tools };
  }

  /** One loop turn: consent, the announcement, then the event stream. */
  async function runLoopTurn(content, context) {
    const contract = registration;
    const epoch = panelEpoch;
    const { manifest } = contract;
    view.setBusy(true);
    const site = selectedSite();
    const turn = {
      contract,
      threadId: context?.threadId ?? loopLocalThread,
      turnId: null,
      site,
      entry: null,
      done: false,
      stopped: false,
      stream: null,
      completions: new Map(),
      answered: new Set(),
      prompting: 0,
      tooling: 0,
      rounds: 0,
      lastActivity: Date.now(),
      usage: null,
      contextTokens: null,
      contextCachedTokens: null,
      contextWindow: null,
    };
    loopTurn = turn;
    try {
      await enableAccess(
        loopAccess(manifest, site),
        { contractFingerprint: contract.fingerprint, mcpOrigins: [] },
        contract,
        null,
        null,
        { loop: manifest.loop, siteModel: site },
      );
      assertRegistration(contract);
      if (epoch !== panelEpoch || turn.done)
        throw aiError("PERMISSION_REQUIRED", "The chat was reset.");
      const bridge = await loopAnnouncement(contract, site, turn);
      assertRegistration(contract);
      if (epoch !== panelEpoch || turn.done)
        throw aiError("PERMISSION_REQUIRED", "The chat was reset.");
      view.startActivity(crypto.randomUUID(), context?.threadId ?? null);
      const { model, reasoning } = view.selection();
      const response = await loopOpen(
        `threads/${encodeURIComponent(turn.threadId)}/turns`,
        {
          method: "POST",
          body: JSON.stringify({
            content,
            controls: { ...controls },
            ...(model ? { model } : {}),
            ...(reasoning ? { reasoning } : {}),
            bridge,
          }),
        },
        LOOP_STREAM_BYTES,
      );
      turn.stream = response;
      if (turn.done) return response.cancel();
      if (response.status < 200 || response.status > 299) {
        response.cancel();
        throw aiError(
          "TOOL_ERROR",
          `The site's loop refused the turn (${response.status}).`,
        );
      }
      await consumeLoop(response, turn, context);
    } catch (error) {
      view.finishActivity(false);
      if (registration === contract && epoch === panelEpoch && !turn.stopped)
        view.addBubble(
          "assistant",
          `Could not complete the request: ${turn.idled ? "the site's loop stopped answering." : error.message}`,
          { error: true, persist: false },
        );
    } finally {
      endLoopTurn(turn);
      if (loopTurn === turn) loopTurn = null;
      view.setBusy(false);
      renderStatus();
      view.refs.input.focus();
    }
  }

  /**
   * Ends a loop turn on this side: every completion it still has running is
   * cancelled, open prompts close, and the stream is let go. Nothing more is
   * posted for any of them; the loop learns of a stop on its cancel route.
   */
  function endLoopTurn(turn) {
    if (!turn || turn.done) return;
    turn.done = true;
    clearInterval(turn.idleTimer);
    for (const completion of turn.completions.values()) {
      completion.cancelled = true;
      loopRounds.delete(completion.requestId);
      void runtime("models.cancel", { request: completion.requestId }).catch(
        () => {},
      );
    }
    turn.completions.clear();
    if (turn.prompting) {
      view?.cancelUserInput("The turn ended.");
      view?.cancelApproval();
    }
    turn.stream?.cancel();
  }

  /** Reads the turn's section 14.3 stream and applies each event. */
  async function consumeLoop(response, turn, context) {
    // Silence is allowed while this side owes the loop an answer (a round of
    // the visitor's model, a site tool, a prompt) and bounded otherwise.
    turn.idleTimer = setInterval(() => {
      const owing =
        turn.completions.size || turn.tooling > 0 || turn.prompting > 0;
      if (owing) turn.lastActivity = Date.now();
      else if (Date.now() - turn.lastActivity > LOOP_IDLE_MS) {
        turn.idled = true;
        response.cancel();
      }
    }, 1000);
    let buffer = "";
    for (;;) {
      const chunk = await response.read();
      if (chunk == null) break;
      turn.lastActivity = Date.now();
      // Normalized as a whole so a CRLF split across two chunks still joins.
      buffer = `${buffer}${chunk}`.replace(/\r\n/g, "\n");
      let split;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const parsed = loopEvent(block);
        if (parsed && (await handleLoopEvent(parsed, turn, context))) return;
      }
    }
    if (turn.idled)
      throw aiError("TIMEOUT", "The site's loop stopped answering.");
    // A stream that ends without `turn.end` or `error` still ends the turn.
    endLoopTurn(turn);
    const finished = view.finishActivity(true);
    if (finished?.entry) context?.record(finished.entry);
  }
  function loopEvent(block) {
    let type = "message";
    const data = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim().slice(0, 40);
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
  /** A card from the stream, drawn only if it passes the section 7.4 validator. */
  async function loopCard(card) {
    if (!plainObject(card)) return undefined;
    return (
      (await runtime("cards.validate", {
        card,
        fingerprint: registration?.fingerprint,
      }).catch(() => null)) ?? undefined
    );
  }
  /**
   * One section 14.3 event. Only the known types are applied, each with its
   * own bounds; anything else is ignored. Returns true once the turn is over.
   */
  async function handleLoopEvent({ type, data }, turn, context) {
    if (turn.done) return true;
    // When the visitor's model answers, what the panel shows about that
    // model comes from the extension's own provider, not from the stream.
    const visitor = !turn.site;
    if (type === "turn.start") {
      turn.turnId = boundedText(data.turnId, 100) || null;
      return false;
    }
    if (type === "error") {
      endLoopTurn(turn);
      view.finishActivity(false);
      view.addBubble(
        "assistant",
        `The assistant reported an error: ${boundedText(data.message, 300) || boundedText(data.code, 40) || "unknown error"}`,
        { error: true, persist: false },
      );
      return true;
    }
    if (type === "turn.end") {
      endLoopTurn(turn);
      noteLoopTurn(turn, visitor ? null : data.usage);
      const finished = view.finishActivity(true);
      if (finished?.entry) context?.record(finished.entry);
      return true;
    }
    if (type === "message") {
      const entry = loopMessage(data.entry ?? data);
      if (entry) {
        const streamed = view.currentTurn()?.outputNode ?? null;
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
            streamed,
          ),
        );
        // The composer's message replaces a relayed round's provisional text.
        view.discardProvisional();
      }
      return false;
    }
    if (type === "tool.client") {
      void runLoopTool(data, turn);
      return false;
    }
    if (type === "model.client") {
      void runLoopCompletion(data, turn);
      return false;
    }
    if (type === "model.cancel") {
      cancelLoopCompletion(data, turn);
      return false;
    }
    if (type === "input.client") {
      void loopPrompt(turn, () => runLoopInput(data, turn));
      return false;
    }
    if (type === "approval.client") {
      void loopPrompt(turn, () => runLoopApproval(data, turn));
      return false;
    }
    const event = { turnId: undefined };
    if (type === "output.delta" || type === "reasoning.delta") {
      const text = boundedText(data.text, LOOP_DELTA_UNITS);
      if (!text) return false;
      view.applyEvent(
        type === "output.delta"
          ? { ...event, type, text }
          : { ...event, type: "agent.reasoning.delta", text },
      );
    } else if (type === "model.start")
      view.applyEvent({
        ...event,
        type,
        round: Number.isInteger(data.round) ? data.round : undefined,
        model: visitor
          ? (turn.entry?.id ?? "")
          : boundedText(data.model, 200) || turn.entry?.id || "",
      });
    else if (type === "model.end")
      view.applyEvent({
        ...event,
        type,
        round: Number.isInteger(data.round) ? data.round : undefined,
        toolCalls: Number.isInteger(data.toolCalls) ? data.toolCalls : 0,
        ...(visitor ? {} : { usage: loopUsage(data.usage) ?? undefined }),
      });
    else if (type === "model.stalled")
      view.applyEvent({
        ...event,
        type,
        round: Number.isInteger(data.round) ? data.round : undefined,
      });
    else if (type === "agent.phase" || type === "progress")
      view.applyEvent({
        ...event,
        type,
        text: boundedText(data.text, 200),
        toolId: boundedText(data.toolId, 128),
      });
    else if (type === "tool.start")
      view.applyEvent({
        ...event,
        type,
        id: boundedText(data.id, 128),
        name: boundedText(data.name, 128) || "tool",
        source: ["site", "mcp", "backend", "agent"].includes(data.source)
          ? data.source
          : "backend",
        arguments: boundedText(
          typeof data.arguments === "string"
            ? data.arguments
            : JSON.stringify(data.arguments ?? {}),
          2000,
        ),
      });
    else if (type === "tool.end")
      view.applyEvent({
        ...event,
        type,
        id: boundedText(data.id, 128),
        name: boundedText(data.name, 128),
        ok: data.ok !== false,
        result: boundedText(
          typeof data.result === "string"
            ? data.result
            : JSON.stringify(data.result ?? null),
          2000,
        ),
        card: await loopCard(data.card),
      });
    else if (type === "card")
      view.applyEvent({
        ...event,
        type,
        toolId: boundedText(data.toolId, 128),
        card: await loopCard(data.card),
      });
    else if (type === "card.update") {
      const card = await loopCard(data.card);
      if (card)
        view.applyEvent({
          ...event,
          type,
          cardId: boundedText(data.cardId, 32),
          card,
        });
    }
    return false;
  }
  /** A complete assistant `TranscriptEntry` from the stream (SPEC 14.3). */
  function loopMessage(raw) {
    if (!plainObject(raw) || (raw.type != null && raw.type !== "message"))
      return null;
    if (raw.role != null && raw.role !== "assistant") return null;
    const content = entryContent(raw.content);
    if (content == null) return null;
    return {
      content,
      reasoning:
        typeof raw.reasoning === "string"
          ? raw.reasoning.slice(0, 12000)
          : null,
    };
  }
  /** Usage the stream reports for a site model's turn, or null. */
  function loopUsage(raw) {
    if (!plainObject(raw)) return null;
    const usage = {};
    for (const key of [
      "promptTokens",
      "completionTokens",
      "totalTokens",
      "cachedTokens",
      "reasoningTokens",
    ]) {
      const value = raw[key] ?? 0;
      if (!Number.isSafeInteger(value) || value < 0) return null;
      usage[key] = value;
    }
    return usage;
  }
  /**
   * The footer's numbers once a loop turn ends: from the extension's own
   * provider for rounds it answered, from the stream only for a site model,
   * and none at all when neither reported any (SPEC 15.1, 15.2).
   */
  function noteLoopTurn(turn, streamUsage) {
    const usage = turn.usage ?? loopUsage(streamUsage);
    live = null;
    lastTurn = {
      at: Date.now(),
      usageReported: usage != null,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      cachedTokens: usage?.cachedTokens ?? 0,
      contextTokens: turn.contextTokens,
      contextCachedTokens: turn.contextCachedTokens,
      reasoningTokens: usage?.reasoningTokens ?? 0,
      contextWindow: turn.contextWindow ?? turn.site?.contextWindow ?? null,
      processor: null,
    };
    if (usage) {
      session.promptTokens += lastTurn.promptTokens;
      session.completionTokens += lastTurn.completionTokens;
    }
    session.turns++;
    void refreshSettings();
  }

  /** Prompts open one at a time; an open one keeps the stream's idle clock still. */
  function enqueuePrompt(task) {
    const next = promptChain.then(task, task);
    promptChain = next.catch(() => {});
    return next;
  }
  function loopPrompt(turn, task) {
    turn.prompting++;
    return enqueuePrompt(task).finally(() => {
      turn.prompting--;
      turn.lastActivity = Date.now();
    });
  }

  /** `tool.client`: one of the page's site tools, run as in hosted chat. */
  async function runLoopTool(data, turn) {
    const id = callId(data?.id);
    if (!id || turn.done || turn.answered.has(`tool:${id}`)) return;
    turn.answered.add(`tool:${id}`);
    turn.tooling++;
    let result;
    try {
      result = await runtime("loop.tool", {
        manifest: turn.contract.manifest,
        registrationId: turn.contract.id,
        fingerprint: turn.contract.fingerprint,
        name: boundedText(data.name, 64),
        arguments:
          typeof data.arguments === "string"
            ? data.arguments.slice(0, 65536)
            : plainObject(data.arguments)
              ? data.arguments
              : {},
        invocationId: id,
      });
    } catch (error) {
      result = {
        isError: true,
        message: String(error?.message ?? "The tool failed.").slice(0, 300),
      };
    } finally {
      turn.tooling--;
    }
    if (turn.done) return;
    await loopPost(turn, "tool-results", { id, result });
  }

  /** `input.client`: the value goes to `inputs` once and is kept nowhere. */
  async function runLoopInput(data, turn) {
    const id = callId(data?.id);
    if (!id || turn.done || turn.answered.has(`input:${id}`)) return;
    turn.answered.add(`input:${id}`);
    const definition = R.userInputDeclaration(data.input);
    let answer = { id, cancelled: true };
    if (definition)
      try {
        const value = await view.requestUserInput({
          toolName: view.stepName(boundedText(data.toolId, 128)) ?? "A tool",
          origin: location.origin,
          definition,
          hint: definition.secret
            ? "Masked. Sent only to this site's loop for this call; अर्जुनः does not store it or send it to the model."
            : "Sent only to this site's loop for this call; अर्जुनः does not store it or send it to the model.",
        });
        answer = { id, value };
      } catch {
        answer = { id, cancelled: true };
      }
    if (turn.done) return;
    await loopPost(turn, "inputs", answer);
  }

  /** `approval.client`: anything but the visitor choosing Approve is false. */
  async function runLoopApproval(data, turn) {
    const id = callId(data?.id);
    if (!id || turn.done || turn.answered.has(`approval:${id}`)) return;
    turn.answered.add(`approval:${id}`);
    const toolId = boundedText(data.toolId, 128);
    let approved = false;
    if (R.approvalPrompt(data.approval))
      approved =
        (await view
          .requestApproval({
            origin: location.origin,
            toolName: view.stepName(toolId),
            approval: data.approval,
          })
          .catch(() => false)) === true;
    if (turn.done) return;
    view.markApproval(toolId, approved);
    await loopPost(turn, "approvals", { id, approved });
  }

  /** Only the section 5.3 request fields cross to the broker. */
  function loopRequest(request) {
    const out = {};
    for (const key of [
      "messages",
      "model",
      "temperature",
      "maxTokens",
      "tools",
      "toolChoice",
      "reasoning",
    ])
      if (request[key] !== undefined) out[key] = request[key];
    return out;
  }

  /**
   * Posts a round's deltas to `model-results` in order, before its answer
   * (SPEC 15, `stream: true`). Deltas that arrive while a post is in flight
   * coalesce per type, so a fast round costs few posts and loses none.
   */
  function loopDeltaPoster(turn, id, completion) {
    let queue = [];
    let running = null;
    const drain = async () => {
      while (queue.length) {
        const delta = queue.shift();
        if (turn.done || completion.cancelled) {
          queue = [];
          break;
        }
        await loopPost(turn, "model-results", { id, delta });
      }
      running = null;
    };
    return {
      push(type, text) {
        const last = queue.at(-1);
        if (
          last?.type === type &&
          last.text.length + text.length <= LOOP_DELTA_POST
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
   * `model.client` (SPEC 15.1): the extension answers from the visitor's
   * model, with the validation a page's `models.generate` gets, in a
   * conversation it keeps per loop thread. The round's deltas are drawn here
   * as provisional text; the loop gets them only when it asked to.
   */
  async function runLoopCompletion(data, turn) {
    const id = callId(data?.id);
    if (!id || turn.done || turn.answered.has(`model:${id}`)) return;
    turn.answered.add(`model:${id}`);
    const refuse = (code, message) =>
      loopPost(turn, "model-results", { id, error: { code, message } });
    // The site's own model answers this turn: the extension does no model
    // work for it (SPEC 15.2).
    if (turn.site)
      return refuse(
        "NOT_SUPPORTED",
        "The visitor chose this site's own model for this turn.",
      );
    if (!turn.entry)
      return refuse(
        "NOT_CONFIGURED",
        "No model of the visitor's is available to this site.",
      );
    if (
      !plainObject(data.request) ||
      !Array.isArray(data.request.messages) ||
      (data.conversation != null &&
        (typeof data.conversation !== "string" ||
          !CONVERSATION_ID.test(data.conversation))) ||
      (data.stream != null && typeof data.stream !== "boolean")
    )
      return refuse("INVALID_REQUEST", "The model.client event is malformed.");
    const completion = {
      requestId: crypto.randomUUID(),
      cancelled: false,
      conversation: null,
    };
    turn.completions.set(id, completion);
    const poster =
      data.stream === true ? loopDeltaPoster(turn, id, completion) : null;
    const round = turn.rounds++;
    view.applyEvent({ type: "model.start", round, model: turn.entry.id });
    loopRounds.set(completion.requestId, {
      round: { output: 0, reasoning: 0 },
      onEvent(event) {
        if (completion.cancelled || turn.done) return;
        if (event.type === "stalled")
          return view.applyEvent({ type: "model.stalled", round });
        if (event.type === "output.delta")
          view.applyEvent({ type: "output.delta", text: event.text });
        else
          view.applyEvent({
            type: "agent.reasoning.delta",
            text: event.text,
            provisional: true,
            provider: String(turn.entry.displayName ?? "model").slice(0, 80),
          });
        poster?.push(event.type, event.text);
      },
    });
    try {
      completion.conversation = await loopConversation(
        turn.threadId,
        data.conversation ?? null,
      );
      if (completion.cancelled || turn.done) return;
      const answer = await runtime("models.generate", {
        ...loopRequest(data.request),
        conversationId: completion.conversation,
        _request: completion.requestId,
        _stream: true,
      });
      if (completion.cancelled || turn.done) return;
      const { _warnings, ...result } = answer ?? {};
      void _warnings;
      // The footer shows this round from the extension's own provider.
      turn.usage ??= {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
      };
      for (const key of Object.keys(turn.usage))
        turn.usage[key] += Number(result.usage?.[key]) || 0;
      turn.contextTokens = result.usage?.promptTokens ?? null;
      turn.contextCachedTokens = result.usage?.cachedTokens ?? null;
      turn.contextWindow = result.contextWindow ?? turn.contextWindow;
      const calls = result.message?.toolCalls?.length ?? 0;
      view.applyEvent({
        type: "model.end",
        round,
        usage: result.usage,
        toolCalls: calls,
      });
      // Only the composer knows whether a round is the answer; one that
      // ends in tool calls is not, so its provisional text goes now.
      if (calls) view.discardProvisional();
      await poster?.flush();
      if (completion.cancelled || turn.done) return;
      await loopPost(turn, "model-results", {
        id,
        result,
        conversation: completion.conversation,
      });
    } catch (error) {
      if (completion.cancelled || turn.done) return;
      view.discardProvisional();
      await poster?.flush();
      await loopPost(turn, "model-results", {
        id,
        error: {
          code: typeof error?.code === "string" ? error.code : "INTERNAL_ERROR",
          message: String(error?.message ?? "The completion failed.").slice(
            0,
            300,
          ),
        },
        ...(completion.conversation
          ? { conversation: completion.conversation }
          : {}),
      });
    } finally {
      loopRounds.delete(completion.requestId);
      if (turn.completions.get(id) === completion) turn.completions.delete(id);
      turn.lastActivity = Date.now();
    }
  }
  /** `model.cancel`: abort that completion and post nothing more for it. */
  function cancelLoopCompletion(data, turn) {
    const id = callId(data?.id);
    const completion = id ? turn.completions.get(id) : null;
    if (!completion) return;
    completion.cancelled = true;
    turn.completions.delete(id);
    loopRounds.delete(completion.requestId);
    void runtime("models.cancel", { request: completion.requestId }).catch(
      () => {},
    );
    view.discardProvisional();
  }

  function snapshot(fields) {
    const result = {};
    if (fields.includes("title")) result.title = document.title.slice(0, 500);
    if (fields.includes("url")) result.url = location.href.slice(0, 4000);
    if (fields.includes("selection"))
      result.selection = String(window.getSelection?.() ?? "").slice(0, 4000);
    if (fields.includes("text"))
      result.text = String(document.body?.innerText ?? "").slice(0, 20000);
    return result;
  }

  function showConsent(request, current, manifest, tools, status, mode = null) {
    ensureUi();
    const loop = mode?.loop ?? manifest?.loop ?? null;
    const siteAnswer = mode?.siteModel ?? null;
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "overlay";
      const card = document.createElement("section");
      card.className = "consent";
      card.setAttribute("role", "dialog");
      card.setAttribute("aria-modal", "true");
      // Fixed header, scrollable body, footer that never leaves the screen.
      const head = document.createElement("header");
      head.className = "consent-head";
      const body = document.createElement("div");
      body.className = "consent-body";
      body.tabIndex = 0;
      const foot = document.createElement("footer");
      foot.className = "consent-foot";
      const title = document.createElement("h2");
      title.textContent = tools
        ? "Allow these assistant tools?"
        : "Allow AI access?";
      const level = levelOf(request.capabilities);
      const badge = document.createElement("span");
      badge.className = "level";
      badge.textContent = {
        assistant: "Level 0 · Assistant",
        completion: "Level 1 · Completion",
        catalog: "Level 2 · Catalog",
      }[level];
      title.append(badge);
      const origin = document.createElement("div");
      origin.className = "origin";
      origin.textContent = location.origin;
      head.append(title, origin);
      const row = (text) => {
        const node = document.createElement("div");
        node.className = "scope";
        node.textContent = text;
        body.append(node);
      };
      const details = (label, text) => {
        const node = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = label;
        const pre = document.createElement("pre");
        pre.textContent = text;
        node.append(summary, pre);
        body.append(node);
      };
      if (request.reason) row(request.reason);
      // Who writes the prompts and who answers them, per mode (SPEC 15.3).
      const approvals = manifest
        ? [
            ...manifest.tools
              .filter((tool) => tool.requiresApproval)
              .map((tool) => tool.name),
            ...manifest.mcpServers.flatMap((server) =>
              (server.tools ?? [])
                .filter((tool) => tool.requiresApproval)
                .map((tool) => `${tool.name} (${server.name})`),
            ),
          ]
        : [];
      for (const line of H.consentLines({
        mode: loop ? "loop" : manifest ? "hosted" : "page",
        composer: loop?.composer ?? request.composer ?? "webapp",
        siteModel: siteAnswer,
        approvals,
      }))
        row(line);
      let modelPicker = null;
      const providerBoxes = [];
      // A site model answering needs none of the visitor's (SPEC 15.2).
      const needsModel =
        !siteAnswer &&
        (request.capabilities.includes("models.generate") ||
          request.capabilities.includes("chat.hosted"));
      // The site restricted which of the user's models may answer it (SPEC
      // 4); only qualifying models are offered, and with none there is
      // nothing to approve.
      const restricted = Boolean(status?.require);
      const unavailable = restricted && !status.models?.length;
      if (restricted)
        row(
          unavailable
            ? `This site restricted the choice of model (${describeRequire(status.require)}), and none of your configured models qualifies. Add one in extension settings, then try again.`
            : `This site restricted the choice of model: ${describeRequire(status.require)}. Only models that qualify are listed.`,
        );
      if (needsModel && status?.models?.length) {
        const field = document.createElement("label");
        field.className = "field";
        field.append(
          level === "assistant"
            ? "Model answering this site's assistant"
            : "Model this site may use",
        );
        modelPicker = document.createElement("select");
        const groups = new Map();
        for (const model of status.models) {
          if (!groups.has(model.providerName))
            groups.set(model.providerName, []);
          groups.get(model.providerName).push(model);
        }
        for (const [provider, list] of groups) {
          const group = document.createElement("optgroup");
          group.label = provider;
          for (const model of list) {
            const option = document.createElement("option");
            option.value = model.id;
            option.textContent =
              model.id === status.defaultModel
                ? `${model.displayName} (default)`
                : model.displayName;
            option.selected = model.id === status.model;
            group.append(option);
          }
          modelPicker.append(group);
        }
        field.append(modelPicker);
        body.append(field);
      } else if (status?.provider && !siteAnswer)
        row(`Requests are sent to: ${status.provider}`);
      else if (needsModel && !unavailable)
        row(
          "No provider is configured yet. Add an API key or pair the desktop app in extension settings.",
        );
      row(
        `Requested permissions:\n${request.capabilities.map(describeCapability).join("\n")}`,
      );
      const effective = [
        ...new Set([...(current?.capabilities ?? []), ...request.capabilities]),
      ];
      row(
        `Permissions after approval:\n${effective.map(describeCapability).join("\n")}`,
      );
      // Level 1 and 2 generation keeps provider state between a reply's tool
      // rounds (SPEC 5.4), so the dialog that grants it says so.
      if (effective.includes("models.generate"))
        row(
          "Keeps the model's working state during a reply's tool steps on this device, for up to 2 days.",
        );
      if (
        request.capabilities.includes("models.catalog") &&
        status?.providers?.length
      ) {
        const heading = document.createElement("div");
        heading.className = "scope";
        heading.textContent =
          "Providers this site may list and choose from (account details are never shared):";
        body.append(heading);
        const box = document.createElement("div");
        box.className = "providers";
        for (const provider of status.providers) {
          const label = document.createElement("label");
          const check = document.createElement("input");
          check.type = "checkbox";
          check.checked = true;
          check.value = provider.id;
          label.append(check, provider.name);
          box.append(label);
          providerBoxes.push(check);
        }
        body.append(box);
      }
      const fields = [
        ...new Set([...(current?.context ?? []), ...request.context]),
      ];
      if (fields.length)
        row(`Page context fields after approval: ${fields.join(", ")}`);
      if (manifest) {
        row(`Assistant: ${manifest.name}\n${manifest.description}`);
        if (manifest.systemPrompt)
          details("Full site instructions", manifest.systemPrompt);
        // The site stores the conversation, so consent has to say so (SPEC 7.6).
        if (manifest.threads)
          row(
            "This site stores your conversations with this assistant and can supply earlier messages back to the model. Stored messages are shown as untrusted site content.",
          );
        if (manifest.tools.some((tool) => tool.outputContent?.includes("card")))
          row(
            "This assistant can show interactive cards written by the site inside the chat. Buttons that send a message always show you the exact text first.",
          );
        for (const tool of manifest.tools)
          details(
            `Site tool: ${tool.name} — ${tool.description}`,
            [
              JSON.stringify(tool.inputSchema, null, 2),
              ...(tool.requiresApproval ? ["\nAsks you before it runs."] : []),
              ...(tool.userInputs?.length
                ? [
                    "\nExtension-collected inputs (not shown to the model):\n" +
                      tool.userInputs
                        .map(
                          (input) =>
                            `- ${input.label} (${input.id}${input.secret ? ", masked" : ""})`,
                        )
                        .join("\n"),
                  ]
                : []),
              ...(tool.outputContent?.length
                ? [
                    tool.outputContent.includes("image")
                      ? "\nReturns structured text and an image that may be sent to the selected vision model. The text is always used as the non-vision fallback."
                      : "\nReturns structured text.",
                    ...(tool.outputContent.includes("card")
                      ? [
                          "\nMay also return an interactive card. The model receives only the text.",
                        ]
                      : []),
                  ]
                : []),
            ].join(""),
          );
        if (manifest.widget.controls.length)
          details(
            `Widget options (${manifest.widget.controls.length})`,
            manifest.widget.controls
              .map(
                (control) =>
                  `${control.label} (${control.type}${control.model ? ", visible to the model" : ""})`,
              )
              .join("\n"),
          );
        for (const server of manifest.mcpServers) {
          row(`MCP server: ${server.name}\n${server.url}`);
          // Declared tools are part of the contract, so they are inspectable
          // here and never rediscovered behind the user's back (SPEC 7.7).
          for (const tool of server.tools ?? [])
            details(
              `Declared tool at ${server.name}: ${tool.name} — ${tool.description}`,
              [
                JSON.stringify(tool.inputSchema, null, 2),
                ...(tool.requiresApproval
                  ? ["\nAsks you before it runs."]
                  : []),
                // Collected here and sent only to this server (SPEC 7.8).
                ...(tool.userInputs?.length
                  ? [
                      `\nInputs you provide, sent only to ${new URL(server.url).origin} and not shown to the model:\n` +
                        tool.userInputs
                          .map(
                            (input) =>
                              `- ${input.label} (${input.id}${input.secret ? ", masked" : ""})`,
                          )
                          .join("\n"),
                    ]
                  : []),
              ].join(""),
            );
        }
        if (
          manifest.mcpServers.some((server) => !server.tools?.length) &&
          !tools
        )
          row(
            "Approval allows tool discovery at these servers. Discovered tools will be shown for approval before any model request or tool call.",
          );
      }
      if (tools)
        for (const tool of tools)
          details(
            `${tool.source}: ${tool.name} — ${tool.description}`,
            JSON.stringify(tool.inputSchema, null, 2),
          );
      const note = document.createElement("p");
      note.className = "notice";
      note.textContent =
        "Your provider credential, subscription, and account details stay with the extension and desktop app. Change this site's model or revoke it any time from the toolbar popup.";
      body.append(note);
      const actions = document.createElement("div");
      actions.className = "actions";
      const deny = document.createElement("button");
      deny.textContent = "Deny";
      const allow = document.createElement("button");
      allow.className = "allow";
      allow.textContent = "Allow";
      // Only a failed lookup blocks approval. An empty catalog is the ordinary
      // first-run state, and the dialog already explains that one; refusing it
      // here would leave a fresh install with no way to grant anything.
      if (unavailable) {
        allow.hidden = true;
        deny.textContent = "Close";
      }
      if (level !== "assistant" && !status) {
        allow.disabled = true;
        const unavailable = document.createElement("p");
        unavailable.className = "notice";
        unavailable.textContent =
          "अर्जुनः could not load the model choices required for this access level. Close this dialog and try again.";
        foot.append(unavailable);
      }
      const finish = (allowed) => {
        pendingConsent = null;
        overlay.remove();
        resolve({
          allowed: allowed && !unavailable,
          unavailable,
          model: allowed && modelPicker ? modelPicker.value : null,
          providers:
            allowed && providerBoxes.length
              ? providerBoxes
                  .filter((check) => check.checked)
                  .map((check) => check.value)
              : null,
        });
      };
      pendingConsent = finish;
      deny.addEventListener("click", () => finish(false), { once: true });
      allow.addEventListener("click", () => finish(true), { once: true });
      actions.append(deny, allow);
      const hint = document.createElement("span");
      hint.className = "consent-hint";
      hint.textContent = "Scroll to review everything the site asked for.";
      foot.append(hint, actions);
      card.append(head, body, foot);
      overlay.append(card);
      root.append(overlay);
      const updateHint = () => {
        hint.hidden =
          body.scrollHeight - body.scrollTop - body.clientHeight < 8;
      };
      body.addEventListener("scroll", updateHint);
      requestAnimationFrame(updateHint);
      (unavailable ? deny : allow).focus();
    });
  }

  /** Collect a declared value in broker-owned UI without adding it to history. */
  function showToolInput(toolName, definition) {
    ensureUi();
    // The prompt is the renderer's (SPEC 7.3), so wallet and standalone mode
    // validate and mask the same way; only the wording below is wallet-specific.
    return view.requestUserInput({
      toolName,
      origin: location.origin,
      definition,
      hint: definition.secret
        ? "Masked. अर्जुनः does not persist or forward it to the model."
        : "अर्जुनः does not persist or forward it to the model.",
    });
  }

  function levelOf(capabilities) {
    if (capabilities.includes("models.catalog")) return "catalog";
    if (capabilities.includes("models.generate")) return "completion";
    return "assistant";
  }
  function describeCapability(capability) {
    return (
      {
        "models.list": "See the model names exposed to this site",
        "models.generate": "Send prompts to the model chosen for this site",
        "models.catalog":
          "List your exposed providers and models and choose among them",
        "context.read": "Read only the page context fields listed below",
        "chat.hosted": "Use the extension-hosted chat on this site",
        "tools.site": "Let the model call the site's declared tools",
        "tools.mcp": "Connect to the site's declared MCP servers",
      }[capability] ?? capability
    );
  }

  /**
   * A round stream event as the page may receive it: a stall notice, or one
   * bounded delta whose text, added to what this round already carried, stays
   * within the result's own answer and reasoning bounds.
   */
  function roundEvent(event, round) {
    if (event?.type === "stalled") return { type: "stalled" };
    const key =
      event?.type === "output.delta"
        ? "output"
        : event?.type === "reasoning.delta"
          ? "reasoning"
          : null;
    if (
      !key ||
      typeof event.text !== "string" ||
      !event.text ||
      event.text.length > ROUND_DELTA_UNITS
    )
      return null;
    const text = event.text.slice(0, ROUND_TEXT_UNITS[key] - round[key]);
    if (!text) return null;
    round[key] += text.length;
    return { type: event.type, text };
  }

  function matchesSession(message) {
    return (
      alive &&
      message.session === nonce &&
      message.origin === location.origin &&
      (!message.registrationId ||
        (registration?.id === message.registrationId &&
          registration?.fingerprint === message.fingerprint))
    );
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.kind === "arjunah-session") {
      sendResponse({ ok: matchesSession(message) });
      return false;
    }
    if (message?.kind === "arjunah-round") {
      // A round the extension is answering for a hosted loop (SPEC 15.1):
      // drawn in this panel, never posted to the page as a stream event.
      const relayed =
        alive &&
        message.session === nonce &&
        typeof message.request === "string"
          ? loopRounds.get(message.request)
          : null;
      if (relayed) {
        const event = roundEvent(message.event, relayed.round);
        if (event) relayed.onEvent(event);
        sendResponse({ ok: Boolean(event) });
        return false;
      }
      // One event of a round this document is streaming (SPEC 5.3, 10).
      const round =
        alive &&
        message.session === nonce &&
        typeof message.request === "string"
          ? streaming.get(message.request)
          : null;
      const event = round ? roundEvent(message.event, round) : null;
      if (event) toPage({ kind: "stream", id: message.request, event });
      sendResponse({ ok: Boolean(event) });
      return false;
    }
    if (message?.kind === "arjunah-progress") {
      if (message.session === nonce) {
        view?.applyEvent(message);
        // Placement and loaded context arrive with each round of a turn.
        if (message.type === "model.end" && message.processor) {
          live = {
            processor: validProcessor(message.processor),
            contextWindow: Number.isSafeInteger(message.contextWindow)
              ? message.contextWindow
              : null,
          };
          renderStatus();
        }
      }
      return false;
    }
    if (message?.kind === "arjunah-ui") {
      if (message.action === "open") {
        openPanel();
        sendResponse({ ok: true, supported: Boolean(registration) });
      } else if (message.action === "toggle") {
        ensureUi();
        panel.hidden ? openPanel() : ((panel.hidden = true), syncLauncher());
        sendResponse({ ok: true, supported: Boolean(registration) });
      } else if (message.action === "status")
        sendResponse({
          ok: true,
          supported: Boolean(registration),
          open: Boolean(panel && !panel.hidden),
          name: registration?.manifest.name ?? null,
          description: registration?.manifest.description ?? null,
          tools: registration?.manifest.tools.length ?? 0,
          mcpServers: registration?.manifest.mcpServers.length ?? 0,
        });
      else if (message.action === "refresh") {
        void refreshSettings();
        sendResponse({ ok: true });
      } else if (message.action === "snapshot") {
        if (!matchesSession(message)) {
          sendResponse({ ok: false });
          return false;
        }
        runtime("context.authorize", {
          fields: ["title", "url", "selection", "text"],
        }).then(
          () =>
            sendResponse({
              ok: true,
              context: snapshot(["title", "url", "selection", "text"]),
            }),
          () => sendResponse({ ok: false }),
        );
        return true;
      }
      return false;
    }
    if (message?.kind === "arjunah-site-generate") {
      // One round of the site's own model (SPEC 15.2), answered by the page's
      // `models.generate` and abortable by the broker.
      const active = registration;
      if (
        !matchesSession(message) ||
        !active?.manifest.models?.generate ||
        typeof message.id !== "string"
      ) {
        sendResponse({
          ok: false,
          error: {
            code: "PROVIDER_ERROR",
            message: "The site's model is not available on this page.",
          },
        });
        return false;
      }
      const pageId = crypto.randomUUID();
      siteRounds.set(message.id, pageId);
      callPage("site-generate", { request: message.request }, 180000, pageId)
        .then(
          (result) =>
            sendResponse(
              registration === active && matchesSession(message)
                ? { ok: true, result }
                : {
                    ok: false,
                    error: {
                      code: "PROVIDER_ERROR",
                      message: "The site replaced its assistant.",
                    },
                  },
            ),
          (error) =>
            sendResponse({
              ok: false,
              error: {
                code: error?.code === "TIMEOUT" ? "TIMEOUT" : "PROVIDER_ERROR",
                message: String(error?.message ?? "").slice(0, 300),
              },
            }),
        )
        .finally(() => siteRounds.delete(message.id));
      return true;
    }
    if (message?.kind === "arjunah-site-generate-cancel") {
      const pageId =
        typeof message.id === "string" ? siteRounds.get(message.id) : null;
      if (pageId && matchesSession(message)) {
        toPage({ kind: "page-call-abort", id: pageId });
        const pending = pagePending.get(pageId);
        if (pending) {
          clearTimeout(pending.timer);
          pagePending.delete(pageId);
          pending.reject(aiError("ABORTED", "The round was cancelled."));
        }
      }
      sendResponse({ ok: true });
      return false;
    }
    if (message?.kind === "arjunah-approval") {
      // The approval prompt of SPEC 7.8 before the broker invokes a tool that
      // declared `requiresApproval`. Only Approve answers true.
      if (!matchesSession(message) || !view) {
        sendResponse({ ok: false });
        return false;
      }
      const toolId =
        typeof message.toolId === "string" ? message.toolId.slice(0, 128) : "";
      void enqueuePrompt(() =>
        view.requestApproval({
          origin: location.origin,
          toolName:
            typeof message.toolName === "string" ? message.toolName : null,
          approval: message.approval,
        }),
      ).then(
        (approved) => {
          const answer = approved === true && matchesSession(message);
          view.markApproval(toolId, answer);
          sendResponse({ ok: true, approved: answer });
        },
        () => sendResponse({ ok: true, approved: false }),
      );
      return true;
    }
    if (message?.kind === "arjunah-tool-input") {
      // A declared remote tool's collected input (SPEC 7.8): shown with the
      // origin that receives it, returned to the broker, kept nowhere.
      let recipient = null;
      try {
        if (new URL(message.recipient).origin === message.recipient)
          recipient = message.recipient;
      } catch {
        recipient = null;
      }
      const definition = R.userInputDeclaration(message.definition);
      if (!matchesSession(message) || !view || !definition || !recipient) {
        sendResponse({ ok: false });
        return false;
      }
      void enqueuePrompt(() =>
        view.requestUserInput({
          toolName:
            typeof message.toolName === "string"
              ? message.toolName.slice(0, 64)
              : "A tool",
          origin: recipient,
          definition,
          hint: definition.secret
            ? `Masked. Sent only to ${recipient} for this call; अर्जुनः does not store it or send it to the model.`
            : `Sent only to ${recipient} for this call; अर्जुनः does not store it or send it to the model.`,
        }),
      ).then(
        (value) =>
          sendResponse(
            matchesSession(message) ? { ok: true, value } : { ok: false },
          ),
        () => sendResponse({ ok: false }),
      );
      return true;
    }
    if (message?.kind === "arjunah-tool") {
      if (!matchesSession(message)) {
        sendResponse({
          ok: false,
          error: {
            code: "TOOL_ERROR",
            message:
              "The page's assistant registration is no longer the one this tool call was made against.",
          },
        });
        return false;
      }
      if (
        !registration?.manifest.tools.some((tool) => tool.name === message.name)
      ) {
        sendResponse({
          ok: false,
          error: {
            code: "TOOL_ERROR",
            message: "The site no longer offers a tool with this name.",
          },
        });
        return false;
      }
      const active = registration;
      const tool = active.manifest.tools.find(
        (item) => item.name === message.name,
      );
      const id = crypto.randomUUID();
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          toolPending.delete(id);
          view?.cancelUserInput("The site tool timed out.");
          reject(aiError("TIMEOUT", "The site tool timed out."));
        }, 120000);
        toolPending.set(id, {
          resolve,
          reject,
          timer,
          name: message.name,
          callId: message.invocationId ?? null,
          userInputs: tool?.userInputs ?? [],
          outputContent: tool?.outputContent ?? [],
          inputRequests: 0,
          progressReports: 0,
        });
        toPage({
          kind: "tool-invoke",
          id,
          name: message.name,
          args: message.args,
          invocationId: message.invocationId,
          registrationId: active.id,
          outputContent: tool?.outputContent ?? [],
          controls: { ...controls },
        });
      })
        .then((result) =>
          sendResponse(
            registration === active && matchesSession(message)
              ? { ok: true, result }
              : {
                  ok: false,
                  error: {
                    code: "TOOL_ERROR",
                    message:
                      "The site replaced its assistant while this tool was running, so the result was discarded.",
                  },
                },
          ),
        )
        .catch((error) =>
          sendResponse({
            ok: false,
            error: { code: error.code, message: error.message },
          }),
        );
      return true;
    }
    return false;
  });
})();
