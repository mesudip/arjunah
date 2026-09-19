#!/usr/bin/env node
import { createDesktopApp, APP_VERSION } from "../lib/server.mjs";
import { Store } from "../lib/store.mjs";
import { detectProviders } from "../lib/providers/index.mjs";
import * as autostart from "../lib/autostart.mjs";

const command = process.argv[2] ?? "start";
const store = new Store();
/** One line naming the account a provider bills, for terminal output. */
function describeConnection(item) {
  const link = item.connection;
  if (!item.available) return "";
  if (!link) return " — signed in (account not reported)";
  const who = link.account
    ? `connected as ${link.account}`
    : `connected via ${link.method ?? "sign-in"}`;
  return ` — ${who}${link.plan ? ` (${link.plan})` : ""}${link.source ? ` · ${link.source}` : ""}`;
}

if (command === "--version" || command === "-v") {
  console.log(APP_VERSION);
  process.exit(0);
}
if (command === "providers") {
  const providers = await detectProviders(store.settings, { force: true });
  for (const item of providers)
    console.log(
      `${item.available ? "✔" : "✘"} ${item.name.padEnd(12)} ${item.installed ? (item.version ?? "installed") : "not installed"}${describeConnection(item)}${item.reason ? `\n    ${item.reason}` : ""}`,
    );
  process.exit(0);
}
if (command === "install") {
  // Registers the companion as a login program for this user and starts it now.
  const step = autostart.install({ dataDirectory: store.directory });
  console.log(`अर्जुनः Desktop ${APP_VERSION} will start when you log in.`);
  console.log(
    `Registered: ${step.path}${step.kind === "launchd" ? `\nLog: ${step.logPath}` : ""}`,
  );
  console.log(`Dashboard: http://127.0.0.1:${store.port}/`);
  console.log("Remove it again with: arjunah-desktop uninstall");
  process.exit(0);
}
if (command === "uninstall") {
  const step = autostart.uninstall({ dataDirectory: store.directory });
  console.log(`Removed the login program (${step.path}).`);
  console.log(`Your pairings and settings stay in ${store.path}.`);
  process.exit(0);
}
if (command === "status") {
  const installed = autostart.isInstalled({ dataDirectory: store.directory });
  const running = await autostart.isRunning(store.port);
  console.log(`अर्जुनः Desktop ${APP_VERSION}`);
  console.log(`Starts at login: ${installed ? "yes" : "no"}`);
  console.log(
    running
      ? `Running: yes (version ${running.version} on http://127.0.0.1:${store.port}/)`
      : `Running: no (nothing answers on 127.0.0.1:${store.port})`,
  );
  console.log(`Data: ${store.path}`);
  process.exit(running ? 0 : 3);
}
if (command !== "start") {
  console.error(
    "Usage: arjunah-desktop [start [--quiet] [--open] | install | uninstall | status | providers | --version]",
  );
  process.exit(2);
}

const quiet = process.argv.includes("--quiet");
const app = createDesktopApp({
  store,
  log: quiet
    ? () => {}
    : (line) => console.log(`[${new Date().toISOString()}] ${line}`),
});
let address;
try {
  address = await app.listen();
} catch (error) {
  console.error(
    `Could not listen on 127.0.0.1:${store.port}: ${error.message}`,
  );
  console.error(
    "Set ARJUNAH_DESKTOP_PORT to use another port and update the extension's desktop address.",
  );
  process.exit(1);
}
const dashboard = `http://127.0.0.1:${address.port}/`;
console.log(`अर्जुनः Desktop ${APP_VERSION}`);
console.log(`Dashboard: ${dashboard}`);
console.log(
  `Pairing code: ${app.pairing.current().code} (also shown on the dashboard)`,
);
console.log(`Data: ${store.path}`);
app.pairing.onChange = (code) => {
  if (!quiet) console.log(`New pairing code: ${code}`);
};
if (process.argv.includes("--open")) {
  const { spawn } = await import("node:child_process");
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args =
    process.platform === "win32" ? ["/c", "start", "", dashboard] : [dashboard];
  spawn(opener, args, { stdio: "ignore", detached: true }).unref();
}
app.providers().then((providers) => {
  for (const item of providers)
    console.log(
      `${item.available ? "✔" : "✘"} ${item.name}: ${item.available ? `available${describeConnection(item)}` : item.reason}`,
    );
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
