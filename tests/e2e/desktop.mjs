// End-to-end: browser extension + desktop companion. The companion runs in-process
// with a fake subscription agent so the suite needs no real sign-in; set
// ARJUNAH_E2E_LIVE=opencode (or codex/claude-code) to drive a real CLI instead.
import { mockProviderExtension } from "../helpers/browser-extension.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer";
import { createDesktopApp } from "../../desktop/lib/server.mjs";
import { Store } from "../../desktop/lib/store.mjs";

const live = process.env.ARJUNAH_E2E_LIVE ?? null;
const liveId = live ?? "claude-code";
const liveName =
  { opencode: "OpenCode", codex: "Codex", "claude-code": "Claude Code" }[
    liveId
  ] ?? liveId;
const shots = process.env.ARJUNAH_E2E_SHOTS ?? null;
const shot = async (page, name) => {
  if (shots)
    await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
};
const step = (name) =>
  process.env.ARJUNAH_E2E_VERBOSE && console.log(`step: ${name}`);
const fixture = await readFile(resolve("tests/fixtures/site.html"));
const site = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(fixture);
});
await new Promise((ready) => site.listen(0, "127.0.0.1", ready));
const sitePort = site.address().port;

const agentRuns = [];
const fakeAdapter = {
  id: "claude-code",
  name: "Claude Code",
  vendor: "Anthropic",
  supportsTools: true,
  async detect() {
    return {
      installed: true,
      available: true,
      binary: "/fake/claude",
      version: "fake",
      account: "fake@example.test",
      models: [
        { id: "default", displayName: "Default" },
        { id: "sonnet", displayName: "Sonnet" },
      ],
      defaultModel: "default",
    };
  },
  start(options) {
    agentRuns.push(options);
    const output = (async () => {
      if (!options.mcp)
        return {
          content: `Desktop answer to: ${options.prompt}`,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "fake-model",
        };
      const rpc = async (method, params, id) => {
        const response = await fetch(options.mcp.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.mcp.token}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
        return response.status === 202 ? null : response.json();
      };
      await rpc("initialize", { protocolVersion: "2025-03-26" }, 1);
      await rpc("notifications/initialized");
      const list = await rpc("tools/list", {}, 2);
      const tool = list.result.tools[0];
      const result = await rpc(
        "tools/call",
        { name: tool.name, arguments: { value: "from-desktop-agent" } },
        3,
      );
      return {
        content: `Tool round completed: ${result.result.content[0].text}`,
        usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
        model: "fake-model",
      };
    })();
    return { child: null, output };
  },
};

const storeDirectory = mkdtempSync(join(tmpdir(), "arjunah-desktop-e2e-"));
const liveStore = new Store(storeDirectory);
if (live)
  liveStore.updateSettings({
    experimentalCodex: live === "codex",
    ...(process.env.ARJUNAH_E2E_CODEX_PATH
      ? { codexPath: process.env.ARJUNAH_E2E_CODEX_PATH }
      : {}),
  });
const desktop = createDesktopApp({
  store: liveStore,
  log: () => {},
  ...(live
    ? {}
    : {
        adapters: (id) => (id === "claude-code" ? fakeAdapter : null),
        detect: async () => [
          {
            id: "claude-code",
            name: "Claude Code",
            vendor: "Anthropic",
            kind: "subscription",
            supportsTools: true,
            enabled: true,
            ...(await fakeAdapter.detect()),
          },
        ],
      }),
});
const desktopAddress = await desktop.listen(0);
const desktopUrl = `http://127.0.0.1:${desktopAddress.port}`;

const profile = await mkdtemp(join(tmpdir(), "arjunah-desktop-chrome-"));
const testExtension = await mockProviderExtension("http://127.0.0.1:9/v1");
let browser;
const errors = [];
try {
  browser = await puppeteer.launch({
    headless: process.env.ARJUNAH_E2E_HEADFUL ? false : true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
    userDataDir: profile,
    protocolTimeout: 30000,
    args: [
      `--disable-extensions-except=${testExtension.directory}`,
      `--load-extension=${testExtension.directory}`,
    ],
  });
  const workerTarget = await browser.waitForTarget(
    (target) =>
      target.type() === "service_worker" &&
      target.url().startsWith("chrome-extension://"),
    { timeout: 15000 },
  );
  const extensionId = new URL(workerTarget.url()).host;
  const worker = await workerTarget.worker();
  worker?.on("console", (message) => {
    if (message.type() === "error") errors.push(`worker: ${message.text()}`);
  });

  const settings = await browser.newPage();
  settings.on("pageerror", (error) =>
    errors.push(`settings: ${error.message}`),
  );
  await settings.goto(`chrome-extension://${extensionId}/options.html`);
  await settings.waitForFunction(() =>
    /Desktop app v|not detected/.test(
      document.querySelector("#desktop-state").textContent,
    ),
  );
  assert.match(
    await settings.$eval("#desktop-state", (el) => el.textContent),
    /Enter its pairing code|not detected/,
  );

  // Pair with a wrong code first, then the real one.
  step("pair");
  await settings.$eval(
    "#desktop-url",
    (el, url) => (el.value = url),
    desktopUrl,
  );
  await settings.type("#desktop-code", "000000");
  await settings.click("#pair");
  await settings.waitForFunction(() =>
    /Incorrect pairing code/.test(
      document.querySelector("#desktop-state").textContent,
    ),
  );
  await new Promise((wait) => setTimeout(wait, 1100));
  assert.match(
    await settings.$eval("#desktop-state", (el) => el.textContent),
    /Incorrect pairing code/,
    "a concurrent status refresh does not replace the pairing result",
  );
  assert.equal(
    await settings.$eval("#desktop-url", (el) => el.value),
    desktopUrl,
    "status refreshes preserve a custom desktop address before pairing",
  );
  await settings.$eval("#desktop-code", (el) => (el.value = ""));
  await settings.type("#desktop-code", desktop.pairing.current().code);
  await settings.click("#pair");
  await settings.waitForFunction(
    () =>
      /Connected to/.test(document.querySelector("#desktop-state").textContent),
    { timeout: 15000 },
  );
  assert.equal(desktop.store.listClients().length, 1);

  // The desktop provider appears with its account label and can be selected.
  step("providers");
  await settings.waitForFunction(
    () => document.querySelectorAll("#providers .provider").length >= 2,
  );
  const providerText = await settings.$eval(
    "#providers",
    (el) => el.textContent,
  );
  assert.match(providerText, new RegExp(`${liveName} · `));
  if (!live) assert.match(providerText, /fake@example.test/);
  // Select the model and press Use inside the page so periodic re-renders cannot detach handles.
  await settings.evaluate(
    (name, pickLast) => {
      const card = [...document.querySelectorAll("#providers .provider")].find(
        (item) => item.textContent.includes(name),
      );
      // The model control is a typable combobox (SPEC 8.2), which draws its
      // rows only while open and closes again once one is picked.
      const combo = card.querySelector(".combo");
      combo
        .querySelector(".combo-input")
        .dispatchEvent(new Event("click", { bubbles: true }));
      const rows = [...combo.querySelectorAll(".combo-option")];
      rows[pickLast ? rows.length - 1 : 0].dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true }),
      );
      card.querySelector(".controls > .btn").click();
    },
    liveName,
    !live,
  );
  await settings.waitForFunction(
    (name) =>
      new RegExp(`Websites now use ${name} on this computer`).test(
        document.querySelector("#active-status").textContent,
      ),
    {},
    liveName,
  );
  await shot(settings, "options-provider-selected");
  const storage = await settings.evaluate(() =>
    chrome.storage.local.get(["desktop", "active", "provider"]),
  );
  assert.equal(storage.active.type, "desktop");
  assert.equal(storage.active.providerId, liveId);
  assert.equal(typeof storage.desktop.token, "string");
  assert.deepEqual(
    desktop.store.sync.config.active,
    storage.active,
    "selection synced to the desktop app",
  );

  // A website sees the desktop model and generates through it after consent.
  step("site");
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  await page.goto(`http://localhost:${sitePort}/site.html`);
  await page.evaluate(() => window.ready);
  await page.evaluate(() => {
    window.__session = window.ai.arjunah.enable();
  });
  await page.waitForFunction(
    () => document.activeElement?.id === "arjunah-extension",
  );
  await page.keyboard.press("Enter");
  await page.evaluate(() => window.__session);
  const models = await page.evaluate(async () =>
    (await window.__session).models.list(),
  );
  assert.equal(models[0].provider, liveId);
  assert.equal(models[0].id.startsWith(`${liveId}/`), true);
  const direct = await page.evaluate(
    async () =>
      (
        await (
          await window.__session
        ).models.generate({
          messages: [
            { role: "user", content: "Reply with the single word PONG." },
          ],
        })
      ).message.content,
  );
  if (live) assert.match(direct, /PONG/i);
  else
    assert.equal(direct, "Desktop answer to: Reply with the single word PONG.");
  assert.equal(
    JSON.stringify(
      await page.evaluate(async () => [
        window.ai?.arjunah,
        await window.__session,
      ]),
    ).includes(storage.desktop.token),
    false,
  );

  // Hosted chat with a site tool: the agent calls the tool through the desktop bridge.
  step("hosted");
  await page.evaluate(() => window.ai.arjunah.chat.open());
  await page.keyboard.type(
    live
      ? "Call the echo tool with value from-desktop-agent and repeat exactly what it echoed."
      : "Please use the echo tool",
  );
  await page.keyboard.press("Enter");
  await new Promise((wait) => setTimeout(wait, 300));
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.toolCalls === 1, {
    timeout: live ? 170000 : 20000,
  });
  await waitFor(
    () => desktop.activity.filter((item) => item.kind === "answer").length >= 2,
    live ? 170000 : 20000,
  );
  await new Promise((wait) => setTimeout(wait, 500));
  await shot(page, "site-hosted-chat");
  const consentText = await settings.evaluate(
    async () => (await chrome.storage.local.get("grants")).grants,
  );
  assert.ok(
    consentText[`http://localhost:${sitePort}`].capabilities.includes(
      "tools.site",
    ),
  );
  if (!live) {
    assert.equal(agentRuns.length, 2);
    assert.equal(agentRuns[1].mcp != null, true);
    assert.match(
      agentRuns[1].systemPrompt,
      /user-controlled browser AI broker/,
    );
  }

  // Settings show both diagnostic logs, so a slow run can be explained.
  step("logs");
  await settings.bringToFront();
  await settings.evaluate(() => document.querySelector("#log-refresh").click());
  await settings.waitForFunction(() =>
    /turn:/.test(document.querySelector("#log-view").textContent),
  );
  assert.match(
    await settings.$eval("#log-view", (el) => el.textContent),
    new RegExp(`round 0 → ${liveId}/`),
    "the extension log names the provider each round used",
  );
  await settings.evaluate(() =>
    document.querySelector("#log-tab-desktop").click(),
  );
  await settings.waitForFunction(() =>
    /Starting /.test(document.querySelector("#log-view").textContent),
  );
  const desktopLog = await settings.$eval("#log-view", (el) => el.textContent);
  assert.match(
    desktopLog,
    new RegExp(`Starting ${liveName}`),
    "the desktop log explains what the run is doing",
  );
  // Detection happened once at startup. A turn must not re-interrogate the
  // CLI: neither the first-run phase nor a slow-resolve note may appear here.
  assert.doesNotMatch(
    desktopLog,
    /provider resolved in \d+ms|Looking for /,
    "a turn against an already-detected provider does not re-detect it",
  );
  assert.ok(
    !desktopLog.includes("Reply with the single word PONG"),
    "prompts never reach the diagnostic log",
  );
  await shot(settings, "options-logs");

  // The popup shows the active provider (it hosts no chat of its own).
  step("popup");
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForFunction(
    (name) =>
      new RegExp(`Sites you approve use ${name} on this computer`).test(
        document.querySelector("#provider-label")?.textContent ?? "",
      ),
    {},
    liveName,
  );
  await shot(popup, "popup");

  // Revoking the pairing on the desktop makes the browser report it.
  step("revoke");
  await popup.close();
  desktop.store.revokeClient(desktop.store.listClients()[0].id);
  await settings.bringToFront();
  await settings.evaluate(() =>
    document.querySelector("#refresh-desktop").click(),
  );
  await settings.waitForFunction(
    () =>
      /no longer accepts this pairing/.test(
        document.querySelector("#desktop-state").textContent,
      ),
    { timeout: 15000 },
  );

  assert.deepEqual(errors, []);
  console.log(
    `Desktop E2E passed with extension ${extensionId} against ${live ?? "a fake"} desktop agent${live ? "" : ` (${agentRuns.length} agent runs)`}.`,
  );
} catch (error) {
  if (shots && browser)
    for (const [index, page] of (await browser.pages()).entries()) {
      try {
        await page.screenshot({
          path: join(shots, `failure-${index}.png`),
          fullPage: true,
        });
        console.error(`failure page ${index}: ${page.url()}`);
        console.error(
          await page
            .evaluate(() =>
              ["#desktop-state", "#active-status", "#providers"]
                .map(
                  (id) =>
                    `${id}: ${document.querySelector(id)?.textContent?.slice(0, 400)}`,
                )
                .join("\n"),
            )
            .catch(() => ""),
        );
      } catch {
        /* page gone */
      }
    }
  throw error;
} finally {
  if (browser) await browser.close();
  await desktop.close();
  await new Promise((done) => site.close(done));
  await rm(profile, { recursive: true, force: true });
  await rm(storeDirectory, { recursive: true, force: true });
  await testExtension.cleanup();
}

async function waitFor(check, timeout) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for the desktop app.");
    await new Promise((wait) => setTimeout(wait, 50));
  }
}
