import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LAUNCHD_LABEL,
  SERVICE_NAME,
  WINDOWS_RUN_KEY,
  WINDOWS_RUN_VALUE,
  plan,
  windowsRunCommand,
} from "../desktop/lib/autostart.mjs";

const common = {
  home: "/Users/tester",
  node: "/opt/node/bin/node",
  bin: "/opt/arjunah/bin/arjunah-desktop.mjs",
  dataDirectory: "/Users/tester/Library/Application Support/arjunah",
  env: {
    PATH: "/opt/node/bin:/usr/bin",
    ARJUNAH_DESKTOP_PORT: "48999",
    SECRET_TOKEN: "must-not-leak",
    HOME: "/Users/tester",
  },
};

test("macOS plan writes a per-user LaunchAgent that keeps the companion alive", () => {
  const step = plan({ ...common, platform: "darwin" });
  assert.equal(step.kind, "launchd");
  assert.equal(
    step.path,
    `/Users/tester/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`,
  );
  assert.match(step.contents, /<string>\/opt\/node\/bin\/node<\/string>/);
  assert.match(
    step.contents,
    /<string>start<\/string>\s*<string>--quiet<\/string>/,
  );
  assert.match(step.contents, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(step.contents, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(step.contents, /arjunah-desktop\.log/);
  assert.match(
    step.contents,
    /<key>ARJUNAH_DESKTOP_PORT<\/key>\s*<string>48999/,
  );
  assert.match(step.contents, /<key>PATH<\/key>/);
  assert.equal(step.contents.includes("SECRET_TOKEN"), false);
  assert.equal(step.contents.includes("must-not-leak"), false);
});

test("plist values are XML-escaped so odd paths cannot break the document", () => {
  const step = plan({
    ...common,
    platform: "darwin",
    bin: "/Users/tester/<odd> & 'quoted' \"dir\"/bin.mjs",
  });
  assert.match(
    step.contents,
    /&lt;odd&gt; &amp; &apos;quoted&apos; &quot;dir&quot;/,
  );
  assert.equal(step.contents.includes("<odd>"), false);
});

test("Linux plan prefers a systemd user unit and falls back to XDG autostart", () => {
  const unit = plan({ ...common, platform: "linux", systemd: true });
  assert.equal(unit.kind, "systemd");
  assert.equal(
    unit.path,
    `/Users/tester/.config/systemd/user/${SERVICE_NAME}.service`,
  );
  assert.match(
    unit.contents,
    /ExecStart="\/opt\/node\/bin\/node" "\/opt\/arjunah\/bin\/arjunah-desktop\.mjs" start --quiet/,
  );
  assert.match(unit.contents, /Restart=on-failure/);
  assert.match(unit.contents, /Environment="ARJUNAH_DESKTOP_PORT=48999"/);
  assert.match(unit.contents, /WantedBy=default\.target/);
  assert.equal(unit.contents.includes("SECRET_TOKEN"), false);

  const xdg = plan({
    ...common,
    platform: "linux",
    systemd: false,
    env: { ...common.env, XDG_CONFIG_HOME: "/Users/tester/cfg" },
  });
  assert.equal(xdg.kind, "xdg-autostart");
  assert.equal(xdg.path, `/Users/tester/cfg/autostart/${SERVICE_NAME}.desktop`);
  assert.match(xdg.contents, /^\[Desktop Entry\]/);
  assert.match(
    xdg.contents,
    /Exec="\/opt\/node\/bin\/node" ".*arjunah-desktop\.mjs" start --quiet/,
  );
});

test("Windows plan stores a quoted command under the current user's Run key", () => {
  const step = plan({
    ...common,
    platform: "win32",
    node: "C:\\Program Files\\nodejs\\node.exe",
    bin: "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\arjunah-desktop\\bin\\arjunah-desktop.mjs",
  });
  assert.equal(step.kind, "windows-run");
  assert.equal(step.path, `${WINDOWS_RUN_KEY}\\${WINDOWS_RUN_VALUE}`);
  assert.equal(
    step.command,
    '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\arjunah-desktop\\bin\\arjunah-desktop.mjs" start --quiet',
  );
  assert.equal(
    windowsRunCommand({ node: 'C:\\odd"name\\node.exe', bin: "x.mjs" }),
    '"C:\\odd""name\\node.exe" "x.mjs" start --quiet',
  );
});

test("unsupported platforms are refused instead of guessed", () => {
  assert.throws(
    () => plan({ ...common, platform: "freebsd" }),
    /not supported/,
  );
});
