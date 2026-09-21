import {
  which,
  run,
  spawnAgent,
  jsonLines,
  usageFrom,
  summarizeFailure,
  scratchDirectory,
  guidance,
  connection,
  effortOf,
  removeQuietly,
  jsonLineProbe,
  quotaFromWindows,
  isoFromString,
} from "./common.mjs";
import { IMAGE_LIMITS } from "../transcript.mjs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readdirSync, realpathSync, writeFileSync } from "node:fs";

export const id = "claude-code";
export const name = "Claude Code";
export const vendor = "Anthropic";
export const supportsTools = true;
export const supportsThreads = true;
export const supportsReasoning = true;
// Claude Code takes images through its stream-json input format (see `start`).
export const supportsVision = true;
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// One user turn may run up to 100 tool rounds (LIMITS.toolRounds in
// src/lib/constants.js), and every one of them happens inside this single
// process: the MCP call blocks until the browser posts the result back. Claude
// Code spends roughly one turn per round plus the turn that writes the answer,
// so this runaway guard sits above the protocol ceiling. The browser's own
// limit is then the one that stops a runaway loop, with a message that says so.
const MAX_TURNS = 120;
// `result` is empty on these, so the subtype is all the run says about itself.
const ERROR_SUBTYPES = Object.freeze({
  error_max_turns: `Claude Code stopped after ${MAX_TURNS} turns in one run.`,
  error_during_execution: "Claude Code stopped while running the turn.",
});
const LINKS = [
  {
    label: "Install Claude Code",
    url: "https://docs.claude.com/en/docs/claude-code/setup",
  },
  { label: "Claude Code overview", url: "https://claude.com/claude-code" },
];
const APP_NOTE =
  "The Claude desktop app ships its own copy of Claude Code, but that copy only runs inside the app and does not share its sign-in. The standalone `claude` command needs its own one-time login with the same subscription.";
const MODELS = [
  { id: "default", displayName: "Claude (account default)" },
  { id: "sonnet", displayName: "Claude Sonnet (latest)" },
  { id: "opus", displayName: "Claude Opus (latest)" },
  { id: "haiku", displayName: "Claude Haiku (latest)" },
].map((model) => ({
  ...model,
  // Claude Code reports the real window after a run; the companion learns it.
  contextWindow: null,
  reasoningLevels: CLAUDE_EFFORTS,
  defaultReasoning: null,
  capabilities: { tools: true, vision: true, reasoning: true },
}));

function parseAuth(stdout) {
  const raw = String(stdout ?? "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** "Claude Team" / "claude_max_20x_subscription" → "Claude Team" / "Claude Max 20x". */
export function claudePlanLabel(subscriptionType) {
  if (!subscriptionType) return null;
  const raw = String(subscriptionType);
  const normalized = raw.toLowerCase().replace(/[\s_-]+/g, "");
  const known = {
    claudemaxsubscription: "Max",
    claudemax5xsubscription: "Max 5x",
    claudemax20xsubscription: "Max 20x",
    claudeenterprisesubscription: "Enterprise",
    claudeteamsubscription: "Team",
    claudeprosubscription: "Pro",
    claudefreesubscription: "Free",
    max: "Max",
    max5: "Max 5x",
    max20: "Max 20x",
    enterprise: "Enterprise",
    team: "Team",
    pro: "Pro",
    free: "Free",
  };
  const label =
    known[normalized] ??
    raw
      .split(/[\s_-]+/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
      .join(" ");
  return /^claude\b/i.test(label) ? label : `Claude ${label}`;
}

const CLAUDE_PROBE_ARGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--tools",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  JSON.stringify({ mcpServers: {} }),
  "--no-session-persistence",
];

/**
 * Parses the control responses of a Claude Code stream-json probe: `initialize`
 * (account and the CLI's own model list) and `get_usage` (plan windows).
 * Nothing here costs model tokens; the CLI answers from its login state.
 */
export function parseClaudeProbe(messages) {
  const responses = new Map();
  for (const message of messages)
    if (message?.type === "control_response" && message.response?.request_id)
      responses.set(message.response.request_id, message.response);
  const init = responses.get("init");
  const usage = responses.get("usage");
  if (!init || init.subtype !== "success") return null;
  const account = init.response?.account ?? null;
  const models = (
    Array.isArray(init.response?.models) ? init.response.models : []
  )
    .filter((model) => typeof model?.value === "string")
    .slice(0, 40)
    .map((model) => {
      const resolved = String(model.resolvedModel ?? model.value);
      const levels = (
        Array.isArray(model.supportedEffortLevels)
          ? model.supportedEffortLevels
          : []
      ).filter((level) => CLAUDE_EFFORTS.includes(level));
      return {
        id: model.value,
        displayName: String(model.displayName ?? model.value).slice(0, 80),
        description: String(model.description ?? "").slice(0, 200),
        resolvedModel: resolved,
        // Claude Code marks the 1M-context variants with a [1m] suffix; the
        // others run in the 200k window (the same mapping T3 Code's manifest uses).
        contextWindow: /\[1m\]/i.test(`${model.value} ${resolved}`)
          ? 1_000_000
          : 200_000,
        reasoningLevels: model.supportsEffort === false ? [] : levels,
        defaultReasoning: null,
        capabilities: {
          tools: true,
          vision: true,
          reasoning: model.supportsEffort !== false && levels.length > 0,
        },
      };
    });
  let quota = null;
  let subscriptionType = account?.subscriptionType ?? null;
  if (usage?.subtype === "success" && usage.response) {
    const body = usage.response;
    subscriptionType ??= body.subscription_type ?? null;
    if (body.rate_limits_available && body.rate_limits) {
      const windows = [];
      const known = {
        five_hour: { kind: "session", label: "Session (5h)" },
        seven_day: { kind: "weekly", label: "Weekly" },
      };
      for (const [id, meta] of Object.entries(known)) {
        const window = body.rate_limits[id];
        if (window && typeof window.utilization === "number")
          windows.push({
            id,
            ...meta,
            usedPercent: window.utilization,
            resetsAt: isoFromString(window.resets_at),
          });
      }
      for (const scoped of Array.isArray(body.rate_limits.model_scoped)
        ? body.rate_limits.model_scoped
        : [])
        if (typeof scoped?.utilization === "number" && scoped.display_name)
          windows.push({
            id: `seven_day_${String(scoped.display_name)
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "_")}`,
            kind: "weekly",
            label: `Weekly · ${scoped.display_name}`,
            usedPercent: scoped.utilization,
            resetsAt: isoFromString(scoped.resets_at),
          });
      quota = quotaFromWindows(windows);
    }
  }
  return {
    account: {
      email: typeof account?.email === "string" ? account.email : null,
      organization:
        typeof account?.organization === "string" ? account.organization : null,
      subscriptionType,
      apiProvider: account?.apiProvider ?? null,
    },
    models,
    quota,
    usageAvailable: usage?.response?.rate_limits_available === true,
  };
}

async function probeClaude(binary) {
  const result = await jsonLineProbe(
    binary,
    CLAUDE_PROBE_ARGS,
    [
      {
        type: "control_request",
        request_id: "init",
        request: { subtype: "initialize" },
      },
      {
        type: "control_request",
        request_id: "usage",
        request: { subtype: "get_usage", skip_behaviors: true },
      },
    ],
    {
      timeoutMs: 20_000,
      env: { DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1" },
      done: (messages) =>
        ["init", "usage"].every((id) =>
          messages.some(
            (message) =>
              message?.type === "control_response" &&
              message.response?.request_id === id,
          ),
        ),
    },
  );
  return parseClaudeProbe(result.messages);
}

export async function detect(settings = {}) {
  const binary =
    settings.claudePath ||
    (await which("claude", [
      `${process.env.HOME}/.local/bin`,
      `${process.env.HOME}/.claude/local`,
    ]));
  if (!binary)
    return {
      installed: false,
      available: false,
      reason:
        "Claude Code CLI is not installed. Install it, then run `claude` once to sign in.",
      guidance: guidance({
        state: "missing",
        summary: "The `claude` command was not found on this computer.",
        steps: [
          "Install it in a terminal: `curl -fsSL https://claude.ai/install.sh | bash` (macOS and Linux) or `npm install -g @anthropic-ai/claude-code`.",
          "Open a new terminal window and run `claude`, then type `/login` and sign in with your Claude subscription.",
          "Click Re-check below. If you installed it somewhere unusual, paste the full path to the `claude` binary in the field below and save.",
        ],
        links: LINKS,
        note: APP_NOTE,
      }),
    };
  const version = await run(binary, ["--version"], { timeoutMs: 15_000 });
  const status = await run(binary, ["auth", "status"], { timeoutMs: 20_000 });
  // `claude auth status` prints pretty-printed JSON, sometimes after a
  // notice line. Parse the outermost object rather than a single line.
  const auth = parseAuth(status.stdout);
  const loggedIn = auth?.loggedIn === true;
  const versionLine = version.stdout.trim().split("\n")[0] || null;
  let reason = null;
  let guide = null;
  if (!auth) {
    reason = "Claude Code is installed but did not report its sign-in status.";
    guide = guidance({
      state: "error",
      summary: `\`${binary} auth status\` did not return a readable result${status.error ? ` (${summarizeFailure(status.stderr, status.error.message)})` : ""}.`,
      steps: [
        "Run `claude auth status` in a terminal and check that it prints JSON with a loggedIn field.",
        "Update Claude Code with `claude update` if the command is not recognized, then click Re-check.",
      ],
      links: LINKS,
    });
  } else if (!loggedIn) {
    reason =
      "Claude Code is installed but not signed in. Run `claude` in a terminal and use /login with your Claude subscription.";
    guide = guidance({
      state: "signed-out",
      summary:
        `Claude Code ${versionLine ?? ""} is installed at ${binary} but has no saved login.`.replace(
          /\s+/g,
          " ",
        ),
      steps: [
        "Open a terminal and run `claude`.",
        "Type `/login`, press Enter, and finish the sign-in in the browser window that opens using your Claude subscription (Pro, Max, Team, or Enterprise).",
        "Come back here and click Re-check. The row turns green once `claude auth status` reports loggedIn: true.",
      ],
      links: LINKS,
      note: APP_NOTE,
    });
  }
  // The CLI's control protocol answers account, model list, and plan usage
  // without spending tokens (the same probe T3 Code uses through the SDK).
  const probe = loggedIn ? await probeClaude(binary).catch(() => null) : null;
  const plan = claudePlanLabel(
    probe?.account.subscriptionType ?? auth?.subscriptionType ?? null,
  );
  const link = loggedIn
    ? connection({
        account: probe?.account.email ?? auth.email ?? auth.account ?? null,
        method:
          auth.authMethod === "claude.ai"
            ? "claude.ai sign-in"
            : auth.authMethod === "console" || auth.apiProvider === "console"
              ? "Anthropic Console API key"
              : `${auth.authMethod ?? "Claude Code"} sign-in`,
        plan:
          (probe?.account.organization ?? auth.orgName)
            ? `${plan ?? "Claude"} · ${probe?.account.organization ?? auth.orgName}`
            : plan,
        source: `Claude Code CLI at ${binary}`,
      })
    : null;
  const models = probe?.models?.length
    ? probe.models.map(
        ({ description: _d, resolvedModel: _r, ...model }) => model,
      )
    : MODELS;
  return {
    installed: true,
    binary,
    version: versionLine,
    available: loggedIn,
    account: link?.account ?? (loggedIn ? "signed in" : null),
    connection: link,
    reason,
    guidance: guide,
    models,
    defaultModel: models.some((model) => model.id === "default")
      ? "default"
      : (models[0]?.id ?? "default"),
    quota: probe?.quota ?? null,
    catalogSource: probe?.models?.length
      ? "claude --output-format stream-json initialize"
      : null,
  };
}

/** Progress items from one `--output-format stream-json` event, or null. */
export function progressItem(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "stream_event") {
    const delta = event.event?.delta;
    if (delta?.type === "text_delta" && typeof delta.text === "string")
      return { type: "output_delta", text: delta.text.slice(0, 4000) };
    if (delta?.type === "thinking_delta" && typeof delta.thinking === "string")
      return {
        type: "reasoning_delta",
        text: delta.thinking.slice(0, 4000),
      };
  }
  if (event.type === "assistant" && Array.isArray(event.message?.content)) {
    const thinking = event.message.content
      .filter((block) => block?.type === "thinking" && block.thinking)
      .map((block) => String(block.thinking))
      .join("\n");
    if (thinking) return { type: "reasoning", text: thinking.slice(0, 4000) };
  }
  if (
    event.type === "system" &&
    event.subtype === "thinking_tokens" &&
    Number.isInteger(event.estimated_tokens)
  )
    return { type: "thinking", tokens: event.estimated_tokens };
  // Lifecycle, so the browser can say what the wait is for (SPEC 12.3.1).
  if (event.type === "system" && event.subtype === "init")
    return {
      type: "phase",
      text: "Claude Code session ready; sending the prompt…",
    };
  if (event.type === "user")
    return { type: "phase", text: "Claude Code is reading a tool result…" };
  if (event.type === "result")
    return {
      type: "phase",
      text: "Claude Code finished; collecting the answer…",
    };
  return null;
}

/** Claude Code's subscription rate limit as a protocol quota (percent of the window used). */
function quotaFrom(event) {
  const info = event?.rate_limit_info;
  const windows = info?.unifiedWindows;
  const five = windows?.five_hour;
  const week = windows?.seven_day;
  if (!Number.isFinite(five?.utilization)) return null;
  return {
    used: Math.round(five.utilization * 100),
    limit: 100,
    unit: "% of the 5-hour window",
    resetsAt: Number.isFinite(five.resetsAt)
      ? new Date(five.resetsAt * 1000).toISOString()
      : null,
    label: Number.isFinite(week?.utilization)
      ? `7-day window ${Math.round(week.utilization * 100)}% used${info.status && info.status !== "allowed" ? ` · ${info.status}` : ""}`
      : null,
  };
}

/** Parses `claude -p --output-format stream-json` output into the adapter result. */
export function parseClaudeOutput(stdout, stderr, code, model) {
  const events = jsonLines(stdout);
  const result = events.find((event) => event.type === "result");
  if (!result)
    return {
      isError: true,
      errorMessage: summarizeFailure(
        stderr,
        `Claude Code exited with status ${code}.`,
      ),
    };
  if (result.is_error || result.subtype?.startsWith("error"))
    return {
      isError: true,
      // A run that hits a ceiling reports the subtype and an empty `result`,
      // which would otherwise reach the browser as a bare "Claude Code failed:".
      errorMessage: (
        String(result.result ?? "").trim() ||
        ERROR_SUBTYPES[result.subtype] ||
        (result.subtype
          ? `Claude Code reported ${result.subtype}.`
          : "Claude Code reported an error.")
      ).slice(0, 300),
    };
  const usage = result.usage ?? {};
  // `result.usage` is the total across every model request in this agent run.
  // The final assistant event is the request that is actually occupying the
  // model's context window, so keep its usage separate from the run ledger.
  const lastRequestUsage = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "assistant" &&
        event.message?.usage &&
        typeof event.message.usage === "object",
    )?.message?.usage;
  const contextTokens = lastRequestUsage
    ? (lastRequestUsage.input_tokens ?? 0) +
      (lastRequestUsage.cache_read_input_tokens ?? 0) +
      (lastRequestUsage.cache_creation_input_tokens ?? 0)
    : null;
  const modelUsage = result.modelUsage ?? {};
  const usedModel = Object.keys(modelUsage)[0] ?? model;
  const reasoning = events
    .filter((event) => event.type === "assistant")
    .flatMap((event) => event.message?.content ?? [])
    .filter((block) => block?.type === "thinking" && block.thinking)
    .map((block) => String(block.thinking))
    .join("\n\n")
    .slice(0, 12_000);
  const rateLimit = [...events]
    .reverse()
    .find((event) => event.type === "rate_limit_event");
  return {
    content: String(result.result ?? ""),
    usage: usageFrom(
      (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0),
      usage.output_tokens,
      {
        cached: usage.cache_read_input_tokens,
        reasoning: usage.output_tokens_details?.thinking_tokens,
      },
    ),
    model: usedModel,
    contextWindow: Number.isInteger(modelUsage[usedModel]?.contextWindow)
      ? modelUsage[usedModel].contextWindow
      : null,
    contextTokens: Number.isSafeInteger(contextTokens) ? contextTokens : null,
    contextCachedTokens: Number.isSafeInteger(
      lastRequestUsage?.cache_read_input_tokens,
    )
      ? lastRequestUsage.cache_read_input_tokens
      : null,
    reasoning: reasoning || null,
    quota: rateLimit ? quotaFrom(rateLimit) : null,
    thread: typeof result.session_id === "string" ? result.session_id : null,
  };
}

/**
 * One stream-json user message carrying the prompt and its image attachments.
 * Claude Code's text input format has no room for an image, so a run with
 * attachments switches to `--input-format stream-json` and sends this line
 * instead of the bare prompt. Text-only runs keep the plain-text path.
 */
export function streamJsonUserMessage(prompt, images) {
  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: prompt },
        ...images.map((image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mediaType,
            data: image.data,
          },
        })),
      ],
    },
  })}\n`;
}

export function start({
  binary,
  model,
  systemPrompt,
  prompt,
  images = [],
  mcp,
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
  // Claude Code keys saved sessions by working directory, so a thread keeps
  // its scratch directory for its whole life.
  const scratch = sharedScratch ?? scratchDirectory("claude");
  const attachments = images.slice(0, IMAGE_LIMITS.perPrompt);
  const args = [
    "-p",
    ...(attachments.length ? ["--input-format", "stream-json"] : []),
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    // No built-in tools: a website assistant must never reach the file system or shell.
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--max-turns",
    String(MAX_TURNS),
  ];
  let handle = thread?.handle ?? null;
  if (!thread) args.push("--no-session-persistence");
  else if (handle) args.push("--resume", handle);
  else {
    handle = randomUUID();
    args.push("--session-id", handle);
  }
  if (model && model !== "default") args.push("--model", model);
  if (systemPrompt) args.push("--system-prompt", systemPrompt);
  const effort = effortOf(reasoning, CLAUDE_EFFORTS);
  if (effort) args.push("--effort", effort);
  if (mcp) {
    const mcpConfig = join(scratch.directory, "arjunah-mcp.json");
    writeFileSync(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          arjunah: {
            type: "http",
            url: mcp.url,
            headers: { Authorization: `Bearer ${mcp.token}` },
          },
        },
      }),
      { mode: 0o600 },
    );
    args.push(
      "--mcp-config",
      mcpConfig,
      "--allowedTools",
      "mcp__arjunah",
      "--permission-mode",
      "dontAsk",
    );
  } else
    // Without an explicit empty server list Claude Code would load the user's own MCP servers.
    args.push("--mcp-config", JSON.stringify({ mcpServers: {} }));
  if (handle) onThread?.(handle);
  say(
    thread?.handle
      ? "Resuming the saved Claude Code session…"
      : "Launching the Claude Code CLI…",
  );
  onLog?.(
    "info",
    `claude -p: model ${model ?? "default"}${effort ? `, effort ${effort}` : ""}${mcp ? ", browser tools bridged over MCP" : ""}${thread?.handle ? ", resumed session" : ""}`,
  );
  let streamedReasoning = false;
  return spawnAgent({
    binary,
    args,
    onLog,
    stdin: attachments.length
      ? streamJsonUserMessage(prompt, attachments)
      : prompt,
    cwd: scratch.directory,
    env: {
      MCP_TOOL_TIMEOUT: "600000",
      MCP_TIMEOUT: "30000",
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
    },
    onExit: sharedScratch ? undefined : scratch.cleanup,
    onLine: onProgress
      ? (event) => {
          const item = progressItem(event);
          if (!item) return;
          if (item.type === "reasoning_delta") streamedReasoning = true;
          if (item.type === "reasoning" && streamedReasoning) return;
          onProgress(item);
        }
      : undefined,
    parse(stdout, stderr, code) {
      return parseClaudeOutput(stdout, stderr, code, model);
    },
  });
}

/**
 * The project directories Claude Code may have used for a scratch directory.
 * It slugifies the *resolved* working directory, which on macOS is the
 * `/private/var/…` spelling of the `/var/…` path `tmpdir()` hands out; slugging
 * the path as given would look for a directory that never existed and leave the
 * conversation on disk. Both spellings are tried, because only the one the CLI
 * chose exists and neither can be assumed.
 */
export function sessionDirectories(scratch) {
  const root = join(
    process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? "", ".claude"),
    "projects",
  );
  let resolved = scratch;
  try {
    resolved = realpathSync(scratch);
  } catch {
    /* already removed; the path as given is the only candidate left */
  }
  return [...new Set([resolved, scratch])].map((path) =>
    join(root, path.replace(/[^A-Za-z0-9]/g, "-")),
  );
}

/** Removes the saved session transcript Claude Code wrote for a finished thread. */
export function endThread(handle, scratchDirectory_) {
  if (!/^[0-9a-f-]{36}$/.test(String(handle ?? "")) || !scratchDirectory_)
    return;
  for (const directory of sessionDirectories(scratchDirectory_)) {
    removeQuietly(join(directory, `${handle}.jsonl`));
    try {
      // The CLI also leaves a `memory` folder beside the transcript, so an
      // emptied directory is not literally empty; what matters is that no
      // other conversation is still stored there.
      if (!readdirSync(directory).some((entry) => entry.endsWith(".jsonl")))
        removeQuietly(directory);
    } catch {
      /* other sessions or already gone */
    }
  }
}
