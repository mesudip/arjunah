/**
 * Registers अर्जुनः Desktop as a per-user login program.
 *
 * macOS: a LaunchAgent in ~/Library/LaunchAgents (launchd keeps it alive).
 * Linux: a systemd user service, or an XDG autostart entry where systemd is absent.
 * Windows: a value under HKCU\...\CurrentVersion\Run.
 *
 * Everything that touches the system goes through `install`, `uninstall`, and
 * `status`; the `plan` function below is pure so the exact files and commands
 * can be inspected and tested without changing anything.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LAUNCHD_LABEL = "io.arjunah.desktop";
export const SERVICE_NAME = "arjunah-desktop";
export const WINDOWS_RUN_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const WINDOWS_RUN_VALUE = "ArjunahDesktop";

/** Environment the login program inherits: only what the companion reads. */
const FORWARDED_ENV = ["PATH", "ARJUNAH_DESKTOP_PORT", "ARJUNAH_DESKTOP_HOME"];

export function defaultBinPath() {
  return fileURLToPath(new URL("../bin/arjunah-desktop.mjs", import.meta.url));
}

function xml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
}

function forwardedEnv(env) {
  return Object.fromEntries(
    FORWARDED_ENV.filter((name) => env[name]).map((name) => [name, env[name]]),
  );
}

export function launchAgentPlist({ node, bin, logPath, env }) {
  const environment = Object.entries(env)
    .map(
      ([name, value]) =>
        `      <key>${xml(name)}</key>\n      <string>${xml(value)}</string>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(node)}</string>
      <string>${xml(bin)}</string>
      <string>start</string>
      <string>--quiet</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xml(logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(logPath)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${environment}
    </dict>
  </dict>
</plist>
`;
}

/** systemd quoting: double quotes with backslash escapes. */
function systemdQuote(value) {
  return `"${String(value).replace(/[\\"]/g, "\\$&")}"`;
}

export function systemdUnit({ node, bin, env }) {
  const environment = Object.entries(env)
    .map(([name, value]) => `Environment=${systemdQuote(`${name}=${value}`)}`)
    .join("\n");
  return `[Unit]
Description=अर्जुनः Desktop (lends websites your local AI subscriptions over loopback)
After=default.target

[Service]
Type=simple
ExecStart=${systemdQuote(node)} ${systemdQuote(bin)} start --quiet
Restart=on-failure
RestartSec=3
${environment}

[Install]
WantedBy=default.target
`;
}

/** XDG autostart fallback for desktops without systemd user sessions. */
export function xdgDesktopEntry({ node, bin }) {
  const quote = (value) => `"${String(value).replace(/["\\$`]/g, "\\$&")}"`;
  return `[Desktop Entry]
Type=Application
Name=अर्जुनः Desktop
Comment=Lends websites your local AI subscriptions over loopback
Exec=${quote(node)} ${quote(bin)} start --quiet
Terminal=false
X-GNOME-Autostart-enabled=true
`;
}

/** The command line stored under the Windows Run key. */
export function windowsRunCommand({ node, bin }) {
  const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
  return `${quote(node)} ${quote(bin)} start --quiet`;
}

function hasCommand(name) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [name], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * What `install` would write and run on this platform. Pure: reads only the
 * arguments it is given.
 */
export function plan({
  platform = process.platform,
  home = homedir(),
  node = process.execPath,
  bin = defaultBinPath(),
  dataDirectory,
  env = process.env,
  systemd = platform === "linux" ? hasCommand("systemctl") : false,
} = {}) {
  const forwarded = forwardedEnv(env);
  if (platform === "darwin") {
    const path = join(
      home,
      "Library",
      "LaunchAgents",
      `${LAUNCHD_LABEL}.plist`,
    );
    const logPath = join(dataDirectory, "arjunah-desktop.log");
    return {
      platform,
      kind: "launchd",
      path,
      contents: launchAgentPlist({ node, bin, logPath, env: forwarded }),
      logPath,
    };
  }
  if (platform === "linux") {
    if (systemd) {
      const path = join(
        env.XDG_CONFIG_HOME ?? join(home, ".config"),
        "systemd",
        "user",
        `${SERVICE_NAME}.service`,
      );
      return {
        platform,
        kind: "systemd",
        path,
        contents: systemdUnit({ node, bin, env: forwarded }),
      };
    }
    const path = join(
      env.XDG_CONFIG_HOME ?? join(home, ".config"),
      "autostart",
      `${SERVICE_NAME}.desktop`,
    );
    return {
      platform,
      kind: "xdg-autostart",
      path,
      contents: xdgDesktopEntry({ node, bin }),
    };
  }
  if (platform === "win32") {
    return {
      platform,
      kind: "windows-run",
      path: `${WINDOWS_RUN_KEY}\\${WINDOWS_RUN_VALUE}`,
      command: windowsRunCommand({ node, bin }),
    };
  }
  throw new Error(`Autostart is not supported on ${platform}.`);
}

function run(file, args, { allowFailure = false } = {}) {
  try {
    return execFileSync(file, args, { stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  } catch (error) {
    if (allowFailure) return null;
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`${file} ${args.join(" ")} failed: ${detail}`);
  }
}

function writePrivate(path, contents) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, contents, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* platform without POSIX modes */
  }
}

function launchdDomain() {
  return `gui/${userInfo().uid}`;
}

/** Registers the login program and starts it now. Returns the plan it applied. */
export function install(options = {}) {
  const step = plan(options);
  if (step.kind === "launchd") {
    writePrivate(step.path, step.contents);
    mkdirSync(dirname(step.logPath), { recursive: true, mode: 0o700 });
    const domain = launchdDomain();
    // bootout first so a re-install picks up the new file; ignore "not loaded".
    run("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`], {
      allowFailure: true,
    });
    run("launchctl", ["bootstrap", domain, step.path]);
    return step;
  }
  if (step.kind === "systemd") {
    writePrivate(step.path, step.contents);
    run("systemctl", ["--user", "daemon-reload"]);
    run("systemctl", ["--user", "enable", "--now", `${SERVICE_NAME}.service`]);
    run("systemctl", ["--user", "restart", `${SERVICE_NAME}.service`]);
    return step;
  }
  if (step.kind === "xdg-autostart") {
    writePrivate(step.path, step.contents);
    startDetached(options);
    return step;
  }
  if (step.kind === "windows-run") {
    run("reg", [
      "add",
      WINDOWS_RUN_KEY,
      "/v",
      WINDOWS_RUN_VALUE,
      "/t",
      "REG_SZ",
      "/d",
      step.command,
      "/f",
    ]);
    startDetached(options);
    return step;
  }
  throw new Error(`Unsupported autostart kind ${step.kind}.`);
}

function startDetached({
  node = process.execPath,
  bin = defaultBinPath(),
} = {}) {
  spawn(node, [bin, "start", "--quiet"], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

/** Stops the login program and removes its registration. */
export function uninstall(options = {}) {
  const step = plan(options);
  if (step.kind === "launchd") {
    run("launchctl", ["bootout", `${launchdDomain()}/${LAUNCHD_LABEL}`], {
      allowFailure: true,
    });
    rmSync(step.path, { force: true });
    return step;
  }
  if (step.kind === "systemd") {
    run(
      "systemctl",
      ["--user", "disable", "--now", `${SERVICE_NAME}.service`],
      {
        allowFailure: true,
      },
    );
    rmSync(step.path, { force: true });
    run("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
    return step;
  }
  if (step.kind === "xdg-autostart") {
    rmSync(step.path, { force: true });
    return step;
  }
  if (step.kind === "windows-run") {
    run("reg", ["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/f"], {
      allowFailure: true,
    });
    return step;
  }
  throw new Error(`Unsupported autostart kind ${step.kind}.`);
}

/** Whether the login registration exists (does not check the process). */
export function isInstalled(options = {}) {
  const step = plan(options);
  if (step.kind === "windows-run")
    return (
      run("reg", ["query", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE], {
        allowFailure: true,
      }) !== null
    );
  return existsSync(step.path);
}

/** Whether a companion answers on the loopback port right now. */
export async function isRunning(port, { timeoutMs = 1500 } = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body?.version === "string" ? body : null;
  } catch {
    return null;
  }
}
