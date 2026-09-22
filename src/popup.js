import { providerMark } from "./lib/provider-icons.js";

const $ = (selector) => document.querySelector(selector);
const state = $("#state"),
  note = $("#note"),
  toggleSite = $("#toggle-site"),
  revokeSite = $("#revoke-site"),
  providerLabel = $("#provider-label"),
  siteModel = $("#site-model"),
  reset = $("#exposed-reset"),
  defaultModel = $("#default-model");
let activeTab = null;
let origin = null;
let catalog = null; // catalog.get: providers with account details, global default
let site = null; // site.get: this origin's grant and settings
let pageStatus = null; // content-script status: registered assistant, open state
let statePort = null;
let liveRefreshTimer = null;
let siteLoadRequest = 0;
let siteUpdateQueue = Promise.resolve();
let siteUpdatesPending = 0;
let deferredSiteReload = false;

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// The popup never hosts its own chat. It is the wallet view: providers, the
// global default, and what the current site may use. Chat happens on the page.
// Opened as a page (from options or for debugging), `?tab=<id>` targets that tab.
const requestedTab = Number(new URLSearchParams(location.search).get("tab"));
const withTab = (callback) =>
  Number.isInteger(requestedTab) && requestedTab > 0
    ? chrome.tabs.get(requestedTab, (tab) =>
        callback(chrome.runtime.lastError ? undefined : tab),
      )
    : chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) =>
        callback(tab),
      );
withTab((tab) => {
  activeTab = tab;
  origin = tab?.url ? safeOrigin(tab.url) : null;
  $("#origin").textContent = origin ?? "Current tab";
  if (!tab?.id || !/^https?:/.test(tab.url ?? "")) {
    state.textContent =
      "This browser page cannot implement the अर्जुनः protocol.";
    origin = null;
    loadSite();
    connectStateStream();
    return;
  }
  chrome.tabs.sendMessage(
    tab.id,
    { kind: "arjunah-ui", action: "status" },
    (reply) => {
      if (chrome.runtime.lastError) {
        state.textContent =
          "Reload this page so the extension can check for an assistant.";
        pageStatus = null;
      } else pageStatus = reply?.supported ? reply : { supported: false };
      renderSite();
    },
  );
  loadSite();
  connectStateStream();
});
toggleSite.addEventListener("click", () =>
  openSite(pageStatus?.open ? "toggle" : "open"),
);
function openSite(action) {
  if (!activeTab?.id) return;
  chrome.tabs.sendMessage(
    activeTab.id,
    { kind: "arjunah-ui", action },
    (reply) => {
      if (chrome.runtime.lastError || !reply?.ok) {
        note.textContent = "Could not reach this page.";
        return;
      }
      window.close();
    },
  );
}
for (const id of ["#settings", "#manage"])
  $(id).addEventListener("click", (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });

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
      if (chrome.runtime.lastError)
        return reject(new Error(chrome.runtime.lastError.message));
      if (!reply?.ok)
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
    if (siteUpdatesPending) {
      deferredSiteReload = true;
      return;
    }
    clearTimeout(liveRefreshTimer);
    liveRefreshTimer = setTimeout(
      () => void loadSite({ onlyIfChanged: true }),
      50,
    );
  });
  port.onDisconnect.addListener(() => {
    if (statePort === port) statePort = null;
    setTimeout(connectStateStream, 500);
  });
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
const format = (n) => Number(n || 0).toLocaleString();
function compact(n) {
  const value = Number(n || 0);
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}k`
      : String(value);
}

/**
 * A grouped <select> of every available model; `selected` may be null.
 * `only` narrows it to a set of provider ids (the site's own allowlist).
 *
 * A select with nothing selected shows its first option, which reads as a
 * choice nobody made. `placeholder` is the honest first row for that case.
 */
function fillModelSelect(
  select,
  selected,
  { defaultMark = null, placeholder = null, only = null } = {},
) {
  select.replaceChildren();
  let any = false;
  let matched = false;
  let placeholderOption = null;
  if (placeholder) {
    placeholderOption = document.createElement("option");
    placeholderOption.value = "";
    placeholderOption.textContent = placeholder;
    select.append(placeholderOption);
  }
  for (const provider of catalog?.providers ?? []) {
    if (!provider.available) continue;
    if (only && !only.has(provider.id)) continue;
    const group = document.createElement("optgroup");
    group.label = provider.name;
    for (const model of provider.models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent =
        model.id === defaultMark
          ? `${model.displayName} (default)`
          : model.displayName;
      option.selected = model.id === selected;
      if (option.selected) matched = true;
      group.append(option);
      any = true;
    }
    select.append(group);
  }
  // A pinned model whose provider is unavailable — or one the site's own
  // allowlist excludes — matches no option. Without this the browser shows
  // whatever is first and it reads as the current choice.
  if (placeholderOption) placeholderOption.selected = !matched;
  if (!any) {
    select.replaceChildren();
    const option = document.createElement("option");
    option.textContent = only
      ? "No provider enabled for this site"
      : "No provider available";
    select.append(option);
  }
  select.disabled = !any;
  return any;
}

function renderProviders() {
  const list = $("#providers");
  list.replaceChildren();
  fillModelSelect(defaultModel, catalog?.defaultModel ?? null, {
    placeholder: "No default chosen",
  });
  for (const provider of catalog?.providers ?? []) {
    const card = element("div", null, "provider");
    card.classList.toggle("available", provider.available);
    card.classList.toggle(
      "default",
      Boolean(
        catalog.defaultModel &&
          catalog.defaultModel.startsWith(`${provider.id}/`),
      ),
    );
    const mark = providerMark(provider.id);
    card.append(
      mark ?? element("span", null, `dot ${provider.available ? "on" : ""}`),
    );
    const name = element("div", null, "name");
    name.append(element("span", provider.name));
    if (!provider.available) card.classList.add("off");
    if (provider.plan) name.append(element("span", provider.plan, "badge"));
    card.append(name);
    if (provider.available) {
      card.append(
        element(
          "div",
          [
            provider.account,
            provider.method,
            `${provider.models.length} model${provider.models.length === 1 ? "" : "s"}`,
          ]
            .filter(Boolean)
            .join(" · "),
          "meta",
        ),
      );
      const stats = element("div", null, "stats");
      const usage = provider.usage;
      const today = element("span");
      today.append("Today ");
      today.append(
        element(
          "b",
          usage?.dayRequests
            ? `${format(usage.dayRequests)} req · ${compact((usage.dayPromptTokens ?? 0) + (usage.dayCompletionTokens ?? 0))} tok`
            : "no requests",
        ),
      );
      stats.append(today);
      const quota = element("span");
      if (provider.quota?.windows?.length) {
        quota.append("Usage ");
        quota.append(
          element(
            "b",
            provider.quota.windows
              .map((w) => `${w.label} ${w.usedPercent}%`)
              .join(" · "),
          ),
        );
      } else if (provider.quota?.limit != null) {
        quota.append("Quota ");
        quota.append(
          element(
            "b",
            `${compact(provider.quota.used ?? 0)}/${compact(provider.quota.limit)} ${provider.quota.unit}`,
          ),
        );
      } else if (provider.quota?.used != null) {
        quota.append("Quota used ");
        quota.append(
          element(
            "b",
            `${compact(provider.quota.used)} ${provider.quota.unit}`,
          ),
        );
      } else quota.append("Quota not reported");
      stats.append(quota);
      card.append(stats);
    } else
      card.append(
        element(
          "div",
          provider.reason ??
            (provider.installed ? "Not signed in." : "Not installed."),
          "meta warn",
        ),
      );
    const side = element("div", null, "side");
    side.append(
      element(
        "span",
        provider.kind === "subscription" ? "Subscription" : "API key",
        "badge",
      ),
    );
    card.append(side);
    list.append(card);
  }
  const desktop = catalog?.desktop;
  const problem = !desktop?.paired
    ? null
    : !desktop.running
      ? "अर्जुनः Desktop is not running. Start it (npm run desktop) to use Claude Code, Codex, or OpenCode."
      : !desktop.accepted
        ? "अर्जुनः Desktop no longer recognises this browser's pairing. Open Settings and pair again."
        : null;
  // A pairing problem blocks every subscription, so it sits above the model picker.
  const alert = $("#provider-alert");
  alert.replaceChildren();
  alert.hidden = !problem;
  if (problem) {
    alert.className = desktop.running ? "alert-row" : "warning-row";
    alert.append(element("span", problem));
  }
  // Three different situations used to share one sentence, and the one it
  // picked when a default was merely unset claimed nothing was configured at
  // all — directly above a list of five working providers.
  const usable = (catalog?.providers ?? []).filter(
    (provider) => provider.available,
  );
  providerLabel.textContent = catalog?.defaultModel
    ? `Sites you approve use ${catalog.label}.`
    : problem
      ? "Sites cannot use your subscriptions until this is fixed."
      : usable.length
        ? "No global default chosen yet. Pick one above; sites you approve will use it."
        : "No provider configured yet. Open settings to add one.";
}

// Narrowing was one-way: unchecking wrote an explicit list and nothing ever
// sent `providers: null` again, so the only way back to "all of them" was to
// re-tick every box by hand — and a provider added later would stay hidden.
reset.addEventListener("click", () => void update({ providers: null }));

/** What the current allowlist means, in one line under the chips. */
function describeAllowlist(allowed) {
  $("#exposed-note").textContent = !allowed.size
    ? "Locked to one model: the assistant answers with the model above, and its picker is disabled."
    : allowed.size === 1
      ? "The assistant may switch between this provider's models only."
      : `The assistant may switch between ${allowed.size} providers' models.`;
}

function renderSite() {
  const dashboard = $("#site-dashboard");
  const level = $("#level");
  const grant = site?.grant ?? null;
  const registered = pageStatus?.supported;
  toggleSite.hidden = !registered;
  toggleSite.textContent = pageStatus?.open
    ? "Hide assistant"
    : "Open assistant";
  revokeSite.hidden = !grant;
  if (!registered && !grant) {
    dashboard.hidden = true;
    level.hidden = true;
    if (pageStatus)
      state.textContent = "This page does not implement the अर्जुनः protocol.";
    return;
  }
  const levelName = grant?.level ?? "assistant";
  level.hidden = false;
  level.className = `badge ${levelName === "assistant" ? "" : "badge-accent"}`;
  level.textContent = {
    assistant: "Level 0 · Assistant",
    completion: "Level 1 · Completion",
    catalog: "Level 2 · Catalog",
  }[levelName];
  state.textContent = registered
    ? pageStatus.open
      ? `${pageStatus.name} is open on this page.`
      : `${pageStatus.name} is available on this page.`
    : grant
      ? "This site holds a grant but has not registered an assistant on this page."
      : "";
  dashboard.hidden = false;
  const assistant = $("#assistant");
  assistant.replaceChildren();
  if (registered) {
    assistant.append(element("strong", pageStatus.name));
    const bits = [
      pageStatus.description,
      pageStatus.tools
        ? `${pageStatus.tools} site tool${pageStatus.tools === 1 ? "" : "s"}`
        : null,
      pageStatus.mcpServers
        ? `${pageStatus.mcpServers} MCP server${pageStatus.mcpServers === 1 ? "" : "s"}`
        : null,
    ].filter(Boolean);
    if (bits.length) assistant.append(element("span", bits.join(" · ")));
  }
  assistant.hidden = !registered;
  // The allowlist is what the assistant may switch between; the model field is
  // what it opens with. Both belong to every grant, not only a level-2 one:
  // even a level-0 site drives the broker's own picker, and until now nothing
  // in this popup could narrow that.
  const exposed = $("#exposed");
  exposed.hidden = !grant;
  const allowed = grant
    ? new Set(
        site.chosenProviders ??
          (catalog?.providers ?? [])
            .filter((provider) => provider.available)
            .map((provider) => provider.id),
      )
    : null;
  const modelField = siteModel.closest("label");
  modelField.hidden = !grant;
  if (grant) {
    fillModelSelect(siteModel, grant.model, {
      defaultMark: catalog?.defaultModel,
      placeholder: "Follow the global default",
      // `allowed` is authoritative even when empty: enabling no provider is a
      // choice, and `null` here would quietly list every model instead.
      only: site.chosenProviders ? allowed : null,
    });
    $("#fallback").hidden = !site.fallback;
    $("#fallback").textContent =
      "The model chosen for this site is unavailable; the global default answers instead.";
  } else $("#fallback").hidden = true;
  if (grant) {
    const box = $("#exposed-list");
    box.replaceChildren();
    // A provider that is momentarily down still holds its place in the grant.
    // Rendering only the available ones, then rebuilding the stored list from
    // the rendered boxes, quietly dropped it the next time any chip was
    // toggled. It is drawn disabled instead, so it is visible and preserved.
    for (const provider of catalog?.providers ?? []) {
      if (!provider.available && !allowed.has(provider.id)) continue;
      const label = document.createElement("label");
      if (!provider.available) label.className = "off";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.value = provider.id;
      check.disabled = !provider.available;
      check.title = provider.available
        ? ""
        : `${provider.name} is unavailable right now; its place in this site's list is kept.`;
      check.checked = allowed.has(provider.id);
      const mark = providerMark(provider.id);
      if (mark) mark.classList.add("sm");
      check.addEventListener("change", async () => {
        const chosen = [...box.querySelectorAll("input:checked")].map(
          (input) => input.value,
        );
        // Keep the chips stable and interactive while ordered writes finish.
        // Rebuilding this whole section here made one click flash twice: once
        // for the response and once for its storage-change broadcast. The two
        // things that do depend on the choice are refreshed by hand instead,
        // so they cannot sit stale until some later render.
        describeAllowlist(new Set(chosen));
        fillModelSelect(siteModel, site?.grant?.model ?? null, {
          defaultMark: catalog?.defaultModel,
          placeholder: "Follow the global default",
          only: new Set(chosen),
        });
        await update({ providers: chosen }, { render: false });
      });
      label.append(check, ...(mark ? [mark] : []), provider.name);
      box.append(label);
    }
    reset.hidden = !site.chosenProviders;
    describeAllowlist(allowed);
  }
  const fields = $("#context-fields");
  fields.textContent = grant
    ? grant.context.length
      ? `Page context allowed: ${grant.context.join(", ")}.`
      : "No page context is shared unless you enable it per turn."
    : "No access granted yet. The site asks when it first needs the model.";
}

function update(patch, { render = true } = {}) {
  siteUpdatesPending++;
  const operation = siteUpdateQueue.then(async () => {
    try {
      site = await runtime("site.update", { origin, ...patch });
      note.textContent = "";
      if (render && siteUpdatesPending === 1) renderSite();
      if (activeTab?.id)
        chrome.tabs.sendMessage(
          activeTab.id,
          { kind: "arjunah-ui", action: "refresh" },
          () => void chrome.runtime.lastError,
        );
    } catch (error) {
      note.textContent = error.message;
      if (siteUpdatesPending === 1) renderSite();
    } finally {
      siteUpdatesPending--;
      if (!siteUpdatesPending && deferredSiteReload) {
        deferredSiteReload = false;
        void loadSite({ onlyIfChanged: true });
      }
    }
  });
  siteUpdateQueue = operation.catch(() => undefined);
  return operation;
}
// The placeholder row is "unpin this site", which the broker spells `null`.
// Sending the empty string instead reached findModel("") and came back as
// "The chosen model is unavailable" — an error for choosing the default.
siteModel.addEventListener("change", () =>
  update({ model: siteModel.value || null }),
);
revokeSite.addEventListener("click", async () => {
  try {
    await runtime("grants.revoke", { origin });
    site = { origin, grant: null };
    note.textContent = "";
    renderSite();
  } catch (error) {
    note.textContent = error.message;
  }
});
defaultModel.addEventListener("change", async () => {
  // "No default chosen" describes the current state; it is not an action.
  // There is no operation that unsets the global default, and sending the
  // empty string reached activeForModel("") as "Unknown provider selection".
  if (!defaultModel.value) {
    defaultModel.value = catalog?.defaultModel ?? "";
    return;
  }
  try {
    await runtime("catalog.default", { model: defaultModel.value });
    catalog = await runtime("catalog.get");
    if (origin) site = await runtime("site.get", { origin });
    note.textContent = "";
    renderProviders();
    renderSite();
  } catch (error) {
    note.textContent = error.message;
    renderProviders();
  }
});

async function loadSite({ onlyIfChanged = false } = {}) {
  const request = ++siteLoadRequest;
  let nextCatalog;
  let nextSite;
  try {
    nextCatalog = await runtime("catalog.get");
    nextSite = origin ? await runtime("site.get", { origin }) : null;
  } catch (error) {
    nextCatalog ??= catalog ?? { providers: [], defaultModel: null };
    nextSite = site;
    if (request !== siteLoadRequest) return;
    note.textContent = error.message;
  }
  if (request !== siteLoadRequest) return;
  if (siteUpdatesPending) {
    deferredSiteReload = true;
    return;
  }
  const catalogChanged = !sameValue(catalog, nextCatalog);
  const siteChanged = !sameValue(site, nextSite);
  catalog = nextCatalog;
  site = nextSite;
  if (!onlyIfChanged || catalogChanged) renderProviders();
  if (!onlyIfChanged || siteChanged) renderSite();
}
function safeOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
