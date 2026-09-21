(() => {
  "use strict";
  const CHANNEL = "arjunah-v0.1";
  const R = ArjunahRenderer;
  const nonce = crypto.randomUUID();
  const toolPending = new Map();
  const pagePending = new Map();
  const IMAGE_TYPES = R.IMAGE_TYPES;
  const HISTORY_LIMIT = 40;
  const PROVIDER_ICONS = Object.freeze({
    openai: "icons/providers/openai.svg",
    "claude-code": "icons/providers/claude.svg",
    codex: "icons/providers/codex.png",
    "opencode-api": "icons/providers/opencode.svg",
    "opencode-cli": "icons/providers/opencode.svg",
  });
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
  let pendingModel = null; // model chosen in the header before any grant exists
  let controls = {};
  let session = { promptTokens: 0, completionTokens: 0, turns: 0 };
  let lastTurn = null;
  let conversationId = crypto.randomUUID(); // one agent thread per panel conversation
  let statePort = null;
  let stateRefreshTimer = null;
  let settingsRequest = 0;
  let threadsAttached = false;

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
      });
      port.onDisconnect.addListener(() => {
        if (statePort === port) statePort = null;
        if (alive) setTimeout(connectStateStream, 500);
      });
    } catch {
      if (alive) setTimeout(connectStateStream, 1000);
    }
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
  function callPage(kind, payload, timeoutMs = 30000) {
    if (!registration)
      return Promise.reject(aiError("TOOL_ERROR", "No assistant is active."));
    const id = crypto.randomUUID();
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
  function respond(id, ok, value) {
    toPage({
      kind: "response",
      id,
      ok,
      ...(ok
        ? { result: value }
        : {
            error: {
              code: value.code ?? "INTERNAL_ERROR",
              message: value.message ?? "The AI request failed.",
              details: value.details,
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
    if (data.kind !== "request") return;
    try {
      respond(
        data.id,
        true,
        await handlePageRequest(data.method, data.params ?? {}),
      );
    } catch (error) {
      respond(data.id, false, error);
    }
  });

  async function handlePageRequest(method, params) {
    if (method === "enable") return enableAccess(params);
    if (method === "permissions.query") return runtime("grant.query");
    if (method === "permissions.revoke") return runtime("grant.revoke");
    if (method === "models.list") return runtime("models.list");
    if (method === "providers.list") return runtime("providers.list");
    if (method === "models.generate") return runtime("models.generate", params);
    if (method === "context.get") {
      await runtime("context.authorize", params);
      return snapshot(params.fields);
    }
    if (method === "site.register") {
      const validated = await runtime("site.register", params);
      const replaced = registration?.id && registration.id !== validated.id;
      cancelSession();
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
      if (registration.manifest.widget.autoShow) openPanel();
      return { id: validated.id, controls: { ...controls } };
    }
    if (method === "site.unregister") {
      if (registration?.id !== params.id) return false;
      cancelSession();
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
    for (const pending of toolPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(aiError("TOOL_ERROR", "The page or assistant changed."));
    }
    toolPending.clear();
    rejectPageCalls("The page or assistant changed.");
    void runtime("session.end", { conversationId }).catch(() => {});
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
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && panel && !panel.hidden)
      void refreshSettings();
  });
  connectStateStream();

  function assertRegistration(contract) {
    if (!alive || (contract && registration !== contract))
      throw aiError(
        "PERMISSION_REQUIRED",
        "The assistant changed. Start a new request.",
      );
  }

  function enableAccess(
    raw,
    resources = {},
    contract = null,
    tools = null,
    preparedId = null,
  ) {
    const next = accessQueue.then(() =>
      enableAccessNow(raw, resources, contract, tools, preparedId),
    );
    accessQueue = next.catch(() => undefined);
    return next;
  }

  async function enableAccessNow(raw, resources, contract, tools, preparedId) {
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
    if (
      !missingCapability &&
      !missingContext &&
      !missingMcpOrigin &&
      !missingContract &&
      !missingTools
    )
      return runtime("grant.query");
    const status = await runtime("broker.status", {
      model: pendingModel ?? undefined,
    }).catch(() => null);
    assertRegistration(contract);
    const answer = await showConsent(
      request,
      current,
      contract?.manifest,
      tools,
      status,
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
      ...(answer.providers ? { providers: answer.providers } : {}),
    });
    pendingModel = null;
    void refreshSettings();
    return grant;
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
    style.textContent = R.STYLE;
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
        `<button class="context-glance" title="Open context and usage details"><span>Context window</span><span class="context-track"><i></i></span><strong>—</strong></button>`,
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
      submit: (content, context) => runTurn(content, context),
      stop() {
        cancelSession();
        view.finishActivity(false);
        view.setBusy(false);
        view.addBubble("assistant", "Stopped.", { persist: false });
      },
      close: syncLauncher,
      reset() {
        cancelSession();
        conversationId = crypto.randomUUID();
        lastTurn = null;
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
        settings?.models?.find((model) => model.id === id)?.displayName ?? id,
      modelIcon({ providerId }) {
        const path = PROVIDER_ICONS[providerId];
        if (!path) return null;
        return {
          src: chrome.runtime.getURL(path),
          ...(providerId === "opencode-api" ? { badge: "[API]" } : {}),
        };
      },
      // The renderer drew the choice already; the wallet decides whether it
      // stands, and a false answer puts the previous model back (SPEC 8.2).
      modelChanged({ model }) {
        return switchModel(model);
      },
      busyChanged() {
        renderSetup();
      },
      async cardAction(detail) {
        const card = await callPage("card-action", { action: detail }).catch(
          () => null,
        );
        if (!card) return null;
        // Page-authored replacements go through the same section 7.4 validator
        // as the original card before anything is drawn.
        return runtime("cards.validate", { card }).catch(() => null);
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
  function transcriptEntries(value) {
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
        out.push({
          type: "activity",
          id: THREAD_ID.test(String(entry.id ?? ""))
            ? entry.id
            : crypto.randomUUID(),
          turnId: String(entry.turnId ?? "").slice(0, 100),
          steps: entry.steps.slice(0, 32).flatMap((step) => {
            if (!step || typeof step !== "object") return [];
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
                ...(step.card && typeof step.card === "object"
                  ? { card: step.card }
                  : {}),
              },
            ];
          }),
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
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string")
        parts.push({ type: "text", text: part.text.slice(0, 12000) });
      else if (
        part?.type === "image" &&
        IMAGE_TYPES.includes(part.mediaType) &&
        typeof part.data === "string" &&
        part.data.length <= 2000000
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
    // Site-owned threads only exist while that contract is the active one.
    const wantsThreads = Boolean(manifest?.threads);
    if (wantsThreads !== threadsAttached) {
      threadsAttached = wantsThreads;
      view.setThreadHost(wantsThreads ? siteThreads() : null);
    }
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
    // Unknown state (settings not loaded) never blocks the composer.
    const blocked = settings !== null && !settings.model;
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
          text: "Add an OpenAI API key or pair अर्जुनः Desktop to use a Claude, ChatGPT/Codex, or OpenCode subscription.",
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
    const current = pendingModel ?? settings?.model?.id ?? null;
    // The catalog is the wallet's; the picker that draws it is the renderer's
    // (SPEC 8.2), so this hands over data and nothing else.
    view.setModels(settings?.models ?? [], current);
    const active = settings?.model;
    view.refs.sub.textContent = active
      ? `${active.providerName} · ${active.displayName}${active.fallback ? " (default)" : ""}`
      : settings?.desktop?.paired && !settings.desktop.running
        ? "अर्जुनः Desktop is not running"
        : settings?.desktop?.paired && !settings.desktop.accepted
          ? "अर्जुनः Desktop needs pairing again"
          : "No provider configured";
    const vision = Boolean(
      (settings?.models ?? []).find((model) => model.id === current)
        ?.capabilities.vision ?? active?.capabilities.vision,
    );
    view.setAttachmentsEnabled(vision);
  }

  async function switchModel(id) {
    if (!id) return false;
    if (!settings?.grant) {
      // No grant yet: remember the choice for the consent dialog.
      pendingModel = id;
      renderModelSelect();
      return true;
    }
    try {
      settings = await runtime("hosted.model", { model: id });
      pendingModel = null;
      renderModelSelect();
      renderStatus();
      return true;
    } catch (error) {
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
    const window_ = lastTurn?.contextWindow ?? settings?.model?.contextWindow;
    const contextKnown = Number.isSafeInteger(lastTurn?.contextTokens);
    const prompt = contextKnown ? lastTurn.contextTokens : 0;
    const contextPercent =
      window_ && contextKnown ? Math.min(100, (prompt / window_) * 100) : 0;
    const contextSection = usageSection(
      "Context window",
      window_ && contextKnown
        ? `${compactNumber(prompt)} / ${compactNumber(window_)} (${Math.round(contextPercent)}%)`
        : "Not reported",
    );
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
    contextSection.append(contextRows);
    statusLine.append(contextSection);

    if (lastTurn || session.turns) {
      const response = usageSection("Token usage", "This conversation");
      const rows = document.createElement("div");
      rows.className = "usage-rows";
      if (lastTurn)
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

    const model = settings?.model;
    const quota = usageSection(
      "Your usage limits",
      model?.plan || model?.providerName || "Provider",
    );
    if (model?.quota?.windows?.length) {
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
    glance.querySelector("strong").textContent =
      window_ && contextKnown
        ? `${compactNumber(prompt)} / ${compactNumber(window_)} (${Math.round(contextPercent)}%)`
        : "Not reported";
    glance.querySelector(".context-track i").style.width = `${contextPercent}%`;
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
      await enableAccess(request, resources, contract);
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
        ...(view.selection().reasoning
          ? { reasoning: view.selection().reasoning }
          : {}),
      });
      if (registration === contract && epoch === panelEpoch) {
        const turn = view.currentTurn();
        lastTurn = {
          promptTokens: turn?.promptTokens || result.usage.promptTokens,
          completionTokens:
            turn?.completionTokens || result.usage.completionTokens,
          cachedTokens: result.usage.cachedTokens ?? 0,
          contextTokens: result.contextTokens ?? null,
          contextCachedTokens: result.contextCachedTokens ?? null,
          reasoningTokens: result.usage.reasoningTokens ?? 0,
          contextWindow: result.contextWindow ?? null,
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

  function showConsent(request, current, manifest, tools, status) {
    ensureUi();
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
      let modelPicker = null;
      const providerBoxes = [];
      const needsModel =
        request.capabilities.includes("models.generate") ||
        request.capabilities.includes("chat.hosted");
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
      } else if (status?.provider)
        row(`Requests are sent to: ${status.provider}`);
      else if (needsModel)
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
              JSON.stringify(tool.inputSchema, null, 2),
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
          allowed,
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
      allow.focus();
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
    if (message?.kind === "arjunah-progress") {
      if (message.session === nonce) view?.applyEvent(message);
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
