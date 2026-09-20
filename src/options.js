const $ = (selector) => document.querySelector(selector);
import {
  OPENAI_BASE_URL,
  OPENAI_DEFAULT_MODEL,
  OPENAI_MODELS,
} from "./lib/openai.js";
let existing = null;
let desktop = null;
let catalog = null; // catalog.get: providers with usage and quota, global default
let statePort = null;
let liveRefreshTimer = null;
let desktopRequest = 0;
let pairingDesktop = false;
// Extension pages always run the newest files, but Chrome keeps the previous
// background service worker alive until the extension is reloaded. Requests
// the old worker does not recognise surface as these two messages.
const STALE_WORKER_MESSAGES = [
  "Unknown extension operation.",
  "This page does not have a supported top-level origin.",
];
function friendlyError(message) {
  if (STALE_WORKER_MESSAGES.includes(message))
    return "The extension's background script is out of date. Open chrome://extensions (or about:addons in Firefox), click Reload on अर्जुनः, then reopen this page.";
  return message;
}
function runtime(method, params = {}) {
  return new Promise((resolve, reject) =>
    chrome.runtime.sendMessage({ kind: "arjunah", method, params }, (reply) => {
      if (chrome.runtime.lastError || !reply?.ok)
        return reject(
          new Error(friendlyError(reply?.error?.message ?? "Request failed.")),
        );
      resolve(reply.result);
    }),
  );
}
function connectStateStream() {
  if (statePort) return;
  const port = chrome.runtime.connect({ name: "arjunah-state" });
  statePort = port;
  port.onMessage.addListener((message) => {
    if (message?.kind !== "arjunah-state") return;
    clearTimeout(liveRefreshTimer);
    liveRefreshTimer = setTimeout(() => {
      if (!pairingDesktop) void refreshDesktop();
    }, 50);
  });
  port.onDisconnect.addListener(() => {
    if (statePort === port) statePort = null;
    setTimeout(connectStateStream, 500);
  });
}
// Render a sentence, turning `backtick` spans into <code> elements.
function rich(tag, content, className) {
  const node = element(tag, null, className);
  String(content)
    .split("`")
    .forEach((part, index) => {
      if (!part) return;
      node.append(index % 2 ? element("code", part) : part);
    });
  return node;
}
function origin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
function refreshKeyControl() {
  const sameOrigin =
    existing && origin(existing.baseUrl) === origin($("#base-url").value);
  const keepKey = $("#keep-key");
  const canReuse = Boolean(sameOrigin && existing.hasApiKey);
  keepKey.disabled = !canReuse;
  if (!canReuse) keepKey.checked = false;
  $("#api-key").required = !(canReuse && keepKey.checked);
  $("#api-key").placeholder =
    canReuse && keepKey.checked ? "Saved key will be used" : "sk-…";
}
function values() {
  return {
    baseUrl: $("#base-url").value.trim(),
    model: $("#model").value.trim(),
    apiKey: $("#api-key").value,
    keepApiKey: !$("#keep-key").disabled && $("#keep-key").checked,
  };
}
function isChatModel(model) {
  return (
    /^(gpt-|o[1-9])/.test(model) &&
    !/(audio|image|instruct|live|realtime|search|transcribe|tts|whisper)/.test(
      model,
    )
  );
}
function setModelOptions(
  selected = OPENAI_DEFAULT_MODEL,
  availableModels = [],
) {
  const models = [
    ...new Set([...OPENAI_MODELS, ...availableModels.filter(isChatModel)]),
  ];
  $("#openai-models").replaceChildren(
    ...models.map((model) => {
      const option = document.createElement("option");
      option.value = model;
      return option;
    }),
  );
  $("#model").value = selected;
}
function status(selector, message, error = false) {
  const node = $(selector);
  node.textContent = message;
  node.classList.toggle("error", error);
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const GUIDANCE_LABELS = {
  missing: "Not installed",
  "signed-out": "Not signed in",
  disabled: "Disabled in the desktop app",
  error: "Check failed",
};
/**
 * The account line every card shows so it is obvious which sign-in a website request
 * will be billed to. Kept identical in shape across providers.
 */
function renderConnection(provider) {
  const link = provider.connection;
  const box = element("div", null, "connection");
  if (!provider.available || (!link && !provider.account)) {
    box.classList.add("none");
    box.append(
      element(
        "span",
        provider.available
          ? "Signed in, account not reported by the CLI."
          : "Not connected to any account.",
      ),
    );
    return box;
  }
  if (!link) {
    // Older companions report only a plain account label.
    const line = element("div", null, "connection-line");
    line.append(element("span", "Connected as", "label"));
    line.append(element("strong", provider.account, "account"));
    box.append(line);
    return box;
  }
  const line = element("div", null, "connection-line");
  line.append(
    element("span", link.account ? "Connected as" : "Connected via", "label"),
  );
  line.append(
    element("strong", link.account ?? link.method ?? "signed in", "account"),
  );
  if (link.plan) line.append(element("span", link.plan, "plan"));
  box.append(line);
  const detail = [
    link.account && link.method ? link.method : null,
    link.source,
    "Requests run on this computer through the desktop app and count against this account.",
  ]
    .filter(Boolean)
    .join(" · ");
  box.append(element("div", detail, "connection-detail"));
  return box;
}
function renderGuidance(provider) {
  const guide = provider.guidance;
  const box = element("div", null, `guidance ${guide?.state ?? "other"}`);
  if (!guide) {
    if (provider.reason) box.append(rich("div", provider.reason, "reason"));
    return box;
  }
  const head = element("div", null, "guidance-head");
  head.append(
    element("span", GUIDANCE_LABELS[guide.state] ?? "Needs attention", "pill"),
    rich("span", guide.summary),
  );
  box.append(head);
  if (guide.steps?.length) {
    const list = document.createElement("ol");
    for (const step of guide.steps)
      list.append(rich("li", step.replace(/\bRe-check\b/g, "Refresh")));
    box.append(list);
  }
  if (guide.note) box.append(rich("p", guide.note, "note"));
  if (guide.links?.length) {
    const links = element("div", null, "links");
    for (const link of guide.links) {
      const a = element("a", link.label);
      a.href = link.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      links.append(a);
    }
    box.append(links);
  }
  box.append(
    rich(
      "p",
      "These steps run on this computer, not in the browser. Use Refresh below once done, or open the desktop dashboard for a custom binary path.",
      "note",
    ),
  );
  return box;
}
const LEVEL_LABELS = {
  assistant: "Level 0 · Assistant",
  completion: "Level 1 · Completion",
  catalog: "Level 2 · Catalog",
};
async function refreshGrants() {
  const grants = await runtime("grants.list");
  $("#grants").replaceChildren();
  for (const grant of grants) {
    const row = element("div", null, "grant");
    const head = element("div", null, "origin");
    head.append(grant.origin, " ");
    head.append(
      element(
        "span",
        LEVEL_LABELS[grant.level] ?? grant.level,
        `badge ${grant.level === "assistant" ? "" : "badge-accent"}`,
      ),
    );
    const detail = [
      grant.capabilities.join(", "),
      grant.model ? `model ${grant.model}` : null,
      grant.context.length ? `context: ${grant.context.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const button = element("button", "Revoke", "btn btn-danger btn-sm");
    button.addEventListener("click", async () => {
      try {
        await runtime("grants.revoke", { origin: grant.origin });
        await refreshGrants();
        status("#grant-status", "Site grant revoked.");
      } catch (error) {
        status("#grant-status", error.message, true);
      }
    });
    row.append(head, element("div", detail, "detail"), button);
    $("#grants").append(row);
  }
  if (!grants.length)
    $("#grants").append(element("p", "No site grants.", "muted small"));
}
const format = (n) => Number(n || 0).toLocaleString();
/** Local usage from the ledger plus provider-reported quota (SPEC 11.1). */
function renderStats(providerId) {
  const provider = catalog?.providers.find((item) => item.id === providerId);
  const stats = element("div", null, "stats");
  const usage = provider?.usage;
  const today = element("span");
  today.append("Today ");
  today.append(
    element(
      "b",
      usage?.dayRequests
        ? `${format(usage.dayRequests)} requests · ${format((usage.dayPromptTokens ?? 0) + (usage.dayCompletionTokens ?? 0))} tokens`
        : "no requests",
    ),
  );
  stats.append(today);
  if (usage?.totalRequests) {
    const total = element("span");
    total.append("All time ");
    total.append(element("b", `${format(usage.totalRequests)} requests`));
    stats.append(total);
  }
  const quota = element("span");
  if (provider?.quota?.windows?.length) {
    quota.append("Plan usage ");
    quota.append(
      element(
        "b",
        provider.quota.windows
          .map(
            (w) =>
              `${w.label} ${w.usedPercent}%${w.resetsAt ? ` (resets ${new Date(w.resetsAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })})` : ""}`,
          )
          .join(" · "),
      ),
    );
    if (provider.quota.note) quota.append(` · ${provider.quota.note}`);
  } else if (provider?.quota?.limit != null) {
    quota.append("Quota ");
    quota.append(
      element(
        "b",
        `${format(provider.quota.used ?? 0)} / ${format(provider.quota.limit)} ${provider.quota.unit}`,
      ),
    );
  } else if (provider?.quota?.used != null) {
    quota.append("Quota used ");
    quota.append(
      element("b", `${format(provider.quota.used)} ${provider.quota.unit}`),
    );
  } else quota.append("Quota not reported by this provider");
  stats.append(quota);
  return stats;
}

function renderProviders() {
  const list = $("#providers");
  list.replaceChildren();
  const active = desktop?.active ?? {};
  const cards = [];
  const problem = desktopProblem();
  if (problem) {
    // A pairing problem blocks every subscription provider, so it leads the list.
    const alert = element("div", null, "provider alert-row");
    alert.setAttribute("role", "alert");
    alert.append(element("strong", problem.title));
    alert.append(element("span", ` ${problem.text} `));
    const fix = element("a", problem.action);
    fix.href = "#desktop-section";
    alert.append(fix);
    cards.push(alert);
  }
  const openaiCard = element("div", null, "provider");
  openaiCard.classList.toggle("available", Boolean(existing));
  openaiCard.classList.toggle("active", active.type === "openai");
  openaiCard.append(element("span", null, `dot ${existing ? "on" : ""}`));
  const openaiTitle = element("div", null, "title");
  openaiTitle.append(element("strong", "OpenAI API key"));
  openaiTitle.append(element("span", "API key", "badge"));
  if (active.type === "openai")
    openaiTitle.append(element("span", "Global default", "badge badge-accent"));
  openaiCard.append(openaiTitle);
  openaiCard.append(
    element(
      "div",
      existing
        ? `${existing.model} · key stored in this browser`
        : "No key saved. Add one below.",
      "meta",
    ),
  );
  if (existing) openaiCard.append(renderStats("openai"));
  const openaiControls = element("div", null, "controls");
  const openaiSelect = document.createElement("select");
  openaiSelect.setAttribute("aria-label", "OpenAI model");
  for (const model of catalog?.providers.find((p) => p.id === "openai")
    ?.models ?? []) {
    const option = document.createElement("option");
    option.value = model.model;
    option.textContent = model.displayName;
    option.selected = model.model === existing?.model;
    openaiSelect.append(option);
  }
  openaiSelect.disabled = !existing;
  const useOpenAI = element(
    "button",
    active.type === "openai" ? "Change model" : "Use as default",
    `btn ${active.type === "openai" ? "btn-secondary" : "btn-primary"}`,
  );
  useOpenAI.type = "button";
  useOpenAI.disabled = !existing;
  useOpenAI.addEventListener("click", () =>
    select({ type: "openai", model: openaiSelect.value }),
  );
  openaiControls.append(openaiSelect, useOpenAI);
  openaiCard.append(openaiControls);
  cards.push(openaiCard);
  for (const provider of desktop?.providers ?? []) {
    const isActive =
      active.type === "desktop" && active.providerId === provider.id;
    const card = element("div", null, "provider");
    card.classList.toggle("available", provider.available);
    card.classList.toggle("active", isActive);
    card.append(element("span", null, `dot ${provider.available ? "on" : ""}`));
    const title = element("div", null, "title");
    title.append(element("strong", `${provider.name} · ${provider.vendor}`));
    title.append(element("span", "Subscription", "badge"));
    if (provider.connection?.plan)
      title.append(element("span", provider.connection.plan, "badge badge-ok"));
    if (isActive)
      title.append(element("span", "Global default", "badge badge-accent"));
    card.append(title);
    card.append(
      element(
        "div",
        provider.installed
          ? (provider.version ?? "installed")
          : "Not installed on this computer",
        "meta",
      ),
    );
    if (provider.installed && !provider.desktopProblem)
      card.append(renderConnection(provider));
    if (provider.sandboxed)
      card.append(
        element(
          "div",
          "Runs inside an additional macOS sandbox: reads and writes under your home folder are denied.",
          "meta",
        ),
      );
    if (provider.available) card.append(renderStats(provider.id));
    if (provider.notice) card.append(rich("div", provider.notice, "notice"));
    if (!provider.available) card.append(renderGuidance(provider));
    const controls = element("div", null, "controls");
    const select_ = document.createElement("select");
    select_.setAttribute("aria-label", `${provider.name} model`);
    const models = provider.desktopProblem
      ? [{ id: "", displayName: "Models unavailable" }]
      : provider.models?.length
        ? provider.models
        : [{ id: "default", displayName: "Default model" }];
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.displayName;
      option.selected = isActive
        ? model.id === active.model
        : model.id === provider.defaultModel;
      select_.append(option);
    }
    const blocked = provider.available
      ? ""
      : provider.desktopProblem
        ? provider.reason
        : provider.guidance?.state === "disabled"
          ? "Enable this provider on the desktop dashboard first."
          : provider.installed
            ? `${provider.name} is not signed in. Follow the steps on the left, then click Refresh.`
            : `${provider.name} is not installed. Follow the steps on the left, then click Refresh.`;
    select_.disabled = !provider.available;
    select_.title = blocked || "Model";
    const use = element(
      "button",
      isActive ? "Change model" : "Use as default",
      `btn ${isActive ? "btn-secondary" : "btn-primary"}`,
    );
    use.type = "button";
    use.disabled = !provider.available;
    use.title = blocked;
    use.addEventListener("click", () =>
      select({
        type: "desktop",
        providerId: provider.id,
        model: select_.value,
      }),
    );
    const test = element("button", "Test", "btn btn-ghost btn-sm");
    test.type = "button";
    test.disabled = !provider.available;
    test.title = blocked;
    test.addEventListener("click", async () => {
      status(
        "#active-status",
        `Testing ${provider.name}… this can take a minute.`,
      );
      try {
        const result = await runtime("desktop.test", {
          providerId: provider.id,
          model: select_.value,
        });
        status(
          "#active-status",
          `${provider.name} answered: ${result.content}`,
        );
      } catch (error) {
        status("#active-status", error.message, true);
      }
    });
    controls.append(select_, use, test);
    if (blocked) controls.append(element("span", "Not ready yet", "not-ready"));
    card.append(controls);
    cards.push(card);
  }
  list.append(...cards);
  // The banner above already states the problem; a stale success line under it
  // (or a second copy of it) only confuses.
  if (problem) status("#active-status", "");
  if (!desktop?.paired)
    list.append(
      element(
        "p",
        "Pair the desktop app below to use Claude Code, Codex, or OpenCode subscriptions signed in on this computer.",
        "help",
      ),
    );
}
async function select(active) {
  status("#active-status", "Switching provider…");
  try {
    const result = await runtime("provider.select", active);
    desktop = { ...desktop, ...result };
    existing = await runtime("provider.get");
    if (existing) setModelOptions(existing.model);
    catalog = await runtime("catalog.get").catch(() => catalog);
    renderProviders();
    status("#active-status", `Websites now use ${result.label}.`);
  } catch (error) {
    status("#active-status", error.message, true);
  }
}
/** Why subscription providers are unusable right now, or null. */
function desktopProblem() {
  if (!desktop?.paired) return null;
  if (!desktop.running)
    return {
      title: "अर्जुनः Desktop is not running.",
      text: "Claude Code, Codex, and OpenCode are unavailable until you start it (npm run desktop).",
      action: "Check the desktop app",
    };
  if (!desktop.accepted)
    return {
      title: "अर्जुनः Desktop no longer recognises this browser.",
      text: "Your subscriptions are unavailable until you unpair and pair again with a fresh code.",
      action: "Fix pairing",
    };
  return null;
}
function renderDesktop() {
  const link = $("#dashboard-link");
  const address = $("#desktop-url");
  // Status refreshes probe the saved/default address. Until pairing succeeds,
  // they must not overwrite a custom loopback address the user is entering.
  if (desktop?.paired && desktop.baseUrl) address.value = desktop.baseUrl;
  link.href = `${desktop?.paired ? desktop.baseUrl : address.value || "http://127.0.0.1:48123"}/`;
  $("#unpair").hidden = !desktop?.paired;
  $("#pair").hidden = Boolean(desktop?.paired && desktop?.accepted);
  $("#desktop-code").closest("label").hidden = Boolean(
    desktop?.paired && desktop?.accepted,
  );
  address.readOnly = Boolean(desktop?.paired);
  let text;
  if (!desktop) text = "Checking the desktop app…";
  else if (!desktop.running)
    text = desktop.paired
      ? `Paired, but the desktop app is not running at ${desktop.baseUrl}. Start it to use desktop providers.`
      : "Desktop app not detected. Start it, then enter its pairing code.";
  else if (desktop.paired && desktop.accepted)
    text = `Connected to ${desktop.device || "the desktop app"} (v${desktop.version}) since ${new Date(desktop.pairedAt).toLocaleString()}.`;
  else if (desktop.paired)
    text =
      "The desktop app no longer accepts this pairing. Unpair and pair again.";
  else
    text = `Desktop app v${desktop.version} detected on ${desktop.device || "this computer"}. Enter its pairing code.`;
  if (desktop?.providerError) text += ` ${desktop.providerError}`;
  status(
    "#desktop-state",
    text,
    Boolean(
      desktop &&
        ((desktop.paired && !(desktop.running && desktop.accepted)) ||
          desktop.providerError),
    ),
  );
}
async function refreshDesktop(refresh = false) {
  if (pairingDesktop) return;
  const request = ++desktopRequest;
  let nextDesktop;
  try {
    nextDesktop = await runtime("desktop.status", { refresh });
  } catch (error) {
    nextDesktop = { running: false, paired: false, error: error.message };
  }
  const nextCatalog = await runtime("catalog.get").catch(() => catalog);
  if (request !== desktopRequest) return;
  desktop = nextDesktop;
  catalog = nextCatalog;
  renderDesktop();
  renderProviders();
  refreshGrants().catch(() => {});
}

existing = await runtime("provider.get");
catalog = await runtime("catalog.get").catch(() => null);
$("#base-url").value = OPENAI_BASE_URL;
setModelOptions(existing?.model);
if (existing) {
  $("#keep-key").checked = existing.hasApiKey;
}
refreshKeyControl();
renderProviders();
await refreshGrants();
refreshDesktop();
connectStateStream();
$("#base-url").addEventListener("input", refreshKeyControl);
$("#keep-key").addEventListener("change", refreshKeyControl);
$("#provider-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  status("#provider-status", "Saving…");
  try {
    existing = await runtime("provider.save", values());
    $("#api-key").value = "";
    $("#keep-key").checked = existing.hasApiKey;
    refreshKeyControl();
    status("#provider-status", "OpenAI key saved.");
    refreshDesktop();
  } catch (error) {
    status("#provider-status", error.message, true);
  }
});
$("#test").addEventListener("click", async () => {
  status("#provider-status", "Testing…");
  try {
    const result = await runtime("provider.test", values());
    const availableModels = Array.isArray(result.models)
      ? result.models
          .map((model) => (typeof model === "string" ? model : model?.id))
          .filter((model) => typeof model === "string")
      : [];
    if (availableModels.length)
      setModelOptions($("#model").value, availableModels);
    status(
      "#provider-status",
      result.generationVerified
        ? `Connected. ${$("#model").value} answered a tool-enabled test request.`
        : "Model list reachable. Reload the extension to test generation and tools.",
    );
  } catch (error) {
    status("#provider-status", error.message, true);
  }
});
$("#clear-provider").addEventListener("click", async () => {
  try {
    await runtime("provider.clear");
    existing = null;
    $("#base-url").value = OPENAI_BASE_URL;
    $("#api-key").value = "";
    setModelOptions();
    refreshKeyControl();
    status("#provider-status", "OpenAI key cleared.");
    refreshDesktop();
  } catch (error) {
    status("#provider-status", error.message, true);
  }
});
$("#clear-grants").addEventListener("click", async () => {
  try {
    await runtime("grants.clear");
    await refreshGrants();
    status("#grant-status", "All site grants revoked.");
  } catch (error) {
    status("#grant-status", error.message, true);
  }
});
$("#pair-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  pairingDesktop = true;
  clearTimeout(liveRefreshTimer);
  desktopRequest++;
  status("#desktop-state", "Pairing…");
  try {
    desktop = await runtime("desktop.pair", {
      baseUrl: $("#desktop-url").value.trim(),
      code: $("#desktop-code").value,
    });
    $("#desktop-code").value = "";
    existing = await runtime("provider.get");
    setModelOptions(existing?.model);
    refreshKeyControl();
    renderDesktop();
    status("#active-status", "Desktop app paired. Choose a provider above.");
    renderProviders();
  } catch (error) {
    status("#desktop-state", error.message, true);
  } finally {
    pairingDesktop = false;
  }
});
$("#unpair").addEventListener("click", async () => {
  try {
    desktop = await runtime("desktop.unpair");
    renderDesktop();
    status("#active-status", "Desktop app unpaired.");
    renderProviders();
  } catch (error) {
    status("#desktop-state", error.message, true);
  }
});
$("#refresh-desktop").addEventListener("click", () => refreshDesktop(true));

// Diagnostics: this extension's log and, when one is paired, the desktop app's.
// Both are read-only views of bounded, metadata-only buffers.
let logTab = "extension";
let logTimer = null;
let logSnapshot = { entries: [], desktop: { available: false, entries: [] } };
function logLines(source) {
  const entries =
    source === "desktop" ? logSnapshot.desktop?.entries : logSnapshot.entries;
  return (entries ?? []).map((entry) => {
    const at = new Date(entry.at).toLocaleTimeString();
    return {
      level: entry.level,
      text: `${at}  ${entry.level.padEnd(5)} ${entry.source}: ${entry.message}`,
    };
  });
}
function renderLog() {
  const view = $("#log-view");
  const lines = logLines(logTab);
  const atBottom = view.scrollTop + view.clientHeight >= view.scrollHeight - 24;
  view.replaceChildren(
    ...lines.map((line) => {
      const node = element("div", line.text, line.level);
      return node;
    }),
  );
  if (atBottom) view.scrollTop = view.scrollHeight;
  for (const [id, name] of [
    ["#log-tab-extension", "extension"],
    ["#log-tab-desktop", "desktop"],
  ]) {
    const active = logTab === name;
    $(id).className = `btn ${active ? "btn-secondary" : "btn-ghost"}`;
    $(id).setAttribute("aria-selected", String(active));
  }
  if (logTab === "desktop" && !logSnapshot.desktop?.available)
    status(
      "#log-status",
      logSnapshot.desktop?.reason ?? "The desktop app log is unavailable.",
      true,
    );
  else
    status(
      "#log-status",
      lines.length
        ? `${lines.length} entr${lines.length === 1 ? "y" : "ies"}${logTab === "desktop" && logSnapshot.desktop?.version ? ` · अर्जुनः Desktop ${logSnapshot.desktop.version}` : ""}`
        : "Nothing logged yet.",
    );
}
async function refreshLog() {
  try {
    logSnapshot = await runtime("logs.get");
    renderLog();
  } catch (error) {
    status("#log-status", error.message, true);
  }
}
function setLogLive(on) {
  clearInterval(logTimer);
  logTimer = on ? setInterval(refreshLog, 2000) : null;
}
$("#log-tab-extension").addEventListener("click", () => {
  logTab = "extension";
  renderLog();
});
$("#log-tab-desktop").addEventListener("click", () => {
  logTab = "desktop";
  renderLog();
  void refreshLog();
});
$("#log-refresh").addEventListener("click", () => refreshLog());
$("#log-live").addEventListener("change", (event) => {
  setLogLive(event.target.checked);
  if (event.target.checked) void refreshLog();
});
$("#log-copy").addEventListener("click", async () => {
  const text = logLines(logTab)
    .map((line) => line.text)
    .join("\n");
  try {
    await navigator.clipboard.writeText(text);
    status("#log-status", "Copied to the clipboard.");
  } catch {
    status("#log-status", "The browser refused clipboard access.", true);
  }
});
$("#log-clear").addEventListener("click", async () => {
  try {
    logSnapshot = await runtime("logs.clear", {
      target: logTab,
    });
    renderLog();
  } catch (error) {
    status("#log-status", error.message, true);
  }
});
void refreshLog();
