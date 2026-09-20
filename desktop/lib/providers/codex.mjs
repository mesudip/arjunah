import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  which,
  run,
  spawnAgent,
  jsonLines,
  usageFrom,
  summarizeFailure,
  scratchDirectory,
  guidance,
  jwtPayload,
  connection,
  outerSandbox,
  outerSandboxAvailable,
  effortOf,
  removeQuietly,
  jsonLineProbe,
  quotaFromWindows,
  windowKind,
  isoFromEpochSeconds,
} from "./common.mjs";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { IMAGE_LIMITS, IMAGE_MEDIA_TYPES } from "../transcript.mjs";

export const id = "codex";
export const name = "Codex";
export const vendor = "OpenAI";
export const supportsTools = true;
export const supportsThreads = true;
export const supportsReasoning = true;
// `codex exec -i <FILE>` attaches images to the prompt (see `start`).
export const supportsVision = true;
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const LINKS = [
  { label: "Codex CLI docs", url: "https://developers.openai.com/codex/cli" },
  { label: "Codex on GitHub", url: "https://github.com/openai/codex" },
];
const APP_NOTE =
  "The ChatGPT desktop app for macOS bundles the Codex CLI and shares its ChatGPT sign-in with it. The desktop companion looks there automatically, so installing the ChatGPT app is enough on a Mac.";
// Fallback when Codex has not cached its model catalog yet. ChatGPT-account logins
// only accept the Codex catalog names, not raw API model ids like `gpt-5.6`.
const FALLBACK_MODELS = [
  { id: "gpt-6-astra", displayName: "GPT-6 Astra" },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" },
  { id: "gpt-5.5", displayName: "GPT-5.5" },
];

/** The models this login can use, from the catalog the Codex CLI caches after each run. */
function readModels(codexHome) {
  let listed = [];
  try {
    const cache = JSON.parse(
      readFileSync(join(codexHome, "models_cache.json"), "utf8"),
    );
    const entries = Array.isArray(cache) ? cache : (cache?.models ?? []);
    listed = entries
      .filter(
        (model) =>
          typeof model?.slug === "string" &&
          (model.visibility ?? "list") === "list",
      )
      .map((model) => ({
        id: model.slug,
        displayName: String(model.display_name ?? model.slug),
        contextWindow: Number.isInteger(model.context_window)
          ? model.context_window
          : null,
        reasoningLevels: (Array.isArray(model.supported_reasoning_levels)
          ? model.supported_reasoning_levels
              .map((level) => level?.effort)
              .filter((level) => CODEX_EFFORTS.includes(level))
          : CODEX_EFFORTS
        ).slice(0, 8),
        defaultReasoning: CODEX_EFFORTS.includes(model.default_reasoning_level)
          ? model.default_reasoning_level
          : null,
        capabilities: {
          tools: true,
          vision:
            Array.isArray(model.input_modalities) &&
            model.input_modalities.includes("image"),
          reasoning: true,
        },
      }));
  } catch {
    /* no catalog yet */
  }
  const fallback = FALLBACK_MODELS.map((model) => ({
    ...model,
    contextWindow: null,
    reasoningLevels: CODEX_EFFORTS,
    defaultReasoning: null,
    // Every model in the fallback list is one of the image-capable GPT-5.x/6 slugs.
    capabilities: { tools: true, vision: true, reasoning: true },
  }));
  return [
    {
      id: "default",
      displayName: "Codex (account default)",
      contextWindow: listed[0]?.contextWindow ?? null,
      reasoningLevels: CODEX_EFFORTS,
      defaultReasoning: null,
      // The account default resolves to a catalog model; follow what that catalog says.
      capabilities: {
        tools: true,
        vision: listed[0]?.capabilities?.vision ?? true,
        reasoning: true,
      },
    },
    ...(listed.length ? listed : fallback),
  ];
}

/**
 * Who Codex is signed in as. `codex login status` only prints the method ("ChatGPT"),
 * so the email comes from the OpenAI ID token the CLI saved in auth.json.
 */
function readIdentity(codexHome) {
  try {
    const auth = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
    const claims = jwtPayload(auth?.tokens?.id_token) ?? {};
    const openai = claims["https://api.openai.com/auth"] ?? {};
    return {
      authMode: auth?.auth_mode ?? null,
      email: typeof claims.email === "string" ? claims.email : null,
      name: typeof claims.name === "string" ? claims.name : null,
      plan:
        typeof openai.chatgpt_plan_type === "string"
          ? openai.chatgpt_plan_type
          : null,
      accountId: auth?.tokens?.account_id ?? null,
      hasApiKey: Boolean(auth?.OPENAI_API_KEY),
    };
  } catch {
    return null;
  }
}

function describePlan(plan) {
  if (!plan) return null;
  const known = {
    plus: "ChatGPT Plus",
    pro: "ChatGPT Pro",
    team: "ChatGPT Team",
    business: "ChatGPT Business",
    enterprise: "ChatGPT Enterprise",
    edu: "ChatGPT Edu",
    free: "ChatGPT Free",
  };
  return known[String(plan).toLowerCase()] ?? `ChatGPT ${plan}`;
}

/**
 * Parses the JSON-RPC answers of a `codex app-server` probe (`account/read`,
 * `account/rateLimits/read`, `model/list`) into account, quota, and models.
 * This is how T3 Code reads the same facts; the probe spends no tokens.
 */
export function parseCodexProbe(messages) {
  const byId = new Map();
  for (const message of messages)
    if (message && message.id != null) byId.set(String(message.id), message);
  const account = byId.get("account")?.result?.account ?? null;
  const limits = byId.get("limits")?.result ?? null;
  const listed = byId.get("models")?.result?.data;
  const models = (Array.isArray(listed) ? listed : [])
    .filter((model) => typeof model?.id === "string" && model.hidden !== true)
    .slice(0, 100)
    .map((model) => ({
      id: model.id,
      displayName: String(model.displayName ?? model.id).slice(0, 80),
      reasoningLevels: (Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
        : []
      )
        .map((entry) =>
          typeof entry === "string" ? entry : entry?.reasoningEffort,
        )
        .filter((level) => CODEX_EFFORTS.includes(level)),
      defaultReasoning: CODEX_EFFORTS.includes(model.defaultReasoningEffort)
        ? model.defaultReasoningEffort
        : null,
      // Codex accepts images natively, but Arjunah's `codex exec` run path is text only.
      acceptsImages:
        Array.isArray(model.inputModalities) &&
        model.inputModalities.includes("image"),
      isDefault: model.isDefault === true,
    }));
  let quota = null;
  const snapshot =
    limits?.rateLimitsByLimitId?.codex ?? limits?.rateLimits ?? null;
  if (snapshot) {
    const monthlyPlan = ["free", "go"].includes(snapshot.planType);
    const windows = [];
    for (const [id, window, fallback] of [
      ["primary", snapshot.primary, monthlyPlan ? 30 * 24 * 60 : 300],
      ["secondary", snapshot.secondary, 7 * 24 * 60],
    ]) {
      if (!window || !Number.isFinite(window.usedPercent)) continue;
      const minutes =
        typeof window.windowDurationMins === "number"
          ? window.windowDurationMins
          : fallback;
      const kind = windowKind(minutes);
      windows.push({
        id,
        kind,
        label:
          kind === "session"
            ? `Session (${Math.round(minutes / 60)}h)`
            : kind === "weekly"
              ? "Weekly"
              : "Monthly",
        usedPercent: window.usedPercent,
        resetsAt: isoFromEpochSeconds(window.resetsAt),
      });
    }
    const spend = snapshot.individualLimit;
    const spendLabel =
      spend &&
      Number.isFinite(Number(spend.used)) &&
      Number.isFinite(Number(spend.limit))
        ? `Spend $${Number(spend.used).toFixed(2)} of $${Number(spend.limit).toFixed(0)}`
        : null;
    quota = quotaFromWindows(windows, { label: spendLabel });
    if (quota && snapshot.rateLimitReachedType)
      quota.label = [
        quota.label,
        `limit reached: ${snapshot.rateLimitReachedType}`,
      ]
        .filter(Boolean)
        .join(" · ");
  }
  return {
    account:
      account?.type === "chatgpt"
        ? {
            type: "chatgpt",
            email: account.email ?? null,
            planType: account.planType ?? null,
          }
        : account
          ? { type: account.type, email: null, planType: null }
          : null,
    quota,
    models,
  };
}

async function probeCodex(binary) {
  const result = await jsonLineProbe(
    binary,
    ["app-server"],
    [
      {
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          clientInfo: {
            name: "arjunah-desktop",
            title: "अर्जुनः Desktop",
            version: "1.0.0",
          },
          capabilities: { experimentalApi: true },
        },
      },
      { jsonrpc: "2.0", method: "initialized" },
      { jsonrpc: "2.0", id: "account", method: "account/read", params: {} },
      { jsonrpc: "2.0", id: "limits", method: "account/rateLimits/read" },
      { jsonrpc: "2.0", id: "models", method: "model/list", params: {} },
    ],
    {
      timeoutMs: 20_000,
      done: (messages) =>
        ["account", "limits", "models"].every((id) =>
          messages.some((message) => String(message?.id) === id),
        ),
    },
  );
  return result.messages.length ? parseCodexProbe(result.messages) : null;
}

export async function detect(settings = {}) {
  const binary =
    settings.codexPath ||
    (await which("codex", [
      `${process.env.HOME}/.local/bin`,
      // The ChatGPT desktop app for macOS bundles a signed-in Codex CLI.
      ...(process.platform === "darwin"
        ? ["/Applications/ChatGPT.app/Contents/Resources"]
        : []),
    ]));
  if (!binary)
    return {
      installed: false,
      available: false,
      reason:
        "Codex CLI is not installed. Install it with `npm install -g @openai/codex` and run `codex login`.",
      guidance: guidance({
        state: "missing",
        summary: "The `codex` command was not found on this computer.",
        steps: [
          "Install it in a terminal: `npm install -g @openai/codex` or, with Homebrew, `brew install --cask codex`. On a Mac, installing the ChatGPT desktop app also provides it.",
          "Run `codex login` and sign in with your ChatGPT account (Plus, Pro, Team, or Enterprise).",
          "Click Re-check below. If Codex lives somewhere unusual, paste the full path to the `codex` binary in the field below and save.",
        ],
        links: LINKS,
        note: APP_NOTE,
      }),
    };
  const version = await run(binary, ["--version"], { timeoutMs: 15_000 });
  const codexHome =
    process.env.CODEX_HOME || join(process.env.HOME ?? "", ".codex");
  const hasAuth = existsSync(join(codexHome, "auth.json"));
  const status = hasAuth
    ? await run(binary, ["login", "status"], { timeoutMs: 20_000 })
    : null;
  const loggedIn = Boolean(
    status &&
      status.code === 0 &&
      /logged in/i.test(status.stdout + status.stderr),
  );
  const method = status
    ? (status.stdout + status.stderr)
        .match(/logged in using (.+)/i)?.[1]
        ?.trim()
    : null;
  const identity = loggedIn ? readIdentity(codexHome) : null;
  // The app-server answers account, plan windows, and the live model list
  // without spending tokens; the auth file stays as the fallback.
  const probe = loggedIn ? await probeCodex(binary).catch(() => null) : null;
  const usesApiKey =
    probe?.account?.type === "apiKey" ||
    identity?.authMode === "apikey" ||
    (!identity?.email && !probe?.account?.email && identity?.hasApiKey);
  const bundled = binary.startsWith("/Applications/ChatGPT.app/");
  const link = loggedIn
    ? connection({
        account:
          probe?.account?.email ??
          identity?.email ??
          (usesApiKey ? "OpenAI API key" : null),
        method: usesApiKey
          ? "OpenAI API key saved by `codex login`"
          : `${method ?? "ChatGPT"} sign-in`,
        plan: usesApiKey
          ? null
          : describePlan(probe?.account?.planType ?? identity?.plan),
        source: bundled
          ? "Codex CLI bundled with the ChatGPT desktop app"
          : `Codex CLI at ${binary}`,
      })
    : null;
  return {
    installed: true,
    binary,
    version: version.stdout.trim() || null,
    available: loggedIn,
    account: link?.account ?? (loggedIn ? "signed in" : null),
    connection: link,
    reason: loggedIn
      ? null
      : "Codex is installed but not signed in. Run `codex login` with your ChatGPT account.",
    guidance: loggedIn
      ? null
      : guidance({
          state: "signed-out",
          summary: `Codex ${version.stdout.trim()} is installed at ${binary} but has no saved login.`,
          steps: [
            hasAuth
              ? "A login file exists but Codex does not report it as valid. Run `codex login` again to refresh it."
              : "Open a terminal and run `codex login`.",
            "Finish the sign-in in the browser window that opens using your ChatGPT account.",
            "Click Re-check. The row turns green once `codex login status` prints “Logged in”.",
          ],
          links: LINKS,
          note: APP_NOTE,
        }),
    models: mergeCodexModels(readModels(codexHome), probe?.models ?? []),
    defaultModel: "default",
    quota: probe?.quota ?? null,
    catalogSource: probe?.models?.length ? "codex app-server model/list" : null,
    sandboxed: outerSandboxAvailable(),
    notice: outerSandboxAvailable()
      ? "Codex cannot remove its shell tool, so every run is wrapped in an additional macOS sandbox that denies reads and writes under your home folder (except Codex's own login data); its shell commands fail instead of reading files."
      : "Codex keeps its shell tool inside a read-only sandbox for every run. On this platform no additional sandbox is available, so a site assistant could ask the model to read files the sandbox permits. Keep Codex disabled here if that is a concern.",
  };
}

const NO_SHELL_NOTE =
  "This environment has no shell, file, or network access of its own: any shell command fails immediately. Do not try to run commands or read files. Use only the tools provided through MCP, if any, and answer from the conversation.";

/** Parses `codex exec --json` output into the adapter result, including the commands Codex tried. */
export function parseCodexOutput(stdout, stderr, code, model) {
  const events = jsonLines(stdout);
  const messages = events.filter(
    (event) =>
      event.type === "item.completed" && event.item?.type === "agent_message",
  );
  const steps = events
    .filter(
      (event) =>
        event.type === "item.completed" &&
        event.item?.type === "command_execution",
    )
    .slice(0, 32)
    .map((event) => ({
      type: "command",
      command: String(event.item.command ?? "").slice(0, 500),
      exitCode: Number.isInteger(event.item.exit_code)
        ? event.item.exit_code
        : null,
      output: String(event.item.aggregated_output ?? "").slice(0, 2000),
    }));
  const reasoning = events
    .filter(
      (event) =>
        event.type === "item.completed" && event.item?.type === "reasoning",
    )
    .map((event) => String(event.item.text ?? event.item.summary ?? ""))
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 12_000);
  const completed = events.find((event) => event.type === "turn.completed");
  const failure = events.find(
    (event) => event.type === "turn.failed" || event.type === "error",
  );
  if (failure || (!messages.length && !completed))
    return {
      isError: true,
      errorMessage: String(
        failure?.error?.message ??
          failure?.message ??
          summarizeFailure(stderr, `Codex exited with status ${code}.`),
      ).slice(0, 300),
    };
  return {
    content: String(messages.at(-1)?.item?.text ?? ""),
    usage: usageFrom(
      completed?.usage?.input_tokens,
      completed?.usage?.output_tokens,
      {
        cached: completed?.usage?.cached_input_tokens,
        reasoning: completed?.usage?.reasoning_output_tokens,
      },
    ),
    model,
    steps,
    reasoning: reasoning || null,
    thread:
      events.find((event) => event.type === "thread.started")?.thread_id ??
      null,
  };
}

// What each stage of a `codex exec` run means in plain words. Codex can spend
// half a minute between launch and its first reasoning item, so every lifecycle
// event it emits becomes a line the browser can show instead of a bare spinner.
const PHASES = {
  "thread.started": "Codex session started; sending the prompt…",
  "turn.started": "Codex is working on the answer…",
  "turn.completed": "Codex finished; collecting the answer…",
};
const STARTED_PHASES = {
  reasoning: "Codex is reasoning…",
  agent_message: "Codex is writing the answer…",
  mcp_tool_call: "Codex is calling a browser tool…",
  web_search: "Codex is searching the web…",
};

/** Maps one `codex exec --json` event to a progress item, or null. */
export function progressItem(event) {
  if (PHASES[event?.type]) return { type: "phase", text: PHASES[event.type] };
  const item = event?.item;
  if (!item || typeof item !== "object") return null;
  if (event.type === "item.started" && STARTED_PHASES[item.type])
    return { type: "phase", text: STARTED_PHASES[item.type] };
  if (item.type === "command_execution") {
    if (event.type === "item.started")
      return {
        type: "command",
        phase: "start",
        id: String(item.id ?? "").slice(0, 80),
        command: String(item.command ?? "").slice(0, 500),
      };
    if (event.type === "item.completed")
      return {
        type: "command",
        phase: "end",
        id: String(item.id ?? "").slice(0, 80),
        command: String(item.command ?? "").slice(0, 500),
        exitCode: Number.isInteger(item.exit_code) ? item.exit_code : null,
        output: String(item.aggregated_output ?? "").slice(0, 2000),
      };
  }
  if (item.type === "reasoning" && event.type === "item.completed")
    return {
      type: "reasoning",
      text: String(item.text ?? item.summary ?? "").slice(0, 4000),
    };
  if (item.type === "agent_message" && event.type === "item.completed")
    return {
      type: "output_delta",
      text: String(item.text ?? "").slice(0, 120000),
    };
  return null;
}

/** Live `model/list` entries lead; cached catalog entries fill context windows and the tail. */
function mergeCodexModels(cached, live) {
  if (!live.length) return cached;
  const byId = new Map(cached.map((model) => [model.id, model]));
  const merged = live.map(({ acceptsImages, isDefault: _d, ...model }) => ({
    ...(byId.get(model.id) ?? {}),
    ...model,
    contextWindow: byId.get(model.id)?.contextWindow ?? null,
    capabilities: {
      tools: true,
      vision: acceptsImages ?? byId.get(model.id)?.capabilities?.vision ?? true,
      reasoning: true,
    },
  }));
  const seen = new Set(merged.map((model) => model.id));
  return [
    ...cached.filter((model) => model.id === "default"),
    ...merged,
    ...cached.filter((model) => !seen.has(model.id) && model.id !== "default"),
  ];
}

/**
 * `codex exec` reads its prompt from stdin but takes images as files, so each
 * attachment is written into the run's scratch directory (which the outer
 * sandbox allows) and passed with `-i`. Returns the argument fragment.
 */
export function imageArguments(images, directory) {
  const args = [];
  images.forEach((image, index) => {
    const suffix = IMAGE_MEDIA_TYPES.includes(image.mediaType)
      ? image.mediaType.slice("image/".length)
      : "png";
    const file = join(directory, `arjunah-image-${index}.${suffix}`);
    writeFileSync(file, Buffer.from(image.data, "base64"), { mode: 0o600 });
    args.push("-i", file);
  });
  return args;
}

export function start({
  binary,
  model,
  systemPrompt,
  prompt,
  images = [],
  mcp,
  tools = [],
  onProgress,
  onLog,
  thread = null,
  onThread,
  reasoning = null,
  scratch: sharedScratch = null,
}) {
  const say = (text) => {
    onLog?.("debug", text);
    onProgress?.({ type: "phase", text });
  };
  say("Preparing a sandboxed workspace for Codex…");
  // A thread keeps its scratch directory alive across turns; Codex filters
  // resumable sessions by working directory.
  const scratch = sharedScratch ?? scratchDirectory("codex");
  const args = [
    "exec",
    "--json",
    ...(thread ? [] : ["--ephemeral"]),
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "-s",
    "read-only",
    "-c",
    'approval_policy="never"',
    "-c",
    'shell_environment_policy.inherit="none"',
    "-c",
    'model_reasoning_summary="detailed"',
    "-C",
    scratch.directory,
  ];
  if (model && model !== "default") args.push("-m", model);
  const effort = effortOf(reasoning, CODEX_EFFORTS);
  if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
  const env = {};
  if (mcp) {
    env.ARJUNAH_MCP_TOKEN = mcp.token;
    args.push(
      "-c",
      `mcp_servers.arjunah.url=${JSON.stringify(mcp.url)}`,
      "-c",
      'mcp_servers.arjunah.bearer_token_env_var="ARJUNAH_MCP_TOKEN"',
      "-c",
      "mcp_servers.arjunah.tool_timeout_sec=600",
      "-c",
      "mcp_servers.arjunah.startup_timeout_sec=30",
    );
    // Non-interactive runs never prompt, so each bridged tool must be pre-approved. Every
    // tool here was already disclosed to and approved by the user in the browser.
    const approvals = tools
      .map((tool) => `${JSON.stringify(tool.name)}={approval_mode="approve"}`)
      .join(",");
    if (approvals) args.push("-c", `mcp_servers.arjunah.tools={${approvals}}`);
  }
  const imageArgs = imageArguments(
    images.slice(0, IMAGE_LIMITS.perPrompt),
    scratch.directory,
  );
  // Resuming continues the saved thread; the prompt then travels on stdin.
  // `-i` belongs to whichever subcommand parses it, so it follows `resume`.
  if (thread?.handle) args.push("resume", ...imageArgs, thread.handle, "-");
  else args.push(...imageArgs);
  const codexHome =
    process.env.CODEX_HOME || join(process.env.HOME ?? "", ".codex");
  const sandbox = outerSandbox({
    binary,
    args,
    scratch: scratch.directory,
    allow: [codexHome],
  });
  // A resumed thread already carries the instructions from its first turn.
  const instructions = thread?.handle
    ? ""
    : [systemPrompt, sandbox ? NO_SHELL_NOTE : null]
        .filter(Boolean)
        .join("\n\n");
  const fullPrompt = instructions
    ? `<system_instructions>\n${instructions}\n</system_instructions>\n\n${prompt}`
    : prompt;
  if (mcp)
    say(
      `Handing Codex ${tools.length} approved browser tool${tools.length === 1 ? "" : "s"}…`,
    );
  say(
    thread?.handle
      ? "Resuming the saved Codex session…"
      : "Launching the Codex CLI…",
  );
  onLog?.(
    "info",
    `codex exec: model ${model ?? "default"}${effort ? `, effort ${effort}` : ""}${sandbox ? `, outer sandbox denying ${sandbox.denied} home entries` : ""}${thread?.handle ? ", resumed thread" : ""}`,
  );
  return spawnAgent({
    binary: sandbox?.binary ?? binary,
    args: sandbox?.args ?? args,
    onLog,
    stdin: fullPrompt,
    cwd: scratch.directory,
    env,
    onExit: sharedScratch ? undefined : scratch.cleanup,
    onLine: (event) => {
      if (
        event?.type === "thread.started" &&
        typeof event.thread_id === "string"
      )
        onThread?.(event.thread_id.slice(0, 80));
      if (!onProgress) return;
      const item = progressItem(event);
      if (item) onProgress(item);
    },
    parse(stdout, stderr, code) {
      return parseCodexOutput(stdout, stderr, code, model);
    },
  });
}

/** Deletes the saved Codex rollout for a finished thread. */
export function endThread(handle) {
  if (!/^[A-Za-z0-9-]{8,80}$/.test(String(handle ?? ""))) return;
  const root = join(
    process.env.CODEX_HOME || join(process.env.HOME ?? "", ".codex"),
    "sessions",
  );
  const walk = (directory, depth) => {
    let entries = [];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory() && depth < 4) walk(path, depth + 1);
      else if (entry.includes(handle) && entry.endsWith(".jsonl"))
        removeQuietly(path);
    }
  };
  walk(root, 0);
}
