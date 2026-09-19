const token = document.querySelector('meta[name="dashboard-token"]').content;
const $ = (selector) => document.querySelector(selector);
let state = null;
let editing = false;

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Dashboard-Token": token,
      ...(options.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      body.error?.message ?? `Request failed (${response.status}).`,
    );
  return body;
}

function text(tag, content, className) {
  const node = document.createElement(tag);
  node.textContent = content;
  if (className) node.className = className;
  return node;
}

// Render a sentence, turning `backtick` spans into <code> elements.
function rich(tag, content, className) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  const parts = String(content).split("`");
  parts.forEach((part, index) => {
    if (!part) return;
    if (index % 2) node.append(text("code", part));
    else node.append(document.createTextNode(part));
  });
  return node;
}
const PATH_KEYS = {
  "claude-code": "claudePath",
  codex: "codexPath",
  opencode: "opencodePath",
};
const STATE_LABELS = {
  missing: "Not installed",
  "signed-out": "Not signed in",
  disabled: "Disabled here",
  error: "Check failed",
};

/** Which account a provider will bill. Mirrors the card in the extension options page. */
function renderConnection(provider) {
  const link = provider.connection;
  const box = document.createElement("div");
  box.className = "connection";
  if (!provider.available || !link) {
    box.classList.add("none");
    box.textContent = provider.available
      ? "Signed in, account not reported by the CLI."
      : "Not connected to any account.";
    return box;
  }
  const line = document.createElement("div");
  line.className = "connection-line";
  line.append(
    text("span", link.account ? "Connected as" : "Connected via", "label"),
  );
  line.append(
    text("strong", link.account ?? link.method ?? "signed in", "account"),
  );
  if (link.plan) line.append(text("span", link.plan, "plan"));
  box.append(line);
  box.append(
    text(
      "div",
      [link.account && link.method ? link.method : null, link.source]
        .filter(Boolean)
        .join(" · "),
      "connection-detail",
    ),
  );
  return box;
}
function renderGuidance(provider) {
  const guide = provider.guidance;
  const box = document.createElement("div");
  box.className = `guidance ${guide?.state ?? "other"}`;
  if (guide) {
    const head = document.createElement("div");
    head.className = "guidance-head";
    head.append(
      text("span", STATE_LABELS[guide.state] ?? "Needs attention", "pill"),
      rich("span", guide.summary),
    );
    box.append(head);
    if (guide.steps?.length) {
      const list = document.createElement("ol");
      for (const step of guide.steps) list.append(rich("li", step));
      box.append(list);
    }
    if (guide.note) box.append(rich("p", guide.note, "note"));
    if (guide.links?.length) {
      const links = document.createElement("div");
      links.className = "links";
      for (const link of guide.links) {
        const a = text("a", link.label);
        a.href = link.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        links.append(a);
      }
      box.append(links);
    }
  } else if (provider.reason) {
    box.append(rich("div", provider.reason, "reason"));
  }
  const key = PATH_KEYS[provider.id];
  if (key) {
    const form = document.createElement("form");
    form.className = "path-form";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = `Custom path to the ${provider.name} binary (optional)`;
    input.value = state.settings[key] ?? "";
    input.setAttribute("aria-label", `${provider.name} binary path`);
    const save = text("button", "Save path", "secondary compact");
    save.type = "submit";
    form.append(input, save);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      save.textContent = "Checking…";
      try {
        await api("/api/dashboard/settings", {
          method: "PUT",
          body: JSON.stringify({ [key]: input.value.trim() }),
        });
        input.blur();
        await refresh(true);
      } catch (error) {
        $("#subtitle").textContent = error.message;
      } finally {
        save.disabled = false;
      }
    });
    box.append(form);
  }
  return box;
}

function render() {
  if (!state) return;
  $("#subtitle").textContent =
    `${state.device} · port ${state.port} · v${state.version}`;
  $("#code").textContent = state.pairing.code.replace(
    /(\d{3})(\d{3})/,
    "$1 $2",
  );
  const clients = $("#clients");
  clients.replaceChildren();
  if (!state.clients.length)
    clients.append(text("p", "No browsers paired yet.", "empty"));
  for (const client of state.clients) {
    const row = document.createElement("div");
    row.className = "row";
    row.append(
      text("strong", client.name),
      text(
        "span",
        `${client.browser} · paired ${new Date(client.pairedAt).toLocaleString()}${client.lastSeenAt ? ` · seen ${new Date(client.lastSeenAt).toLocaleTimeString()}` : ""}`,
        "meta",
      ),
    );
    const revoke = text("button", "Revoke", "danger compact");
    revoke.addEventListener("click", async () => {
      await api("/api/dashboard/clients/revoke", {
        method: "POST",
        body: JSON.stringify({ id: client.id }),
      });
      refresh();
    });
    row.append(revoke);
    clients.append(row);
  }
  const providers = $("#providers");
  // Keep a half-typed binary path intact across the periodic refresh.
  const typingPath = providers.contains(document.activeElement);
  if (!typingPath) providers.replaceChildren();
  for (const provider of typingPath ? [] : state.providers) {
    const row = document.createElement("div");
    row.className = `row provider ${provider.available ? "ok" : "off"}`;
    row.append(text("span", provider.available ? "●" : "○", "dot"));
    const body = document.createElement("div");
    body.append(text("strong", `${provider.name} · ${provider.vendor}`));
    body.append(
      text(
        "div",
        provider.installed
          ? (provider.version ?? "installed")
          : "Not installed",
        "meta",
      ),
    );
    if (provider.installed) body.append(renderConnection(provider));
    if (provider.notice) body.append(rich("div", provider.notice, "notice"));
    if (!provider.available || state.settings[PATH_KEYS[provider.id]])
      body.append(renderGuidance(provider));
    row.append(body);
    providers.append(row);
  }
  if (!typingPath && !state.providers.some((provider) => provider.available))
    providers.append(
      rich(
        "p",
        "No provider is ready yet. Paired browsers can still use an OpenAI API key saved in the extension. Follow the steps above for the subscription you want to use, then click Re-check providers.",
        "empty",
      ),
    );
  $("#codex-toggle").checked = Boolean(state.settings.experimentalCodex);
  renderT3();
  if (!editing) {
    const config = state.sync.config ?? {};
    $("#openai-model").value = config.openai?.model ?? "";
    $("#openai-key").value = "";
    $("#openai-key").placeholder = config.openai?.apiKey
      ? `Synced key ${config.openai.apiKey}`
      : "No key synced yet";
    const active = config.active ?? { type: "openai" };
    $("#active").value =
      active.type === "desktop" ? `desktop:${active.providerId}` : "openai";
    $("#active-model").value =
      active.type === "desktop" ? (active.model ?? "") : "";
  }
  $("#sync-meta").textContent = state.sync.updatedAt
    ? `Revision ${state.sync.revision} · updated ${new Date(state.sync.updatedAt).toLocaleString()} by ${state.sync.source}`
    : "Nothing synced yet.";
  const log = $("#activity");
  log.replaceChildren();
  for (const item of state.activity.slice(0, 40))
    log.append(
      text(
        "div",
        `${new Date(item.at).toLocaleTimeString()}  ${item.kind}  ${item.detail}`,
        `entry ${item.kind}`,
      ),
    );
  if (!state.activity.length)
    log.append(text("div", "No activity yet.", "empty"));
  $("#data-path").textContent = `Data file: ${state.dataPath}`;
}

async function refresh(force = false) {
  try {
    state = await api(`/api/dashboard/state${force ? "?refresh=1" : ""}`);
    render();
  } catch (error) {
    $("#subtitle").textContent = error.message;
  }
}

$("#recheck").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Checking…";
  try {
    await refresh(true);
  } finally {
    button.disabled = false;
    button.textContent = "Re-check providers";
  }
});

$("#rotate").addEventListener("click", async () => {
  await api("/api/dashboard/pairing/rotate", { method: "POST" });
  refresh();
});
function renderT3() {
  const t3 = state.t3 ?? { configured: false };
  const status = $("#t3-state");
  $("#t3-unpair").hidden = !t3.configured;
  $("#t3-pair").textContent = t3.configured ? "Re-pair" : "Connect";
  if (t3.configured && t3.url && !$("#t3-url").matches(":focus"))
    $("#t3-url").value = t3.url;
  if (!t3.configured) {
    status.textContent = "Not connected. अर्जुनः uses its own detection only.";
    status.className = "status";
  } else if (t3.error) {
    status.textContent = `Connected to ${t3.url} but the last request failed: ${t3.error}`;
    status.className = "status error";
  } else {
    status.textContent = `Connected to ${t3.environment?.label ?? t3.url}${t3.environment?.serverVersion ? ` (T3 Code ${t3.environment.serverVersion})` : ""} · ${t3.providers} provider entries${t3.checkedAt ? ` · checked ${new Date(t3.checkedAt).toLocaleTimeString()}` : ""}`;
    status.className = "status";
  }
}
$("#t3-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = $("#t3-state");
  status.textContent = "Pairing with T3 Code…";
  status.className = "status";
  try {
    const result = await api("/api/dashboard/t3/pair", {
      method: "POST",
      body: JSON.stringify({
        baseUrl: $("#t3-url").value.trim(),
        pairingToken: $("#t3-token").value.trim(),
      }),
    });
    $("#t3-token").value = "";
    state.t3 = result.t3;
    renderT3();
    refresh();
  } catch (error) {
    status.textContent = error.message;
    status.className = "status error";
  }
});
$("#t3-unpair").addEventListener("click", async () => {
  const result = await api("/api/dashboard/t3", { method: "DELETE" });
  state.t3 = result.t3;
  renderT3();
  refresh();
});
$("#codex-toggle").addEventListener("change", async (event) => {
  await api("/api/dashboard/settings", {
    method: "PUT",
    body: JSON.stringify({ experimentalCodex: event.target.checked }),
  });
  refresh();
});
for (const field of [
  "#openai-model",
  "#openai-key",
  "#active",
  "#active-model",
])
  $(field).addEventListener("focus", () => {
    editing = true;
  });
$("#config-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const activeValue = $("#active").value;
  const config = {
    openai: {
      model: $("#openai-model").value.trim() || null,
      apiKey: $("#openai-key").value.trim() || null,
    },
    active:
      activeValue === "openai"
        ? { type: "openai" }
        : {
            type: "desktop",
            providerId: activeValue.slice(8),
            model: $("#active-model").value.trim() || "default",
          },
  };
  await api("/api/dashboard/config", {
    method: "PUT",
    body: JSON.stringify({ config }),
  });
  editing = false;
  refresh();
});
refresh();
setInterval(refresh, 3000);
