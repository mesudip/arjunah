/**
 * Wallet-mode end-to-end for SPEC section 15: the hosted external loop (modes
 * 2 and 3, a page-registered `loop.fetch` backed by an in-page fake loop),
 * the site's own models answering a mode 1 assistant with no provider
 * configured (15.2), and a mode 1 `requiresApproval` tool the visitor denies
 * (7.8). Everything runs in a real browser with the real extension and a
 * mock provider.
 */
import { mockProviderExtension } from "../helpers/browser-extension.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer";

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
const mock = await mockProviderExtension(`http://127.0.0.1:${port}/v1`);
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

async function openSite(url) {
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("404"))
      errors.push(`console: ${message.text()}`);
  });
  await page.goto(url);
  const registered = await page.evaluate(() => window.ready);
  assert.equal(
    registered,
    true,
    `registration failed: ${await page.evaluate(() => window.registerError)}`,
  );
  await page.evaluate(() => window.ai.arjunah.chat.open());
  await sleep(400);
  const cdp = await page.createCDPSession();
  return { page, cdp, dom: shadowTools(cdp) };
}

const results = [];
try {
  const target = await browser.waitForTarget(
    (item) => item.type() === "service_worker",
    { timeout: 20000 },
  );
  const extensionId = new URL(target.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${extensionId}/options.html`);

  // (b) Mode 1, the site's own models only, and no provider configured: the
  // page's generate answers, including a tool round, and consent says the
  // visitor's AI is not used.
  {
    const { page, cdp, dom } = await openSite(
      `http://localhost:${port}/site-models.html`,
    );
    await page.keyboard.type("how many in stock?");
    await page.keyboard.press("Enter");
    await until(
      async () => /Your AI is not used/.test(await dom.text()),
      "the site-model consent sheet",
    );
    const consent = await dom.text();
    assert.match(consent, /This site's own model \(Shop model\) answers/);
    assert.doesNotMatch(consent, /No provider is configured yet/);
    await page.keyboard.press("Enter");
    await until(
      async () =>
        /From the shop model: \{\\+"stock\\+":7\}/.test(await dom.text()),
      "the site model's answer",
    );
    const requests = await page.evaluate(() => window.siteRequests);
    assert.equal(requests.length, 2, "one round per tool step");
    assert.deepEqual(
      requests[0].tools.map((tool) => tool.name),
      ["site__lookup"],
    );
    assert.equal(await page.evaluate(() => window.lookups), 1);
    assert.equal(modelRequests.length, 0, "no provider was contacted");
    await cdp.detach();
    await page.close();
    results.push("site models answered without a provider (2 rounds)");
  }

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

  // (a) Modes 2 and 3 on one origin: the second composer asks again.
  for (const composer of ["server", "webapp"]) {
    const before = modelRequests.length;
    const { page, cdp, dom } = await openSite(
      `http://127.0.0.1:${port}/loop.html?composer=${composer}`,
    );
    await page.keyboard.type("plan my trip");
    await page.keyboard.press("Enter");
    const line =
      composer === "server"
        ? /This site's server writes the prompts/
        : /This site's page writes the prompts/;
    await until(async () => line.test(await dom.text()), `${composer} consent`);
    const consent = await dom.text();
    assert.doesNotMatch(consent, /Full site instructions/);
    assert.match(consent, /Site tool: page_info/);
    assert.match(consent, /Level 1 · Completion/);
    await page.keyboard.press("Enter");
    // The renderer's prompt names the asking origin; the page source cannot
    // contain that line. Each pierced read renumbers the nodes, so the button
    // is looked up right before it is clicked.
    await until(
      async () =>
        (await dom.text()).includes(`Asked by http://127.0.0.1:${port}`),
      "the loop's approval prompt",
    );
    await dom.click(await dom.button("Approve"));
    await until(
      async () =>
        /Loop says: Hello from the visitor model \/ approved true/.test(
          await dom.text(),
        ),
      "the loop's message",
    );
    const log = await page.evaluate(() => window.loopLog);
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
    assert.equal(await page.evaluate(() => window.toolRuns), 1);
    const approvalPost = log.find((item) => /approvals$/.test(item.path));
    assert.deepEqual(approvalPost.body, { id: "a1", approved: true });
    const loopRequests = modelRequests.slice(before);
    assert.equal(loopRequests.length, 1, "one provider round for the loop");
    assert.equal(loopRequests[0].messages[0].content, "LOOP system prompt");
    const panel = await dom.text();
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
    await cdp.detach();
    await page.close();
    results.push(`mode ${composer === "server" ? 2 : 3} loop turn`);
  }

  // Revoking the site while a loop's completion runs ends that completion
  // with a section 9 error the loop receives, and nothing else.
  {
    const { page, cdp, dom } = await openSite(
      `http://127.0.0.1:${port}/loop.html?composer=server`,
    );
    await page.keyboard.type("slow please");
    await page.keyboard.press("Enter");
    // The grant's composer is now "webapp", so the server's loop asks again.
    await until(
      async () =>
        /This site's server writes the prompts/.test(await dom.text()),
      "consent after the composer changed",
    );
    await page.keyboard.press("Enter");
    await until(
      () =>
        modelRequests.some((item) =>
          item.messages.some((message) => message.content === "LOOP slow"),
        ),
      "the slow round to reach the provider",
    );
    assert.equal(await page.evaluate(() => window.ai.arjunah.disable()), true);
    const failed = await until(
      () =>
        page.evaluate(() =>
          window.loopLog.find(
            (item) => /model-results$/.test(item.path) && item.body.error,
          ),
        ),
      "the loop to receive the revocation",
    );
    assert.equal(failed.body.id, "m-slow");
    assert.equal(failed.body.error.code, "PERMISSION_REQUIRED");
    await until(
      async () =>
        /The visitor's model stopped: PERMISSION_REQUIRED/.test(
          await dom.text(),
        ),
      "the loop's error in the panel",
    );
    await cdp.detach();
    await page.close();
    results.push("revocation ended the loop's pending completion");
  }

  // (c) Mode 1: a requiresApproval tool the visitor denies is never run, and
  // the model is told so as the call's result.
  {
    const before = modelRequests.length;
    const { page, cdp, dom } = await openSite(
      `http://127.0.0.1:${port}/approval.html`,
    );
    await page.keyboard.type("remove A-1");
    await page.keyboard.press("Enter");
    await until(
      async () =>
        /This tool asks you before it runs: delete_item/.test(await dom.text()),
      "the approval disclosure in consent",
    );
    await page.keyboard.press("Enter");
    await until(
      async () => /Approval requested/.test(await dom.text()),
      "the approval prompt",
    );
    assert.match(await dom.text(), /\\+"sku\\+": \\+"A-1\\+"/);
    await dom.click(await dom.button("Deny"));
    await until(
      async () => /Understood, nothing was removed\./.test(await dom.text()),
      "the final answer",
    );
    assert.equal(await page.evaluate(() => window.deleted), 0);
    const rounds = modelRequests.slice(before);
    assert.equal(rounds.length, 2);
    const toolMessage = rounds[1].messages.find((item) => item.role === "tool");
    assert.match(toolMessage.content, /did not approve/);
    await cdp.detach();
    await page.close();
    results.push("mode 1 denied approval reached the model as a tool error");
  }

  assert.deepEqual(errors, []);
  console.log(`Hosted loop E2E passed: ${results.join("; ")}.`);
} finally {
  await browser.close();
  await mock.cleanup();
  await rm(profile, { recursive: true, force: true });
  server.closeAllConnections();
  server.close();
}
