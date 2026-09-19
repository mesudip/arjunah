import { mockProviderExtension } from "../helpers/browser-extension.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer";

let heldResponse,
  holdNext = false;
const requests = [];
const server = createServer(async (req, res) => {
  if (req.url === "/v1/chat/completions") {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    if (holdNext) {
      holdNext = false;
      heldResponse = res;
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "done" } }] }));
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html",
    ...(req.url === "/csp"
      ? { "Content-Security-Policy": "script-src 'none'" }
      : {}),
  });
  res.end(
    '<!doctype html><title>Security regression</title><body>Test page<textarea>FORM_DEFAULT_SECRET</textarea><input value="INPUT_SECRET"></body>',
  );
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const port = server.address().port;
const profile = await mkdtemp(join(tmpdir(), "arjunah-security-"));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error("Security regression timed out.");
}
const testExtension = await mockProviderExtension(
  `http://127.0.0.1:${port}/v1`,
);
let browser;
try {
  browser = await puppeteer.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
    userDataDir: profile,
    args: [
      `--disable-extensions-except=${testExtension.directory}`,
      `--load-extension=${testExtension.directory}`,
    ],
  });
  const worker = await browser.waitForTarget(
    (target) => target.type() === "service_worker",
  );
  const extensionId = new URL(worker.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${extensionId}/options.html`);
  const extensionCall = (method, params = {}) =>
    settings.evaluate(
      (message) =>
        new Promise((r) =>
          chrome.runtime.sendMessage({ kind: "arjunah", ...message }, r),
        ),
      { method, params },
    );
  await extensionCall("provider.save", {
    baseUrl: "https://api.openai.com/v1",
    model: "audit",
    apiKey: "DUMMY_AUDIT_KEY",
  });
  await settings.reload();
  await settings.$eval(
    "#base-url",
    (el, url) => {
      el.value = url;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    `http://127.0.0.1:${port}/v1`,
  );
  assert.equal(await settings.$eval("#keep-key", (el) => el.checked), false);
  const rejected = await extensionCall("provider.save", {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "audit",
    keepApiKey: true,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "INVALID_REQUEST");
  assert.equal(
    await settings.evaluate(
      async () => (await chrome.storage.local.get("provider")).provider.apiKey,
    ),
    "DUMMY_AUDIT_KEY",
  );
  await settings.reload();

  for (const mode of ["navigation", "registration", "revocation"]) {
    await extensionCall("grants.clear");
    heldResponse = null;
    holdNext = true;
    const page = await browser.newPage();
    await page.goto(`http://localhost:${port}/${mode}`);
    await page.waitForFunction(() => Boolean(window.ai?.arjunah));
    await page.evaluate(() => {
      window.toolInvocations = 0;
      return window.ai.arjunah.site.register({
        name: "Sensitive assistant",
        systemPrompt: "x".repeat(600) + "FULL_PROMPT_TAIL",
        tools: [
          {
            name: "echo",
            description: "Inspect sensitive site data",
            handler: () => {
              window.toolInvocations++;
              return { secret: "PRIVATE_TOOL_DATA" };
            },
          },
        ],
      });
    });
    await page.evaluate(() => window.ai.arjunah.chat.open());
    await page.keyboard.type("invoke echo");
    await page.keyboard.press("Enter");
    await pause(200);
    const cdp = await page.createCDPSession();
    const dom = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const text = JSON.stringify(dom);
    assert.match(text, /FULL_PROMPT_TAIL/);
    assert.match(text, /Inspect sensitive site data/);
    assert.match(text, /Permissions after approval/);
    await cdp.detach();
    await page.keyboard.press("Enter");
    await wait(() => Boolean(heldResponse));
    const before = requests.length;
    if (mode === "navigation") {
      await page.goto(`http://127.0.0.1:${port}/new`);
      await page.waitForFunction(() => Boolean(window.ai?.arjunah));
      assert.equal(
        await page.evaluate(() => window.ai.arjunah.isEnabled()),
        false,
      );
    }
    if (mode === "navigation" || mode === "registration") {
      await page.evaluate(() => {
        window.toolInvocations = 0;
        return window.ai.arjunah.site.register({
          name: "Replacement",
          tools: [
            {
              name: "echo",
              handler: () => {
                window.toolInvocations++;
                return { secret: "NEW_PRIVATE_DATA" };
              },
            },
          ],
        });
      });
    } else await page.evaluate(() => window.ai.arjunah.disable());
    heldResponse.writeHead(200, { "Content-Type": "application/json" });
    heldResponse.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "late",
                  type: "function",
                  function: { name: "site__echo", arguments: "{}" },
                },
              ],
            },
          },
        ],
      }),
    );
    await pause(750);
    assert.equal(
      await page.evaluate(() => window.toolInvocations),
      0,
      `${mode} must prevent tool execution`,
    );
    assert.equal(
      requests.length,
      before,
      `${mode} must prevent another model request`,
    );
    await page.close();
  }
  const page = await browser.newPage();
  await page.goto(`http://localhost:${port}/csp`);
  await page.waitForFunction(() => Boolean(window.ai?.arjunah));
  assert.equal(
    await page.evaluate(() =>
      document.body.innerText.includes("FORM_DEFAULT_SECRET"),
    ),
    false,
  );
  console.log(
    "Chrome security E2E passed: full disclosure, provider key isolation, navigation, replacement, revocation, and strict CSP.",
  );
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(profile, { recursive: true, force: true });
  await testExtension.cleanup();
}
