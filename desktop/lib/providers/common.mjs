import { spawn, execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const OUTPUT_LIMIT = 4_000_000;
const ENV_KEEP = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
]);

/** A minimal environment so a nested agent CLI does not inherit this process's session state. */
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env))
    if (ENV_KEEP.has(key)) env[key] = value;
  return { ...env, ...extra };
}

export async function which(binary, extraPaths = []) {
  const { access, constants } = await import("node:fs/promises");
  const separator = process.platform === "win32" ? ";" : ":";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
      : [""];
  const directories = [
    ...extraPaths,
    ...(process.env.PATH ?? "").split(separator),
  ].filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, binary + extension);
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

export function run(binary, args, { env, cwd, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      {
        env: cleanEnv(env),
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4_000_000,
        windowsHide: true,
      },
      (error, stdout, stderr) =>
        resolve({
          code: error?.code ?? 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          error,
        }),
    );
  });
}

export function scratchDirectory(prefix) {
  const directory = mkdtempSync(join(tmpdir(), `arjunah-${prefix}-`));
  return {
    directory,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/**
 * Spawns a CLI agent and resolves with its parsed output. `parse(stdout, stderr, code)`
 * returns { content, usage, model, isError, errorMessage }.
 */
export function spawnAgent({
  binary,
  args,
  stdin,
  env,
  cwd,
  parse,
  onExit,
  onLine,
}) {
  const child = spawn(binary, args, {
    env: cleanEnv(env),
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let partial = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
    if (!onLine) return;
    // Deliver complete JSON lines as they arrive so progress can be streamed.
    partial += chunk;
    const lines = partial.split(/\r?\n/);
    partial = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        onLine(JSON.parse(trimmed));
      } catch {
        /* partial or non-JSON line */
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 200_000) stderr += chunk;
  });
  const output = new Promise((resolve, reject) => {
    child.on("error", (error) =>
      reject(new Error(`Could not start the agent CLI: ${error.message}`)),
    );
    child.on("close", (code) => {
      onExit?.();
      try {
        resolve(parse(stdout, stderr, code));
      } catch (error) {
        reject(error);
      }
    });
  });
  // A CLI that exits before draining stdin (an auth failure, say) breaks the
  // pipe. Without this listener the EPIPE would take the whole companion down.
  child.stdin.on("error", () => {});
  if (stdin != null) child.stdin.end(stdin);
  else child.stdin.end();
  return { child, output };
}

export function jsonLines(text) {
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      items.push(JSON.parse(trimmed));
    } catch {
      /* partial or non-JSON line */
    }
  }
  return items;
}

export function usageFrom(input, output, { cached, reasoning } = {}) {
  const count = (value) =>
    Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return {
    promptTokens: count(input),
    completionTokens: count(output),
    totalTokens: count(input) + count(output),
    cachedTokens: count(cached),
    reasoningTokens: count(reasoning),
  };
}

/** Reasoning effort names shared by the protocol; adapters map them to CLI flags. */
export const EFFORTS = Object.freeze([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export function effortOf(value, allowed = EFFORTS) {
  return typeof value === "string" && allowed.includes(value) ? value : null;
}

/** Removes a file if it exists; used to delete persisted agent sessions on thread end. */
export function removeQuietly(path) {
  try {
    rmSync(path, { force: true, recursive: true });
  } catch {
    /* already gone */
  }
}

export function summarizeFailure(stderr, fallback) {
  const line = stderr
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1);
  return line ? line.slice(0, 300) : fallback;
}

// Structured troubleshooting shown in the desktop dashboard and the extension.
// `steps` are plain sentences; text between backticks is rendered as a command.
export function guidance({ state, summary, steps = [], links = [], note }) {
  return { state, summary, steps, links, note: note ?? null };
}

/**
 * Decode the payload of a JWT without verifying it. The token comes from a file the
 * user's own CLI wrote, so this is only used to display who is signed in, never to
 * grant anything.
 */
export function jwtPayload(token) {
  const segment = String(token ?? "").split(".")[1];
  if (!segment) return null;
  try {
    const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
    const parsed = JSON.parse(
      Buffer.from(padded, "base64url").toString("utf8"),
    );
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Normalize the account line every provider exposes. `account` is the human identity
 * (an email when known); `connection` says which sign-in and plan back the requests.
 */
export function connection({ account, method, plan, source }) {
  return {
    account: account ? String(account).slice(0, 200) : null,
    method: method ? String(method).slice(0, 120) : null,
    plan: plan ? String(plan).slice(0, 80) : null,
    source: source ? String(source).slice(0, 200) : null,
  };
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Wraps a CLI agent in a macOS seatbelt profile that denies reads and writes of
 * everything in the user's home directory except the folders the agent itself
 * needs. Each top-level home entry is denied individually (a blanket deny on the
 * home directory would also block the `stat` calls agents use to resolve their
 * own session files). The agent's inner sandbox then cannot start, so
 * model-issued shell commands fail instead of reading files. Returns null where
 * sandbox-exec is unavailable.
 */
export function outerSandbox({ binary, args, scratch, allow = [] }) {
  if (process.platform !== "darwin" || !existsSync(SANDBOX_EXEC)) return null;
  const home = homedir();
  const quote = (path) => JSON.stringify(path);
  const allowed = [
    ...new Set(
      [scratch, process.env.TMPDIR?.replace(/\/$/, ""), ...allow]
        .filter(Boolean)
        // A binary installed under the home directory must stay readable.
        .concat(binary.startsWith(home) ? [dirname(binary)] : []),
    ),
  ];
  const keep = (entry) =>
    allowed.some(
      (path) =>
        path === join(home, entry) || path.startsWith(`${join(home, entry)}/`),
    );
  let entries = [];
  try {
    entries = readdirSync(home);
  } catch {
    entries = [];
  }
  const denied = entries.filter((entry) => !keep(entry));
  const profile = [
    "(version 1)",
    "(allow default)",
    // Listing the home directory itself would reveal folder names.
    `(deny file-read-data (literal ${quote(home)}))`,
    ...denied.map(
      (entry) =>
        `(deny file-read* file-write* (subpath ${quote(join(home, entry))}))`,
    ),
    `(deny file-read* file-write* (subpath "/Users/Shared"))`,
    "",
  ].join("\n");
  const profilePath = join(scratch, "arjunah-outer-sandbox.sb");
  writeFileSync(profilePath, profile, { mode: 0o600 });
  return {
    binary: SANDBOX_EXEC,
    args: ["-f", profilePath, binary, ...args],
    profilePath,
    denied: denied.length,
  };
}

export function outerSandboxAvailable() {
  return process.platform === "darwin" && existsSync(SANDBOX_EXEC);
}

/**
 * Drives a CLI that speaks newline-delimited JSON on stdio: writes `requests`
 * (already serialized objects), collects lines until `done(messages)` says the
 * answers arrived or the deadline passes, then kills the process. Used for the
 * Claude Code control protocol and the Codex app-server JSON-RPC probe; both
 * are read-only account/catalog questions that cost no model tokens.
 */
export function jsonLineProbe(
  binary,
  args,
  requests,
  { done, env, cwd, timeoutMs = 20_000 } = {},
) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, args, {
        env: cleanEnv(env),
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({ messages: [], error: error.message, stderr: "" });
      return;
    }
    const messages = [];
    let stderr = "";
    let buffer = "";
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode == null) child.kill("SIGKILL");
        }, 2000).unref();
      } catch {
        /* gone */
      }
      resolve({
        messages,
        error: error ?? null,
        stderr: stderr.slice(0, 2000),
      });
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    child.on("error", (error) => finish(error.message));
    child.stdin.on("error", () => {});
    child.on("close", () => finish(messages.length ? null : "exited"));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 20_000) stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line.startsWith("{")) continue;
        try {
          messages.push(JSON.parse(line));
        } catch {
          continue;
        }
        if (done?.(messages)) finish(null);
      }
    });
    for (const item of requests) child.stdin.write(`${JSON.stringify(item)}\n`);
  });
}

const WINDOW_LABELS = {
  session: "Session",
  weekly: "Weekly",
  monthly: "Monthly",
};
export function windowKind(minutes) {
  if (minutes >= 30 * 24 * 60) return "monthly";
  if (minutes >= 7 * 24 * 60) return "weekly";
  return "session";
}
export function isoFromEpochSeconds(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value * 1000).toISOString()
    : null;
}
export function isoFromString(value) {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
/**
 * Arjunah quota from rolling usage windows: the session window (or the first)
 * is the headline, every window travels along for the UI.
 */
export function quotaFromWindows(windows, { label } = {}) {
  const list = windows
    .filter((item) => Number.isFinite(item.usedPercent))
    .map((item) => ({
      id: String(item.id).slice(0, 40),
      kind: item.kind ?? "other",
      label: String(item.label ?? WINDOW_LABELS[item.kind] ?? item.id).slice(
        0,
        60,
      ),
      usedPercent: Math.max(0, Math.min(100, Math.round(item.usedPercent))),
      resetsAt: item.resetsAt ?? null,
    }));
  if (!list.length) return null;
  const primary = list.find((item) => item.kind === "session") ?? list[0];
  const rest = list.filter((item) => item !== primary);
  return {
    used: primary.usedPercent,
    limit: 100,
    unit: `% of ${primary.label.toLowerCase()} window`,
    resetsAt: primary.resetsAt,
    // `label` summarises everything for consumers that show one line; `note`
    // holds only what the windows list does not already say (spend caps, flags).
    label:
      [label, ...rest.map((item) => `${item.label} ${item.usedPercent}%`)]
        .filter(Boolean)
        .join(" · ") || null,
    note: label ?? null,
    windows: list,
  };
}
