/**
 * Wallet-mode end-to-end for SPEC section 15: the hosted external loop (modes
 * 2 and 3, a page-registered `loop.fetch` backed by an in-page fake loop),
 * the site's own models answering a mode 1 assistant with no provider
 * configured (15.2), a mode 1 `requiresApproval` tool the visitor denies
 * (7.8), and provider-state continuity (5.4) between a loop's own rounds,
 * kept in the extension's IndexedDB, reported and cleared by the settings
 * page (11.2). Everything runs in a real browser with the real extension and
 * a mock provider.
 *
 * `node tests/e2e/hosted-loop.mjs` runs Chrome (Puppeteer); `--firefox` runs
 * the same scenarios in Firefox over the WebDriver harness of firefox.mjs.
 * Only the browser plumbing differs: Firefox's WebDriver refuses scripts in
 * extension pages, so its settings steps work the options page's own
 * controls, and it reads the closed panel through WebDriver's shadow-root
 * access instead of CDP.
 */
import { mockProviderExtension } from "../helpers/browser-extension.mjs";
import { launchFirefox, waitForExtensionOptions } from "../helpers/firefox.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer";
import { By, Key } from "selenium-webdriver";

const FIREFOX = process.argv.includes("--firefox");
const BROWSER = FIREFOX ? "Firefox" : "Chrome";
// Gemini's signature on a function call, which the visitor's next round must
// carry back (SPEC 5.4); the page never sees it.
const GEMINI_SIGNATURE = "CiQBloop-state-signature==";

const READY = `const installed = window.ai?.arjunah
  ? Promise.resolve()
  : new Promise((done) => window.addEventListener("arjunah:ready", () => done(), { once: true }));`;

// Modes 2 and 3: the page answers the section 14.4 routes itself and runs a
// scripted loop: model.client (streamed), tool.client, approval.client, then
// the assistant message built from the visitor model's answer.
const LOOP_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Loop desk</title></head>
<body><script>
${READY}
const composer = new URLSearchParams(location.search).get("composer") || "server";
window.loopLog = [];
window.toolRuns = 0;
window.stateTurns = 0;
const waiting = new Map();
const answered = new Map();
function answer(route, body) {
  const key = route + ":" + body.id;
  if (body.delta) return;
  answered.set(key, body);
  waiting.get(key)?.(body);
}
function waitFor(route, id) {
  const key = route + ":" + id;
  if (answered.has(key)) return Promise.resolve(answered.get(key));
  return new Promise((done) => waiting.set(key, done));
}
const encoder = new TextEncoder();
async function runTurn(controller, threadId, body) {
  const send = (type, data) =>
    controller.enqueue(encoder.encode("event: " + type + "\\ndata: " + JSON.stringify(data) + "\\n\\n"));
  const text = typeof body.content === "string" ? body.content : "";
  if (text.startsWith("state ")) {
    // SPEC 5.4 through the loop: round 1 asks for a tool; round 2 waits until
    // the test lets it go, and names the conversation round 1 was answered
    // under, as a server that stored it with its thread would.
    const n = ++window.stateTurns;
    send("turn.start", { turnId: "turn-state-" + n, threadId });
    const tools = [{
      name: "get_weather",
      description: "Weather for a city.",
      inputSchema: { type: "object", properties: { city: { type: "string" } }, additionalProperties: false },
    }];
    const ask = [{ role: "system", content: "LOOP state" }, { role: "user", content: text }];
    send("model.client", { id: "s1-" + n, request: { messages: ask, tools } });
    const first = await waitFor("model-results", "s1-" + n);
    window.stateFirst = first;
    await new Promise((done) => { window.continueState = done; });
    const calls = first.result?.message?.toolCalls ?? [];
    send("model.client", {
      id: "s2-" + n,
      ...(first.conversation ? { conversation: first.conversation } : {}),
      request: {
        tools,
        messages: [
          ...ask,
          {
            role: "assistant",
            content: first.result?.message?.content ?? "",
            toolCalls: calls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
            })),
          },
          ...calls.map((call) => ({ role: "tool", toolCallId: call.id, content: '{"tempC":21}' })),
        ],
      },
    });
    const second = await waitFor("model-results", "s2-" + n);
    window.stateSecond = second;
    send("message", {
      entry: {
        type: "message",
        id: "e-state-" + n,
        role: "assistant",
        content: "State says: " + (second.result?.message?.content ?? second.error?.code) + " / " + (second.result?.providerState ?? "no result"),
        createdAt: new Date().toISOString(),
      },
    });
    send("turn.end", { turnId: "turn-state-" + n });
    controller.close();
    return;
  }
  send("turn.start", { turnId: "turn-1", threadId });
  if (text === "slow please") {
    // A round the visitor revokes while it runs: the loop learns of it as a
    // section 9 error on model-results and ends the turn itself.
    send("model.client", {
      id: "m-slow",
      request: { messages: [{ role: "system", content: "LOOP slow" }, { role: "user", content: text }] },
    });
    const slow = await waitFor("model-results", "m-slow");
    send("error", { code: slow.error?.code ?? "INTERNAL_ERROR", message: "The visitor's model stopped: " + (slow.error?.code ?? "no error") });
    controller.close();
    return;
  }
  send("model.client", {
    id: "m1",
    stream: true,
    request: {
      messages: [
        { role: "system", content: "LOOP system prompt" },
        { role: "user", content: text },
      ],
    },
  });
  const first = await waitFor("model-results", "m1");
  send("tool.start", { id: "c1", name: "page_info", source: "site", arguments: "{}" });
  send("tool.client", { id: "c1", name: "page_info", arguments: {} });
  const tool = await waitFor("tool-results", "c1");
  send("tool.end", { id: "c1", name: "page_info", ok: !tool.result?.isError, result: JSON.stringify(tool.result) });
  send("approval.client", {
    id: "a1",
    toolId: "c1",
    approval: { title: "Book the trip", summary: "The loop wants to book Lisbon.", detail: "{\\n  \\"city\\": \\"Lisbon\\"\\n}" },
  });
  const approval = await waitFor("approvals", "a1");
  send("message", {
    entry: {
      type: "message",
      id: "e1",
      role: "assistant",
      content: "Loop says: " + (first.result?.message?.content ?? first.error?.code) + " / approved " + approval.approved,
      createdAt: new Date().toISOString(),
    },
  });
  send("turn.end", { turnId: "turn-1" });
  controller.close();
}
window.ready = installed.then(() => window.ai.arjunah.site.register({
  name: "Loop desk",
  description: "A site whose " + composer + " runs the conversation.",
  tools: [{
    name: "page_info",
    description: "Read the page title",
    inputSchema: { type: "object", additionalProperties: false },
    handler() { window.toolRuns++; return { title: document.title }; },
  }],
  // Mode 3 also owns its threads: the panel drives the loop's thread routes.
  ...(composer === "webapp" ? { threads: true } : {}),
  loop: {
    composer,
    async fetch(path, init) {
      const body = init.body ? JSON.parse(init.body) : null;
      window.loopLog.push({ path, method: init.method, body });
      const json = (value, status = 200) =>
        new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
      if (path === "threads" && init.method === "GET") return json([]);
      if (path === "threads" && init.method === "POST")
        return json({ id: "t-loop-1", title: "Trip", updatedAt: new Date().toISOString() });
      const turn = /^threads\\/([^/]+)\\/turns$/.exec(path);
      if (turn && init.method === "POST") {
        const stream = new ReadableStream({
          start(controller) { void runTurn(controller, decodeURIComponent(turn[1]), body); },
        });
        return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      const route = /\\/turns\\/[^/]+\\/(model-results|tool-results|approvals|inputs|cancel)$/.exec(path);
      if (route && body) answer(route[1], body);
      return new Response(null, { status: 204 });
    },
  },
})).then(() => true, (error) => { window.registerError = String(error?.message ?? error); return false; });
</script></body></html>`;

// Mode 1 with only the site's own models: no provider is configured.
const SITE_MODEL_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Shop</title></head>
<body><script>
${READY}
window.siteRequests = [];
window.lookups = 0;
window.ready = installed.then(() => window.ai.arjunah.site.register({
  name: "Shop",
  systemPrompt: "Help with the shop.",
  tools: [{
    name: "lookup",
    description: "Look up stock",
    inputSchema: { type: "object", additionalProperties: false },
    handler() { window.lookups++; return { stock: 7 }; },
  }],
  models: {
    list: [{ id: "shop-small", displayName: "Shop model", contextWindow: 8000 }],
    async generate(request, { signal }) {
      window.siteRequests.push(request);
      if (signal.aborted) throw new Error("aborted");
      const tool = request.messages.find((message) => message.role === "tool");
      if (!tool)
        return { message: { content: "", toolCalls: [{ id: "s1", name: "site__lookup", arguments: "{}" }] } };
      return { message: { content: "From the shop model: " + tool.content }, usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 } };
    },
  },
})).then(() => true, (error) => { window.registerError = String(error?.message ?? error); return false; });
</script></body></html>`;

// Mode 1 with a tool that asks before it runs.
const APPROVAL_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Cart</title></head>
<body><script>
${READY}
window.deleted = 0;
window.ready = installed.then(() => window.ai.arjunah.site.register({
  name: "Cart",
  systemPrompt: "Manage the cart.",
  tools: [{
    name: "delete_item",
    description: "Remove an item from the cart",
    inputSchema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"], additionalProperties: false },
    requiresApproval: true,
    handler() { window.deleted++; return { ok: true }; },
  }],
})).then(() => true, (error) => { window.registerError = String(error?.message ?? error); return false; });
</script></body></html>`;

const modelRequests = [];
const geminiRequests = [];
const sse = (response, events) => {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of events)
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
};
const server = createServer(async (request, response) => {
  const path = request.url.split("?")[0];
  const page = {
    "/loop.html": LOOP_PAGE,
    "/site-models.html": SITE_MODEL_PAGE,
    "/approval.html": APPROVAL_PAGE,
  }[path];
  if (page) {
    response.writeHead(200, { "Content-Type": "text/html" });
    return response.end(page);
  }
  // OpenCode Zen beside the OpenAI mock: one Gemini model, which keeps a
  // signature per function call (SPEC 5.4). Loop rounds always stream.
  if (path === "/zen/v1/models") {
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end(JSON.stringify({ data: [{ id: "gemini-3.1-pro" }] }));
  }
  if (path === "/zen/v1/models/gemini-3.1-pro:streamGenerateContent") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw);
    geminiRequests.push(payload);
    const continuing = payload.contents.some((content) =>
      content.parts.some((part) => part.functionResponse),
    );
    const usage = {
      promptTokenCount: 9,
      candidatesTokenCount: 3,
      totalTokenCount: 12,
    };
    return sse(
      response,
      continuing
        ? [
            {
              candidates: [
                {
                  content: { role: "model", parts: [{ text: "It is 21C." }] },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: usage,
            },
          ]
        : [
            {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [{ text: "Checking the weather.", thought: true }],
                  },
                },
              ],
            },
            {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      {
                        thoughtSignature: GEMINI_SIGNATURE,
                        functionCall: {
                          id: "g_state",
                          name: "get_weather",
                          args: { city: "Kathmandu" },
                        },
                      },
                    ],
                  },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: usage,
            },
          ],
    );
  }
  if (path === "/v1/models") {
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end(JSON.stringify({ data: [{ id: "gpt-test-model" }] }));
  }
  if (path === "/v1/chat/completions") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw);
    modelRequests.push(payload);
    // The revocation scenario's round never answers: the extension must
    // abandon it when the grant goes.
    if (payload.messages.some((item) => item.content === "LOOP slow")) return;
    const loop = payload.messages.some(
      (item) => item.role === "system" && item.content === "LOOP system prompt",
    );
    if (loop && payload.stream) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of ["Hello ", "from the ", "visitor model"])
        response.write(
          `data: ${JSON.stringify({ id: "r-loop", choices: [{ delta: { content: text } }] })}\n\n`,
        );
      response.write(
        `data: ${JSON.stringify({ id: "r-loop", choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 21, completion_tokens: 6, total_tokens: 27 } })}\n\n`,
      );
      return response.end("data: [DONE]\n\n");
    }
    const answered = payload.messages.some((item) => item.role === "tool");
    const message = loop
      ? { role: "assistant", content: "Hello from the visitor model" }
      : answered
        ? { role: "assistant", content: "Understood, nothing was removed." }
        : {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-del",
                type: "function",
                function: {
                  name: "site__delete_item",
                  arguments: '{"sku":"A-1"}',
                },
              },
            ],
          };
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end(
      JSON.stringify({
        id: "r1",
        model: "gpt-test-model",
        choices: [
          {
            message,
            finish_reason: message.tool_calls ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  }
  response.writeHead(404);
  response.end();
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
const mock = await mockProviderExtension(
  `http://127.0.0.1:${port}/v1`,
  FIREFOX,
);

const errors = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(200);
  }
}
// What the summary line of the settings page reads before its first answer.
const CHECKING = "Checking…";

/** The panel is a closed shadow root; CDP's pierced DOM reaches it. */
function shadowTools(cdp) {
  const tree = async () =>
    (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })).root;
  const walk = (root, visit) => {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (visit(node)) return node;
      for (const child of [
        ...(node.children ?? []),
        ...(node.shadowRoots ?? []),
      ])
        stack.push(child);
    }
    return null;
  };
  return {
    async text() {
      return JSON.stringify(await tree());
    },
    async button(label) {
      const node = walk(
        await tree(),
        (item) =>
          item.nodeName === "BUTTON" &&
          (item.children ?? []).some(
            (child) => child.nodeType === 3 && child.nodeValue === label,
          ),
      );
      return node?.nodeId ?? null;
    },
    async click(nodeId) {
      const { object } = await cdp.send("DOM.resolveNode", { nodeId });
      await cdp.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: "function () { this.click(); }",
      });
    },
  };
}

/**
 * Chrome over Puppeteer. Settings calls go straight to the background from
 * the options page, except the stored-state control, which is clicked.
 */
async function chromeBrowser() {
  const profile = await mkdtemp(join(tmpdir(), "arjunah-loop-profile-"));
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: profile,
    args: [
      "--no-sandbox",
      `--disable-extensions-except=${mock.directory}`,
      `--load-extension=${mock.directory}`,
    ],
  });
  const close = async () => {
    await browser.close();
    await rm(profile, { recursive: true, force: true });
  };
  try {
    const target = await browser.waitForTarget(
      (item) => item.type() === "service_worker",
      { timeout: 20000 },
    );
    const extensionId = new URL(target.url()).host;
    const settings = await browser.newPage();
    await settings.goto(`chrome-extension://${extensionId}/options.html`);
    const call = async (method, params) => {
      const reply = await settings.evaluate(
        (method, params) =>
          new Promise((done) =>
            chrome.runtime.sendMessage(
              { kind: "arjunah", method, params },
              done,
            ),
          ),
        method,
        params,
      );
      assert.equal(reply.ok, true, JSON.stringify(reply));
      return reply.result;
    };
    // The user works the settings page in front: a background tab gets no
    // frames, and a click there never lands.
    const front = async () => {
      await settings.bringToFront();
    };
    return {
      close,
      async saveOpenAI() {
        await call("provider.save", {
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-test-model",
          apiKey: "e2e-secret",
        });
      },
      async saveZen() {
        return (
          await call("opencode.save", {
            baseUrl: "https://opencode.ai/zen/v1",
            apiKey: "zen-e2e-secret",
          })
        ).models;
      },
      async useDefault(model) {
        await call("catalog.default", { model });
      },
      async storedSummary(pattern) {
        await front();
        await settings.reload();
        await settings.waitForFunction(
          (source) =>
            new RegExp(source).test(
              document.querySelector("#stored-state-summary")?.textContent ??
                "",
            ),
          { polling: 100 },
          pattern.source,
        );
        return settings.$eval(
          "#stored-state-summary",
          (node) => node.textContent,
        );
      },
      async clearStoredState() {
        await front();
        await settings.click("#clear-state");
        await settings.waitForFunction(
          () => !document.querySelector("#clear-state-confirm").hidden,
          { polling: 100 },
        );
        await settings.click("#clear-state-yes");
        await settings.waitForFunction(
          () =>
            /^Cleared /.test(
              document.querySelector("#state-status")?.textContent ?? "",
            ),
          { polling: 100 },
        );
        return settings.$eval("#state-status", (node) => node.textContent);
      },
      async openSite(url) {
        const page = await browser.newPage();
        page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
        page.on("console", (message) => {
          if (message.type() === "error" && !message.text().includes("404"))
            errors.push(`console: ${message.text()}`);
        });
        await page.goto(url);
        const evaluate = (expression) => page.evaluate(expression);
        const registered = await evaluate("window.ready");
        assert.equal(
          registered,
          true,
          `registration failed: ${await evaluate("window.registerError")}`,
        );
        await evaluate("window.ai.arjunah.chat.open()");
        await sleep(400);
        const cdp = await page.createCDPSession();
        const dom = shadowTools(cdp);
        return {
          evaluate,
          type: (text) => page.keyboard.type(text),
          enter: () => page.keyboard.press("Enter"),
          text: () => dom.text(),
          // Each pierced read renumbers the nodes, so the button is looked
          // up right before it is clicked.
          async click(label) {
            await dom.click(await dom.button(label));
          },
          async focus() {
            await page.bringToFront();
            await evaluate("window.ai.arjunah.chat.open()");
            await sleep(300);
          },
          async close() {
            await cdp.detach();
            await page.close();
          },
        };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Firefox over the WebDriver harness of firefox.mjs. Its WebDriver will not
 * run a script in an extension page ("not supported for privileged browsing
 * contexts"), so every settings step works the options page's own controls.
 */
async function firefoxBrowser() {
  const { driver } = await launchFirefox(mock.addonPath);
  const close = () => driver.quit();
  try {
    const settingsHandle = await waitForExtensionOptions(driver);
    const toSettings = () => driver.switchTo().window(settingsHandle);
    const text = async (id) =>
      driver.findElement(By.id(id)).getProperty("textContent");
    const waitText = (id, pattern, label) =>
      until(async () => pattern.test(await text(id)), label, 20000);
    return {
      close,
      async saveOpenAI() {
        await toSettings();
        // The model field is a typable combobox; Tab commits what was typed.
        const modelBox = await driver.findElement(
          By.css("#model .combo-input"),
        );
        await modelBox.clear();
        await modelBox.sendKeys("gpt-test-model", Key.TAB);
        await driver.findElement(By.id("api-key")).sendKeys("e2e-secret");
        await driver
          .findElement(By.css("#provider-form button[type=submit]"))
          .click();
        await waitText("provider-status", /OpenAI key saved/, "the OpenAI key");
      },
      async saveZen() {
        await toSettings();
        await driver
          .findElement(By.id("opencode-api-key"))
          .sendKeys("zen-e2e-secret");
        await driver
          .findElement(By.css("#opencode-form button[type=submit]"))
          .click();
        await waitText("opencode-status", /^Saved\./, "the Zen key");
        const meta = await driver
          .findElement(
            By.xpath(
              "//div[contains(concat(' ',normalize-space(@class),' '),' provider ')][.//strong[text()='OpenCode Zen API key']]//div[contains(@class,'meta')]",
            ),
          )
          .getProperty("textContent");
        return /(\d+) models?$/.exec(meta)?.[1] === "1"
          ? ["gemini-3.1-pro"]
          : meta;
      },
      async useDefault(model) {
        assert.equal(model, "opencode-api/gemini-3.1-pro");
        await toSettings();
        // Zen's only model is selected on its card; this makes it the
        // default. The cards redraw on every state change, so the button is
        // found again on each try.
        await until(
          async () => {
            try {
              const use = await driver.findElement(
                By.xpath(
                  "//div[contains(concat(' ',normalize-space(@class),' '),' provider ')][.//strong[text()='OpenCode Zen API key']]//button[normalize-space(text())='Use as default']",
                ),
              );
              if (!(await use.isEnabled())) return false;
              await use.click();
              return true;
            } catch {
              return false;
            }
          },
          "the Zen card's default button",
          20000,
        );
        await waitText("active-status", /^Websites now use/, "the new default");
      },
      // Extension pages cannot be reloaded over WebDriver, so this relies on
      // the options page reading the state again when its tab comes back.
      async storedSummary(pattern) {
        await toSettings();
        await until(
          async () =>
            pattern.test(
              await text("stored-state-summary").catch(() => CHECKING),
            ),
          `a stored-state summary matching ${pattern}`,
          20000,
        );
        return text("stored-state-summary");
      },
      async clearStoredState() {
        await toSettings();
        await driver.findElement(By.id("clear-state")).click();
        // isDisplayed() is a script, which an extension page refuses.
        await until(
          async () =>
            (await driver
              .findElement(By.id("clear-state-confirm"))
              .getProperty("hidden")) === false,
          "the confirmation",
          10000,
        );
        await driver.findElement(By.id("clear-state-yes")).click();
        await waitText("state-status", /^Cleared /, "the clear to finish");
        return text("state-status");
      },
      async openSite(url) {
        await driver.switchTo().newWindow("tab");
        const handle = await driver.getWindowHandle();
        await driver.get(url);
        const evaluate = async (expression) => {
          await driver.switchTo().window(handle);
          const reply = await driver.executeAsyncScript(
            `const done = arguments[arguments.length - 1];
             Promise.resolve(${expression}).then(
               (value) => done({ ok: true, value: value ?? null }),
               (error) => done({ ok: false, error: String(error?.message ?? error) }),
             );`,
          );
          if (!reply.ok) throw new Error(reply.error);
          return reply.value;
        };
        const registered = await evaluate("window.ready");
        assert.equal(
          registered,
          true,
          `registration failed: ${await evaluate("window.registerError")}`,
        );
        await evaluate("window.ai.arjunah.chat.open()");
        await sleep(400);
        const root = async () => {
          await driver.switchTo().window(handle);
          return (
            await driver.findElement(By.id("arjunah-extension"))
          ).getShadowRoot();
        };
        return {
          evaluate,
          async type(value) {
            await driver.switchTo().window(handle);
            await driver.actions().sendKeys(value).perform();
          },
          async enter() {
            await driver.switchTo().window(handle);
            await driver.actions().sendKeys(Key.ENTER).perform();
          },
          // WebDriver hands back elements of a closed root, but not the root
          // itself, so its text is read from inside through getRootNode().
          async text() {
            const [first] = await (await root()).findElements(By.css("*"));
            return first
              ? driver.executeScript(
                  "return arguments[0].getRootNode().textContent",
                  first,
                )
              : "";
          },
          async click(label) {
            for (const button of await (
              await root()
            ).findElements(By.css("button")))
              if ((await button.getProperty("textContent")).trim() === label)
                return button.click();
            throw new Error(`no ${label} button in the panel`);
          },
          async focus() {
            await evaluate("window.ai.arjunah.chat.open()");
            await sleep(300);
          },
          async close() {
            await driver.switchTo().window(handle);
            await driver.close();
            await toSettings();
          },
        };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

const browser = FIREFOX ? await firefoxBrowser() : await chromeBrowser();
const results = [];
try {
  // (b) Mode 1, the site's own models only, and no provider configured: the
  // page's generate answers, including a tool round, and consent says the
  // visitor's AI is not used.
  {
    const site = await browser.openSite(
      `http://localhost:${port}/site-models.html`,
    );
    await site.type("how many in stock?");
    await site.enter();
    await until(
      async () => /Your AI is not used/.test(await site.text()),
      "the site-model consent sheet",
    );
    const consent = await site.text();
    assert.match(consent, /This site's own model \(Shop model\) answers/);
    assert.doesNotMatch(consent, /No provider is configured yet/);
    await site.enter();
    // CDP's pierced tree is JSON, where the quotes come escaped.
    await until(
      async () =>
        /From the shop model: \{\\*"stock\\*":7\}/.test(await site.text()),
      "the site model's answer",
    );
    const requests = await site.evaluate("window.siteRequests");
    assert.equal(requests.length, 2, "one round per tool step");
    assert.deepEqual(
      requests[0].tools.map((tool) => tool.name),
      ["site__lookup"],
    );
    assert.equal(await site.evaluate("window.lookups"), 1);
    assert.equal(modelRequests.length, 0, "no provider was contacted");
    await site.close();
    results.push("site models answered without a provider (2 rounds)");
  }

  await browser.saveOpenAI();

  // (a) Modes 2 and 3 on one origin: the second composer asks again.
  for (const composer of ["server", "webapp"]) {
    const before = modelRequests.length;
    const site = await browser.openSite(
      `http://127.0.0.1:${port}/loop.html?composer=${composer}`,
    );
    await site.type("plan my trip");
    await site.enter();
    const line =
      composer === "server"
        ? /This site's server writes the prompts/
        : /This site's page writes the prompts/;
    await until(
      async () => line.test(await site.text()),
      `${composer} consent`,
    );
    const consent = await site.text();
    assert.doesNotMatch(consent, /Full site instructions/);
    assert.match(consent, /Site tool: page_info/);
    assert.match(consent, /Level 1 · Completion/);
    await site.enter();
    // The renderer's prompt names the asking origin; the page source cannot
    // contain that line.
    await until(
      async () =>
        (await site.text()).includes(`Asked by http://127.0.0.1:${port}`),
      "the loop's approval prompt",
    );
    await site.click("Approve");
    await until(
      async () =>
        /Loop says: Hello from the visitor model \/ approved true/.test(
          await site.text(),
        ),
      "the loop's message",
    );
    const log = await site.evaluate("window.loopLog");
    const turn = log.find((item) => /\/turns$/.test(item.path));
    assert.equal(turn.method, "POST");
    if (composer === "webapp") {
      // Declared threads: the panel created one on the loop's route first.
      assert.ok(
        log.some((item) => item.path === "threads" && item.method === "POST"),
      );
      assert.equal(turn.path, "threads/t-loop-1/turns");
    } else
      assert.match(
        turn.path,
        /^threads\/[A-Za-z0-9]{32}\/turns$/,
        "without thread routes the extension names the thread",
      );
    assert.equal(turn.body.bridge.model.id, "openai/gpt-test-model");
    assert.equal(turn.body.bridge.model.kind, "api-key");
    assert.deepEqual(
      turn.body.bridge.tools.map((tool) => tool.name),
      ["page_info"],
    );
    const modelPosts = log.filter((item) => /model-results$/.test(item.path));
    const final = modelPosts.find((item) => item.body.result);
    assert.ok(final, "model-results carried the result");
    assert.equal(
      final.body.result.message.content,
      "Hello from the visitor model",
    );
    assert.match(
      final.body.conversation,
      /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      "model-results carries the conversation the extension minted",
    );
    assert.ok(
      modelPosts.some((item) => item.body.delta?.type === "output.delta"),
      "stream: true posted deltas before the result",
    );
    assert.ok(
      modelPosts.indexOf(final) === modelPosts.length - 1,
      "the result came after every delta",
    );
    const toolPost = log.find((item) => /tool-results$/.test(item.path));
    assert.deepEqual(toolPost.body, {
      id: "c1",
      result: { title: "Loop desk" },
    });
    assert.equal(await site.evaluate("window.toolRuns"), 1);
    const approvalPost = log.find((item) => /approvals$/.test(item.path));
    assert.deepEqual(approvalPost.body, { id: "a1", approved: true });
    const loopRequests = modelRequests.slice(before);
    assert.equal(loopRequests.length, 1, "one provider round for the loop");
    assert.equal(loopRequests[0].messages[0].content, "LOOP system prompt");
    const panel = await site.text();
    assert.match(
      panel,
      new RegExp(
        `This conversation is run by this site's ${composer === "server" ? "server" : "page"}`,
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(log),
      /e2e-secret/,
      "the credential never reaches the loop",
    );
    await site.close();
    results.push(`mode ${composer === "server" ? 2 : 3} loop turn`);
  }

  // Revoking the site while a loop's completion runs ends that completion
  // with a section 9 error the loop receives, and nothing else.
  {
    const site = await browser.openSite(
      `http://127.0.0.1:${port}/loop.html?composer=server`,
    );
    await site.type("slow please");
    await site.enter();
    // The grant's composer is now "webapp", so the server's loop asks again.
    await until(
      async () =>
        /This site's server writes the prompts/.test(await site.text()),
      "consent after the composer changed",
    );
    await site.enter();
    await until(
      () =>
        modelRequests.some((item) =>
          item.messages.some((message) => message.content === "LOOP slow"),
        ),
      "the slow round to reach the provider",
    );
    assert.equal(await site.evaluate("window.ai.arjunah.disable()"), true);
    const failed = await until(
      () =>
        site.evaluate(
          "window.loopLog.find((item) => /model-results$/.test(item.path) && item.body.error)",
        ),
      "the loop to receive the revocation",
    );
    assert.equal(failed.body.id, "m-slow");
    assert.equal(failed.body.error.code, "PERMISSION_REQUIRED");
    await until(
      async () =>
        /The visitor's model stopped: PERMISSION_REQUIRED/.test(
          await site.text(),
        ),
      "the loop's error in the panel",
    );
    await site.close();
    results.push("revocation ended the loop's pending completion");
  }

  // (c) Mode 1: a requiresApproval tool the visitor denies is never run, and
  // the model is told so as the call's result.
  {
    const before = modelRequests.length;
    const site = await browser.openSite(
      `http://127.0.0.1:${port}/approval.html`,
    );
    await site.type("remove A-1");
    await site.enter();
    await until(
      async () =>
        /This tool asks you before it runs: delete_item/.test(
          await site.text(),
        ),
      "the approval disclosure in consent",
    );
    await site.enter();
    await until(
      async () => /Approval requested/.test(await site.text()),
      "the approval prompt",
    );
    assert.match(await site.text(), /\\*"sku\\*": \\*"A-1\\*"/);
    await site.click("Deny");
    await until(
      async () => /Understood, nothing was removed\./.test(await site.text()),
      "the final answer",
    );
    assert.equal(await site.evaluate("window.deleted"), 0);
    const rounds = modelRequests.slice(before);
    assert.equal(rounds.length, 2);
    const toolMessage = rounds[1].messages.find((item) => item.role === "tool");
    assert.match(toolMessage.content, /did not approve/);
    await site.close();
    results.push("mode 1 denied approval reached the model as a tool error");
  }

  // (d) Provider-state continuity between a loop's own rounds (SPEC 5.4) on
  // a Gemini model: round 1's signature waits in the extension's IndexedDB,
  // which the settings page reports, and goes back on round 2. A second turn
  // keeps its round-1 state too, until the settings page clears it (11.2):
  // the loop's next round then names a conversation that no longer verifies,
  // gets a new one, and nothing is reattached.
  {
    assert.deepEqual(await browser.saveZen(), ["gemini-3.1-pro"]);
    await browser.useDefault("opencode-api/gemini-3.1-pro");
    await browser.storedSummary(/^Nothing stored\.$/);
    const site = await browser.openSite(
      `http://localhost:${port}/loop.html?composer=server`,
    );
    const runRoundOne = async (text, consent) => {
      await site.focus();
      await site.type(text);
      await site.enter();
      if (consent) {
        await until(
          async () =>
            /This site's server writes the prompts/.test(await site.text()),
          "consent for the Gemini loop",
        );
        assert.match(await site.text(), /Level 1 · Completion/);
        await site.enter();
      }
      return until(
        () => site.evaluate("window.stateFirst"),
        `round 1 of "${text}"`,
      );
    };
    const finishTurn = async (n) => {
      await site.evaluate(
        "(window.stateFirst = null, window.continueState(), true)",
      );
      const second = await until(
        () => site.evaluate("window.stateSecond"),
        `round 2 of turn ${n}`,
      );
      await site.evaluate("(window.stateSecond = null, true)");
      return second;
    };

    const first = await runRoundOne("state one", true);
    assert.deepEqual(
      first.result.message.toolCalls.map((call) => call.id),
      ["g_state"],
    );
    assert.equal(first.result.providerState, "none");
    assert.equal(
      JSON.stringify(first).includes(GEMINI_SIGNATURE),
      false,
      "provider state never reaches the loop",
    );
    // Read by the settings page from the index keys of the background's
    // IndexedDB store.
    await browser.storedSummary(
      /^1 provider-state entry \(\d+ bytes\) for 1 site$/,
    );
    const second = await finishTurn(1);
    assert.equal(second.result.providerState, "reused");
    assert.equal(second.result.message.content, "It is 21C.");
    assert.equal(second.conversation, first.conversation);
    const replayed = geminiRequests
      .at(-1)
      .contents.flatMap((content) => content.parts)
      .find((part) => part.functionCall);
    assert.equal(replayed.thoughtSignature, GEMINI_SIGNATURE);
    await until(
      async () => /State says: It is 21C\. \/ reused/.test(await site.text()),
      "turn 1's message",
    );
    // The final round ended the turn and its state.
    await browser.storedSummary(/^Nothing stored\.$/);

    const again = await runRoundOne("state two", false);
    assert.equal(again.conversation, first.conversation, "one per thread");
    await browser.storedSummary(/^1 provider-state entry /);
    assert.match(
      await browser.clearStoredState(),
      /^Cleared 1 provider-state entry and 0 desktop agent threads\./,
    );
    await browser.storedSummary(/^Nothing stored\.$/);
    const after = await finishTurn(2);
    assert.equal(after.result.providerState, "none");
    assert.equal(after.result.message.content, "It is 21C.");
    assert.match(after.conversation, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    assert.notEqual(
      after.conversation,
      first.conversation,
      "the cleared conversation was replaced",
    );
    const resent = geminiRequests
      .at(-1)
      .contents.flatMap((content) => content.parts)
      .find((part) => part.functionCall);
    assert.equal(resent.thoughtSignature, undefined);
    await until(
      async () => /State says: It is 21C\. \/ none/.test(await site.text()),
      "turn 2's message",
    );
    assert.equal(geminiRequests.length, 4);
    await site.close();
    results.push(
      "loop rounds reused IndexedDB provider state; clearing it in settings replaced the conversation",
    );
  }

  assert.deepEqual(errors, []);
  console.log(`Hosted loop E2E (${BROWSER}) passed: ${results.join("; ")}.`);
} finally {
  await browser.close();
  await mock.cleanup();
  server.closeAllConnections();
  server.close();
}
