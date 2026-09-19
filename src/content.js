(() => {
  "use strict";
  const CHANNEL = "arjunah-v0.1";
  const nonce = crypto.randomUUID();
  const toolPending = new Map();
  const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  const HISTORY_LIMIT = 40;
  let registration = null,
    history = [],
    host,
    root,
    panel,
    launcher,
    messages,
    contextToggle,
    input,
    sendButton,
    stopButton,
    attachButton,
    fileInput,
    modelSelect,
    modelMenu,
    drawer,
    statusLine,
    contextGlance,
    activity,
    busy = false;
  let accessQueue = Promise.resolve();
  let pendingConsent = null;
  let pendingInputPrompt = null;
  let panelEpoch = 0;
  let alive = true;
  let settings = null; // hosted.settings result: site model, switchable models, usage
  let pendingModel = null; // model chosen in the header before any grant exists
  let attachments = [];
  let controls = {};
  let currentTurn = null;
  let session = { promptTokens: 0, completionTokens: 0, turns: 0 };
  let lastTurn = null;
  let conversationId = crypto.randomUUID(); // one agent thread per panel conversation
  let reasoningEffort = ""; // "" = provider default
  let thinkSelect;

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
      data.ok
        ? pending.resolve(data.result)
        : pending.reject(
            aiError("TOOL_ERROR", data.error?.message ?? "Site tool failed."),
          );
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
      if (pendingInputPrompt)
        return fail("Another extension input prompt is already open.");
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
      if (registration?.id && registration.id !== validated.id) {
        history = [];
        if (messages) messages.textContent = "";
      }
      cancelSession();
      conversationId = crypto.randomUUID();
      registration = {
        id: validated.id,
        manifest: validated.manifest,
        fingerprint: validated.fingerprint,
      };
      controls = defaultControls(validated.manifest.widget.controls);
      ensureUi();
      launcher.hidden = false;
      applyManifest();
      if (registration.manifest.widget.autoShow) openPanel();
      return { id: validated.id, controls: { ...controls } };
    }
    if (method === "site.unregister") {
      if (registration?.id !== params.id) return false;
      cancelSession();
      conversationId = crypto.randomUUID();
      registration = null;
      history = [];
      controls = {};
      if (messages) messages.textContent = "";
      if (launcher) launcher.hidden = true;
      if (panel) panel.hidden = true;
      return true;
    }
    if (method === "chat.open") {
      ensureUi();
      openPanel();
      return true;
    }
    if (method === "chat.close") {
      if (panel) panel.hidden = true;
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
      renderControls();
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
    pendingInputPrompt?.("The page or assistant changed.");
    for (const pending of toolPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(aiError("TOOL_ERROR", "The page or assistant changed."));
    }
    toolPending.clear();
    void runtime("session.end", { conversationId }).catch(() => {});
  }
  window.addEventListener("pagehide", () => {
    alive = false;
    cancelSession();
  });
  window.addEventListener("pageshow", () => {
    alive = true;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && panel && !panel.hidden)
      void refreshSettings();
  });

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

  const STYLE = `
    *{box-sizing:border-box}button,input,select,textarea{font:inherit}
    :host{--accent:#3b5bdb;--accent-ink:#fff}
    .panel{--bg:#fff;--surface:#f5f6f8;--surface-strong:#eceef2;--ink:#171717;--muted:#6b7280;--line:#e5e7eb;--bubble:#fff;--user:var(--accent);--shadow:0 24px 70px #0f172a26,0 2px 10px #0f172a10;color-scheme:light}
    .panel[data-mode=dark]{--bg:#171717;--surface:#212121;--surface-strong:#2f2f2f;--ink:#f3f4f6;--muted:#a1a1aa;--line:#343434;--bubble:#212121;color-scheme:dark}
    @media (prefers-color-scheme:dark){.panel[data-mode=auto]{--bg:#171717;--surface:#212121;--surface-strong:#2f2f2f;--ink:#f3f4f6;--muted:#a1a1aa;--line:#343434;--bubble:#212121;color-scheme:dark}}
    .launcher{pointer-events:auto;position:fixed;right:20px;bottom:20px;width:54px;height:54px;border:0;border-radius:18px;background:var(--accent);color:var(--accent-ink);box-shadow:0 12px 32px #0f172a40;font:700 15px/1 system-ui,-apple-system,sans-serif;cursor:pointer;display:grid;place-items:center;transition:transform .18s ease,box-shadow .18s ease}
    .launcher:hover{transform:translateY(-2px) scale(1.02);box-shadow:0 16px 38px #0f172a48}.launcher:active{transform:translateY(0) scale(.97)}
    .panel{pointer-events:auto;position:fixed;right:20px;bottom:86px;width:min(460px,calc(100vw - 24px));height:min(680px,calc(100vh - 110px));min-width:320px;min-height:380px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);resize:both;overflow:hidden;border:1px solid var(--line);border-radius:18px;background:var(--bg);color:var(--ink);box-shadow:var(--shadow);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column}
    .panel:not([hidden]){animation:panel-in .22s cubic-bezier(.2,.8,.2,1) both}
    .panel[hidden],.launcher[hidden],[hidden]{display:none!important}
    .head{display:flex;align-items:center;gap:6px;padding:11px 10px 10px 16px;border-bottom:1px solid var(--line);cursor:grab;user-select:none;background:var(--bg)}
    .head:active{cursor:grabbing}
    .brand{flex:1;min-width:0;display:grid}
    .brand strong{font-size:14px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .brand small{color:var(--muted);font-size:11.5px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .icon{width:32px;height:32px;border:0;border-radius:10px;background:transparent;color:var(--muted);cursor:pointer;display:grid;place-items:center;font-size:15px}
    .icon:hover{background:var(--surface);color:var(--ink)}
    .icon[aria-pressed=true]{background:var(--surface);color:var(--accent)}
    .toolbar{display:flex;gap:6px;align-items:center;padding:7px 12px;border-bottom:1px solid var(--line);background:var(--bg);overflow-x:auto}
    .toolbar select{flex:0 1 270px;min-width:150px;max-width:270px;border:0;border-radius:9px;padding:7px 9px;background:var(--surface);color:var(--ink);font-size:12px;outline:none}
    .toolbar select:focus{box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 24%,transparent)}
    .toolbar select.think{flex:0 0 auto;max-width:150px}
    .chip{display:inline-flex;align-items:center;gap:6px;padding:6px 9px;border:0;border-radius:9px;background:var(--surface);color:var(--muted);font-size:12px;cursor:pointer;white-space:nowrap}
    .chip input{margin:0;accent-color:var(--accent)}
    .chip:has(input:checked){border-color:var(--accent);color:var(--accent)}
    .drawer{border-bottom:1px solid var(--line);padding:10px 12px;display:grid;gap:8px;background:var(--bg)}
    .drawer h4{margin:0;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
    .control{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .control .text{display:grid;min-width:0}
    .control .text span{font-weight:600;font-size:12.5px}
    .control .text small{color:var(--muted);font-size:11.5px}
    .control select,.control button{border:1px solid var(--line);border-radius:9px;padding:5px 9px;background:var(--bg);color:var(--ink);font-size:12px;cursor:pointer}
    .switch{position:relative;width:38px;height:22px;border-radius:999px;background:var(--line);border:0;cursor:pointer;flex:none;transition:background .15s}
    .switch::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0003;transition:transform .15s}
    .switch[aria-checked=true]{background:var(--accent)}.switch[aria-checked=true]::after{transform:translateX(16px)}
    .messages{flex:1;overflow:auto;padding:18px 16px 24px;background:var(--bg);display:flex;flex-direction:column;gap:16px;scrollbar-gutter:stable}
    .msg{max-width:min(82%,720px);padding:10px 13px;border-radius:16px;white-space:pre-wrap;overflow-wrap:anywhere;animation:message-in .24s cubic-bezier(.2,.8,.2,1) both}
    .user{align-self:flex-end;background:var(--user);color:var(--accent-ink);border-bottom-right-radius:5px}
    .assistant{align-self:stretch;max-width:none;padding:0 2px;background:transparent;white-space:normal}
    .assistant.streaming .md::after{content:"";display:inline-block;width:5px;height:1em;margin-left:3px;border-radius:2px;background:var(--accent);vertical-align:-.16em;animation:stream-caret .8s ease-in-out infinite}
    .assistant.error{color:#b42318;background:#fff1f2;border:1px solid #fecdd3;padding:10px 12px}
    .md{max-width:760px;color:var(--ink);overflow-wrap:anywhere}
    .md>*:first-child{margin-top:0}.md>*:last-child{margin-bottom:0}
    .md p{margin:0 0 12px}.md h1,.md h2,.md h3,.md h4{margin:18px 0 8px;line-height:1.25;letter-spacing:-.01em}.md h1{font-size:20px}.md h2{font-size:18px}.md h3{font-size:16px}.md h4{font-size:14px}
    .md ul,.md ol{margin:6px 0 14px;padding-left:22px}.md li{margin:3px 0;padding-left:2px}.md strong{font-weight:650}.md em{font-style:italic}
    .md code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface-strong);border-radius:5px;padding:2px 5px}
    .md pre{margin:10px 0 14px;padding:12px 14px;border:1px solid var(--line);border-radius:11px;background:var(--surface);overflow:auto;white-space:pre;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
    .md pre code{padding:0;background:transparent;border-radius:0;font:inherit}
    .md blockquote{margin:10px 0 14px;padding:2px 0 2px 12px;border-left:3px solid var(--line);color:var(--muted)}
    .md a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}.md a:hover{text-decoration-thickness:2px}
    .table-wrap{max-width:100%;margin:10px 0 16px;overflow-x:auto;border:1px solid var(--line);border-radius:11px}
    .md table{width:100%;border-collapse:collapse;font-size:13px}.md th,.md td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.md th{background:var(--surface);font-weight:650}.md tr:last-child td{border-bottom:0}
    .thumbs{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
    .thumbs img{width:88px;height:88px;object-fit:cover;border-radius:10px;border:1px solid #ffffff55}
    .assistant .thumbs img{border-color:var(--line);width:100%;max-width:280px;height:auto}
    details.reason{margin:0 0 6px;font-size:12px;color:var(--muted)}
    details.reason summary{cursor:pointer;font-weight:600}
    details.reason pre{margin:6px 0 0;white-space:pre-wrap;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
    .activity{align-self:stretch;max-width:760px;border:0;font-size:12px;color:var(--muted);animation:message-in .22s ease both}
    .activity>summary{display:flex;align-items:center;gap:8px;width:max-content;max-width:100%;padding:2px 2px 5px;cursor:pointer;list-style:none;color:var(--muted);font-weight:500}
    .activity>summary::-webkit-details-marker{display:none}
    .workflow-indicator{position:relative;width:13px;height:13px;border:1.5px solid var(--line);border-radius:50%;flex:none;transition:border-color .2s ease,background .2s ease,transform .2s ease}
    .activity.live .workflow-indicator{border-color:color-mix(in srgb,var(--accent) 28%,var(--line));border-top-color:var(--accent);animation:spin .9s linear infinite}
    .activity.done .workflow-indicator{border-color:var(--muted);background:var(--muted);transform:scale(.82)}
    .activity.done .workflow-indicator::after{content:"";position:absolute;left:3px;top:1px;width:4px;height:7px;border:solid var(--bg);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
    .workflow-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.workflow-chevron{font-size:16px;line-height:1;transition:transform .2s ease}.activity[open] .workflow-chevron{transform:rotate(90deg)}
    .workflow-body{position:relative;display:grid;gap:1px;padding:1px 0 2px 20px}
    .workflow-body::before{content:"";position:absolute;left:8px;top:7px;bottom:11px;width:1px;background:var(--line)}
    .step{display:flex;gap:8px;align-items:flex-start;padding:4px 2px;font-size:12px;color:var(--muted)}
    .step .dot{width:7px;height:7px;border-radius:50%;background:var(--accent);margin:6px 0 0 -15px;flex:none;box-shadow:0 0 0 3px var(--bg)}
    .step.live .dot{animation:pulse 1.2s ease-in-out infinite}
    .tool{position:relative;align-self:stretch;border:0;background:transparent;font-size:12px;overflow:visible;animation:task-in .2s ease both}
    .tool summary{display:flex;align-items:flex-start;gap:7px;padding:5px 2px;cursor:pointer;list-style:none}
    .tool summary::-webkit-details-marker{display:none}
    .tool .marker{position:relative;width:11px;height:11px;margin:3px 0 0 -18px;border-radius:50%;background:var(--bg);border:1.5px solid var(--line);flex:none;box-shadow:0 0 0 3px var(--bg);transition:background .2s ease,border-color .2s ease,transform .2s ease}
    .tool .marker.run{border-color:color-mix(in srgb,var(--accent) 30%,var(--line));border-top-color:var(--accent);animation:spin .9s linear infinite}
    .tool .marker.ok{background:var(--muted);border-color:var(--muted);transform:scale(.86)}.tool .marker.ok::after{content:"";position:absolute;left:2.5px;top:.5px;width:3px;height:5px;border:solid var(--bg);border-width:0 1.2px 1.2px 0;transform:rotate(45deg)}
    .tool .marker.err{background:#dc2626;border-color:#dc2626}.tool .marker.err::before,.tool .marker.err::after{content:"";position:absolute;left:4px;top:1px;width:1px;height:6px;background:#fff}.tool .marker.err::before{transform:rotate(45deg)}.tool .marker.err::after{transform:rotate(-45deg)}
    .tool .name{font:600 12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink)}
    .tool .source{color:var(--muted);font-size:11.5px}.tool .state{margin-left:auto;font-size:10.5px;color:var(--muted);white-space:nowrap;transition:color .2s ease}.tool .state.ok{color:#15803d}.tool .state.err{color:#b42318}.tool .state.run{color:var(--accent)}
    .tool pre{margin:2px 0 7px;padding:9px 10px;border:1px solid var(--line);border-radius:9px;background:var(--surface);white-space:pre-wrap;overflow-wrap:anywhere;font:11.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);max-height:160px;overflow:auto;animation:reveal .18s ease both}
    .tool pre b{display:block;font:600 10.5px system-ui;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin-bottom:3px}
    .setup{align-self:stretch;border:1px solid #fde68a;background:#fffbeb;color:#78350f;border-radius:14px;padding:12px 14px;display:grid;gap:6px;font-size:13px}
    .panel[data-mode=dark] .setup{background:#3b2f0b;border-color:#a16207;color:#fef3c7}
    .setup strong{font-size:13.5px}.setup p{margin:0}
    .setup-actions{display:flex;gap:8px;margin-top:4px}
    .setup-actions button{border:1px solid #fcd34d;border-radius:10px;padding:6px 11px;background:#fff;color:#78350f;font-size:12.5px;cursor:pointer}
    .setup-actions button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
    .setup.blocked{border-color:#fecaca;background:#fee4e2;color:#7f1d1d}
    .panel[data-mode=dark] .setup.blocked{background:#3f1212;border-color:#b91c1c;color:#fee2e2}
    .setup.blocked .setup-actions button{border-color:#fca5a5;color:#7f1d1d}
    .suggestions{display:flex;flex-wrap:wrap;gap:6px}
    .suggestions button{border:1px solid var(--line);border-radius:999px;background:var(--bubble);color:var(--ink);padding:6px 11px;font-size:12px;cursor:pointer;text-align:left}
    .suggestions button:hover{border-color:var(--accent)}
    .composer{border-top:1px solid var(--line);padding:10px 12px 9px;background:var(--bg)}
    .attach-strip{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
    .attach-strip figure{position:relative;margin:0}
    .attach-strip img{width:56px;height:56px;object-fit:cover;border-radius:10px;border:1px solid var(--line)}
    .attach-strip button{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:0;background:var(--ink);color:var(--bg);font-size:12px;cursor:pointer;line-height:1}
    .compose-row{display:flex;gap:8px;align-items:flex-end;border:1px solid var(--line);border-radius:16px;padding:6px 6px 6px 9px;background:var(--bg);box-shadow:0 1px 2px #0f172a08}
    .compose-row:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
    .compose-row textarea{flex:1;min-width:0;border:0;outline:0;resize:none;background:transparent;color:var(--ink);max-height:140px;padding:6px 2px;line-height:1.45}
    .send{width:34px;height:34px;border:0;border-radius:11px;background:var(--accent);color:var(--accent-ink);cursor:pointer;display:grid;place-items:center;font-size:15px;flex:none;transition:transform .15s ease,filter .15s ease}.send:not(:disabled):hover{transform:translateY(-1px);filter:brightness(1.04)}.send:not(:disabled):active{transform:scale(.94)}
    .send:disabled{opacity:.45;cursor:default}
    .stop{background:#0f172a}
    .telemetry{margin:5px 2px 0;color:var(--muted);font-size:10.5px}
    .telemetry summary{width:max-content;cursor:pointer;list-style:none;padding:1px 0}.telemetry summary::-webkit-details-marker{display:none}.telemetry summary::after{content:" · details";opacity:.7}.telemetry[open] summary::after{content:" · hide"}
    .status{display:flex;gap:5px 12px;flex-wrap:wrap;padding-top:5px;font-size:10.5px;color:var(--muted)}
    .status b{font-weight:600;color:var(--ink)}
    .meter{display:inline-block;width:42px;height:3px;border-radius:2px;background:var(--line);vertical-align:middle;overflow:hidden}
    .meter i{display:block;height:100%;background:var(--accent)}
    .overlay{pointer-events:auto;position:fixed;inset:0;background:#0f172a99;display:grid;place-items:center;padding:18px;font:14px/1.5 system-ui,-apple-system,sans-serif}
    .consent{width:min(520px,100%);max-height:calc(100vh - 36px);display:flex;flex-direction:column;background:#fff;color:#0f172a;border-radius:20px;box-shadow:0 30px 90px #0008;overflow:hidden}
    .consent-head{padding:20px 24px 12px;border-bottom:1px solid #e6e9f0}
    .consent-body{flex:1;min-height:0;overflow-y:scroll;scrollbar-gutter:stable;padding:12px 24px;scrollbar-width:auto}
    .consent-body::-webkit-scrollbar{width:12px}.consent-body::-webkit-scrollbar-thumb{background:#c7cdd8;border-radius:6px;border:3px solid #fff}.consent-body::-webkit-scrollbar-track{background:#f3f4f8}
    .consent-foot{padding:12px 24px 18px;border-top:1px solid #e6e9f0;background:#fff;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
    .consent-hint{font-size:12px;color:#64748b}.consent-hint[hidden]{display:none}
    .consent h2{margin:0 0 4px;font-size:19px}
    .consent .origin{color:#64748b;overflow-wrap:anywhere;font-size:13px}
    .consent .scope{padding:10px 12px;margin:8px 0;background:#f6f7fb;border-radius:12px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}
    .consent details{margin:8px 0;font-size:13px}.consent summary{cursor:pointer;font-weight:600}
    .consent pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f6f7fb;padding:10px;border-radius:10px;margin:6px 0 0}
    .consent label.field{display:grid;gap:5px;margin:10px 0;font-weight:600;font-size:13px}
    .consent label.field input,.consent label.field select{font-weight:400;border:1px solid #d5dae3;border-radius:10px;padding:8px 10px;background:#fff;color:#0f172a}
    .consent label.field input[type=checkbox]{justify-self:start;width:18px;height:18px;accent-color:var(--accent)}
    .consent .validation{min-height:18px;color:#b42318;font-size:12px}
    .consent .providers{display:grid;gap:6px;margin:6px 0 10px}
    .consent .providers label{display:flex;gap:8px;align-items:center;font-size:13px}
    .consent .notice{font-size:12px;color:#64748b;margin:10px 0 0}
    .consent .actions{display:flex;justify-content:flex-end;gap:8px;margin:0 0 0 auto}
    .consent .actions button{border:1px solid #d5dae3;border-radius:11px;padding:9px 15px;background:#fff;color:#0f172a;cursor:pointer;font-weight:600}
    .consent .actions .allow{border-color:var(--accent);background:var(--accent);color:var(--accent-ink)}
    .consent .level{display:inline-block;padding:2px 8px;border-radius:999px;background:var(--accent);color:var(--accent-ink);font-size:11px;font-weight:600;vertical-align:middle;margin-left:6px}
    /* Chat-style conversation shell with broker-owned model and usage controls. */
    .panel{width:min(600px,calc(100vw - 24px));height:min(760px,calc(100vh - 110px));border-radius:22px}
    .head{padding:12px 12px 11px 18px}.brand strong{font-size:15px}.brand small{font-size:11px}
    .messages{padding:24px 28px 30px;gap:20px}
    .messages.empty{justify-content:center;padding-top:72px;padding-bottom:28px}
    .welcome{width:100%;max-width:500px;margin:auto;display:grid;gap:18px;animation:message-in .3s ease both}
    .welcome h2{margin:0;color:var(--ink);font-size:25px;line-height:1.16;letter-spacing:-.025em;font-weight:650}
    .welcome p{margin:-9px 0 0;color:var(--muted);font-size:13.5px}
    .suggestions{display:grid;gap:4px}
    .suggestions button{display:flex;align-items:center;gap:12px;width:100%;border:0;border-radius:12px;background:transparent;color:var(--muted);padding:10px 8px;font-size:14px}
    .suggestions button::before{content:"✦";width:22px;color:var(--muted);font-size:15px;text-align:center}
    .suggestions button:nth-child(2n)::before{content:"⌘"}.suggestions button:hover{border:0;background:var(--surface);color:var(--ink)}
    .msg{font-size:14px}.user{background:var(--surface);color:var(--ink);border-bottom-right-radius:16px;padding:9px 13px}.assistant{line-height:1.6}
    .composer{position:relative;border-top:0;padding:8px 14px 12px;background:linear-gradient(180deg,transparent 0,var(--bg) 13%)}
    .compose-shell{position:relative;border:1px solid var(--line);border-radius:22px;padding:10px;background:var(--bg);box-shadow:0 10px 30px #0f172a0d,0 1px 2px #0f172a0d;transition:border-color .15s,box-shadow .15s}
    .compose-shell:focus-within{border-color:color-mix(in srgb,var(--ink) 22%,var(--line));box-shadow:0 12px 34px #0f172a14}
    .compose-shell textarea{display:block;width:100%;min-height:45px;max-height:150px;padding:2px 5px 8px;border:0;outline:0;resize:none;background:transparent;color:var(--ink);line-height:1.5;font-size:14px}
    .compose-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
    .compose-left,.compose-right{display:flex;align-items:center;gap:4px;min-width:0}.compose-left{flex:1}
    .compose-control{height:32px;border:0;border-radius:10px;background:transparent;color:var(--ink);cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:0 8px;white-space:nowrap;font-size:12.5px}
    .compose-control:hover,.compose-control[aria-expanded=true]{background:var(--surface)}.compose-control:disabled{opacity:.45;cursor:default}
    .attach.compose-control{width:32px;padding:0;justify-content:center;font-size:19px}.context-toggle{padding:0;width:32px;justify-content:center;font-size:16px}.context-toggle input{position:absolute;opacity:0;pointer-events:none}.context-toggle:has(input:checked){background:var(--surface-strong);color:var(--accent)}
    .model-picker{position:relative;min-width:0}.model-button{max-width:190px}.model-label{overflow:hidden;text-overflow:ellipsis}.chevron{font-size:13px;color:var(--muted)}
    .model-menu{position:absolute;left:0;bottom:calc(100% + 10px);z-index:8;width:min(330px,calc(100vw - 70px));max-height:360px;overflow:auto;padding:8px;border:1px solid var(--line);border-radius:17px;background:var(--bg);box-shadow:0 20px 50px #0f172a2b,0 2px 8px #0f172a12;animation:popover-in .15s ease both}
    .menu-title{padding:7px 10px 8px;color:var(--muted);font-size:12px}.menu-group{padding:7px 10px 3px;color:var(--muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em}
    .model-option{width:100%;display:flex;align-items:center;gap:9px;border:0;border-radius:11px;background:transparent;color:var(--ink);padding:9px 10px;cursor:pointer;text-align:left}.model-option:hover,.model-option.selected{background:var(--surface)}.model-option span:first-child{flex:1}.model-option small{color:var(--muted)}.model-check{width:14px;font-weight:700}
    .think{height:32px;max-width:130px;border:0;border-radius:10px;background:transparent;color:var(--muted);padding:0 5px;font-size:12px;outline:0;cursor:pointer}.think:hover{background:var(--surface);color:var(--ink)}
    .send{width:36px;height:36px;border-radius:50%;background:var(--ink);color:var(--bg);font-size:17px}.stop{background:var(--surface-strong);color:var(--ink);font-size:12px}
    .telemetry{position:relative;margin:0;color:var(--muted);font-size:12px}.telemetry>summary{display:grid;place-items:center;width:32px;height:32px;padding:0;border-radius:10px;cursor:pointer;list-style:none}.telemetry>summary::after,.telemetry[open]>summary::after{content:none}.telemetry>summary::-webkit-details-marker{display:none}.telemetry>summary:hover,.telemetry[open]>summary{background:var(--surface)}
    .usage-ring{width:19px;height:19px;border-radius:50%;background:conic-gradient(var(--usage-color,var(--accent)) var(--usage-angle,0deg),var(--line) 0);display:grid;place-items:center}.usage-ring::after{content:"";width:11px;height:11px;border-radius:50%;background:var(--bg)}
    .status{position:absolute;right:-48px;bottom:43px;z-index:9;width:min(420px,calc(100vw - 54px));max-height:min(560px,calc(100vh - 180px));overflow:auto;display:block;padding:18px;border:1px solid var(--line);border-radius:18px;background:var(--bg);color:var(--ink);box-shadow:0 24px 60px #0f172a30,0 2px 8px #0f172a12;animation:popover-in .15s ease both}
    .usage-section+.usage-section{margin-top:16px;padding-top:16px;border-top:1px solid var(--line)}.usage-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:8px}.usage-heading span{color:var(--muted);font-size:12px}.usage-heading strong{font-size:13px;font-weight:600}
    .usage-bar{height:7px;border-radius:999px;background:var(--surface-strong);overflow:hidden}.usage-bar i{display:block;height:100%;border-radius:inherit;background:var(--bar-color,var(--accent));transition:width .25s ease}
    .usage-rows{display:grid;gap:9px;margin-top:12px}.usage-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center}.usage-row .label{display:flex;align-items:center;gap:8px;min-width:0}.usage-row .swatch{width:9px;height:9px;border-radius:3px;background:var(--row-color,var(--accent));flex:none}.usage-row .value{color:var(--muted);font-variant-numeric:tabular-nums;text-align:right}.quota-row{display:grid;gap:6px;margin-top:12px}.quota-line{display:flex;justify-content:space-between;gap:10px}.quota-line span:last-child{color:var(--muted);text-align:right}.usage-note{margin:10px 0 0;color:var(--muted);font-size:11.5px;line-height:1.45}.usage-empty{color:var(--muted)}
    .context-glance{width:100%;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:9px;margin-top:7px;padding:0 5px;border:0;background:transparent;color:var(--muted);font-size:10.5px;cursor:pointer;text-align:left}.context-glance strong{font-weight:500;color:var(--muted);font-variant-numeric:tabular-nums}.context-track{height:3px;border-radius:999px;background:var(--surface-strong);overflow:hidden}.context-track i{display:block;height:100%;width:0;background:var(--accent);border-radius:inherit}
    .activity{font-size:13px}.activity>summary{padding:4px 0 6px}.workflow-body{gap:2px}
    .panel[data-tool-view=compact] .tool .source,.panel[data-tool-view=compact] .tool .state{display:none}
    .panel[data-tool-view=detailed] .workflow-body{padding:5px 0}.panel[data-tool-view=detailed] .workflow-body::before{display:none}
    .panel[data-tool-view=detailed] .tool{margin:7px 0;border:1px solid var(--line);border-radius:15px;background:var(--bg);overflow:hidden}.panel[data-tool-view=detailed] .tool summary{padding:12px 13px}.panel[data-tool-view=detailed] .tool .marker{margin:3px 0 0}.panel[data-tool-view=detailed] .tool pre{margin:0 12px 12px;max-height:220px}.panel[data-tool-view=detailed] .tool .name{font-size:12.5px;overflow-wrap:anywhere}
    @keyframes panel-in{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
    @keyframes popover-in{from{opacity:0;transform:translateY(5px) scale(.985)}to{opacity:1;transform:none}}
    @keyframes message-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    @keyframes task-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
    @keyframes reveal{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
    @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.42;transform:scale(.72)}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes stream-caret{0%,100%{opacity:.25}50%{opacity:1}}
    @media (prefers-reduced-motion:reduce){.panel:not([hidden]),.msg,.activity,.tool,.tool pre,.launcher,.send,.workflow-indicator,.tool .marker,.assistant.streaming .md::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
    @media (max-width:520px){.messages{padding:18px 14px 22px}.messages.empty{padding-top:44px}.msg{max-width:90%}.welcome h2{font-size:22px}.model-button{max-width:140px}.status{right:-48px}.context-glance{grid-template-columns:auto 1fr}.context-glance strong{grid-column:1/-1;justify-self:end;margin-top:-4px}}
  `;

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
    style.textContent = STYLE;
    root.append(style);
    root.append(
      build(`<button class="launcher" hidden title="Open AI assistant" aria-label="Open AI assistant"><svg viewBox="0 0 128 128" width="30" height="30" aria-hidden="true"><path d="M32 30 C32 66 58 64 64 94" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round"/><path d="M96 30 C96 66 70 64 64 94" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round"/><circle cx="64" cy="98" r="10" fill="currentColor"/></svg></button>
<section class="panel" hidden data-mode="light" role="dialog" aria-label="AI assistant">
  <header class="head">
    <div class="brand"><strong class="name">AI assistant</strong><small class="sub">अर्जुनः</small></div>
    <button class="icon options" title="Options" aria-label="Options" aria-pressed="false">⚙</button>
    <button class="icon clear" title="Clear chat" aria-label="Clear chat">↺</button>
    <button class="icon close" title="Close" aria-label="Close">×</button>
  </header>
  <div class="drawer" hidden></div>
  <main class="messages"></main>
  <footer class="composer">
    <div class="attach-strip" hidden></div>
    <div class="compose-shell">
      <textarea rows="1" maxlength="12000" placeholder="Ask about this site…" aria-label="Message"></textarea>
      <div class="compose-actions">
        <div class="compose-left">
          <button class="attach compose-control" title="Attach image" aria-label="Attach image" hidden>＋</button>
          <label class="context-toggle compose-control" title="Share page context"><input type="checkbox" aria-label="Share page context"><span>@</span></label>
          <div class="model-picker">
            <button class="model-button compose-control" title="Select model" aria-label="Select model" aria-haspopup="listbox" aria-expanded="false"><span class="model-label">Select model</span><span class="chevron">⌄</span></button>
            <div class="model-menu" role="listbox" hidden></div>
          </div>
          <select class="think" title="Thinking effort" aria-label="Thinking effort" hidden></select>
        </div>
        <div class="compose-right">
          <details class="telemetry"><summary title="Context and usage" aria-label="Context and usage"><span class="usage-ring"></span></summary><div class="status"></div></details>
          <button class="send" title="Send" aria-label="Send">↑</button>
          <button class="send stop" title="Stop" aria-label="Stop" hidden>■</button>
        </div>
      </div>
    </div>
    <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
    <button class="context-glance" title="Open context and usage details"><span>Context window</span><span class="context-track"><i></i></span><strong>—</strong></button>
  </footer>
</section>`),
    );
    document.documentElement.appendChild(host);
    launcher = root.querySelector(".launcher");
    panel = root.querySelector(".panel");
    messages = root.querySelector(".messages");
    contextToggle = root.querySelector(".context-toggle input");
    input = root.querySelector("textarea");
    sendButton = root.querySelector(".send:not(.stop)");
    stopButton = root.querySelector(".stop");
    attachButton = root.querySelector(".attach");
    fileInput = root.querySelector("input[type=file]");
    modelSelect = root.querySelector(".model-button");
    modelMenu = root.querySelector(".model-menu");
    thinkSelect = root.querySelector(".think");
    drawer = root.querySelector(".drawer");
    statusLine = root.querySelector(".status");
    contextGlance = root.querySelector(".context-glance");
    launcher.addEventListener("click", openPanel);
    root.querySelector(".close").addEventListener("click", () => {
      panel.hidden = true;
    });
    root.querySelector(".clear").addEventListener("click", () => {
      cancelSession();
      conversationId = crypto.randomUUID();
      history = [];
      lastTurn = null;
      session = { promptTokens: 0, completionTokens: 0, turns: 0 };
      renderHistory();
      renderStatus();
    });
    root.querySelector(".options").addEventListener("click", (event) => {
      drawer.hidden = !drawer.hidden;
      event.currentTarget.setAttribute("aria-pressed", String(!drawer.hidden));
    });
    sendButton.addEventListener("click", submitChat);
    stopButton.addEventListener("click", () => {
      cancelSession();
      addBubble("assistant", "Stopped.", { error: false, persist: false });
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submitChat();
      }
    });
    input.addEventListener("input", () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
    });
    attachButton.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      for (const file of fileInput.files) await addAttachment(file);
      fileInput.value = "";
    });
    input.addEventListener("paste", async (event) => {
      const files = [...(event.clipboardData?.files ?? [])].filter((file) =>
        IMAGE_TYPES.includes(file.type),
      );
      if (files.length && !attachButton.hidden) {
        event.preventDefault();
        for (const file of files) await addAttachment(file);
      }
    });
    modelSelect.addEventListener("click", () => {
      if (modelSelect.disabled) return;
      modelMenu.hidden = !modelMenu.hidden;
      modelSelect.setAttribute("aria-expanded", String(!modelMenu.hidden));
    });
    contextGlance.addEventListener("click", () => {
      const details = root.querySelector(".telemetry");
      details.open = !details.open;
    });
    root.addEventListener("click", (event) => {
      if (!event.target.closest(".model-picker")) {
        modelMenu.hidden = true;
        modelSelect.setAttribute("aria-expanded", "false");
      }
    });
    thinkSelect.addEventListener("change", () => {
      reasoningEffort = thinkSelect.value;
    });
    enableDrag(root.querySelector(".head"));
  }
  function build(html) {
    // Static, extension-authored markup only; parsed without touching innerHTML.
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const fragment = document.createDocumentFragment();
    fragment.append(...parsed.body.childNodes);
    return fragment;
  }

  /** Move the panel by its header; resizing keeps using the CSS handle. */
  function enableDrag(handle) {
    let start = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const rect = panel.getBoundingClientRect();
      start = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!start) return;
      const rect = panel.getBoundingClientRect();
      const left = Math.min(
        Math.max(0, event.clientX - start.x),
        window.innerWidth - rect.width,
      );
      const top = Math.min(
        Math.max(0, event.clientY - start.y),
        window.innerHeight - rect.height,
      );
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });
    const stop = () => {
      start = null;
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  function applyManifest() {
    if (!root) return;
    const manifest = registration?.manifest;
    root.querySelector(".name").textContent = manifest?.name ?? "AI assistant";
    const theme = manifest?.widget.theme;
    host.style.setProperty("--accent", theme?.accent ?? "#3b5bdb");
    host.style.setProperty(
      "--accent-ink",
      theme?.accent && luminance(theme.accent) > 0.6 ? "#0f172a" : "#fff",
    );
    panel.dataset.mode = theme?.mode ?? "light";
    panel.dataset.toolView = manifest?.widget.toolCallView ?? "compact";
    input.placeholder = manifest?.widget.placeholder || "Ask about this site…";
    renderControls();
    renderSuggestions();
  }
  function luminance(hex) {
    const [r, g, b] = [1, 3, 5].map(
      (index) => parseInt(hex.slice(index, index + 2), 16) / 255,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function renderControls() {
    if (!drawer) return;
    const list = registration?.manifest.widget.controls ?? [];
    drawer.textContent = "";
    root.querySelector(".options").hidden = !list.length;
    if (!list.length) {
      drawer.hidden = true;
      return;
    }
    const title = document.createElement("h4");
    title.textContent = "Options";
    drawer.append(title);
    for (const control of list) {
      const row = document.createElement("div");
      row.className = "control";
      const text = document.createElement("div");
      text.className = "text";
      const label = document.createElement("span");
      label.textContent = control.label;
      text.append(label);
      if (control.description) {
        const small = document.createElement("small");
        small.textContent = control.description;
        text.append(small);
      }
      row.append(text);
      if (control.type === "toggle") {
        const button = document.createElement("button");
        button.className = "switch";
        button.setAttribute("role", "switch");
        button.setAttribute("aria-checked", String(controls[control.id]));
        button.setAttribute("aria-label", control.label);
        button.addEventListener("click", () => {
          controls[control.id] = !controls[control.id];
          button.setAttribute("aria-checked", String(controls[control.id]));
          announceControl(control.id, controls[control.id]);
        });
        row.append(button);
      } else if (control.type === "select") {
        const select = document.createElement("select");
        select.setAttribute("aria-label", control.label);
        for (const option of control.options) {
          const item = document.createElement("option");
          item.value = option.value;
          item.textContent = option.label;
          item.selected = option.value === controls[control.id];
          select.append(item);
        }
        select.addEventListener("change", () => {
          controls[control.id] = select.value;
          announceControl(control.id, select.value);
        });
        row.append(select);
      } else {
        const button = document.createElement("button");
        button.textContent = control.label;
        button.addEventListener("click", () =>
          announceControl(control.id, true),
        );
        row.append(button);
      }
      drawer.append(row);
    }
  }
  function announceControl(id, value) {
    if (!registration) return;
    toPage({
      kind: "control-change",
      registrationId: registration.id,
      id,
      value,
      values: { ...controls },
    });
  }
  function renderSuggestions() {
    root.querySelector(".welcome")?.remove();
    const list = registration?.manifest.widget.suggestions ?? [];
    messages.classList.toggle("empty", !history.length);
    if (history.length) return;
    const welcome = document.createElement("section");
    welcome.className = "welcome";
    const title = document.createElement("h2");
    title.textContent = `How can I help with ${registration?.manifest.name ?? "this site"}?`;
    welcome.append(title);
    if (registration?.manifest.widget.greeting) {
      const greeting = document.createElement("p");
      greeting.textContent = registration.manifest.widget.greeting;
      welcome.append(greeting);
    }
    if (!list.length) {
      messages.append(welcome);
      return;
    }
    const box = document.createElement("div");
    box.className = "suggestions";
    for (const text of list) {
      const button = document.createElement("button");
      button.textContent = text;
      button.addEventListener("click", () => {
        input.value = text;
        input.dispatchEvent(new Event("input"));
        input.focus();
      });
      box.append(button);
    }
    welcome.append(box);
    messages.append(welcome);
  }

  async function refreshSettings() {
    try {
      settings = await runtime("hosted.settings");
    } catch {
      settings = null;
    }
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
    root.querySelector(".setup")?.remove();
    // Unknown state (settings not loaded) never blocks the composer.
    const blocked = settings !== null && !settings.model;
    input.disabled = blocked || busy;
    sendButton.disabled = blocked;
    attachButton.disabled = blocked;
    input.placeholder = blocked
      ? "Finish the setup above to start chatting"
      : registration?.manifest.widget.placeholder || "Ask about this site…";
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
    messages.prepend(card);
  }
  function renderModelSelect() {
    if (!modelSelect) return;
    const current = pendingModel ?? settings?.model?.id ?? "";
    const groups = new Map();
    for (const model of settings?.models ?? []) {
      if (!groups.has(model.providerName)) groups.set(model.providerName, []);
      groups.get(model.providerName).push(model);
    }
    modelMenu.textContent = "";
    const title = document.createElement("div");
    title.className = "menu-title";
    title.textContent = "Select model";
    modelMenu.append(title);
    if (!groups.size) {
      root.querySelector(".model-label").textContent = "No model";
      modelSelect.disabled = true;
    } else {
      modelSelect.disabled = false;
      for (const [provider, list] of groups) {
        const group = document.createElement("div");
        group.className = "menu-group";
        group.textContent = provider;
        modelMenu.append(group);
        for (const model of list) {
          const option = document.createElement("button");
          option.type = "button";
          option.className = `model-option${model.id === current ? " selected" : ""}`;
          option.setAttribute("role", "option");
          option.setAttribute("aria-selected", String(model.id === current));
          const label = document.createElement("span");
          label.textContent = model.displayName;
          const windowLabel = document.createElement("small");
          windowLabel.textContent = model.contextWindow
            ? compactNumber(model.contextWindow)
            : "";
          const check = document.createElement("span");
          check.className = "model-check";
          check.textContent = model.id === current ? "✓" : "";
          option.append(label, windowLabel, check);
          option.addEventListener("click", () => {
            modelMenu.hidden = true;
            modelSelect.setAttribute("aria-expanded", "false");
            void switchModel(model.id);
          });
          modelMenu.append(option);
        }
      }
      const selected = (settings?.models ?? []).find(
        (model) => model.id === current,
      );
      root.querySelector(".model-label").textContent =
        selected?.displayName ?? settings?.model?.displayName ?? "Select model";
    }
    const active = settings?.model;
    const levels =
      (settings?.models ?? []).find((model) => model.id === current)
        ?.reasoningLevels ??
      active?.reasoningLevels ??
      [];
    thinkSelect.hidden = !levels.length;
    if (levels.length) {
      thinkSelect.textContent = "";
      const auto = document.createElement("option");
      auto.value = "";
      auto.textContent = active?.defaultReasoning
        ? `Thinking: default (${active.defaultReasoning})`
        : "Thinking: default";
      thinkSelect.append(auto);
      for (const level of levels) {
        const option = document.createElement("option");
        option.value = level;
        option.textContent = `Thinking: ${level}`;
        thinkSelect.append(option);
      }
      if (!levels.includes(reasoningEffort)) reasoningEffort = "";
      thinkSelect.value = reasoningEffort;
    } else reasoningEffort = "";
    root.querySelector(".sub").textContent = active
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
    attachButton.hidden = !vision;
    if (!vision) {
      attachments = [];
      renderAttachments();
    }
  }
  async function switchModel(id) {
    if (!id) return;
    if (!settings?.grant) {
      // No grant yet: remember the choice for the consent dialog.
      pendingModel = id;
      renderModelSelect();
      return;
    }
    try {
      settings = await runtime("hosted.model", { model: id });
      pendingModel = null;
      renderModelSelect();
      renderStatus();
    } catch (error) {
      addBubble("assistant", `Could not switch model: ${error.message}`, {
        error: true,
        persist: false,
      });
      renderModelSelect();
    }
  }

  function renderStatus() {
    if (!statusLine) return;
    statusLine.textContent = "";
    const window_ = lastTurn?.contextWindow ?? settings?.model?.contextWindow;
    const prompt = lastTurn?.promptTokens ?? 0;
    const contextPercent = window_
      ? Math.min(100, (prompt / window_) * 100)
      : 0;
    const contextSection = usageSection(
      "Context window",
      window_
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
    contextRows.append(
      usageRow("Current prompt", compactNumber(prompt), "#3b82f6"),
    );
    if (lastTurn?.cachedTokens)
      contextRows.append(
        usageRow(
          "Cached portion",
          compactNumber(lastTurn.cachedTokens),
          "#10b981",
        ),
      );
    if (window_)
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
      rows.append(
        usageRow(
          "Session total",
          compactNumber(session.promptTokens + session.completionTokens),
          "#64748b",
        ),
        usageRow(
          "Hosted history",
          `${Math.min(history.length, HISTORY_LIMIT)} / ${HISTORY_LIMIT} messages`,
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
    glance.querySelector("strong").textContent = window_
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
    const ring = root.querySelector(".usage-ring");
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

  function compactNumber(value) {
    const number = Number(value || 0);
    if (number >= 1_000_000)
      return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}M`;
    if (number >= 1000)
      return `${(number / 1000).toFixed(number >= 100_000 ? 0 : 1)}k`;
    return number.toLocaleString();
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

  async function addAttachment(file) {
    if (!IMAGE_TYPES.includes(file.type) || attachments.length >= 4) return;
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    if (data.length > 2000000) {
      addBubble(
        "assistant",
        `${file.name} is too large (limit about 1.5 MB).`,
        {
          error: true,
          persist: false,
        },
      );
      return;
    }
    attachments.push({ type: "image", mediaType: file.type, data });
    renderAttachments();
  }
  function renderAttachments() {
    const strip = root.querySelector(".attach-strip");
    strip.textContent = "";
    strip.hidden = !attachments.length;
    attachments.forEach((item, index) => {
      const figure = document.createElement("figure");
      const img = document.createElement("img");
      img.src = `data:${item.mediaType};base64,${item.data}`;
      img.alt = "Attached image";
      const remove = document.createElement("button");
      remove.textContent = "×";
      remove.title = "Remove";
      remove.addEventListener("click", () => {
        attachments.splice(index, 1);
        renderAttachments();
      });
      figure.append(img, remove);
      strip.append(figure);
    });
  }

  function openPanel() {
    ensureUi();
    panel.hidden = false;
    applyManifest();
    renderSuggestions();
    void refreshSettings();
    queueMicrotask(() => input.focus());
  }

  function appendMarkdownInline(parent, value) {
    const text = String(value ?? "");
    const tokens =
      /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let cursor = 0;
    for (const match of text.matchAll(tokens)) {
      if (match.index > cursor)
        parent.append(document.createTextNode(text.slice(cursor, match.index)));
      if (match[1] != null) {
        const strong = document.createElement("strong");
        strong.textContent = match[1];
        parent.append(strong);
      } else if (match[2] != null) {
        const code = document.createElement("code");
        code.textContent = match[2];
        parent.append(code);
      } else {
        const link = document.createElement("a");
        link.textContent = match[3];
        link.href = match[4];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        parent.append(link);
      }
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length)
      parent.append(document.createTextNode(text.slice(cursor)));
  }

  function markdownCells(line) {
    let value = line.trim();
    if (value.startsWith("|")) value = value.slice(1);
    if (value.endsWith("|")) value = value.slice(0, -1);
    return value.split("|").map((cell) => cell.trim());
  }

  function isMarkdownTableDivider(line) {
    const cells = markdownCells(line);
    return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  /** Render a small safe Markdown subset without ever interpreting model HTML. */
  function renderMarkdown(value) {
    const container = document.createElement("div");
    container.className = "md";
    const lines = String(value ?? "")
      .replace(/\r\n?/g, "\n")
      .split("\n");
    const startsBlock = (index) => {
      const line = lines[index] ?? "";
      return (
        !line.trim() ||
        /^\s*```/.test(line) ||
        /^\s*#{1,4}\s+/.test(line) ||
        /^\s*>\s?/.test(line) ||
        /^\s*(?:[-*]|\d+\.)\s+/.test(line) ||
        /^\s*-{3,}\s*$/.test(line) ||
        (index + 1 < lines.length &&
          line.includes("|") &&
          isMarkdownTableDivider(lines[index + 1]))
      );
    };
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index++;
        continue;
      }
      const fence = line.match(/^\s*```([^\s`]*)\s*$/);
      if (fence) {
        const body = [];
        index++;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index]))
          body.push(lines[index++]);
        if (index < lines.length) index++;
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        if (fence[1]) code.dataset.language = fence[1];
        code.textContent = body.join("\n");
        pre.append(code);
        container.append(pre);
        continue;
      }
      if (
        line.includes("|") &&
        index + 1 < lines.length &&
        isMarkdownTableDivider(lines[index + 1])
      ) {
        const headers = markdownCells(line);
        index += 2;
        const wrapper = document.createElement("div");
        wrapper.className = "table-wrap";
        const table = document.createElement("table");
        const head = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const value of headers) {
          const cell = document.createElement("th");
          appendMarkdownInline(cell, value);
          headRow.append(cell);
        }
        head.append(headRow);
        table.append(head);
        const body = document.createElement("tbody");
        while (index < lines.length && lines[index].includes("|")) {
          const row = document.createElement("tr");
          const cells = markdownCells(lines[index++]);
          for (let column = 0; column < headers.length; column++) {
            const cell = document.createElement("td");
            appendMarkdownInline(cell, cells[column] ?? "");
            row.append(cell);
          }
          body.append(row);
        }
        table.append(body);
        wrapper.append(table);
        container.append(wrapper);
        continue;
      }
      const heading = line.match(/^\s*(#{1,4})\s+(.+)$/);
      if (heading) {
        const node = document.createElement(`h${heading[1].length}`);
        appendMarkdownInline(node, heading[2]);
        container.append(node);
        index++;
        continue;
      }
      const list = line.match(/^\s*([-*]|\d+\.)\s+(.+)$/);
      if (list) {
        const ordered = /\d/.test(list[1]);
        const node = document.createElement(ordered ? "ol" : "ul");
        while (index < lines.length) {
          const item = lines[index].match(/^\s*([-*]|\d+\.)\s+(.+)$/);
          if (!item || /\d/.test(item[1]) !== ordered) break;
          const entry = document.createElement("li");
          appendMarkdownInline(entry, item[2]);
          node.append(entry);
          index++;
        }
        container.append(node);
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        const quote = document.createElement("blockquote");
        const values = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index]))
          values.push(lines[index++].replace(/^\s*>\s?/, ""));
        appendMarkdownInline(quote, values.join(" "));
        container.append(quote);
        continue;
      }
      if (/^\s*-{3,}\s*$/.test(line)) {
        container.append(document.createElement("hr"));
        index++;
        continue;
      }
      const paragraph = [];
      while (index < lines.length && !startsBlock(index))
        paragraph.push(lines[index++].trim());
      if (!paragraph.length) {
        paragraph.push(lines[index++].trim());
      }
      const node = document.createElement("p");
      appendMarkdownInline(node, paragraph.join(" "));
      container.append(node);
    }
    return container;
  }

  function addBubble(role, content, { persist = true, error = false } = {}) {
    if (persist) history.push({ role, content });
    root.querySelector(".welcome")?.remove();
    messages.classList.remove("empty");
    const item = document.createElement("div");
    item.className = `msg ${role}${error ? " error" : ""}`;
    const parts = Array.isArray(content)
      ? content
      : [{ type: "text", text: content }];
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    if (text)
      item.append(
        role === "assistant"
          ? renderMarkdown(text)
          : document.createTextNode(text),
      );
    const images = parts.filter((part) => part.type === "image");
    if (images.length) {
      const thumbs = document.createElement("div");
      thumbs.className = "thumbs";
      for (const image of images) {
        const img = document.createElement("img");
        img.src = `data:${image.mediaType};base64,${image.data}`;
        img.alt = role === "user" ? "Attached image" : "Generated image";
        thumbs.append(img);
      }
      item.append(thumbs);
    }
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
    renderStatus();
    return item;
  }
  function addAssistantResult(result, streamedItem = null) {
    const message = result.message;
    const content = message.content || "The model returned an empty response.";
    let item;
    if (streamedItem?.isConnected && typeof content === "string") {
      history.push({ role: "assistant", content });
      streamedItem.classList.remove("streaming");
      streamedItem.replaceChildren(renderMarkdown(content));
      item = streamedItem;
    } else item = addBubble("assistant", content);
    if (message.reasoning) {
      const details = document.createElement("details");
      details.className = "reason";
      const summary = document.createElement("summary");
      summary.textContent = "Reasoning";
      const pre = document.createElement("pre");
      pre.textContent = message.reasoning;
      details.append(summary, pre);
      item.prepend(details);
    }
    if (message.attachments?.length) {
      const thumbs = document.createElement("div");
      thumbs.className = "thumbs";
      for (const image of message.attachments) {
        if (!IMAGE_TYPES.includes(image.mediaType)) continue;
        const img = document.createElement("img");
        img.src = `data:${image.mediaType};base64,${image.data}`;
        img.alt = "Generated image";
        thumbs.append(img);
      }
      item.append(thumbs);
    }
    messages.scrollTop = messages.scrollHeight;
  }
  function renderHistory() {
    messages.textContent = "";
    for (const item of history)
      addBubble(item.role, item.content, { persist: false });
    renderSuggestions();
  }

  /** Live activity for the running turn: model rounds and tool calls. */
  function startActivity(turnId) {
    activity = document.createElement("details");
    activity.className = "activity live";
    activity.dataset.turn = turnId;
    activity.open = true;
    const summary = document.createElement("summary");
    const indicator = document.createElement("span");
    indicator.className = "workflow-indicator";
    const title = document.createElement("span");
    title.className = "workflow-title";
    title.textContent = "Thinking…";
    const chevron = document.createElement("span");
    chevron.className = "workflow-chevron";
    chevron.textContent = "›";
    summary.append(indicator, title, chevron);
    const body = document.createElement("div");
    body.className = "workflow-body";
    activity.append(summary, body);
    messages.append(activity);
    currentTurn = {
      id: turnId,
      startedAt: Date.now(),
      steps: new Map(),
      promptTokens: 0,
      completionTokens: 0,
      timer: null,
      title,
      body,
      outputItem: null,
      outputText: "",
      outputRender: 0,
    };
    currentTurn.timer = setInterval(() => {
      if (!currentTurn) return;
      const seconds = ((Date.now() - currentTurn.startedAt) / 1000).toFixed(1);
      currentTurn.title.textContent = `${currentTurn.label ?? "Thinking…"} ${seconds}s`;
    }, 200);
    messages.scrollTop = messages.scrollHeight;
  }
  function finishActivity(keep) {
    if (!currentTurn) return;
    clearInterval(currentTurn.timer);
    if (!keep) currentTurn.outputItem?.remove();
    if (currentTurn.outputRender)
      cancelAnimationFrame(currentTurn.outputRender);
    const seconds = ((Date.now() - currentTurn.startedAt) / 1000).toFixed(1);
    const stepCount = currentTurn.steps.size;
    activity.classList.remove("live");
    if (keep && stepCount) {
      activity.classList.add("done");
      currentTurn.title.textContent = `${stepCount} step${stepCount === 1 ? "" : "s"} completed · ${seconds}s`;
      activity.open = false;
    } else if (!keep && stepCount) {
      currentTurn.title.textContent = `Stopped after ${stepCount} step${stepCount === 1 ? "" : "s"}`;
      activity.open = false;
    } else {
      activity?.remove();
    }
    currentTurn = null;
    activity = null;
  }
  function renderOutputDelta(text) {
    if (!currentTurn || typeof text !== "string" || !text) return;
    const remaining = 120000 - currentTurn.outputText.length;
    if (remaining <= 0) return;
    currentTurn.outputText += text.slice(0, remaining);
    if (!currentTurn.outputItem) {
      currentTurn.outputItem = addBubble("assistant", "", { persist: false });
      currentTurn.outputItem.classList.add("streaming");
    }
    currentTurn.label = "Answering…";
    if (currentTurn.outputRender) return;
    const turn = currentTurn;
    turn.outputRender = requestAnimationFrame(() => {
      turn.outputRender = 0;
      if (!turn.outputItem?.isConnected) return;
      turn.outputItem.replaceChildren(renderMarkdown(turn.outputText));
      messages.scrollTop = messages.scrollHeight;
    });
  }
  function onProgress(event) {
    if (!currentTurn || event.turnId !== currentTurn.id) return;
    if (event.type === "model.start") {
      const name =
        settings?.models?.find((model) => model.id === event.model)
          ?.displayName ?? event.model;
      currentTurn.label = `${event.round ? "Continuing with" : "Asking"} ${name}…`;
    } else if (event.type === "model.end") {
      currentTurn.promptTokens += event.usage?.promptTokens ?? 0;
      currentTurn.completionTokens += event.usage?.completionTokens ?? 0;
      currentTurn.label = event.toolCalls
        ? `Running ${event.toolCalls} tool call${event.toolCalls === 1 ? "" : "s"}…`
        : "Finishing…";
      if (event.toolCalls && currentTurn.outputItem) {
        currentTurn.outputItem.remove();
        currentTurn.outputItem = null;
        currentTurn.outputText = "";
        if (currentTurn.outputRender) {
          cancelAnimationFrame(currentTurn.outputRender);
          currentTurn.outputRender = 0;
        }
      }
    } else if (event.type === "output.delta") {
      renderOutputDelta(event.text);
    } else if (event.type === "tool.start") {
      const card = document.createElement("details");
      card.className = "tool";
      card.open = panel.dataset.toolView === "detailed";
      const summary = document.createElement("summary");
      const marker = document.createElement("span");
      marker.className = "marker run";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = event.name;
      const source = document.createElement("span");
      source.className = "source";
      source.textContent = event.source === "site" ? "site tool" : "MCP tool";
      const state = document.createElement("span");
      state.className = "state run";
      state.textContent = "running";
      summary.append(marker, name, source, state);
      const args = document.createElement("pre");
      const label = document.createElement("b");
      label.textContent = "Arguments";
      args.append(label, pretty(event.arguments));
      card.append(summary, args);
      currentTurn.body.append(card);
      currentTurn.steps.set(event.id, { card, marker, state });
      currentTurn.label = `Calling ${event.name}…`;
      messages.scrollTop = messages.scrollHeight;
    } else if (event.type === "agent.step") {
      // A command the desktop agent runs inside its own sandbox, shown for transparency.
      const key = `agent:${event.round}:${event.id || event.command}`;
      let step = currentTurn.steps.get(key);
      if (!step) {
        const card = document.createElement("details");
        card.className = "tool";
        card.open = panel.dataset.toolView === "detailed";
        const summary = document.createElement("summary");
        const marker = document.createElement("span");
        marker.className = "marker run";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent =
          event.command.split("\n")[0].slice(0, 80) || "(command)";
        const source = document.createElement("span");
        source.className = "source";
        source.textContent = `run by ${event.provider ?? "the agent"}`;
        const state = document.createElement("span");
        state.className = "state run";
        state.textContent = "running";
        summary.append(marker, name, source, state);
        card.append(summary);
        currentTurn.body.append(card);
        step = { card, marker, state };
        currentTurn.steps.set(key, step);
        currentTurn.label = `${event.provider ?? "The agent"} is running a command…`;
      }
      if (event.phase === "end") {
        step.marker.className = `marker ${event.exitCode === 0 ? "ok" : "err"}`;
        step.state.className = `state ${event.exitCode === 0 ? "ok" : "err"}`;
        step.state.textContent =
          event.exitCode === 0
            ? "exit 0"
            : event.exitCode == null
              ? "blocked"
              : `exit ${event.exitCode}`;
        if (!step.card.querySelector("pre")) {
          const pre = document.createElement("pre");
          const label = document.createElement("b");
          label.textContent = "Output";
          pre.append(label, event.output || "(no output)");
          step.card.append(pre);
        }
      }
      messages.scrollTop = messages.scrollHeight;
    } else if (event.type === "agent.thinking") {
      currentTurn.label = `${event.provider ?? "The model"} is thinking (~${Number(event.tokens).toLocaleString()} tokens)…`;
    } else if (
      event.type === "agent.reasoning" ||
      event.type === "agent.reasoning.delta"
    ) {
      let box = currentTurn.reasoning;
      if (!box) {
        box = document.createElement("details");
        box.className = "reason";
        box.open = true;
        const summary = document.createElement("summary");
        summary.textContent = `Reasoning (${event.provider ?? "agent"})`;
        const pre = document.createElement("pre");
        box.append(summary, pre);
        currentTurn.body.append(box);
        currentTurn.reasoning = box;
      }
      const pre = box.querySelector("pre");
      pre.textContent = `${pre.textContent}${event.type === "agent.reasoning" && pre.textContent ? "\n\n" : ""}${event.text}`;
      messages.scrollTop = messages.scrollHeight;
    } else if (event.type === "tool.end") {
      const step = currentTurn.steps.get(event.id);
      if (!step) return;
      step.marker.className = `marker ${event.ok ? "ok" : "err"}`;
      step.state.className = `state ${event.ok ? "ok" : "err"}`;
      step.state.textContent = event.ok ? "done" : "failed";
      const result = document.createElement("pre");
      const label = document.createElement("b");
      label.textContent = "Result";
      result.append(label, pretty(event.result));
      step.card.append(result);
    }
  }
  function pretty(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return String(text ?? "");
    }
  }

  function setBusy(value) {
    busy = value;
    sendButton.hidden = value;
    stopButton.hidden = !value;
    input.disabled = value || (settings !== null && !settings.model);
    modelSelect.disabled = value || !settings?.models?.length;
  }

  async function submitChat() {
    const value = input.value.trim();
    if ((!value && !attachments.length) || busy) return;
    if (!registration) {
      addBubble("assistant", "This site has not registered an assistant.", {
        persist: false,
      });
      return;
    }
    setBusy(true);
    input.value = "";
    input.style.height = "auto";
    const content = attachments.length
      ? [...(value ? [{ type: "text", text: value }] : []), ...attachments]
      : value;
    attachments = [];
    renderAttachments();
    addBubble("user", content);
    const contract = registration;
    const epoch = panelEpoch;
    const { manifest, fingerprint } = contract;
    const turnHistory = history.map((item) => ({ ...item }));
    const capabilities = ["chat.hosted"];
    if (manifest.tools.length) capabilities.push("tools.site");
    if (manifest.mcpServers.length) capabilities.push("tools.mcp");
    const context = contextToggle.checked
      ? ["title", "url", "selection", "text"]
      : [];
    if (context.length) capabilities.push("context.read");
    const request = {
      capabilities,
      context,
      reason: `${manifest.name} wants to provide an AI chat on this site.`,
    };
    const resources = {
      contractFingerprint: fingerprint,
      mcpOrigins: manifest.mcpServers.map(
        (server) => new URL(server.url).origin,
      ),
    };
    const turnId = crypto.randomUUID();
    try {
      await enableAccess(request, resources, contract);
      assertRegistration(contract);
      const prepared = await runtime("chat.prepare", {
        manifest,
        registrationId: contract.id,
      });
      assertRegistration(contract);
      if (manifest.mcpServers.length)
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
      startActivity(turnId);
      const result = await runtime("chat.complete", {
        preparedId: prepared.id,
        registrationId: contract.id,
        fingerprint,
        history: turnHistory,
        context: context.length ? snapshot(context) : null,
        controls: { ...controls },
        turnId,
        conversationId,
        ...(reasoningEffort ? { reasoning: reasoningEffort } : {}),
      });
      if (registration === contract && epoch === panelEpoch) {
        lastTurn = {
          promptTokens: currentTurn?.promptTokens || result.usage.promptTokens,
          completionTokens:
            currentTurn?.completionTokens || result.usage.completionTokens,
          cachedTokens: result.usage.cachedTokens ?? 0,
          reasoningTokens: result.usage.reasoningTokens ?? 0,
          contextWindow: result.contextWindow ?? null,
        };
        session.promptTokens += lastTurn.promptTokens;
        session.completionTokens += lastTurn.completionTokens;
        session.turns++;
        const streamedItem = currentTurn?.outputItem ?? null;
        finishActivity(true);
        addAssistantResult(result, streamedItem);
        void refreshSettings();
      }
    } catch (error) {
      finishActivity(false);
      if (registration === contract && epoch === panelEpoch)
        addBubble(
          "assistant",
          `Could not complete the request: ${error.message}`,
          {
            error: true,
            persist: false,
          },
        );
    } finally {
      setBusy(false);
      renderStatus();
      input.focus();
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
        for (const server of manifest.mcpServers)
          row(`MCP server: ${server.name}\n${server.url}`);
        if (manifest.mcpServers.length && !tools)
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

  function userInputMatches(value, schema) {
    if (schema.type === "string") {
      if (typeof value !== "string") return false;
      const length = [...value].length;
      if (length < (schema.minLength ?? 0)) return false;
      if (length > (schema.maxLength ?? 4096)) return false;
    } else if (schema.type === "boolean") {
      if (typeof value !== "boolean") return false;
    } else {
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (schema.type === "integer" && !Number.isInteger(value)) return false;
      if (value < (schema.minimum ?? -Infinity)) return false;
      if (value > (schema.maximum ?? Infinity)) return false;
    }
    if (schema.enum && !schema.enum.some((item) => item === value))
      return false;
    if (Object.hasOwn(schema, "const") && schema.const !== value) return false;
    return true;
  }

  /** Collect a declared value in broker-owned UI without adding it to history. */
  function showToolInput(toolName, definition) {
    ensureUi();
    return new Promise((resolve, reject) => {
      const overlay = document.createElement("div");
      overlay.className = "overlay";
      const card = document.createElement("section");
      card.className = "consent";
      card.setAttribute("role", "dialog");
      card.setAttribute("aria-modal", "true");
      const head = document.createElement("header");
      head.className = "consent-head";
      const title = document.createElement("h2");
      title.textContent = "Provide input to this site tool";
      const origin = document.createElement("div");
      origin.className = "origin";
      origin.textContent = location.origin;
      head.append(title, origin);
      const body = document.createElement("div");
      body.className = "consent-body";
      const scope = document.createElement("div");
      scope.className = "scope";
      scope.textContent = `Tool: ${toolName}\nअर्जुनः will deliver the value only to this page's tool handler and will not add it to model messages or chat history. The site receives the value and is responsible for how it uses it.`;
      body.append(scope);
      const field = document.createElement("label");
      field.className = "field";
      field.append(definition.label);
      let control;
      if (definition.schema.enum) {
        control = document.createElement("select");
        for (const value of definition.schema.enum) {
          const option = document.createElement("option");
          option.value = JSON.stringify(value);
          option.textContent = String(value);
          control.append(option);
        }
      } else if (definition.schema.type === "boolean") {
        control = document.createElement("input");
        control.type = "checkbox";
      } else {
        control = document.createElement("input");
        control.type = definition.secret
          ? "password"
          : ["number", "integer"].includes(definition.schema.type)
            ? "number"
            : "text";
        control.autocomplete = "off";
        control.spellcheck = false;
        if (definition.schema.minLength != null)
          control.minLength = definition.schema.minLength;
        if (definition.schema.maxLength != null)
          control.maxLength = definition.schema.maxLength;
        if (definition.schema.minimum != null)
          control.min = String(definition.schema.minimum);
        if (definition.schema.maximum != null)
          control.max = String(definition.schema.maximum);
        if (definition.schema.type === "integer") control.step = "1";
      }
      field.append(control);
      if (definition.description) {
        const description = document.createElement("span");
        description.className = "notice";
        description.textContent = definition.description;
        field.append(description);
      }
      body.append(field);
      const validation = document.createElement("div");
      validation.className = "validation";
      body.append(validation);
      const foot = document.createElement("footer");
      foot.className = "consent-foot";
      const note = document.createElement("span");
      note.className = "consent-hint";
      note.textContent = definition.secret
        ? "Masked. अर्जुनः does not persist or forward it to the model."
        : "अर्जुनः does not persist or forward it to the model.";
      const actions = document.createElement("div");
      actions.className = "actions";
      const cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      const provide = document.createElement("button");
      provide.className = "allow";
      provide.textContent = "Provide";
      const finish = (ok, value) => {
        if (!pendingInputPrompt) return;
        pendingInputPrompt = null;
        overlay.remove();
        ok ? resolve(value) : reject(new Error(value));
      };
      pendingInputPrompt = (message = "The user cancelled.") =>
        finish(false, message);
      cancel.addEventListener("click", () =>
        finish(false, "The user cancelled."),
      );
      provide.addEventListener("click", () => {
        let value;
        if (definition.schema.enum) value = JSON.parse(control.value);
        else if (definition.schema.type === "boolean") value = control.checked;
        else if (["number", "integer"].includes(definition.schema.type))
          value = control.value === "" ? NaN : Number(control.value);
        else value = control.value;
        if (!userInputMatches(value, definition.schema)) {
          validation.textContent =
            "Enter a value that matches the disclosed requirements.";
          control.focus();
          return;
        }
        finish(true, value);
      });
      control.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          provide.click();
        }
      });
      actions.append(cancel, provide);
      foot.append(note, actions);
      card.append(head, body, foot);
      overlay.append(card);
      root.append(overlay);
      queueMicrotask(() => control.focus());
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
      if (message.session === nonce) onProgress(message);
      return false;
    }
    if (message?.kind === "arjunah-ui") {
      if (message.action === "open") {
        openPanel();
        sendResponse({ ok: true, supported: Boolean(registration) });
      } else if (message.action === "toggle") {
        ensureUi();
        panel.hidden ? openPanel() : (panel.hidden = true);
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
      } else if (message.action === "snapshot")
        sendResponse({
          ok: true,
          context: snapshot(["title", "url", "selection", "text"]),
        });
      return false;
    }
    if (message?.kind === "arjunah-tool") {
      if (
        !matchesSession(message) ||
        !registration?.manifest.tools.some((tool) => tool.name === message.name)
      ) {
        sendResponse({ ok: false });
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
          pendingInputPrompt?.("The site tool timed out.");
          reject(aiError("TIMEOUT", "The site tool timed out."));
        }, 120000);
        toolPending.set(id, {
          resolve,
          reject,
          timer,
          name: message.name,
          userInputs: tool?.userInputs ?? [],
          inputRequests: 0,
        });
        toPage({
          kind: "tool-invoke",
          id,
          name: message.name,
          args: message.args,
          invocationId: message.invocationId,
          registrationId: active.id,
          controls: { ...controls },
        });
      })
        .then((result) =>
          sendResponse(
            registration === active && matchesSession(message)
              ? { ok: true, result }
              : { ok: false },
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
