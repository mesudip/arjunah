/**
 * Wallet-mode end-to-end for the hosted surfaces: a transcript card returned by a
 * site tool (SPEC 7.4), `reportProgress` from that tool (7.5), and site-owned
 * threads driven through the page bridge (7.6). Everything here runs in a real
 * browser with the real extension and a mock provider.
 */
import { mockProviderExtension } from "../helpers/browser-extension.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer";

const FIXTURE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Cards and threads</title></head>
<body><script>
window.cardActions = [];
window.threadCalls = [];
const store = new Map([["saved-1", { summary: { id: "saved-1", title: "Saved trip", updatedAt: new Date().toISOString() }, entries: [
  { type: "message", id: "e1", role: "user", content: "what did we decide?", createdAt: new Date().toISOString() },
  { type: "message", id: "e2", role: "assistant", content: "Lisbon in May.", createdAt: new Date().toISOString() }
] }]]);
const card = {
  type: "card",
  id: "seatmap",
  children: [
    { type: "text", text: "One window seat is free.", style: "heading" },
    { type: "button", label: "Hold it", action: { type: "local", name: "hold", payload: { seat: "12A" } }, style: "primary" },
    { type: "button", label: "Ask about it", action: { type: "message", text: "Tell me about seat 12A" } }
  ]
};
window.registerError = null;
// The extension installs the namespace at document start, but this inline
// script may still run first, so wait for the ready event like any real site.
const installed = window.ai?.arjunah
  ? Promise.resolve()
  : new Promise((done) => window.addEventListener("arjunah:ready", () => done(), { once: true }));
window.ready = installed.then(() => window.ai.arjunah.site.register({
  name: "Seat desk",
  systemPrompt: "Help with seats.",
  tools: [{
    name: "seatmap",
    description: "Show the seat map",
    inputSchema: { type: "object", additionalProperties: false },
    outputContent: ["text", "card"],
    async handler(_args, invocation) {
      invocation.reportProgress("loading the seat map");
      await new Promise((done) => setTimeout(done, 30));
      return { kind: "content", content: [{ type: "text", text: "Seat 12A is free." }, { type: "card", card }] };
    }
  }],
  threads: {
    async list() { window.threadCalls.push("list"); return [...store.values()].map((item) => item.summary); },
    async create() {
      window.threadCalls.push("create");
      const id = "t" + (store.size + 1);
      const summary = { id, title: "New chat", updatedAt: new Date().toISOString() };
      store.set(id, { summary, entries: [] });
      return summary;
    },
    async load(id) { window.threadCalls.push("load:" + id); return store.get(id)?.entries ?? []; },
    async append(id, entries) {
      window.threadCalls.push("append:" + id + ":" + entries.length);
      store.get(id)?.entries.push(...entries);
    },
    async delete(id) { window.threadCalls.push("delete:" + id); store.delete(id); }
  },
  onCardAction(event) {
    window.cardActions.push(event);
    return { type: "card", id: "seatmap", children: [{ type: "text", text: "Seat 12A is on hold." }] };
  }
}));
window.ready = window.ready.then((r) => { window.registered = true; return true; }, (e) => { window.registerError = String(e && e.message || e); return false; });
window.storedEntries = () => (store.get("saved-1")?.entries ?? []).length;
</script></body></html>`;

const modelRequests = [];
const server = createServer(async (request, response) => {
  if (request.url === "/site.html") {
    response.writeHead(200, { "Content-Type": "text/html" });
    return response.end(FIXTURE);
  }
  if (request.url === "/v1/models") {
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end(JSON.stringify({ data: [{ id: "gpt-test-model" }] }));
  }
  if (request.url === "/v1/chat/completions") {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw);
    modelRequests.push(payload);
    const answered = payload.messages.some((item) => item.role === "tool");
    const message = answered
      ? { role: "assistant", content: "Seat 12A is yours if you want it." }
      : {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "site__seatmap", arguments: "{}" },
            },
          ],
        };
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end(
      JSON.stringify({
        id: "r1",
        model: "gpt-test-model",
        choices: [{ message, finish_reason: answered ? "stop" : "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  }
  response.writeHead(404);
  response.end();
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const port = server.address().port;
const mock = await mockProviderExtension(`http://127.0.0.1:${port}/v1`);
const profile = await mkdtemp(join(tmpdir(), "arjunah-cards-profile-"));
const browser = await puppeteer.launch({
  headless: true,
  userDataDir: profile,
  args: [
    "--no-sandbox",
    `--disable-extensions-except=${mock.directory}`,
    `--load-extension=${mock.directory}`,
  ],
});

const errors = [];
try {
  const target = await browser.waitForTarget(
    (item) => item.type() === "service_worker",
    { timeout: 20000 },
  );
  const extensionId = new URL(target.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${extensionId}/options.html`);
  const saved = await settings.evaluate(
    (config) =>
      new Promise((done) =>
        chrome.runtime.sendMessage(
          { kind: "arjunah", method: "provider.save", params: config },
          done,
        ),
      ),
    {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-test-model",
      apiKey: "e2e-secret",
    },
  );
  assert.equal(saved.ok, true, JSON.stringify(saved));

  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("console", (message) => {
    // The fixture has no favicon; only script errors matter here.
    if (message.type() === "error" && !message.text().includes("404"))
      errors.push(`console: ${message.text()}`);
  });
  await page.goto(`http://127.0.0.1:${port}/site.html`);
  const registered = await page.evaluate(() => window.ready);
  assert.equal(
    registered,
    true,
    `registration failed: ${await page.evaluate(() => window.registerError)}`,
  );

  // The panel lives in a closed shadow root, so drive it with real input.
  await page.evaluate(() => window.ai.arjunah.chat.open());
  await new Promise((done) => setTimeout(done, 400));

  // Consent, then one turn that calls the card tool.
  await page.keyboard.type("show me the seats");
  await page.keyboard.press("Enter");
  // The consent dialog focuses Allow; the panel is a closed shadow root, so the
  // test approves it the way a user does, with the keyboard.
  await new Promise((done) => setTimeout(done, 600));
  await page.keyboard.press("Enter");

  const deadline = Date.now() + 40000;
  for (;;) {
    const stored = await page.evaluate(() =>
      window.threadCalls.some((call) => call.startsWith("append:")),
    );
    if (stored) break;
    if (Date.now() > deadline)
      throw new Error(
        `the turn never completed. thread calls: ${JSON.stringify(
          await page.evaluate(() => window.threadCalls),
        )}; provider requests: ${modelRequests.length}`,
      );
    await new Promise((done) => setTimeout(done, 250));
  }

  // The site stored the turn it just had: user message, activity, answer.
  const calls = await page.evaluate(() => window.threadCalls);
  assert.ok(calls.includes("list"), `thread list was read: ${calls}`);
  assert.ok(
    calls.some((call) => call === "create"),
    `a thread was created: ${calls}`,
  );
  const append = calls.find((call) => call.startsWith("append:"));
  assert.equal(
    Number(append.split(":")[2]) >= 3,
    true,
    `the whole turn was stored: ${append}`,
  );

  // The model saw the text fallback and never the card.
  const toolMessages = modelRequests
    .flatMap((item) => item.messages)
    .filter((item) => item.role === "tool");
  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0].content, "Seat 12A is free.");
  assert.equal(
    JSON.stringify(modelRequests).includes('"type":"card"'),
    false,
    "no card reached the provider",
  );
  assert.equal(
    JSON.stringify(modelRequests).includes("loading the seat map"),
    false,
    "no progress line reached the provider",
  );

  // The card rendered inside the closed shadow root; reach it the way the
  // existing suites do, through the pierced DOM, and press its local action.
  const cdp = await page.createCDPSession();
  const findByText = async (text) => {
    const { root } = await cdp.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      for (const child of [
        ...(node.children ?? []),
        ...(node.shadowRoots ?? []),
        ...(node.contentDocument ? [node.contentDocument] : []),
      ])
        stack.push(child);
      if (
        node.nodeName === "BUTTON" &&
        (node.children ?? []).some(
          (child) => child.nodeType === 3 && child.nodeValue === text,
        )
      )
        return node.nodeId;
    }
    return null;
  };
  const cardText = async () => {
    const { root } = await cdp.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    return JSON.stringify(root);
  };
  assert.match(await cardText(), /One window seat is free\./);
  const holdButton = await findByText("Hold it");
  assert.ok(holdButton, "the card's local action button rendered");
  const { object } = await cdp.send("DOM.resolveNode", { nodeId: holdButton });
  await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: "function () { this.click(); }",
  });
  const cardDeadline = Date.now() + 15000;
  for (;;) {
    if ((await page.evaluate(() => window.cardActions.length)) > 0) break;
    if (Date.now() > cardDeadline)
      throw new Error("the card's local action never reached the page");
    await new Promise((done) => setTimeout(done, 200));
  }
  assert.deepEqual(await page.evaluate(() => window.cardActions[0]), {
    cardId: "seatmap",
    name: "hold",
    payload: { seat: "12A" },
    values: null,
  });
  // The replacement card the page returned was validated and swapped in place.
  const swapDeadline = Date.now() + 15000;
  for (;;) {
    if (/Seat 12A is on hold\./.test(await cardText())) break;
    if (Date.now() > swapDeadline)
      throw new Error("the card was not replaced in place");
    await new Promise((done) => setTimeout(done, 200));
  }
  // A local action is not a model message: no new provider request happened.
  assert.equal(modelRequests.length, 2);
  await cdp.detach();

  assert.deepEqual(errors, []);
  console.log(
    `Hosted surfaces E2E passed with ${modelRequests.length} provider requests and thread calls ${calls.join(", ")}.`,
  );
} finally {
  await browser.close();
  await mock.cleanup();
  await rm(profile, { recursive: true, force: true });
  server.close();
}
