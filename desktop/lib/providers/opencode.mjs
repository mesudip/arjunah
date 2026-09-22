import { readFileSync, writeFileSync } from "node:fs";
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
  connection,
  effortOf,
} from "./common.mjs";

export const id = "opencode";
export const name = "OpenCode";
export const vendor = "OpenCode";
export const supportsTools = true;
// `opencode run` takes its prompt on stdin and offers no image input, so no
// OpenCode model advertises vision even when the upstream model accepts images.
export const supportsVision = false;
export const supportsThreads = true;
export const supportsReasoning = true;
const LINKS = [
  { label: "OpenCode website", url: "https://opencode.ai" },
  { label: "OpenCode docs", url: "https://opencode.ai/docs" },
];
let modelCache = { at: 0, models: [] };

/**
 * `opencode models --verbose` prints each `provider/model` id followed by a JSON
 * object with limits and capabilities. Plain ids (older versions) still work.
 */
export function parseModelList(stdout) {
  const models = [];
  const lines = String(stdout ?? "").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!/^[a-z0-9_.-]+\/[^\s]+$/i.test(line)) continue;
    let meta = null;
    if (lines[index + 1]?.trim().startsWith("{")) {
      let depth = 0;
      const buffer = [];
      for (let j = index + 1; j < lines.length; j++) {
        buffer.push(lines[j]);
        for (const char of lines[j]) {
          if (char === "{") depth++;
          else if (char === "}") depth--;
        }
        if (depth <= 0) {
          index = j;
          break;
        }
      }
      try {
        meta = JSON.parse(buffer.join("\n"));
      } catch {
        meta = null;
      }
    }
    // OpenCode lists retired models too; only active ones are selectable.
    if (meta?.status && meta.status !== "active") continue;
    const cost = meta?.cost;
    const free =
      cost && Number(cost.input ?? 0) === 0 && Number(cost.output ?? 0) === 0;
    models.push({
      id: line,
      displayName: meta?.name
        ? `${meta.name}${free && !/free/i.test(meta.name) ? " (free)" : ""} (${line})`
        : line,
      free: Boolean(free),
      contextWindow: Number.isInteger(meta?.limit?.context)
        ? meta.limit.context
        : null,
      reasoningLevels: meta?.capabilities?.reasoning
        ? ["low", "medium", "high", "max"]
        : [],
      defaultReasoning: null,
      capabilities: {
        tools: meta?.capabilities?.toolcall !== false,
        // The upstream model may accept images; this run path cannot deliver one.
        vision: false,
        reasoning: meta?.capabilities?.reasoning === true,
      },
    });
    if (models.length >= 400) break;
  }
  return models;
}

/**
 * OpenCode has no account of its own: it stores one credential per upstream
 * provider in its auth file. This is the same signal `opencode auth list`
 * prints and the `connected` list T3 Code reads from `provider.list`.
 */
export function readOpenCodeCredentials(
  path = join(
    process.env.XDG_DATA_HOME ??
      join(process.env.HOME ?? "", ".local", "share"),
    "opencode",
    "auth.json",
  ),
) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return describeOpenCodeCredentials(parsed);
  } catch {
    return [];
  }
}
const PROVIDER_LABELS = {
  "opencode-go": "OpenCode Go",
  opencode: "OpenCode",
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
  github: "GitHub Copilot",
  "github-copilot": "GitHub Copilot",
  amazon: "Amazon Bedrock",
  "amazon-bedrock": "Amazon Bedrock",
};
export function describeOpenCodeCredentials(authJson) {
  if (!authJson || typeof authJson !== "object") return [];
  return Object.entries(authJson)
    .slice(0, 32)
    .map(([id, entry]) => ({
      id: String(id).slice(0, 64),
      label:
        PROVIDER_LABELS[id] ??
        String(id)
          .split(/[-_]/)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" "),
      type:
        entry?.type === "oauth"
          ? "sign-in"
          : entry?.type === "api"
            ? "API key"
            : String(entry?.type ?? "credential").slice(0, 20),
    }));
}

// A full detection may wait a minute for the catalog, but the light pass runs
// while a browser holds an open read, so it must finish inside that read's
// ceiling (see src/lib/desktop.js) rather than outlive it.
const REFRESH_LIST_MS = 20_000;
const LIST_TIMEOUT_S = 60;

/** The light pass: re-list models only. See claude-code's `refresh`. */
export async function refresh(previous) {
  if (!previous?.binary || !previous.available) return null;
  const listed = await run(previous.binary, ["models", "--verbose"], {
    timeoutMs: REFRESH_LIST_MS,
  });
  // A killed listing leaves truncated stdout, and `parseModelList` will
  // happily return the models it got — including one whose JSON block was cut
  // off, with its metadata silently degraded. Caching that as the catalog can
  // even move `defaultModel`. An incomplete answer is not an answer.
  if (listed.timedOut || listed.error) return null;
  const models = parseModelList(listed.stdout);
  if (!models.length) return null;
  modelCache = { at: Date.now(), models };
  return { ...previous, models, defaultModel: models[0]?.id ?? null };
}

export async function detect(settings = {}) {
  const binary =
    settings.opencodePath ||
    (await which("opencode", [
      "/opt/homebrew/bin",
      `${process.env.HOME}/.opencode/bin`,
      `${process.env.HOME}/.local/bin`,
    ]));
  if (!binary)
    return {
      installed: false,
      available: false,
      reason:
        "OpenCode is not installed. See https://opencode.ai for installation and provider sign-in.",
      guidance: guidance({
        state: "missing",
        summary: "The `opencode` command was not found on this computer.",
        steps: [
          "Install it in a terminal: `curl -fsSL https://opencode.ai/install | bash` or `npm install -g opencode-ai`.",
          "Run `opencode auth login` and connect at least one model provider. OpenCode also offers free models that need no account.",
          "Click Re-check below. If OpenCode lives somewhere unusual, paste the full path to the `opencode` binary in the field below and save.",
        ],
        links: LINKS,
      }),
    };
  const version = await run(binary, ["--version"], { timeoutMs: 15_000 });
  let listFailed = false;
  if (Date.now() - modelCache.at > 60_000) {
    const listed = await run(binary, ["models", "--verbose"], {
      timeoutMs: 60_000,
    });
    // Same reasoning as `refresh`: a truncated listing is not a catalog. Keep
    // whatever was cached and report why, instead of publishing a short list
    // that reads as "these are the models you have".
    listFailed = Boolean(listed.timedOut || listed.error);
    if (!listFailed)
      modelCache = { at: Date.now(), models: parseModelList(listed.stdout) };
  }
  const models = modelCache.models;
  const providers = [...new Set(models.map((model) => model.id.split("/")[0]))];
  const credentials = readOpenCodeCredentials();
  const freeCount = models.filter((model) => model.free).length;
  return {
    installed: true,
    binary,
    version: version.stdout.trim() || null,
    available: models.length > 0,
    // OpenCode has no personal login of its own; it forwards to whichever model
    // providers the user configured, so there is no single account to show.
    account: credentials.length
      ? credentials
          .slice(0, 3)
          .map((item) => `${item.label} (${item.type})`)
          .join(", ")
      : models.length
        ? "free models only"
        : null,
    connection: models.length
      ? connection({
          account: credentials.length
            ? credentials
                .slice(0, 3)
                .map((item) => `${item.label} (${item.type})`)
                .join(", ")
            : null,
          method: credentials.length
            ? `${credentials.length} upstream credential${credentials.length === 1 ? "" : "s"} in OpenCode`
            : "OpenCode free models, no credential",
          plan: null,
          source: `${models.length} models from ${providers.length} provider${providers.length === 1 ? "" : "s"} (${freeCount} free): ${providers.slice(0, 6).join(", ")}${providers.length > 6 ? ", …" : ""}`,
        })
      : null,
    // OpenCode forwards to upstream providers and has no rolling allowance of
    // its own; upstream quotas are not exposed through its CLI.
    quota: null,
    reason: listFailed
      ? `OpenCode did not finish listing its models within ${LIST_TIMEOUT_S} seconds. It is probably fine; this computer was too busy to answer.`
      : models.length
        ? null
        : "OpenCode has no configured model providers. Run `opencode auth login` or configure a provider first.",
    guidance: models.length
      ? null
      : guidance({
          state: "signed-out",
          summary: `OpenCode ${version.stdout.trim()} is installed at ${binary} but lists no usable models.`,
          steps: [
            "Open a terminal and run `opencode auth login`, then pick a provider and sign in or paste its API key.",
            "Run `opencode models` and confirm at least one model is printed.",
            "Click Re-check.",
          ],
          links: LINKS,
        }),
    models,
    defaultModel: models[0]?.id ?? null,
  };
}

const BUILTIN_TOOLS = [
  "bash",
  "edit",
  "write",
  "read",
  "glob",
  "grep",
  "list",
  "patch",
  "webfetch",
  "websearch",
  "todowrite",
  "todoread",
  "task",
  "skill",
  "question",
  "lsp",
  "codesearch",
  "external_directory",
];

export function start({
  binary,
  model,
  systemPrompt,
  prompt,
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
  say("Preparing a sandboxed workspace for OpenCode…");
  const scratch = sharedScratch ?? scratchDirectory("opencode");
  const deny = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool, "deny"]));
  const tools = Object.fromEntries(BUILTIN_TOOLS.map((tool) => [tool, false]));
  const config = {
    $schema: "https://opencode.ai/config.json",
    share: "disabled",
    autoupdate: false,
    permission: { ...deny, "arjunah_*": "allow" },
    tools: { ...tools, "arjunah_*": true },
    agent: {
      arjunah: {
        mode: "primary",
        description: "अर्जुनः browser broker agent",
        prompt: systemPrompt || "You are a helpful assistant.",
        steps: 24,
        permission: { ...deny, "arjunah_*": "allow" },
        tools: { ...tools, "arjunah_*": true },
      },
    },
  };
  if (mcp)
    config.mcp = {
      arjunah: {
        type: "remote",
        url: mcp.url,
        enabled: true,
        oauth: false,
        timeout: 600_000,
        headers: { Authorization: `Bearer ${mcp.token}` },
      },
    };
  const configPath = join(scratch.directory, "opencode.json");
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  // The prompt travels on stdin, like the Claude Code and Codex adapters: it
  // never appears in process arguments, has no command-template expansion
  // applied to it, and is not subject to argv size limits. `opencode run`
  // with no positional message reads the message from stdin.
  const args = [
    "run",
    "--format",
    "json",
    "--pure",
    "--agent",
    "arjunah",
    "--dir",
    scratch.directory,
  ];
  if (model && model !== "default") args.push("-m", model);
  if (thread?.handle) args.push("--session", thread.handle);
  const effort = effortOf(reasoning, ["low", "medium", "high", "max"]);
  if (effort) args.push("--variant", effort);
  say(
    thread?.handle
      ? "Resuming the saved OpenCode session…"
      : "Launching the OpenCode CLI…",
  );
  onLog?.(
    "info",
    `opencode run: model ${model ?? "default"}${effort ? `, variant ${effort}` : ""}${mcp ? ", browser tools bridged over MCP" : ""}${thread?.handle ? ", resumed session" : ""}`,
  );
  let announced = false;
  let working = false;
  return spawnAgent({
    binary,
    args,
    onLog,
    stdin: prompt,
    cwd: scratch.directory,
    env: { OPENCODE_CONFIG: configPath, OPENCODE_DISABLE_AUTOUPDATE: "1" },
    onExit: sharedScratch ? undefined : scratch.cleanup,
    onLine: (event) => {
      if (!announced && typeof event?.sessionID === "string") {
        announced = true;
        onThread?.(event.sessionID.slice(0, 80));
      }
      if (onProgress && !working && event?.type) {
        working = true;
        onProgress({
          type: "phase",
          text: "OpenCode is working on the answer…",
        });
      }
      if (
        onProgress &&
        event?.type === "reasoning" &&
        typeof event.part?.text === "string" &&
        event.part.text
      )
        onProgress({ type: "reasoning", text: event.part.text.slice(0, 4000) });
      if (
        onProgress &&
        event?.type === "text" &&
        typeof event.part?.text === "string" &&
        event.part.text
      )
        onProgress({
          type: "output_delta",
          text: event.part.text.slice(0, 4000),
        });
    },
    parse(stdout, stderr, code) {
      const events = jsonLines(stdout);
      const failure = events.find((event) => event.type === "error");
      const texts = events.filter(
        (event) =>
          event.type === "text" && typeof event.part?.text === "string",
      );
      const lastMessage = texts.at(-1)?.part?.messageID;
      const content = texts
        .filter((event) => event.part.messageID === lastMessage)
        .map((event) => event.part.text)
        .join("");
      if (
        failure ||
        (!texts.length && !events.some((event) => event.type === "step_finish"))
      )
        return {
          isError: true,
          errorMessage: String(
            failure?.error?.message ??
              failure?.error?.data?.message ??
              summarizeFailure(stderr, `OpenCode exited with status ${code}.`),
          ).slice(0, 300),
        };
      let input = 0;
      let output = 0;
      let cached = 0;
      let reasoningTokens = 0;
      for (const event of events)
        if (event.type === "step_finish") {
          input +=
            Number(event.part?.tokens?.input ?? 0) +
            Number(event.part?.tokens?.cache?.read ?? 0);
          output += Number(event.part?.tokens?.output ?? 0);
          cached += Number(event.part?.tokens?.cache?.read ?? 0);
          reasoningTokens += Number(event.part?.tokens?.reasoning ?? 0);
        }
      const reasoningText = events
        .filter(
          (event) =>
            event.type === "reasoning" && typeof event.part?.text === "string",
        )
        .map((event) => event.part.text)
        .join("\n\n")
        .slice(0, 12_000);
      return {
        content,
        usage: usageFrom(input, output, {
          cached,
          reasoning: reasoningTokens,
        }),
        model,
        reasoning: reasoningText || null,
        thread: events.find((event) => event.sessionID)?.sessionID ?? null,
      };
    },
  });
}

/** Delete the persisted OpenCode session associated with a finished browser chat. */
export async function endThread(handle, scratchDirectory_, binary) {
  if (
    !/^[A-Za-z0-9_-]{1,100}$/.test(String(handle ?? "")) ||
    !scratchDirectory_ ||
    !binary
  )
    return;
  await run(binary, ["session", "delete", handle], {
    cwd: scratchDirectory_,
    env: {
      OPENCODE_CONFIG: join(scratchDirectory_, "opencode.json"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    },
  });
}
