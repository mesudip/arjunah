const $ = (selector) => document.querySelector(selector);
import {
  OPENAI_BASE_URL,
  OPENAI_DEFAULT_MODEL,
  OPENAI_MODELS,
} from "./lib/openai.js";
import { OPENCODE_BASE_URL, opencodeDisplayName } from "./lib/opencode.js";
import { searchFilter } from "./lib/search.js";
import { ollamaDisplayName } from "./lib/ollama.js";
import { originFromHash } from "./lib/settings-link.js";
import { providerMark } from "./lib/provider-icons.js";
import { VERSION } from "./lib/constants.js";

// The settings page shows one view at a time, chosen by the address hash (see
// the router near the end). Every view stays in the document, so a background
// refresh updates the hidden ones too, and the forms keep what is typed.
let existing = null; // provider.get: the OpenAI configuration
let opencodeExisting = null;
let desktop = null; // desktop.status
let activeInfo = null; // provider.active: { active, label, configured }
let catalog = null; // catalog.get: providers with usage and quota, global default
let grants = [];
let grantsLoaded = false;
let storedState = null;
let statePort = null;
let liveRefreshTimer = null;
let desktopRequest = 0;
let pairingDesktop = false;
// "recheck" while an explicit re-check of installs and sign-ins is under way,
// which can take up to a minute; the view says so instead of looking stuck.
let desktopChecking = null;
let route = { view: "overview" };
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

// ---------------------------------------------------------------------------
// DOM helpers

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
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
const ICONS = Object.freeze({
  chevron: ["m9 6 6 6-6 6"],
  check: ["m5 12.5 4.2 4.2L19 7"],
  alert: ["M12 4.5 3.2 19.5h17.6Z", "M12 10v4.2", "M12 16.9v.2"],
  star: [
    "m12 4.5 2.3 4.7 5.2.8-3.8 3.6.9 5.1-4.6-2.4-4.6 2.4.9-5.1-3.8-3.6 5.2-.8Z",
  ],
  dot: ["M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Z"],
  step: ["M12 9.7a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6Z"],
  error: [
    "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z",
    "m9.3 9.3 5.4 5.4M14.7 9.3l-5.4 5.4",
  ],
  globe: [
    "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z",
    "M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5s1.2-6.1 3.6-8.5Z",
  ],
});
function icon(name, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);
  for (const d of ICONS[name]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
function status(selector, message, error = false) {
  const node = $(selector);
  node.textContent = message;
  node.classList.toggle("error", error);
}
let toastTimer = null;
/**
 * One announcement for changes that reach every site, wherever they were made:
 * the default model and pairing. An error stays until the next message.
 */
function toast(message, error = false) {
  const node = $("#active-status");
  clearTimeout(toastTimer);
  node.textContent = message;
  node.classList.toggle("error", error);
  node.classList.add("show");
  toastTimer = setTimeout(
    () => node.classList.remove("show"),
    error ? 10000 : 4500,
  );
}
const format = (n) => Number(n || 0).toLocaleString();
function compact(n) {
  const value = Number(n || 0);
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 10_000
      ? `${(value / 1000).toFixed(1)}k`
      : value.toLocaleString();
}
// Sizes as the caps in SPEC 5.4 are written: decimal kilobytes and megabytes.
function approxSize(bytes) {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `~${Math.round(bytes / 1000)} KB`;
  return `~${(bytes / 1_000_000).toFixed(1)} MB`;
}
const plural = (count, one, many = `${one}s`) =>
  `${format(count)} ${count === 1 ? one : many}`;
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
function origin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}
function pill(text, tone = "muted", title = "") {
  const node = element("span", text, `pill pill-${tone}`);
  if (title) node.title = title;
  return node;
}
function defaultPill() {
  const node = element("span", null, "pill pill-accent pill-icon");
  node.append(icon("star"), "Default");
  node.title = "Websites use this by default";
  return node;
}
/** A provider's artwork, or its initial for one we ship no artwork for. */
function avatar(providerId, name, size = "") {
  const mark = providerMark(providerId);
  if (mark) {
    if (size) mark.classList.add(size);
    return mark;
  }
  const node = element(
    "span",
    String(name || "?")
      .trim()
      .charAt(0)
      .toUpperCase(),
    `avatar ${size}`.trim(),
  );
  node.setAttribute("aria-hidden", "true");
  return node;
}
function banner({ tone = "warn", title, text, action }) {
  const node = element("div", null, `banner banner-${tone}`);
  node.append(icon("alert", "icon banner-icon"));
  const body = element("div", null, "banner-text");
  body.append(element("strong", title));
  if (text) body.append(rich("span", text));
  node.append(body);
  if (action) {
    const link = element("a", action.label, "btn btn-secondary btn-sm");
    link.href = action.href;
    node.append(link);
  }
  return node;
}
function panelHead(title, description) {
  const head = element("div", null, "panel-head");
  const text = element("div");
  text.append(element("h2", title));
  if (description) text.append(element("p", description, "panel-desc"));
  head.append(text);
  return head;
}

/**
 * Live views redraw on every state change. Focus inside one would fall back
 * to the page, so it goes back to the same control, found by a stable key.
 */
function focusKey(node) {
  if (node.id) return `#${CSS.escape(node.id)}`;
  const row = node.closest("[data-origin], [data-provider]");
  const rowKey = row?.dataset.origin
    ? `.grant[data-origin="${CSS.escape(row.dataset.origin)}"]`
    : row
      ? `[data-provider="${CSS.escape(row.dataset.provider)}"]`
      : null;
  if (row === node) return rowKey;
  if (rowKey && node.matches(".grant-actions .btn"))
    return `${rowKey} .grant-actions .btn`;
  const href = node.getAttribute("href");
  return href ? `[href="${CSS.escape(href)}"]` : null;
}
function redraw(container, draw) {
  const active = document.activeElement;
  const key =
    active && active !== document.body && container.contains(active)
      ? focusKey(active)
      : null;
  draw();
  if (key) container.querySelector(key)?.focus({ preventScroll: true });
}

let confirmCount = 0;
/**
 * Asks before a removal, in place: the question opens under the row that
 * holds the trigger, with Cancel focused, and Escape backs out.
 */
function confirmInline(
  trigger,
  { question, confirmLabel, run, onClose, focus = true },
) {
  const host = trigger.closest(".danger-row, .grant");
  const open = host.nextElementSibling;
  if (open?.confirmFor === trigger)
    return open.querySelector("button")?.focus();
  const box = element("div", null, "confirm");
  box.confirmFor = trigger;
  box.setAttribute("role", "alertdialog");
  const text = element("p", question);
  text.id = `confirm-${++confirmCount}`;
  box.setAttribute("aria-labelledby", text.id);
  const actions = element("div", null, "actions");
  const cancel = element("button", "Cancel", "btn btn-secondary");
  cancel.type = "button";
  const yes = element("button", confirmLabel, "btn btn-danger btn-solid");
  yes.type = "button";
  actions.append(cancel, yes);
  box.append(text, actions);
  const close = () => {
    box.remove();
    trigger.disabled = false;
    onClose?.();
  };
  const back = () => {
    close();
    trigger.focus();
  };
  cancel.addEventListener("click", back);
  box.addEventListener("keydown", (event) => {
    if (event.key === "Escape") back();
  });
  yes.addEventListener("click", async () => {
    yes.disabled = true;
    try {
      await run();
    } finally {
      close();
    }
  });
  trigger.disabled = true;
  host.after(box);
  if (focus) cancel.focus();
}

// ---------------------------------------------------------------------------
// Providers

// The four providers configured on this page. Subscriptions are drawn from the
// desktop app's own state instead (see renderSubscription).
const PROVIDERS = Object.freeze({
  openai: {
    type: "openai",
    name: "OpenAI API",
    kind: "api-key",
    blurb: "GPT models with your own OpenAI API key.",
    head: "#openai-head",
    prefix: "openai",
    model: "#model",
  },
  "opencode-api": {
    type: "opencode",
    name: "OpenCode Zen",
    kind: "api-key",
    blurb:
      "One key for GPT, Claude, Gemini, Grok, Qwen, and open models, each sent in the format it needs.",
    head: "#opencode-head",
    prefix: "opencode",
    model: "#opencode-model",
  },
  ollama: {
    type: "ollama",
    name: "Ollama server",
    kind: "self-hosted",
    blurb:
      "Models on your own Ollama server, on this computer or your network.",
    head: "#ollama-head",
    prefix: "ollama",
    model: "#ollama-model",
  },
  "ollama-cloud": {
    type: "ollama-cloud",
    name: "Ollama Cloud",
    kind: "api-key",
    blurb: "Models Ollama hosts at ollama.com, with your API key.",
    head: "#ollama-cloud-head",
    prefix: "ollama-cloud",
    model: "#ollama-cloud-model",
  },
});
const STATIC_PROVIDERS = Object.keys(PROVIDERS);
const SUBSCRIPTION_BLURBS = Object.freeze({
  "claude-code":
    "Your Claude subscription, through Claude Code on this computer.",
  codex: "Your ChatGPT subscription, through Codex on this computer.",
  "opencode-cli":
    "The providers you signed in to in OpenCode on this computer.",
});
const KIND_LABELS = Object.freeze({
  "api-key": "API key",
  "self-hosted": "Self-hosted",
  subscription: "Subscription",
});
const GUIDANCE_LABELS = Object.freeze({
  missing: "Not installed",
  "signed-out": "Not signed in",
  disabled: "Disabled in the desktop app",
  error: "Check failed",
});
// The catalog calls the OpenCode CLI `opencode-cli`; the companion calls it
// `opencode`. Routes use the catalog's ids and accept either.
const publicIdFor = (runtimeId) =>
  runtimeId === "opencode" ? "opencode-cli" : runtimeId;
const providerName = (provider) =>
  PROVIDERS[provider.id]?.name ?? provider.name;
const catalogProvider = (id) =>
  catalog?.providers?.find((item) => item.id === id) ?? null;
const desktopEntry = (id) =>
  desktop?.providers?.find(
    (item) => item.id === id || publicIdFor(item.id) === id,
  ) ?? null;
const activeSelection = () => activeInfo?.active ?? desktop?.active ?? {};
function savedSummary(id) {
  if (id === "openai") return existing;
  if (id === "opencode-api") return opencodeExisting;
  if (id === "ollama") return ollamaExisting.local;
  if (id === "ollama-cloud") return ollamaExisting.cloud;
  return null;
}
const isConfigured = (id) => Boolean(savedSummary(id));
function isDefaultProvider(id) {
  const active = activeSelection();
  if (PROVIDERS[id]) return active.type === PROVIDERS[id].type;
  const entry = desktopEntry(id);
  return Boolean(
    entry && active.type === "desktop" && active.providerId === entry.id,
  );
}
/** The name the catalog gives a model, or the best local guess at one. */
function modelName(providerId, model) {
  const found = catalogProvider(providerId)?.models?.find(
    (item) => item.model === model || item.id === model,
  );
  if (found) return found.displayName;
  if (providerId === "opencode-api") return opencodeDisplayName(model);
  if (providerId === "ollama" || providerId === "ollama-cloud")
    return ollamaDisplayName(model);
  return model ?? "";
}
/** "GPT-5.6 Sol · OpenAI API" for a `<provider>/<model>` catalog id. */
function catalogModelLabel(id) {
  for (const provider of catalog?.providers ?? []) {
    const model = provider.models?.find((item) => item.id === id);
    if (model) return `${model.displayName} · ${providerName(provider)}`;
  }
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(slash + 1) : id;
}

// ---------------------------------------------------------------------------
// The model picker

let comboCount = 0;
/**
 * A model chooser you can type into. Provider catalogs run to hundreds of names
 * that differ by a suffix, so a plain <select> means hunting through a list for
 * the one already in mind. This filters as you type and orders what is left by
 * how well it answers the query (see `lib/search.js`).
 *
 * Only a model from the list can be chosen: the box is a filter over the
 * catalog, not a free text field, so `value` is always something real. Reads the
 * same way a <select> did — `node.value` — so callers did not have to change.
 *
 * `grouped` models carry `group` and `providerId`: unfiltered, the list is
 * headed by provider; filtered, each row names its provider instead.
 * `onChange` hears a choice the person made, never a value set from code.
 */
function modelCombo({
  label,
  models,
  value = "",
  disabled = false,
  title = "",
  placeholder = "Search models",
  empty = "No models available",
  // OpenAI ships models faster than any bundled list knows about, so that field
  // stays a text box the suggestions only assist. Catalogs the provider reports
  // are complete by definition, and typing a name they lack is a mistake.
  allowCustom = false,
  grouped = false,
  onChange = null,
}) {
  const entries = models.map((model) => ({
    id: String(model.id ?? ""),
    displayName: String(model.displayName ?? model.id ?? ""),
    group: model.group ?? null,
    providerId: model.providerId ?? null,
  }));
  const listId = `combo-list-${++comboCount}`;
  // A grouped picker with nothing chosen says so rather than showing a choice
  // nobody made; the per-provider pickers always hold one of their models.
  const fallback = () => (grouped ? "" : (entries[0]?.id ?? ""));
  const known = (id) => entries.some((entry) => entry.id === id);
  let current = known(value)
    ? value
    : allowCustom
      ? String(value ?? "")
      : fallback();
  let active = current;
  let open = false;
  // The box shows the chosen model's name, which must not act as a filter: a
  // picker opens on the whole catalog and narrows only once something is typed.
  let query = null;

  const root = element("div", null, "combo");
  const input = document.createElement("input");
  input.type = "text";
  input.className = "combo-input";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = placeholder;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", label);
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", listId);
  input.setAttribute("aria-autocomplete", "list");
  input.disabled = disabled || (!entries.length && !allowCustom);
  if (title) input.title = title;
  const list = element("div", null, "combo-list");
  list.id = listId;
  list.setAttribute("role", "listbox");
  list.hidden = true;
  // A grouped picker shows the chosen provider's mark inside its box.
  const mark = grouped ? element("span", null, "combo-mark") : null;
  if (mark) {
    root.classList.add("with-mark");
    root.append(mark);
  }
  root.append(input, list);

  const entryOf = (id) => entries.find((entry) => entry.id === id);
  const nameOf = (id) =>
    entryOf(id)?.displayName ?? (allowCustom ? String(id ?? "") : "");
  const matches = () =>
    searchFilter(entries, query ?? "", (entry) => [
      entry.displayName,
      entry.id,
      entry.group ?? "",
    ]);
  function drawMark() {
    if (!mark) return;
    const entry = entryOf(current);
    root.classList.toggle("has-mark", Boolean(entry?.providerId));
    mark.replaceChildren(
      entry?.providerId ? avatar(entry.providerId, entry.group, "sm") : "",
    );
  }

  function draw() {
    const rows = matches();
    if (!rows.some((row) => row.id === active)) active = rows[0]?.id ?? null;
    list.replaceChildren();
    if (!rows.length) {
      list.append(element("div", empty, "combo-empty"));
      input.removeAttribute("aria-activedescendant");
      return;
    }
    const headed = grouped && !(query ?? "").trim();
    let lastGroup = null;
    rows.forEach((row, index) => {
      if (headed && row.group !== lastGroup) {
        lastGroup = row.group;
        const head = element("div", null, "combo-group");
        head.setAttribute("role", "presentation");
        if (row.providerId)
          head.append(avatar(row.providerId, row.group, "sm"));
        head.append(element("span", row.group));
        list.append(head);
      }
      const option = element("button", null, "combo-option");
      option.type = "button";
      option.id = `${listId}-${index}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(row.id === current));
      option.classList.toggle("selected", row.id === current);
      option.classList.toggle("active", row.id === active);
      option.append(element("span", row.displayName));
      if (grouped) {
        if (!headed && row.group)
          option.append(element("small", row.group, "combo-provider"));
      } else if (row.displayName !== row.id)
        option.append(element("small", row.id, "combo-id"));
      // `mousedown` beats the input's `blur`, which would close the list first.
      option.addEventListener("mousedown", (event) => {
        event.preventDefault();
        commit(row.id);
      });
      if (row.id === active)
        input.setAttribute("aria-activedescendant", option.id);
      list.append(option);
    });
  }

  function show() {
    if (open || input.disabled) return;
    open = true;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    query = null;
    active = current;
    draw();
    list.querySelector(".combo-option.active")?.scrollIntoView({
      block: "nearest",
    });
  }

  function settle(next) {
    const changed = next !== current;
    current = next;
    input.value = nameOf(current);
    drawMark();
    if (changed) onChange?.(current);
  }

  /**
   * `acceptTyped` distinguishes leaving the box from choosing a row. On the way
   * out, a field that takes names off the list keeps what was typed; a row that
   * was picked is already the answer, and re-reading the search text would throw
   * that pick away.
   */
  function hide(acceptTyped = true) {
    open = false;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    settle(acceptTyped && allowCustom ? input.value.trim() : current);
  }

  function commit(id) {
    open = false;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    settle(id);
  }

  function move(step) {
    const rows = matches();
    if (!rows.length) return;
    const at = rows.findIndex((row) => row.id === active);
    const next = at < 0 ? (step > 0 ? 0 : rows.length - 1) : at + step;
    active = rows[(next + rows.length) % rows.length].id;
    draw();
    list.querySelector(".combo-option.active")?.scrollIntoView({
      block: "nearest",
    });
  }

  input.value = nameOf(current);
  drawMark();
  input.addEventListener("focus", () => {
    show();
    input.select();
  });
  input.addEventListener("click", show);
  input.addEventListener("input", () => {
    show();
    query = input.value;
    // A new search proposes its own best answer rather than keeping a highlight
    // that may no longer be in the list.
    active = null;
    draw();
    list.scrollTop = 0;
  });
  input.addEventListener("blur", hide);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) return show();
      return move(event.key === "ArrowDown" ? 1 : -1);
    }
    if (event.key === "Enter" && open) {
      event.preventDefault();
      if (active) commit(active);
      return;
    }
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      // Escape abandons the search rather than adopting it.
      hide(false);
    }
  });

  Object.defineProperty(root, "value", {
    get: () => current,
    set: (next) => {
      current = known(next)
        ? next
        : allowCustom
          ? String(next ?? "")
          : fallback();
      input.value = nameOf(current);
      drawMark();
    },
  });
  Object.defineProperty(root, "disabled", {
    get: () => input.disabled,
    set: (next) => {
      input.disabled = Boolean(next) || (!entries.length && !allowCustom);
    },
  });
  return root;
}
/**
 * Swaps a combo into a form field's place, keeping the id the rest of the page
 * reads it by. The model last saved rides along as `data-saved`, so a later
 * refresh can tell a picker nobody touched (it follows the saved model) from
 * one the person is changing (it is left alone).
 */
function mountCombo(mountSelector, id, combo, saved = null) {
  combo.id = id;
  combo.dataset.saved = saved ?? "";
  $(mountSelector).replaceChildren(combo);
}
function followSaved(selector, saved) {
  const combo = $(selector);
  if (!combo || saved == null || combo.contains(document.activeElement)) return;
  if (!combo.dataset.saved || combo.value === combo.dataset.saved)
    combo.value = saved;
  combo.dataset.saved = saved;
}

// ---------------------------------------------------------------------------
// Saved keys

/**
 * A saved key is never shown, only reused. The hidden checkbox holds the
 * form's "keep the saved key" state and Replace/Keep switch it. Reuse is
 * offered only for the provider origin the key was saved for (SPEC 11.2).
 */
const KEY_FIELDS = Object.freeze({
  openai: {
    input: "#api-key",
    keep: "#keep-key",
    required: true,
    placeholder: "sk-…",
    canReuse: () =>
      Boolean(
        existing?.hasApiKey &&
          origin(existing.baseUrl) === origin($("#base-url").value),
      ),
  },
  "opencode-api": {
    input: "#opencode-api-key",
    keep: "#opencode-keep-key",
    required: true,
    placeholder: "OpenCode API key",
    canReuse: () => Boolean(opencodeExisting?.hasApiKey),
  },
  ollama: {
    input: "#ollama-api-key",
    keep: "#ollama-keep-key",
    required: false,
    placeholder: "Only for a server behind an authenticating proxy",
    // A saved key belongs to the address it was saved with.
    canReuse: () => {
      const saved = ollamaExisting.local;
      return Boolean(
        saved?.hasApiKey &&
          origin(saved.baseUrl) ===
            origin(
              ollamaField("local", "base-url").value.trim() ||
                "http://127.0.0.1:11434",
            ),
      );
    },
  },
  "ollama-cloud": {
    input: "#ollama-cloud-api-key",
    keep: "#ollama-cloud-keep-key",
    required: true,
    placeholder: "Ollama API key",
    canReuse: () => Boolean(ollamaExisting.cloud?.hasApiKey),
  },
});
function refreshKeyField(id) {
  const spec = KEY_FIELDS[id];
  const keep = $(spec.keep);
  const input = $(spec.input);
  const field = input.closest(".key-field");
  const canReuse = spec.canReuse();
  keep.disabled = !canReuse;
  if (!canReuse) keep.checked = false;
  const keeping = canReuse && keep.checked;
  if (keeping) input.value = "";
  input.required = spec.required && !keeping;
  input.hidden = keeping;
  input.placeholder = keeping ? "Saved key will be used" : spec.placeholder;
  field.querySelector(".saved-key").hidden = !keeping;
  field.querySelector(".keep-saved").hidden = !canReuse || keeping;
}
function wireKeyField(id) {
  const spec = KEY_FIELDS[id];
  const field = $(spec.input).closest(".key-field");
  const set = (keep) => {
    $(spec.keep).checked = keep;
    refreshKeyField(id);
    renderStaticDetail(id);
    if (!keep) $(spec.input).focus();
  };
  field
    .querySelector('[data-key-action="replace"]')
    .addEventListener("click", () => set(false));
  field
    .querySelector('[data-key-action="keep"]')
    .addEventListener("click", () => set(true));
  $(spec.keep).addEventListener("change", () => refreshKeyField(id));
  $(spec.input).addEventListener("input", () => renderStaticDetail(id));
}

// ---------------------------------------------------------------------------
// OpenAI and OpenCode Zen forms

function values() {
  return {
    baseUrl: $("#base-url").value.trim(),
    model: $("#model").value.trim(),
    apiKey: $("#api-key").value,
    keepApiKey: !$("#keep-key").disabled && $("#keep-key").checked,
  };
}
function opencodeValues() {
  return {
    baseUrl: $("#opencode-base-url").value.trim(),
    model: $("#opencode-model").value.trim(),
    apiKey: $("#opencode-api-key").value,
    keepApiKey:
      !$("#opencode-keep-key").disabled && $("#opencode-keep-key").checked,
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
  mountCombo(
    "#openai-model-mount",
    "model",
    modelCombo({
      label: "OpenAI model",
      models: models.map((model) => ({ id: model, displayName: model })),
      value: selected,
      allowCustom: true,
      placeholder: "Search or type a model",
      onChange: () => renderStaticDetail("openai"),
    }),
    existing?.model,
  );
}
/**
 * The Zen model list is whatever the saved key discovered; there is no useful
 * list to offer before that, so the control says so instead of inviting a guess.
 */
function setOpenCodeModelOptions(selected = "", availableModels = []) {
  const models = [
    ...new Set(
      availableModels
        .map((item) => (typeof item === "string" ? item : item?.id))
        .filter((item) => typeof item === "string"),
    ),
  ];
  mountCombo(
    "#opencode-model-mount",
    "opencode-model",
    modelCombo({
      label: "OpenCode Zen model",
      models: models.map((model) => ({
        id: model,
        displayName: opencodeDisplayName(model),
      })),
      value: models.includes(selected) ? selected : (models[0] ?? ""),
      disabled: !models.length,
      empty: "Save your key to load models",
      placeholder: models.length
        ? "Search models"
        : "Save your key to load models",
      onChange: () => renderStaticDetail("opencode-api"),
    }),
    opencodeExisting?.model,
  );
}

// ---------------------------------------------------------------------------
// Ollama: the self-hosted server and Ollama Cloud share one form shape, told
// apart by the DOM prefix and the provider id the broker routes on.

const OLLAMA_FORMS = Object.freeze({
  local: { provider: "ollama", prefix: "ollama", name: "Ollama server" },
  cloud: {
    provider: "ollama-cloud",
    prefix: "ollama-cloud",
    name: "Ollama Cloud",
  },
});
const ollamaExisting = { local: null, cloud: null };
function ollamaField(which, suffix) {
  return $(`#${OLLAMA_FORMS[which].prefix}-${suffix}`);
}
/**
 * "qwen3-vl:2b · 2.1B Q4_K_M · vision · tools · thinking": what a model is
 * and accepts, at a glance, and whether it actually runs on ollama.com.
 */
function ollamaModelLabel(model) {
  const size = [model.parameterSize, model.quantization]
    .filter(Boolean)
    .join(" ");
  const traits = [
    size || null,
    model.remote ? "runs on ollama.com" : null,
    model.capabilities?.vision ? "vision" : null,
    model.capabilities?.tools ? "tools" : null,
    model.capabilities?.reasoning ? "thinking" : null,
  ].filter(Boolean);
  return [model.displayName ?? model.id, ...traits].join(" · ");
}
function ollamaValues(which) {
  const keep = ollamaField(which, "keep-key");
  return {
    provider: OLLAMA_FORMS[which].provider,
    ...(which === "local"
      ? { baseUrl: ollamaField(which, "base-url").value.trim() }
      : {}),
    model: $(`#${OLLAMA_FORMS[which].prefix}-model`)?.value.trim() ?? "",
    apiKey: ollamaField(which, "api-key").value,
    keepApiKey: !keep.disabled && keep.checked,
  };
}
function setOllamaModelOptions(which, selected = "", models = []) {
  const form = OLLAMA_FORMS[which];
  const ids = models.map((model) => model.id);
  mountCombo(
    `#${form.prefix}-model-mount`,
    `${form.prefix}-model`,
    modelCombo({
      label: `${form.name} model`,
      models: models.map((model) => ({
        id: model.id,
        displayName: ollamaModelLabel(model),
      })),
      value: ids.includes(selected) ? selected : (ids[0] ?? ""),
      disabled: !models.length,
      empty:
        which === "local"
          ? "Connect the server to load models"
          : "Save your key to load models",
      placeholder: models.length ? "Search models" : "No models loaded yet",
      onChange: () => renderStaticDetail(form.provider),
    }),
    ollamaExisting[which]?.model,
  );
  $(`#${form.prefix}-model`).dataset.models = ids.join("\n");
}
function applyOllamaSummary(which, summary) {
  ollamaExisting[which] = summary;
  if (which === "local" && summary)
    ollamaField(which, "base-url").value = summary.baseUrl;
  ollamaField(which, "api-key").value = "";
  ollamaField(which, "keep-key").checked = Boolean(summary?.hasApiKey);
  if (which === "local" && summary?.hasApiKey) $("#ollama-auth").open = true;
  setOllamaModelOptions(which, summary?.model, summary?.models ?? []);
  refreshKeyField(OLLAMA_FORMS[which].provider);
}
/**
 * The broker refreshes Ollama catalogs in the background. A picker nobody is
 * using takes the new list, keeping a model the person picked but did not save.
 */
function followOllama(which) {
  const summary = ollamaExisting[which];
  const selector = `#${OLLAMA_FORMS[which].prefix}-model`;
  const combo = $(selector);
  if (!summary || !combo || combo.contains(document.activeElement)) return;
  const ids = (summary.models ?? []).map((model) => model.id).join("\n");
  if (combo.dataset.models === ids) return followSaved(selector, summary.model);
  const picked =
    combo.dataset.saved && combo.value !== combo.dataset.saved
      ? combo.value
      : summary.model;
  setOllamaModelOptions(which, picked, summary.models ?? []);
}
function describeOllama(summary) {
  const models = summary.models ?? [];
  const vision = models.filter((model) => model.capabilities?.vision).length;
  const remote = models.filter((model) => model.remote).length;
  return `${models.length} model${models.length === 1 ? "" : "s"}${vision ? `, ${vision} with image input` : ""}${remote ? `, ${remote} running on ollama.com` : ""}`;
}
/** "Not offered: gpt-oss:20b (the server cannot load it…)", or null. */
function describeSkipped(summary) {
  const skipped = summary?.skipped ?? [];
  if (!skipped.length) return null;
  return `Not offered: ${skipped.map((item) => `${item.id} (${item.reason.replace(/\.$/, "")})`).join("; ")}.`;
}
async function loadOllama() {
  const [local, cloud] = await Promise.all([
    runtime("ollama.get", { provider: "ollama" }),
    runtime("ollama.get", { provider: "ollama-cloud" }),
  ]);
  ollamaExisting.local = local;
  ollamaExisting.cloud = cloud;
}
function wireOllamaForm(which) {
  const form = OLLAMA_FORMS[which];
  const statusId = `#${form.prefix}-status`;
  if (which === "local")
    ollamaField(which, "base-url").addEventListener("input", () => {
      refreshKeyField(form.provider);
      renderStaticDetail(form.provider);
    });
  $(`#${form.prefix}-form`).addEventListener("submit", async (event) => {
    event.preventDefault();
    status(statusId, "Connecting and loading models…");
    try {
      const chosen = $(`#${form.prefix}-model`)?.value;
      const summary = await runtime("ollama.save", ollamaValues(which));
      applyOllamaSummary(which, summary);
      await settleViews();
      status(
        statusId,
        [
          `Saved. ${describeOllama(summary)} loaded; ${ollamaDisplayName(summary.model)} is the default${chosen ? "" : " (pick another above and save again to change it)"}.`,
          describeSkipped(summary),
        ]
          .filter(Boolean)
          .join(" "),
      );
      refreshDesktop();
    } catch (error) {
      status(statusId, error.message, true);
    }
  });
  $(`#refresh-${form.prefix}`).addEventListener("click", async () => {
    if (!ollamaExisting[which])
      return status(statusId, "Save first, then refresh.", true);
    status(statusId, "Refreshing models…");
    try {
      const summary = await runtime("ollama.refresh", {
        provider: form.provider,
      });
      applyOllamaSummary(which, summary);
      await settleViews();
      status(
        statusId,
        summary?.lastError ??
          [`${describeOllama(summary)} available.`, describeSkipped(summary)]
            .filter(Boolean)
            .join(" "),
        Boolean(summary?.lastError),
      );
      refreshDesktop();
    } catch (error) {
      status(statusId, error.message, true);
    }
  });
  $(`#test-${form.prefix}`).addEventListener("click", async () => {
    status(statusId, "Testing… a local model may take a while to load.");
    try {
      const result = await runtime("ollama.test", ollamaValues(which));
      const traits = [
        result.capabilities?.vision ? "accepts images" : "no image input",
        result.capabilities?.tools ? "accepts tools" : "no tool support",
      ].join(", ");
      status(
        statusId,
        `Connected. ${ollamaDisplayName(result.model)} ${result.calledTool ? "answered with a tool call" : "answered"} (${traits}${result.contextWindow ? `, ${result.contextWindow.toLocaleString()}-token context loaded` : ""}). ${result.modelCount} models on this ${which === "local" ? "server" : "account"}, ${result.visionModels} with image input.`,
      );
      await loadOllama();
      refreshDesktop();
    } catch (error) {
      status(statusId, error.message, true);
    }
  });
  $(`#clear-${form.prefix}`).addEventListener("click", (event) =>
    confirmInline(event.currentTarget, {
      question:
        which === "local"
          ? "Disconnect this Ollama server? अर्जुनः forgets its address, its key, and its models."
          : "Remove the Ollama Cloud key from this browser?",
      confirmLabel: which === "local" ? "Disconnect" : "Remove key",
      run: async () => {
        try {
          await runtime("ollama.clear", { provider: form.provider });
          applyOllamaSummary(which, null);
          if (which === "local") ollamaField(which, "base-url").value = "";
          await settleViews();
          status(
            statusId,
            which === "local"
              ? "Ollama server disconnected."
              : "Ollama Cloud key cleared.",
          );
          refreshDesktop();
        } catch (error) {
          status(statusId, error.message, true);
        }
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Usage and quota (SPEC 11.1)

function stat(label, value, sub) {
  const box = element("div", null, "stat");
  box.append(element("span", label, "stat-label"));
  box.append(element("span", value, "stat-value"));
  if (sub) box.append(element("span", sub, "stat-sub"));
  return box;
}
const resetsLabel = (at) =>
  `Resets ${new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
function meter(label, percent, note) {
  const share = Math.max(0, Math.min(100, Number(percent) || 0));
  const row = element("div", null, "meter-row");
  const head = element("div", null, "meter-head");
  head.append(
    element("span", label),
    element("b", `${Math.round(share)}% used`),
  );
  const bar = element("div", null, "meter");
  bar.classList.toggle("high", share >= 75);
  bar.classList.toggle("full", share >= 95);
  bar.setAttribute("role", "img");
  bar.setAttribute("aria-label", `${label}: ${Math.round(share)}% used`);
  const fill = element("span");
  fill.style.width = `${share}%`;
  bar.append(fill);
  row.append(head, bar);
  if (note) row.append(element("span", note, "stat-sub"));
  return row;
}
/** Local usage from the ledger, and the quota the provider reports, if any. */
function renderUsage(providerId) {
  const provider = catalogProvider(providerId);
  const usage = provider?.usage;
  const quota = provider?.quota;
  const box = element("div", null, "panel-body usage");
  const stats = element("div", null, "stats");
  const tokens =
    (usage?.dayPromptTokens ?? 0) + (usage?.dayCompletionTokens ?? 0);
  stats.append(
    stat(
      "Today",
      usage?.dayRequests ? plural(usage.dayRequests, "request") : "No requests",
      usage?.dayRequests ? `${compact(tokens)} tokens` : null,
    ),
    stat(
      "All time",
      usage?.totalRequests
        ? plural(usage.totalRequests, "request")
        : "No requests",
    ),
  );
  if (!quota?.windows?.length) {
    if (quota?.limit != null)
      stats.append(
        stat(
          "Quota",
          `${format(quota.used ?? 0)} / ${format(quota.limit)} ${quota.unit}`,
          quota.resetsAt ? resetsLabel(quota.resetsAt) : null,
        ),
      );
    else if (quota?.used != null)
      stats.append(stat("Quota used", `${format(quota.used)} ${quota.unit}`));
    else stats.append(stat("Quota", "Not reported", "by this provider"));
  }
  box.append(stats);
  if (quota?.windows?.length) {
    const meters = element("div", null, "meters");
    for (const window of quota.windows)
      meters.append(
        meter(
          window.label,
          window.usedPercent,
          window.resetsAt ? resetsLabel(window.resetsAt) : null,
        ),
      );
    if (quota.note) meters.append(element("p", quota.note, "hint"));
    box.append(meters);
  }
  return box;
}
function usagePanel(providerId, note) {
  const panel = element("section", null, "panel");
  panel.append(panelHead("Usage", note), renderUsage(providerId));
  return panel;
}

// ---------------------------------------------------------------------------
// The views of the four providers configured here

/** What a provider's picker holds, and the model saved for it. */
function pickedModel(id) {
  return {
    picked: $(PROVIDERS[id].model)?.value ?? "",
    saved: savedSummary(id)?.model ?? "",
  };
}
function providerState(id) {
  const saved = savedSummary(id);
  const provider = catalogProvider(id);
  if (!saved) return { label: "Not connected", tone: "muted" };
  if (saved.lastError) return { label: "Needs attention", tone: "warn" };
  if (provider && !provider.available)
    return {
      label: "Needs attention",
      tone: "warn",
      title: provider.reason ?? "",
    };
  return { label: "Connected", tone: "ok" };
}
/** Typed but unsaved input, which makes saving the view's next step. */
function isDirty(id) {
  if ($(KEY_FIELDS[id].input).value) return true;
  if (id === "ollama") {
    const typed = ollamaField("local", "base-url").value.trim();
    const saved = ollamaExisting.local;
    if (!saved) return Boolean(typed);
    if (typed && origin(typed) !== origin(saved.baseUrl)) return true;
  }
  const { picked, saved } = pickedModel(id);
  return Boolean(savedSummary(id) && picked && picked !== saved);
}
/**
 * A provider view's header: what it is, whether it works, whether websites use
 * it. Its actions slot holds the view's one primary action once the provider
 * works: making it the default, with the model picked below.
 */
function renderDetailHead(head, { id, name, blurb, kind, state, extra }) {
  const title = element("div", null, "detail-title");
  const heading = element("h1", name);
  heading.id = `${head.id.replace(/-head$/, "")}-title`;
  heading.tabIndex = -1;
  title.append(heading, pill(state.label, state.tone, state.title ?? ""));
  title.append(...extra);
  const actions = element("div", null, "detail-actions");
  head.replaceChildren(
    avatar(id, name, "lg"),
    title,
    element("p", `${KIND_LABELS[kind]} · ${blurb}`, "detail-desc"),
    actions,
  );
  return actions;
}
function useButton(id, onClick) {
  const button = element("button", null, "btn btn-primary");
  button.type = "button";
  button.id = id;
  button.append(icon("check"), "Use for websites");
  button.addEventListener("click", onClick);
  return button;
}
function renderStaticDetail(id) {
  const meta = PROVIDERS[id];
  const configured = isConfigured(id);
  const isDefault = configured && isDefaultProvider(id);
  const { picked, saved } = pickedModel(id);
  const extra = isDefault ? [defaultPill()] : [];
  if (id === "opencode-api" && opencodeExisting)
    extra.push(
      pill(
        opencodeExisting.tier === "paid"
          ? "Paid (Go) key"
          : "Key not yet tested",
      ),
    );
  const actions = renderDetailHead($(meta.head), {
    id,
    name: meta.name,
    blurb: meta.blurb,
    kind: meta.kind,
    state: providerState(id),
    extra,
  });
  // Offered only when it changes something: a provider websites do not use
  // yet, or the one they use with another model picked below.
  const offerUse =
    configured &&
    Boolean(catalogProvider(id)?.available) &&
    Boolean(picked) &&
    (!isDefault || picked !== saved);
  if (offerUse)
    actions.append(
      useButton(`${meta.prefix}-use`, () =>
        select({ type: meta.type, model: pickedModel(id).picked }),
      ),
    );
  const save = $(`#${meta.prefix}-save`);
  save.textContent = configured ? "Save changes" : "Connect";
  save.className = `btn ${!offerUse && (!configured || isDirty(id)) ? "btn-primary" : "btn-secondary"}`;
  const usage = $(`#${meta.prefix}-usage`);
  usage.hidden = !configured;
  usage.replaceChildren(
    ...(configured
      ? [
          panelHead(
            "Usage",
            "Counted in this browser. Quota appears when the provider reports it.",
          ),
          renderUsage(id),
        ]
      : []),
  );
  $(`[data-view="providers/${id}"] .danger-zone`).hidden = !configured;
  if (id === "opencode-api")
    $("#opencode-model-hint").textContent = opencodeExisting
      ? `${plural((opencodeExisting.models ?? []).length, "model")} available with this key.`
      : "Saving your key loads the models it can call.";
  if (id === "ollama" || id === "ollama-cloud") {
    const which = id === "ollama" ? "local" : "cloud";
    const summary = ollamaExisting[which];
    $(`#${meta.prefix}-model-hint`).textContent = summary
      ? `${describeOllama(summary)} on this ${which === "local" ? "server" : "account"}.`
      : which === "local"
        ? "Connecting loads the server's models and what each one accepts."
        : "Saving your key loads the hosted models and what each one accepts.";
    const notices = [];
    if (summary?.lastError)
      notices.push(
        banner({ title: "The last refresh failed.", text: summary.lastError }),
      );
    const skipped = describeSkipped(summary);
    if (skipped)
      notices.push(
        banner({
          tone: "muted",
          title: "Some models are not offered.",
          text: skipped,
        }),
      );
    $(`#${meta.prefix}-notices`).replaceChildren(...notices);
    $(`#refresh-${meta.prefix}`).hidden = !summary;
  }
}

// ---------------------------------------------------------------------------
// A subscription, drawn from the desktop app's state

// The model picked on a subscription's view outlives the redraws every state
// change causes, until the person moves on to another provider.
let subscriptionPick = { id: null, model: null };
function subscriptionState(entry) {
  if (entry.desktopProblem === "down")
    return { label: "Desktop app not running", tone: "warn" };
  if (entry.desktopProblem === "unpaired")
    return { label: "Pairing rejected", tone: "danger" };
  if (entry.available) return { label: "Connected", tone: "ok" };
  const state = entry.guidance?.state;
  if (state === "disabled")
    return { label: GUIDANCE_LABELS.disabled, tone: "muted" };
  if (state)
    return {
      label: GUIDANCE_LABELS[state] ?? "Needs attention",
      tone: state === "error" ? "danger" : "warn",
    };
  return {
    label: entry.installed ? "Not signed in" : "Not installed",
    tone: "warn",
  };
}
/**
 * The account line every subscription shows, so it is obvious which sign-in a
 * website request will be billed to.
 */
function renderConnection(provider) {
  const link = provider.connection;
  const box = element("div", null, "connection");
  if (!provider.available || (!link && !provider.account)) {
    box.classList.add("none");
    box.append(
      element(
        "p",
        provider.available
          ? "Signed in, account not reported by the CLI."
          : "Not connected to any account.",
      ),
    );
    return box;
  }
  // Older companions report only a plain account label.
  const line = element("div", null, "connection-line");
  line.append(
    element(
      "span",
      !link || link.account ? "Connected as" : "Connected via",
      "label",
    ),
    element(
      "strong",
      link ? (link.account ?? link.method ?? "signed in") : provider.account,
      "account",
    ),
  );
  box.append(line);
  box.append(
    element(
      "p",
      [
        link?.account && link?.method ? link.method : null,
        link?.source,
        "Requests run on this computer through the desktop app and count against this account.",
      ]
        .filter(Boolean)
        .join(" · "),
      "connection-detail",
    ),
  );
  return box;
}
function renderGuidance(provider) {
  const guide = provider.guidance;
  const box = element("div", null, `guidance ${guide?.state ?? "other"}`);
  if (!guide) {
    if (provider.reason) box.append(rich("p", provider.reason, "reason"));
    return box;
  }
  box.append(rich("p", guide.summary, "guidance-summary"));
  if (guide.steps?.length) {
    const list = element("ol", null, "steps");
    for (const step of guide.steps)
      list.append(rich("li", step.replace(/\bRe-check\b/g, "Check again")));
    box.append(list);
  }
  if (guide.note) box.append(rich("p", guide.note, "note"));
  if (guide.links?.length) {
    const links = element("div", null, "link-list");
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
      "These steps run on this computer, not in the browser. Choose Check again once done, or open the desktop dashboard for a custom binary path.",
      "note",
    ),
  );
  return box;
}
function renderSubscription({ force = false } = {}) {
  if (route.view !== "providers/desktop") return;
  // A redraw must not pull a picker out from under the person using it.
  if (!force && $("#subscription-model")?.contains(document.activeElement))
    return;
  const mount = $("#subscription");
  const entry = desktopEntry(route.providerId);
  if (!entry) {
    const empty = element("section", null, "panel empty");
    empty.append(
      element(
        "h1",
        desktop?.paired
          ? "The desktop app does not report this provider"
          : "Pair the desktop app first",
      ),
      element(
        "p",
        desktop?.paired
          ? "It may have been removed, or detection has not finished yet."
          : "Subscriptions such as Claude Code, Codex, and OpenCode reach websites through the desktop app.",
      ),
    );
    const go = element(
      "a",
      desktop?.paired ? "All providers" : "Set up the desktop app",
      "btn btn-primary",
    );
    go.href = desktop?.paired ? "#providers" : "#desktop";
    empty.append(go);
    mount.replaceChildren(empty);
    return;
  }
  const id = publicIdFor(entry.id);
  const active = activeSelection();
  const isDefault = isDefaultProvider(id);
  if (subscriptionPick.id !== id) subscriptionPick = { id, model: null };
  const models = entry.desktopProblem
    ? [{ id: "", displayName: "Models unavailable" }]
    : entry.models?.length
      ? entry.models
      : [{ id: "default", displayName: "Default model" }];
  const picked =
    subscriptionPick.model ??
    (isDefault ? active.model : entry.defaultModel) ??
    models[0]?.id;

  const head = element("header", null, "detail-head");
  head.id = "subscription-head";
  const extra = [];
  if (entry.connection?.plan) extra.push(pill(entry.connection.plan, "ok"));
  if (isDefault) extra.push(defaultPill());
  const actions = renderDetailHead(head, {
    id,
    name: entry.name,
    blurb:
      SUBSCRIPTION_BLURBS[id] ?? "Through the desktop app on this computer.",
    kind: "subscription",
    state: subscriptionState(entry),
    extra,
  });
  if (
    entry.available &&
    Boolean(picked) &&
    (!isDefault || picked !== active.model)
  )
    actions.append(
      useButton("subscription-use", () =>
        select({
          type: "desktop",
          providerId: entry.id,
          model: $("#subscription-model").value,
        }),
      ),
    );
  const main = element("div", null, "split-main");
  const side = element("div", null, "split-side");
  if (entry.desktopProblem)
    main.append(
      banner({
        tone: entry.desktopProblem === "down" ? "warn" : "danger",
        title:
          entry.desktopProblem === "down"
            ? "अर्जुनः Desktop is not running."
            : "अर्जुनः Desktop no longer recognises this browser.",
        text:
          entry.desktopProblem === "down"
            ? `${entry.name} is unavailable until you start it with \`arjunah-desktop start\`.`
            : "Unpair and pair again with a fresh code to use your subscriptions.",
        action: { label: "Open Desktop app", href: "#desktop" },
      }),
    );
  else if (!entry.available) {
    const guide = element("section", null, "panel");
    guide.append(
      panelHead(
        "Get it working",
        entry.guidance?.state === "disabled"
          ? "Enable this provider on the desktop dashboard first."
          : null,
      ),
    );
    const body = element("div", null, "panel-body");
    const again = element("button", "Check again", "btn btn-secondary");
    again.type = "button";
    again.addEventListener("click", () => refreshDesktop(true));
    if (desktopChecking === "recheck") {
      again.disabled = true;
      again.replaceChildren(element("span", null, "spinner"), "Checking…");
    }
    const row = element("div", null, "actions");
    row.append(again);
    body.append(renderGuidance(entry));
    if (entry.version)
      body.append(element("p", `Version ${entry.version} installed.`, "hint"));
    body.append(row);
    guide.append(body);
    main.append(guide);
  }
  const split = element("div", null, "split");
  split.append(main, side);
  // Until it works there is no account to show and no model to pick: the
  // steps above are the whole view.
  if (!entry.available) {
    side.hidden = true;
    redraw(mount, () => mount.replaceChildren(head, split));
    return;
  }
  if (entry.installed) {
    const account = element("section", null, "panel");
    account.append(panelHead("Account"));
    const body = element("div", null, "panel-body");
    body.append(renderConnection(entry));
    if (entry.version)
      body.append(element("p", `Version ${entry.version}`, "hint"));
    if (entry.sandboxed)
      body.append(
        element(
          "p",
          "Runs inside an additional macOS sandbox: reads and writes under your home folder are denied.",
          "hint",
        ),
      );
    if (entry.notice) body.append(rich("p", entry.notice, "notice"));
    account.append(body);
    side.append(account);
  }
  const combo = modelCombo({
    label: `${entry.name} model`,
    models,
    value: picked,
    disabled: !entry.available,
    title: entry.available ? "" : (entry.reason ?? ""),
    onChange: (model) => {
      subscriptionPick = { id, model };
      renderSubscription({ force: true });
    },
  });
  combo.id = "subscription-model";
  const modelPanel = element("section", null, "panel");
  modelPanel.append(
    panelHead(
      "Model",
      isDefault
        ? "Websites use this provider. Pick another model to switch."
        : "The model websites get when you make this the default.",
    ),
  );
  const body = element("div", null, "panel-body fields");
  const field = element("div", null, "field");
  field.append(element("span", "Model", "label"), combo);
  const test = element("button", "Test", "btn btn-secondary");
  test.type = "button";
  test.disabled = !entry.available;
  test.addEventListener("click", async () => {
    status(
      "#subscription-status",
      `Testing ${entry.name}… this can take a minute.`,
    );
    try {
      const result = await runtime("desktop.test", {
        providerId: entry.id,
        model: $("#subscription-model").value,
      });
      status(
        "#subscription-status",
        `${entry.name} answered: ${result.content}`,
      );
    } catch (error) {
      status("#subscription-status", error.message, true);
    }
  });
  const row = element("div", null, "actions");
  row.append(test);
  // A test result outlives the redraws the test itself causes.
  const previous = $("#subscription-status");
  const line = element("p", previous?.textContent ?? "", "status");
  line.classList.toggle(
    "error",
    Boolean(previous?.classList.contains("error")),
  );
  line.id = "subscription-status";
  line.setAttribute("role", "status");
  body.append(field, row, line);
  modelPanel.append(body);
  main.append(modelPanel);
  if (catalogProvider(id))
    side.append(
      usagePanel(
        id,
        "Counted in this browser. Plan usage comes from the agent when it reports it.",
      ),
    );
  side.hidden = !side.childElementCount;
  redraw(mount, () => mount.replaceChildren(head, split));
}

// ---------------------------------------------------------------------------
// The provider list

function providerRow({ id, name, meta, kind, state, isDefault, extra, cta }) {
  const row = element("a", null, "row provider");
  row.href = `#providers/${id}`;
  row.dataset.provider = id;
  const main = element("div", null, "row-main");
  const title = element("div", null, "row-title");
  title.append(element("strong", name));
  if (isDefault) title.append(defaultPill());
  if (extra) title.append(...extra);
  main.append(title, element("div", meta, "row-meta"));
  const end = element("div", null, "row-end");
  if (kind) end.append(element("span", KIND_LABELS[kind], "row-kind"));
  if (cta) end.append(element("span", cta, "row-cta"));
  else if (state) end.append(pill(state.label, state.tone));
  end.append(icon("chevron", "icon chev"));
  row.append(avatar(id, name), main, end);
  return row;
}
function staticRowMeta(id) {
  const saved = savedSummary(id);
  if (!saved) return PROVIDERS[id].blurb;
  if (id === "openai")
    return `${modelName("openai", saved.model)} · key stored in this browser`;
  if (id === "opencode-api")
    return `${opencodeDisplayName(saved.model)} · ${
      saved.tier === "paid" ? "paid (Go) key" : "key not yet tested"
    } · ${plural((saved.models ?? []).length, "model")}`;
  return [
    ollamaDisplayName(saved.model),
    catalogProvider(id)?.account,
    describeOllama(saved),
  ]
    .filter(Boolean)
    .join(" · ");
}
function subscriptionMeta(entry) {
  // The desktop app's own problem is stated once, above the list.
  if (entry.desktopProblem)
    return entry.connection?.account ?? "Waiting for the desktop app";
  if (entry.available)
    return [
      entry.connection?.account ?? entry.account ?? "Signed in",
      plural(entry.models?.length || 1, "model"),
    ].join(" · ");
  const why = entry.guidance?.summary ?? entry.reason;
  if (why) return why.replace(/`/g, "");
  return entry.installed ? "Not signed in." : "Not installed on this computer.";
}
function subscriptionRow(entry) {
  const id = publicIdFor(entry.id);
  return providerRow({
    id,
    name: entry.name,
    meta: subscriptionMeta(entry),
    state: subscriptionState(entry),
    isDefault: isDefaultProvider(id),
    extra: entry.connection?.plan ? [pill(entry.connection.plan, "ok")] : null,
  });
}
function group(title, description, rows) {
  const box = element("section", null, "group");
  const head = element("div", null, "group-head");
  head.append(element("h2", title));
  if (description) head.append(element("p", description));
  const list = element("div", null, "provider-cards");
  list.append(...rows);
  box.append(head, list);
  return box;
}
function renderProviderList() {
  const parts = [];
  const problem = desktopProblem();
  if (problem)
    parts.push(
      banner({
        tone: "danger",
        title: problem.title,
        text: problem.text,
        action: { label: problem.action, href: "#desktop" },
      }),
    );
  const connected = [];
  const add = [];
  for (const id of STATIC_PROVIDERS) {
    const configured = isConfigured(id);
    const row = providerRow({
      id,
      name: PROVIDERS[id].name,
      meta: staticRowMeta(id),
      kind: configured ? null : PROVIDERS[id].kind,
      state: configured ? providerState(id) : null,
      isDefault: configured && isDefaultProvider(id),
      cta: configured ? null : "Connect",
    });
    (configured ? connected : add).push(row);
  }
  const waiting = [];
  for (const entry of desktop?.providers ?? [])
    (entry.available ? connected : waiting).push(subscriptionRow(entry));
  if (connected.length)
    parts.push(
      group(
        "Connected",
        "Open one to pick its model, test it, or make it the default.",
        connected,
      ),
    );
  if (add.length)
    parts.push(
      group(
        connected.length ? "Add another provider" : "Add a provider",
        "Bring an API key, or your own Ollama server.",
        add,
      ),
    );
  if (!desktop?.paired) {
    const row = element("a", null, "row provider");
    row.href = "#desktop";
    const marks = element("span", null, "mark-stack");
    for (const id of ["claude-code", "codex", "opencode-cli"]) {
      const mark = providerMark(id, { badges: false });
      if (mark) marks.append(mark);
    }
    const main = element("div", null, "row-main");
    const title = element("div", null, "row-title");
    title.append(element("strong", "Claude Code, Codex, and OpenCode"));
    main.append(
      title,
      element(
        "div",
        "Use the subscriptions you're signed in to on this computer, through the desktop app.",
        "row-meta",
      ),
    );
    const end = element("div", null, "row-end");
    end.append(
      element("span", KIND_LABELS.subscription, "row-kind"),
      element("span", "Set up", "row-cta"),
      icon("chevron", "icon chev"),
    );
    row.append(marks, main, end);
    parts.push(group("Subscriptions", null, [row]));
  } else if (waiting.length)
    parts.push(
      group(
        "Subscriptions on this computer",
        "Found by the desktop app, but not ready yet.",
        waiting,
      ),
    );
  const list = $("#provider-list");
  redraw(list, () => list.replaceChildren(...parts));
}

// ---------------------------------------------------------------------------
// Overview

/** Why subscription providers are unusable right now, or null. */
function desktopProblem() {
  if (!desktop?.paired) return null;
  if (!desktop.running)
    return {
      title: "अर्जुनः Desktop is not running.",
      text: "Claude Code, Codex, and OpenCode are unavailable until you start it with `arjunah-desktop start`.",
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
function attentionItems() {
  const items = [];
  const problem = desktopProblem();
  if (problem)
    items.push({
      tone: "danger",
      title: problem.title,
      text: problem.text,
      action: { label: problem.action, href: "#desktop" },
    });
  else if (desktop?.providerError)
    items.push({
      title: "The desktop app could not list its providers.",
      text: desktop.providerError,
      action: { label: "Open Desktop app", href: "#desktop" },
    });
  for (const [which, id] of [
    ["local", "ollama"],
    ["cloud", "ollama-cloud"],
  ])
    if (ollamaExisting[which]?.lastError)
      items.push({
        title: `${PROVIDERS[id].name} needs attention.`,
        text: ollamaExisting[which].lastError,
        action: { label: "Open", href: `#providers/${id}` },
      });
  if (activeSelection().type && catalog && !catalog.defaultModel && !problem)
    items.push({
      title: "Your default model is unavailable.",
      text: `${activeInfo?.label ?? "The provider you chose"} cannot answer right now. Choose another default below.`,
    });
  return items;
}
const anythingConfigured = () =>
  Boolean(
    existing ||
      opencodeExisting ||
      ollamaExisting.local ||
      ollamaExisting.cloud ||
      desktop?.paired,
  );
function renderGlobalPicker() {
  const mount = $("#global-model-mount");
  const hint = $("#global-model-hint");
  const available = (catalog?.providers ?? []).filter(
    (provider) => provider.available && provider.models?.length,
  );
  if (!available.length) {
    const empty = element("div", null, "empty-inline");
    const go = element("a", "Open providers", "btn btn-primary");
    go.href = "#providers";
    empty.append(element("p", "No provider is ready to answer yet."), go);
    mount.replaceChildren(empty);
    hint.textContent = "";
    return;
  }
  const models = available.flatMap((provider) =>
    provider.models.map((model) => ({
      id: model.id,
      displayName: model.displayName,
      group: providerName(provider),
      providerId: provider.id,
    })),
  );
  const answering = available.find((provider) =>
    provider.models.some((model) => model.id === catalog.defaultModel),
  );
  hint.textContent = [
    answering
      ? `Answered by ${providerName(answering)}${answering.kind === "subscription" ? " on this computer" : ""}.`
      : activeSelection().type
        ? `${activeInfo?.label ?? "Your default"} cannot answer right now. Pick a model that can.`
        : "Nothing is chosen yet, so sites without a model of their own have nothing to use.",
    `${plural(models.length, "model")} from ${plural(available.length, "provider")}; type to search.`,
  ].join(" ");
  // Typing into the picker must survive a background refresh.
  if ($("#global-model")?.contains(document.activeElement)) return;
  const combo = modelCombo({
    label: "Default model for websites",
    models,
    value: catalog?.defaultModel ?? "",
    grouped: true,
    placeholder: "Choose a model",
    onChange: (id) => {
      if (id) void select({ model: id }, "catalog.default");
    },
  });
  combo.id = "global-model";
  mount.replaceChildren(combo);
}
function tile({ label, value, sub, href, tone }) {
  const node = element(href ? "a" : "div", null, "tile");
  if (href) node.href = href;
  const head = element("span", null, "tile-label");
  if (tone) head.append(element("span", null, `dot ${tone}`));
  head.append(label);
  node.append(head, element("span", value, "tile-value"));
  if (sub) node.append(element("span", sub, "tile-sub"));
  return node;
}
function desktopWord() {
  if (!desktop || desktop.checking) return { value: "Checking…" };
  if (desktop.paired && desktop.running && desktop.accepted)
    return {
      value: "Connected",
      sub: `${desktop.device || "This computer"} · v${desktop.version}`,
      tone: "on",
    };
  if (desktop.paired && !desktop.running)
    return { value: "Not running", sub: "Paired, not reachable", tone: "warn" };
  if (desktop.paired)
    return { value: "Pairing rejected", sub: "Pair again", tone: "warn" };
  if (desktop.running)
    return { value: "Ready to pair", sub: `Version ${desktop.version} found` };
  return { value: "Not paired", sub: "Optional, for subscriptions" };
}
function renderTiles() {
  const available = (catalog?.providers ?? []).filter((item) => item.available);
  let requests = 0;
  let tokens = 0;
  for (const item of available) {
    requests += item.usage?.dayRequests ?? 0;
    tokens +=
      (item.usage?.dayPromptTokens ?? 0) +
      (item.usage?.dayCompletionTokens ?? 0);
  }
  const names = available.map(providerName);
  const tiles = $("#tiles");
  tiles.hidden = !anythingConfigured();
  redraw(tiles, () =>
    tiles.replaceChildren(
      tile({
        label: "Providers",
        value: available.length
          ? `${available.length} connected`
          : "None ready",
        sub: names.length
          ? `${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}`
          : "Connect one to start",
        href: "#providers",
      }),
      tile({
        label: "Sites",
        value: grants.length ? plural(grants.length, "site") : "No sites",
        sub: grants.length ? "with access" : "Listed once you approve one",
        href: "#sites",
      }),
      tile({ label: "Desktop app", ...desktopWord(), href: "#desktop" }),
      tile({
        label: "Today",
        value: requests ? plural(requests, "request") : "No requests",
        sub: requests
          ? `${compact(tokens)} tokens, all providers`
          : "Counted here, never shared",
      }),
    ),
  );
}
/** Today's requests per provider, with the plan windows a provider reports. */
function renderUsageToday() {
  const providers = (catalog?.providers ?? [])
    .filter((provider) => provider.available)
    .sort((a, b) => (b.usage?.dayRequests ?? 0) - (a.usage?.dayRequests ?? 0));
  const rows = providers.map((provider) => {
    const usage = provider.usage;
    const row = element("div", null, "usage-row");
    const name = element("div", null, "usage-name");
    name.append(
      avatar(provider.id, providerName(provider), "sm"),
      element("strong", providerName(provider)),
    );
    const tokens =
      (usage?.dayPromptTokens ?? 0) + (usage?.dayCompletionTokens ?? 0);
    row.append(
      name,
      element(
        "span",
        usage?.dayRequests
          ? `${plural(usage.dayRequests, "request")} · ${compact(tokens)} tokens`
          : "No requests",
        "usage-figure",
      ),
    );
    const windows = provider.quota?.windows ?? [];
    if (windows.length) {
      const meters = element("div", null, "usage-meters");
      for (const window of windows)
        meters.append(
          meter(
            window.label,
            window.usedPercent,
            window.resetsAt ? resetsLabel(window.resetsAt) : null,
          ),
        );
      row.append(meters);
    }
    return row;
  });
  $("#usage-list").replaceChildren(
    ...(rows.length
      ? rows
      : [element("p", "No provider is ready yet.", "empty-inline")]),
  );
}
function renderRecentSites() {
  const recent = [...grants]
    .sort((a, b) => String(b.grantedAt).localeCompare(String(a.grantedAt)))
    .slice(0, 5);
  const rows = recent.map((grant) => {
    const host = hostOf(grant.origin);
    const row = element("a", null, "row");
    row.href = "#sites";
    const initial = element(
      "span",
      host
        .replace(/^www\./, "")
        .charAt(0)
        .toUpperCase(),
      "site-avatar",
    );
    initial.setAttribute("aria-hidden", "true");
    const main = element("div", null, "row-main");
    const title = element("div", null, "row-title");
    title.append(
      element("strong", host),
      element(
        "span",
        LEVEL_NAMES[grant.level] ?? grant.level,
        `level level-${grant.level}`,
      ),
    );
    main.append(
      title,
      element(
        "div",
        grant.model ? catalogModelLabel(grant.model) : "Uses the default model",
        "row-meta",
      ),
    );
    row.append(initial, main);
    return row;
  });
  $("#recent-sites").replaceChildren(
    ...(rows.length
      ? rows
      : [element("p", "No site has access yet.", "empty-inline")]),
  );
}
function renderOverview() {
  const items = attentionItems();
  const attention = $("#attention");
  attention.hidden = !items.length;
  redraw(attention, () => attention.replaceChildren(...items.map(banner)));
  // Until the desktop app has answered, a page with only a pairing would
  // flash the first-run welcome.
  const configured = anythingConfigured();
  $("#welcome").hidden = configured || !desktop;
  $("#default-panel").hidden = !configured;
  if (configured) renderGlobalPicker();
  $("#overview-more").hidden = !configured;
  renderUsageToday();
  renderRecentSites();
  renderTiles();
}
function renderNav() {
  const available = (catalog?.providers ?? []).filter((item) => item.available);
  $("#nav-providers").textContent = available.length
    ? String(available.length)
    : "";
  $("#nav-sites").textContent = grants.length ? String(grants.length) : "";
  const word = desktopWord();
  const dot = element("span", null, `dot ${word.tone ?? ""}`);
  dot.title = word.value;
  $("#nav-desktop").replaceChildren(...(desktop?.paired ? [dot] : []));
}

// ---------------------------------------------------------------------------
// Desktop app

function renderDesktop() {
  const link = $("#dashboard-link");
  const address = $("#desktop-url");
  // Status refreshes probe the saved/default address. Until pairing succeeds,
  // they must not overwrite a custom loopback address the user is entering.
  if (desktop?.paired && desktop.baseUrl) address.value = desktop.baseUrl;
  link.href = `${desktop?.paired ? desktop.baseUrl : address.value || "http://127.0.0.1:48123"}/`;
  $("#desktop-address-value").textContent = address.value;
  const connected = Boolean(desktop?.paired && desktop?.accepted);
  // A paired app that is not running cannot take a code either: starting it
  // is the next step, so checking again is what this view leads with.
  const down = Boolean(desktop?.paired && !desktop.running);
  // "status": the first answer is not in yet and the view shows the last
  // known state; "recheck": an explicit re-check is running.
  const checking =
    desktopChecking ?? (!desktop || desktop.checking ? "status" : null);
  $("#desktop-danger").hidden = !desktop?.paired;
  $("#pair").hidden = connected || down;
  $("#desktop-code-field").hidden = connected || down;
  const refresh = $("#refresh-desktop");
  refresh.className = `btn ${down && !checking ? "btn-primary" : "btn-secondary"}`;
  refresh.disabled = Boolean(checking);
  refresh.replaceChildren(
    ...(checking ? [element("span", null, "spinner"), "Checking…"] : []),
  );
  if (!checking) refresh.textContent = connected ? "Refresh" : "Check again";
  address.readOnly = Boolean(desktop?.paired);
  let heading;
  let text;
  let tone = "";
  if (checking === "status") {
    heading = "Checking the desktop app…";
    text = desktop?.paired
      ? `Reaching ${desktop.device || "the desktop app"} at ${desktop.baseUrl}. Below is what it reported last time.`
      : "Looking for the desktop app on this computer.";
  } else if (!desktop.running) {
    heading = desktop.paired ? "Not running" : "Not detected";
    tone = desktop.paired ? "warn" : "";
    text = desktop.paired
      ? `Paired, but the desktop app is not running at ${desktop.baseUrl}. Start it to use desktop providers.`
      : "Desktop app not detected. Start it, then enter its pairing code.";
  } else if (desktop.paired && desktop.accepted) {
    heading = "Connected";
    tone = "ok";
    text = `Connected to ${desktop.device || "the desktop app"} (v${desktop.version}) since ${new Date(desktop.pairedAt).toLocaleString()}.`;
  } else if (desktop.paired) {
    heading = "Pairing no longer accepted";
    tone = "danger";
    text =
      "The desktop app no longer accepts this pairing. Unpair and pair again.";
  } else {
    heading = "Ready to pair";
    tone = "accent";
    text = `Desktop app v${desktop.version} detected on ${desktop.device || "this computer"}. Enter its pairing code.`;
  }
  if (checking === "recheck")
    text =
      "Re-checking what is installed and signed in. This can take up to a minute.";
  else if (desktop?.providerError) text += ` ${desktop.providerError}`;
  $("#desktop-heading").textContent = heading;
  $("#desktop-badge").className =
    `hero-icon ${checking ? "accent busy" : tone}`;
  status(
    "#desktop-state",
    text,
    Boolean(
      !checking &&
        desktop &&
        ((desktop.paired && !(desktop.running && desktop.accepted)) ||
          desktop.providerError),
    ),
  );
  $("#desktop-setup").hidden =
    !desktop || Boolean(checking) || desktop.running || desktop.paired;
  $("#desktop-providers").hidden = !desktop?.paired;
  $("#desktop-providers").setAttribute("aria-busy", String(Boolean(checking)));
  const rows = (desktop?.providers ?? []).map(subscriptionRow);
  const list = $("#desktop-provider-list");
  redraw(list, () =>
    list.replaceChildren(
      ...(rows.length || !desktop?.paired
        ? rows
        : [element("p", "No coding agents found yet.", "empty-inline")]),
    ),
  );
}

// ---------------------------------------------------------------------------
// Sites

const LEVEL_NAMES = Object.freeze({
  assistant: "Assistant",
  completion: "Completion",
  catalog: "Catalog",
});
const LEVEL_LABELS = Object.freeze({
  assistant: "Level 0 · Assistant",
  completion: "Level 1 · Completion",
  catalog: "Level 2 · Catalog",
});
const CAPABILITY_LABELS = Object.freeze({
  "models.list": "read its model's details",
  "models.generate": "send requests to its model",
  "models.catalog": "list and choose exposed models",
  "context.read": "read the page context you approved",
  "chat.hosted": "hosted chat",
  "tools.site": "run its page tools from chat",
  "tools.mcp": "connect chat to its MCP servers",
});
const CONTEXT_LABELS = Object.freeze({
  title: "page title",
  url: "page address",
  selection: "selected text",
  text: "page text",
});
function renderStoredState() {
  const summary = $("#stored-state-summary");
  if (!storedState) {
    summary.textContent = "The amount stored could not be read.";
    return;
  }
  const { entries, bytes, origins, threads } = storedState;
  const sites = Object.keys(origins ?? {}).length;
  const parts = [];
  if (entries)
    parts.push(
      `${plural(entries, "provider-state entry", "provider-state entries")} (${approxSize(bytes)}) for ${plural(sites, "site")}`,
    );
  if (threads) parts.push(plural(threads, "desktop agent thread"));
  summary.textContent = parts.length ? parts.join(" · ") : "Nothing stored.";
}
// The site a page's openSettings() asked about (options.html#grants:<origin>):
// scrolled to once, and outlined for as long as the page stays open.
let askedOrigin = null;
let askedPending = false;
function showAskedOrigin(rows) {
  if (!askedOrigin || !grantsLoaded) return;
  const row = rows.find((item) => item.dataset.origin === askedOrigin);
  row?.classList.add("asked");
  if (!askedPending || route.view !== "sites") return;
  askedPending = false;
  if (row) {
    row.scrollIntoView({ block: "center" });
    row.focus({ preventScroll: true });
  } else {
    $("#grants").scrollIntoView({ block: "center" });
    status("#grant-status", `${askedOrigin} holds no site grant.`);
  }
}
async function refreshGrants() {
  const [list, stored] = await Promise.all([
    runtime("grants.list"),
    runtime("grants.storedState").catch(() => null),
  ]);
  grants = list;
  grantsLoaded = true;
  storedState = stored;
  renderGrants();
  renderNav();
  renderTiles();
  renderRecentSites();
}
// A revoke question survives the redraw a background refresh causes.
let revoking = null;
function askRevoke(button, grant, focus = true) {
  revoking = grant.origin;
  confirmInline(button, {
    focus,
    question: `Revoke access for ${hostOf(grant.origin)}? It will have to ask again, and its stored conversation state is deleted.`,
    confirmLabel: "Revoke access",
    onClose: () => {
      if (revoking === grant.origin) revoking = null;
    },
    run: async () => {
      try {
        await runtime("grants.revoke", { origin: grant.origin });
        revoking = null;
        await refreshGrants();
        status(
          "#grant-status",
          "Site grant revoked and its stored conversation state deleted.",
        );
      } catch (error) {
        status("#grant-status", error.message, true);
      }
    },
  });
}
function grantRow(grant) {
  const row = element("div", null, "grant");
  row.dataset.origin = grant.origin;
  row.tabIndex = -1;
  const host = hostOf(grant.origin);
  const initial = element(
    "span",
    host
      .replace(/^www\./, "")
      .charAt(0)
      .toUpperCase(),
    "site-avatar",
  );
  initial.setAttribute("aria-hidden", "true");
  const main = element("div", null, "grant-main");
  const head = element("div", null, "origin");
  const level = element(
    "span",
    LEVEL_NAMES[grant.level] ?? grant.level,
    `level level-${grant.level}`,
  );
  level.title = LEVEL_LABELS[grant.level] ?? grant.level;
  head.append(element("strong", host), level);
  main.append(head);
  // The exact origin is what the grant covers; the host alone hides a scheme
  // or a port that differs.
  if (grant.origin !== `https://${host}`)
    main.append(element("div", grant.origin, "grant-origin"));
  const facts = element("dl", null, "grant-facts");
  const fact = (term, value) => {
    if (!value) return;
    const item = element("div", null, term === "Can" ? "wide" : null);
    item.append(element("dt", term), element("dd", value));
    facts.append(item);
  };
  fact("Model", grant.model ? catalogModelLabel(grant.model) : null);
  fact(
    "Shares",
    grant.context?.length
      ? capitalize(
          grant.context.map((item) => CONTEXT_LABELS[item] ?? item).join(", "),
        )
      : null,
  );
  fact(
    "Approved",
    grant.grantedAt
      ? new Date(grant.grantedAt).toLocaleDateString([], {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : null,
  );
  fact(
    "Can",
    grant.capabilities?.length
      ? capitalize(
          grant.capabilities
            .map((item) => CAPABILITY_LABELS[item] ?? item)
            .join(", "),
        )
      : null,
  );
  const kept = storedState?.origins?.[grant.origin];
  main.append(
    facts,
    element(
      "div",
      kept?.entries
        ? `Stored conversation state: ${plural(kept.entries, "entry", "entries")}, ${approxSize(kept.bytes)}. Revoking deletes it.`
        : "No stored conversation state. Revoking deletes any it keeps.",
      "detail",
    ),
  );
  const button = element("button", "Revoke", "btn btn-danger btn-sm");
  button.type = "button";
  button.title =
    "Revoke this site's grant and delete its stored conversation state";
  button.addEventListener("click", () => askRevoke(button, grant));
  const actions = element("div", null, "grant-actions");
  actions.append(button);
  row.append(initial, main, actions);
  return row;
}
function renderGrants() {
  renderStoredState();
  const mount = $("#grants");
  $("#clear-grants").disabled = !grants.length;
  if (!grantsLoaded) {
    mount.replaceChildren(element("p", "Checking…", "empty-inline"));
    return;
  }
  const query = $("#sites-filter").value.trim().toLowerCase();
  $("#sites-toolbar").hidden = grants.length < 6;
  const shown = query
    ? grants.filter((grant) => grant.origin.toLowerCase().includes(query))
    : grants;
  const rows = shown.map(grantRow);
  // A revoke question that had focus gets it back when it is reopened below.
  const questionFocused = Boolean(
    mount.querySelector(".confirm")?.contains(document.activeElement),
  );
  redraw(mount, () => mount.replaceChildren(...rows));
  if (!grants.length) {
    const empty = element("div", null, "empty");
    empty.append(
      icon("globe", "icon empty-icon"),
      element("h3", "No site has access yet"),
      element(
        "p",
        "When a website that supports अर्जुनः asks to use your AI, you choose what it gets, and it shows up here.",
      ),
    );
    mount.append(empty);
  } else if (!rows.length)
    mount.append(element("p", "No site matches that filter.", "empty-inline"));
  const asking = rows.find((row) => row.dataset.origin === revoking);
  if (asking)
    askRevoke(
      asking.querySelector(".grant-actions .btn"),
      grants.find((grant) => grant.origin === revoking),
      questionFocused,
    );
  else revoking = null;
  showAskedOrigin(rows);
}

// ---------------------------------------------------------------------------
// The default model

async function select(choice, method = "provider.select") {
  toast("Switching the default model…");
  try {
    const result = await runtime(method, choice);
    activeInfo = result;
    if (desktop) desktop = { ...desktop, ...result };
    [existing, opencodeExisting] = await Promise.all([
      runtime("provider.get"),
      runtime("opencode.get"),
    ]);
    await loadOllama();
    catalog = await runtime("catalog.get").catch(() => catalog);
    for (const id of STATIC_PROVIDERS)
      followSaved(PROVIDERS[id].model, savedSummary(id)?.model);
    subscriptionPick = { id: null, model: null };
    renderAll();
    toast(`Websites now use ${result.label}.`);
  } catch (error) {
    renderAll();
    toast(error.message, true);
  }
}
async function refreshDesktop(refresh = false) {
  if (pairingDesktop) return;
  const request = ++desktopRequest;
  // Before the first answer, draw what the extension last knew, marked as
  // being checked, rather than an empty view for as long as the read takes.
  if (!desktop) {
    const cached = await runtime("desktop.status", { cached: true }).catch(
      () => null,
    );
    if (cached && !desktop && request === desktopRequest) {
      desktop = cached;
      renderAll();
    }
  }
  if (refresh) {
    desktopChecking = "recheck";
    renderAll();
  }
  let nextDesktop;
  try {
    nextDesktop = await runtime("desktop.status", { refresh });
  } catch (error) {
    nextDesktop = { running: false, paired: false, error: error.message };
  }
  const nextCatalog = await runtime("catalog.get").catch(() => catalog);
  // The views follow a background catalog refresh; the forms keep what is typed.
  await loadOllama().catch(() => {});
  if (request !== desktopRequest) return;
  desktop = nextDesktop;
  desktopChecking = null;
  if (nextDesktop.active)
    activeInfo = {
      active: nextDesktop.active,
      label: nextDesktop.label,
      configured: nextDesktop.configured,
    };
  catalog = nextCatalog;
  followOllama("local");
  followOllama("cloud");
  renderAll();
  refreshGrants().catch(() => {});
}
/** After a change the person made: every view shows it before it is announced. */
async function settleViews() {
  catalog = await runtime("catalog.get").catch(() => catalog);
  renderAll();
}
function renderAll() {
  renderNav();
  renderOverview();
  renderProviderList();
  for (const id of STATIC_PROVIDERS) renderStaticDetail(id);
  renderSubscription();
  renderDesktop();
}

// ---------------------------------------------------------------------------
// Router: #overview, #providers, #providers/<id>, #sites, #desktop,
// #diagnostics, #about. #grants:<origin> is the address openSettings() opens
// (SPEC 3), and the anchors of the old single-page layout still land.

const VIEW_TITLES = Object.freeze({
  overview: "Overview",
  providers: "Providers",
  sites: "Sites",
  desktop: "Desktop app",
  diagnostics: "Diagnostics",
  about: "About",
});
const VIEWS = new Set([
  ...Object.keys(VIEW_TITLES),
  ...STATIC_PROVIDERS.map((id) => `providers/${id}`),
]);
const LEGACY_ROUTES = Object.freeze({
  grants: "sites",
  "desktop-section": "desktop",
  "logs-section": "diagnostics",
  logs: "diagnostics",
  "ollama-section": "providers/ollama",
  "ollama-cloud-section": "providers/ollama-cloud",
});
function parseRoute(hash) {
  if (hash.startsWith("#grants:"))
    return { view: "sites", asked: originFromHash(hash) };
  const name = LEGACY_ROUTES[hash.slice(1)] ?? hash.slice(1);
  if (VIEWS.has(name)) return { view: name };
  const subscription = /^providers\/([a-z][a-z0-9-]{0,63})$/.exec(name);
  if (subscription)
    return { view: "providers/desktop", providerId: subscription[1] };
  return { view: "overview" };
}
function applyRoute({ initial = false } = {}) {
  const next = parseRoute(location.hash);
  if (next.asked !== undefined) {
    askedOrigin = next.asked;
    askedPending = Boolean(next.asked);
  }
  const moved =
    next.view !== route.view || next.providerId !== route.providerId;
  route = next;
  for (const view of document.querySelectorAll("main > [data-view]"))
    view.hidden = view.dataset.view !== route.view;
  const section = route.view.split("/")[0];
  for (const link of document.querySelectorAll("[data-nav]"))
    if (link.dataset.nav === section) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  renderSubscription({ force: moved });
  document.title = `${
    VIEW_TITLES[route.view] ??
    PROVIDERS[route.view.slice("providers/".length)]?.name ??
    desktopEntry(route.providerId)?.name ??
    "Providers"
  } · अर्जुनः settings`;
  if (!initial && moved) {
    window.scrollTo(0, 0);
    $(
      route.view === "providers/desktop"
        ? "#subscription h1"
        : `main > [data-view="${route.view}"] h1`,
    )?.focus({ preventScroll: true });
  }
  if (route.view === "sites") renderGrants();
}

// ---------------------------------------------------------------------------
// Start

$("#base-url").value = OPENAI_BASE_URL;
$("#opencode-base-url").value = OPENCODE_BASE_URL;
const manifest = chrome.runtime.getManifest?.() ?? {};
$("#about-version").textContent =
  `Version ${manifest.version_name ?? manifest.version ?? VERSION} · Protocol v${VERSION}`;
applyRoute({ initial: true });
window.addEventListener("hashchange", () => {
  applyRoute();
  if (route.view === "sites") void refreshGrants().catch(() => {});
});
// The skip link moves focus into the current view. Following its `#main`
// href would change the route, and an unknown route is Overview.
document.querySelector(".skip")?.addEventListener("click", (event) => {
  event.preventDefault();
  document.getElementById("main")?.focus();
});
// Stored conversation state changes with every page round and announces
// nothing, so coming back to this tab reads it again.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible")
    void refreshGrants().catch(() => {});
});
$("#active-status").addEventListener("click", (event) =>
  event.currentTarget.classList.remove("show"),
);

try {
  [existing, opencodeExisting, catalog, activeInfo] = await Promise.all([
    runtime("provider.get"),
    runtime("opencode.get"),
    runtime("catalog.get").catch(() => null),
    runtime("provider.active").catch(() => null),
    loadOllama(),
  ]);
} catch (error) {
  $("#app-alert").replaceChildren(
    element("strong", "Settings could not load. "),
    element("span", error.message),
  );
  $("#app-alert").hidden = false;
}
setModelOptions(existing?.model);
setOpenCodeModelOptions(
  opencodeExisting?.model,
  opencodeExisting?.models ?? [],
);
if (existing) $("#keep-key").checked = existing.hasApiKey;
if (opencodeExisting)
  $("#opencode-keep-key").checked = opencodeExisting.hasApiKey;
refreshKeyField("openai");
refreshKeyField("opencode-api");
applyOllamaSummary("local", ollamaExisting.local);
applyOllamaSummary("cloud", ollamaExisting.cloud);
for (const id of STATIC_PROVIDERS) wireKeyField(id);
wireOllamaForm("local");
wireOllamaForm("cloud");
renderAll();
await refreshGrants().catch((error) =>
  status("#grant-status", error.message, true),
);
refreshDesktop();
connectStateStream();
$("#base-url").addEventListener("input", () => {
  refreshKeyField("openai");
  renderStaticDetail("openai");
});
$("#provider-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  // The model field is a combo now, so the browser no longer enforces `required`.
  if (!$("#model").value.trim())
    return status("#provider-status", "Choose or type a model first.", true);
  status("#provider-status", "Saving…");
  try {
    existing = await runtime("provider.save", values());
    $("#api-key").value = "";
    $("#keep-key").checked = existing.hasApiKey;
    $("#model").dataset.saved = existing.model;
    refreshKeyField("openai");
    await settleViews();
    status("#provider-status", "OpenAI key saved.");
    refreshDesktop();
  } catch (error) {
    status("#provider-status", error.message, true);
  }
});
$("#opencode-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  status("#opencode-status", "Saving and loading models…");
  try {
    const chosen = $("#opencode-model").value;
    opencodeExisting = await runtime("opencode.save", opencodeValues());
    $("#opencode-api-key").value = "";
    $("#opencode-keep-key").checked = opencodeExisting.hasApiKey;
    setOpenCodeModelOptions(
      opencodeExisting.model,
      opencodeExisting.models ?? [],
    );
    refreshKeyField("opencode-api");
    await settleViews();
    status(
      "#opencode-status",
      chosen
        ? `Saved. ${opencodeDisplayName(opencodeExisting.model)} is the default model.`
        : `Saved. ${opencodeExisting.models.length} models loaded; ${opencodeDisplayName(opencodeExisting.model)} selected as the default. Pick another above and save again to change it.`,
    );
    refreshDesktop();
  } catch (error) {
    status("#opencode-status", error.message, true);
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
$("#test-opencode").addEventListener("click", async () => {
  status("#opencode-status", "Testing…");
  try {
    const result = await runtime("opencode.test", opencodeValues());
    opencodeExisting = await runtime("opencode.get");
    setOpenCodeModelOptions(result.model, result.models ?? []);
    await settleViews();
    status(
      "#opencode-status",
      `Connected. ${opencodeDisplayName(result.model)} answered a tool-enabled test request, so this is a paid (Go) key; ${result.modelCount} usable models found.`,
    );
    refreshDesktop();
  } catch (error) {
    status("#opencode-status", error.message, true);
  }
});
$("#clear-provider").addEventListener("click", (event) =>
  confirmInline(event.currentTarget, {
    question: "Remove the OpenAI key from this browser?",
    confirmLabel: "Remove key",
    run: async () => {
      try {
        await runtime("provider.clear");
        existing = null;
        $("#base-url").value = OPENAI_BASE_URL;
        $("#api-key").value = "";
        setModelOptions();
        refreshKeyField("openai");
        await settleViews();
        status("#provider-status", "OpenAI key cleared.");
        refreshDesktop();
      } catch (error) {
        status("#provider-status", error.message, true);
      }
    },
  }),
);
$("#clear-opencode").addEventListener("click", (event) =>
  confirmInline(event.currentTarget, {
    question: "Remove the OpenCode Zen key from this browser?",
    confirmLabel: "Remove key",
    run: async () => {
      try {
        await runtime("opencode.clear");
        opencodeExisting = null;
        $("#opencode-api-key").value = "";
        setOpenCodeModelOptions();
        refreshKeyField("opencode-api");
        await settleViews();
        status("#opencode-status", "OpenCode Zen key cleared.");
        refreshDesktop();
      } catch (error) {
        status("#opencode-status", error.message, true);
      }
    },
  }),
);
// Clearing stored conversation state asks first (SPEC 11.2): it cannot be
// undone, and every conversation id a site holds stops working.
function closeClearState() {
  $("#clear-state-confirm").hidden = true;
  $("#clear-state").disabled = false;
}
$("#clear-state").addEventListener("click", async () => {
  const fresh = await runtime("grants.storedState").catch(() => storedState);
  storedState = fresh;
  renderStoredState();
  const parts = [];
  if (fresh?.entries)
    parts.push(
      `deletes ${plural(fresh.entries, "provider-state entry", "provider-state entries")} (${approxSize(fresh.bytes)})`,
    );
  if (fresh?.threads)
    parts.push(`ends ${plural(fresh.threads, "desktop agent thread")}`);
  $("#clear-state-question").textContent = [
    parts.length ? `This ${parts.join(" and ")}.` : "Nothing is stored now.",
    "Every conversation a site holds ends too, so sites must start a new one. Site grants and provider keys are kept. This cannot be undone.",
  ].join(" ");
  $("#clear-state").disabled = true;
  $("#clear-state-confirm").hidden = false;
  $("#clear-state-cancel").focus();
});
$("#clear-state-cancel").addEventListener("click", () => {
  closeClearState();
  $("#clear-state").focus();
});
$("#clear-state-yes").addEventListener("click", async () => {
  $("#clear-state-yes").disabled = true;
  try {
    const result = await runtime("grants.clearState");
    storedState = result;
    renderStoredState();
    status(
      "#state-status",
      `Cleared ${plural(result.cleared.entries, "provider-state entry", "provider-state entries")} and ${plural(result.cleared.threads, "desktop agent thread")}. Sites start new conversations from now on.`,
    );
    await refreshGrants();
  } catch (error) {
    status("#state-status", error.message, true);
  } finally {
    $("#clear-state-yes").disabled = false;
    closeClearState();
  }
});
function closeClearGrants() {
  $("#clear-grants-confirm").hidden = true;
  $("#clear-grants").disabled = !grants.length;
}
$("#clear-grants").addEventListener("click", () => {
  $("#clear-grants-question").textContent =
    `Revoke all ${plural(grants.length, "site")}? Every one must ask again, and the conversation state stored for them is deleted.`;
  $("#clear-grants").disabled = true;
  $("#clear-grants-confirm").hidden = false;
  $("#clear-grants-cancel").focus();
});
$("#clear-grants-cancel").addEventListener("click", () => {
  closeClearGrants();
  $("#clear-grants").focus();
});
$("#clear-grants-yes").addEventListener("click", async () => {
  $("#clear-grants-yes").disabled = true;
  try {
    await runtime("grants.clear");
    await refreshGrants();
    status(
      "#grant-status",
      "All site grants revoked and their stored conversation state deleted.",
    );
  } catch (error) {
    status("#grant-status", error.message, true);
  } finally {
    $("#clear-grants-yes").disabled = false;
    closeClearGrants();
  }
});
for (const [box, close] of [
  ["#clear-state-confirm", closeClearState],
  ["#clear-grants-confirm", closeClearGrants],
])
  $(box).addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
$("#sites-filter").addEventListener("input", renderGrants);
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
    opencodeExisting = await runtime("opencode.get");
    setModelOptions(existing?.model);
    refreshKeyField("openai");
    renderAll();
    toast("Desktop app paired. Your subscriptions now appear under Providers.");
  } catch (error) {
    status("#desktop-state", error.message, true);
  } finally {
    pairingDesktop = false;
  }
});
$("#unpair").addEventListener("click", (event) =>
  confirmInline(event.currentTarget, {
    question:
      "Unpair this browser from the desktop app? Subscriptions stop working here until you pair again.",
    confirmLabel: "Unpair",
    run: async () => {
      try {
        desktop = await runtime("desktop.unpair");
        renderAll();
        toast("Desktop app unpaired.");
      } catch (error) {
        status("#desktop-state", error.message, true);
      }
    },
  }),
);
$("#refresh-desktop").addEventListener("click", () => refreshDesktop(true));
$("#desktop-url").addEventListener("input", () => {
  $("#desktop-address-value").textContent = $("#desktop-url").value;
});

// ---------------------------------------------------------------------------
// Diagnostics: this extension's log and, when one is paired, the desktop app's.
// Both are read-only views of bounded, metadata-only buffers. The list shows
// the newest first; Copy hands over the exact lines, oldest first.

const LOG_PAGE = 150;
const LEVEL_TEXT = Object.freeze({
  debug: "Step",
  info: "Info",
  warn: "Warning",
  error: "Error",
});
const LEVEL_ICONS = Object.freeze({
  debug: "step",
  info: "dot",
  warn: "alert",
  error: "error",
});
let logTab = "extension";
let logLevel = "all";
let logShown = LOG_PAGE;
let logTimer = null;
let logSnapshot = { entries: [], desktop: { available: false, entries: [] } };
const logEntries = (source) =>
  (source === "desktop" ? logSnapshot.desktop?.entries : logSnapshot.entries) ??
  [];
const desktopLogDown = () => !logSnapshot.desktop?.available;
/** One entry as the line Copy produces, the text a bug report wants verbatim. */
function logLine(entry) {
  const at = new Date(entry.at).toLocaleTimeString();
  return `${at}  ${entry.level.padEnd(5)} ${entry.source}: ${entry.message}`;
}
function logFiltered() {
  const query = $("#log-search").value.trim().toLowerCase();
  return logEntries(logTab).filter((entry) => {
    if (logLevel === "important" && entry.level === "debug") return false;
    if (
      logLevel === "problems" &&
      entry.level !== "warn" &&
      entry.level !== "error"
    )
      return false;
    return (
      !query || `${entry.source} ${entry.message}`.toLowerCase().includes(query)
    );
  });
}
/** 173626 → "2 min 54 s": the logs count milliseconds, people do not. */
function humanDuration(ms) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
function logMessage(text) {
  const node = element("span", null, "log-message");
  let last = 0;
  for (const match of text.matchAll(/\b(\d{4,})ms\b/g)) {
    node.append(text.slice(last, match.index));
    const duration = element(
      "span",
      humanDuration(Number(match[1])),
      "log-duration",
    );
    duration.title = `${match[1]} ms`;
    node.append(duration);
    last = match.index + match[0].length;
  }
  node.append(text.slice(last));
  return node;
}
function dayLabel(at) {
  const date = new Date(at);
  const midnight = (value) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
const logKey = (entry) =>
  `${entry.at}|${entry.source}|${entry.message.slice(0, 80)}`;
function logRow(entry) {
  const row = element("li", null, `log-row level-${entry.level}`);
  row.dataset.key = logKey(entry);
  const date = new Date(entry.at);
  const time = element(
    "time",
    date.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    }),
    "log-time",
  );
  time.dateTime = date.toISOString();
  time.title = date.toLocaleString();
  const label = LEVEL_TEXT[entry.level] ?? entry.level;
  const level = element("span", null, "log-level");
  level.title = label;
  level.append(
    icon(LEVEL_ICONS[entry.level] ?? "dot"),
    element("span", label, "sr-only"),
  );
  const source = element("span", entry.source, "log-source");
  source.title = entry.source;
  row.append(time, level, source, logMessage(entry.message));
  return row;
}
function logEmpty() {
  const box = element("li", null, "log-empty");
  if (logTab === "desktop" && desktopLogDown()) {
    const go = element("a", "Open Desktop app", "btn btn-secondary btn-sm");
    go.href = "#desktop";
    box.append(
      element("strong", "The desktop app's log is not available"),
      element(
        "span",
        logSnapshot.desktop?.reason ?? "The desktop app did not answer.",
      ),
      go,
    );
  } else if (logEntries(logTab).length) {
    const reset = element(
      "button",
      "Show everything",
      "btn btn-secondary btn-sm",
    );
    reset.type = "button";
    reset.addEventListener("click", () => {
      $("#log-search").value = "";
      setLogLevel("all");
    });
    box.append(
      element("strong", "Nothing matches"),
      element("span", "No entry has that level or text."),
      reset,
    );
  } else
    box.append(
      element("strong", "Nothing logged yet"),
      element(
        "span",
        logTab === "desktop"
          ? "Entries appear when the desktop app detects or runs an agent."
          : "Entries appear when sites use your providers.",
      ),
    );
  return box;
}
/** "42 · 2 warnings" on each tab, so a log with problems shows from the other. */
function renderLogCounts() {
  for (const source of ["extension", "desktop"]) {
    const entries = logEntries(source);
    const parts = [];
    if (source !== "desktop" || !desktopLogDown())
      parts.push(element("span", format(entries.length)));
    const errors = entries.filter((entry) => entry.level === "error").length;
    const warnings = entries.filter((entry) => entry.level === "warn").length;
    if (errors) parts.push(element("span", plural(errors, "error"), "error"));
    if (warnings)
      parts.push(element("span", plural(warnings, "warning"), "warn"));
    $(`#log-count-${source}`).replaceChildren(...parts);
  }
}
function setLogLevel(level) {
  logLevel = level;
  logShown = LOG_PAGE;
  for (const button of document.querySelectorAll("[data-log-level]"))
    button.setAttribute(
      "aria-checked",
      String(button.dataset.logLevel === level),
    );
  renderLog();
}
function renderLog() {
  renderLogCounts();
  for (const [id, name] of [
    ["#log-tab-extension", "extension"],
    ["#log-tab-desktop", "desktop"],
  ])
    $(id).setAttribute("aria-selected", String(logTab === name));
  $("#log-clear").title =
    `Clear the ${logTab === "desktop" ? "desktop app's" : "extension's"} log`;
  const list = $("#log-view");
  // New rows arrive on top. Someone reading older ones keeps their place: the
  // first row in view is found again after the redraw and put back where it was.
  let anchor = null;
  if (list.scrollTop > 0) {
    const top = list.getBoundingClientRect().top + 32;
    const row = [...list.querySelectorAll(".log-row")].find(
      (item) => item.getBoundingClientRect().bottom > top,
    );
    if (row)
      anchor = {
        key: row.dataset.key,
        offset: row.getBoundingClientRect().top - top,
      };
  }
  const total = logEntries(logTab).length;
  const matches = logFiltered().reverse();
  const items = [];
  let day = null;
  for (const entry of matches.slice(0, logShown)) {
    const label = dayLabel(entry.at);
    if (label !== day) {
      day = label;
      const head = element("li", label, "log-day");
      head.setAttribute("role", "presentation");
      items.push(head);
    }
    items.push(logRow(entry));
  }
  if (!items.length) items.push(logEmpty());
  if (matches.length > logShown) {
    const more = element("li", null, "log-more");
    const button = element(
      "button",
      `Show older entries (${format(matches.length - logShown)} more)`,
      "btn btn-ghost btn-sm",
    );
    button.type = "button";
    button.addEventListener("click", () => {
      logShown += LOG_PAGE;
      renderLog();
    });
    more.append(button);
    items.push(more);
  }
  list.replaceChildren(...items);
  if (anchor) {
    const row = [...list.querySelectorAll(".log-row")].find(
      (item) => item.dataset.key === anchor.key,
    );
    if (row)
      list.scrollTop +=
        row.getBoundingClientRect().top -
        (list.getBoundingClientRect().top + 32) -
        anchor.offset;
  }
  status(
    "#log-status",
    logTab === "desktop" && desktopLogDown()
      ? ""
      : [
          matches.length === total
            ? plural(total, "entry", "entries")
            : `${format(matches.length)} of ${plural(total, "entry", "entries")} shown`,
          logTab === "desktop" && logSnapshot.desktop?.version
            ? `अर्जुनः Desktop ${logSnapshot.desktop.version}`
            : null,
        ]
          .filter(Boolean)
          .join(" · "),
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
for (const [id, name] of [
  ["#log-tab-extension", "extension"],
  ["#log-tab-desktop", "desktop"],
])
  $(id).addEventListener("click", () => {
    logTab = name;
    logShown = LOG_PAGE;
    $("#log-view").scrollTop = 0;
    renderLog();
    if (name === "desktop") void refreshLog();
  });
for (const button of document.querySelectorAll("[data-log-level]"))
  button.addEventListener("click", () => setLogLevel(button.dataset.logLevel));
$("#log-search").addEventListener("input", () => {
  logShown = LOG_PAGE;
  renderLog();
});
$("#log-refresh").addEventListener("click", () => refreshLog());
$("#log-live").addEventListener("change", (event) => {
  setLogLive(event.target.checked);
  if (event.target.checked) void refreshLog();
});
$("#log-copy").addEventListener("click", async () => {
  const entries = logFiltered();
  const total = logEntries(logTab).length;
  try {
    await navigator.clipboard.writeText(entries.map(logLine).join("\n"));
    status(
      "#log-status",
      entries.length === total
        ? `Copied ${plural(total, "entry", "entries")}.`
        : `Copied the ${format(entries.length)} entries shown, of ${format(total)}.`,
    );
  } catch {
    status("#log-status", "The browser refused clipboard access.", true);
  }
});
$("#log-clear").addEventListener("click", async () => {
  try {
    logSnapshot = await runtime("logs.clear", { target: logTab });
    renderLog();
  } catch (error) {
    status("#log-status", error.message, true);
  }
});
void refreshLog();
