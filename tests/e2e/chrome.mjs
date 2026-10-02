import { mockProviderExtension } from "../helpers/browser-extension.mjs";
import { approveConsent, denyConsent } from "../helpers/consent.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer";

const fixture = await readFile(resolve("tests/fixtures/site.html"));
const widgetFixture = await readFile(
  resolve("tests/fixtures/widget-extension.html"),
);
const modelRequests = [];
const zenRequests = [];
// Provider state a Responses round leaves for its continuation (SPEC 5.4).
const ZEN_REASONING = {
  type: "reasoning",
  id: "rs_zen_1",
  summary: [{ type: "summary_text", text: "Use the weather tool." }],
  encrypted_content: "gAAAAABe2e-encrypted-reasoning-blob==",
};
const mcpMethods = [];
// Requests the mock holds open until the browser gives up on them.
const held = [];
// Streamed rounds the mock holds open after their first delta.
const heldStreams = [];
// The loop behind the bridged widget page: one turn whose single round is
// relayed with `stream: true`, and every `model-results` body it was posted.
const widgetRelay = { threads: [], posts: [] };
async function widgetBridgeApi(request, response, route) {
  const json = (value, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(value === null ? "" : JSON.stringify(value));
  };
  let text = "";
  for await (const chunk of request) text += chunk;
  if (route === "threads" && request.method === "GET")
    return json(widgetRelay.threads);
  if (route === "threads" && request.method === "POST") {
    const summary = {
      id: `t${widgetRelay.threads.length + 1}`,
      title: "Streamed",
      updatedAt: new Date().toISOString(),
    };
    widgetRelay.threads.push(summary);
    return json(summary);
  }
  if (/^threads\/[^/]+$/.test(route)) return json([]);
  if (/\/model-results$/.test(route)) {
    widgetRelay.posts.push(JSON.parse(text));
    return json(null, 204);
  }
  if (/\/cancel$/.test(route)) return json(null, 204);
  const turn = route.match(/^threads\/([^/]+)\/turns$/);
  if (!turn || request.method !== "POST") return json(null, 404);
  const send = (type, data) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  send("turn.start", { turnId: "w1", threadId: turn[1] });
  send("model.client", {
    id: "m1",
    request: { messages: [{ role: "user", content: "stream this round" }] },
    stream: true,
  });
  let final;
  while (!(final = widgetRelay.posts.find((item) => item.result || item.error)))
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  send("message", {
    entry: {
      type: "message",
      id: "f1",
      role: "assistant",
      content: `${final.result?.message.content ?? final.error.code} (final)`,
      createdAt: new Date().toISOString(),
    },
  });
  send("turn.end", { turnId: "w1" });
  response.end();
}
const server = createServer(async (request, response) => {
  if (request.url.startsWith("/bridge-api/"))
    return widgetBridgeApi(request, response, request.url.slice(12));
  if (request.url === "/site.html") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(fixture);
    return;
  }
  // The published widget (built by `npm run build:widget`) in bridged mode
  // over this extension, with its loop in page JavaScript.
  if (request.url === "/widget-extension.html") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(widgetFixture);
    return;
  }
  const widgetFile = request.url.match(/^\/widget\/([a-z]+\.js)$/);
  if (widgetFile) {
    response.writeHead(200, { "Content-Type": "text/javascript" });
    response.end(
      await readFile(resolve("packages/widget/dist", widgetFile[1])),
    );
    return;
  }
  if (request.url === "/v1/models") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "gpt-test-model" }] }));
    return;
  }
  if (request.url === "/v1/chat/completions") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    modelRequests.push({
      payload,
      authorization: request.headers.authorization,
    });
    // A model that never answers, so the test can watch a page abort reach
    // this very connection.
    if (payload.messages?.[0]?.content === "hold this request open") {
      const entry = { closed: false };
      held.push(entry);
      response.on("close", () => {
        entry.closed = true;
      });
      return;
    }
    // A page's own round stream (SPEC 5.3): the same answer streamed in three
    // deltas further apart than the extension's batch window, or as one
    // fixed JSON response, so both forms must produce the same result.
    if (payload.messages?.[0]?.content === "stream this round") {
      const usage = { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 };
      const parts = ["Streamed ", "round ", "answer."];
      if (!payload.stream) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            id: "response-stream",
            choices: [
              {
                message: { role: "assistant", content: parts.join("") },
                finish_reason: "stop",
              },
            ],
            usage,
          }),
        );
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const [index, text] of parts.entries()) {
        response.write(
          `data: ${JSON.stringify({
            id: "response-stream",
            choices: [
              {
                delta: { content: text },
                finish_reason: index === parts.length - 1 ? "stop" : null,
              },
            ],
          })}\n\n`,
        );
        await new Promise((resolveWait) => setTimeout(resolveWait, 400));
      }
      response.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    if (payload.messages?.[0]?.content === "stream then hold") {
      const entry = { closed: false };
      heldStreams.push(entry);
      response.on("close", () => {
        entry.closed = true;
      });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({
          id: "response-held",
          choices: [{ delta: { content: "Partial" }, finish_reason: null }],
        })}\n\n`,
      );
      return;
    }
    const hasToolResult = payload.messages.some((item) => item.role === "tool");
    const shouldCallTool =
      Array.isArray(payload.tools) && payload.tools.length && !hasToolResult;
    const toolName = payload.tools?.[0]?.function?.name;
    const message = shouldCallTool
      ? {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: toolName,
                arguments:
                  toolName === "site__look_at_canvas"
                    ? "{}"
                    : '{"value":"from-model"}',
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: hasToolResult
            ? "Tool **round** completed.\n\n| Status | Value |\n| --- | --- |\n| Result | Ready |"
            : "Direct model response.",
        };
    if (payload.stream) {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
      });
      const deltas = shouldCallTool
        ? [
            {
              tool_calls: message.tool_calls.map((call, index) => ({
                index,
                ...call,
              })),
            },
          ]
        : [
            { content: message.content.slice(0, 12) },
            { content: message.content.slice(12) },
          ];
      for (const [index, delta] of deltas.entries()) {
        response.write(
          `data: ${JSON.stringify({
            id: `response-${modelRequests.length}`,
            choices: [
              {
                delta,
                finish_reason:
                  index === deltas.length - 1
                    ? shouldCallTool
                      ? "tool_calls"
                      : "stop"
                    : null,
              },
            ],
          })}\n\n`,
        );
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
      response.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: `response-${modelRequests.length}`,
        model: "gpt-test-model",
        choices: [
          { message, finish_reason: shouldCallTool ? "tool_calls" : "stop" },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    );
    return;
  }
  // OpenCode Zen stands beside the OpenAI mock on the same server. Each family
  // must arrive on the route its wire format requires, never on /v1.
  if (request.url === "/zen/v1/models") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        data: [
          { id: "gpt-5.6-luna" },
          { id: "claude-sonnet-4-6" },
          { id: "jev-1.13" },
        ],
      }),
    );
    return;
  }
  if (request.url === "/zen/v1/responses") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    zenRequests.push({
      path: "/responses",
      payload,
      authorization: request.headers.authorization,
    });
    // A request with tools that does not yet carry a tool result is round 1
    // of a tool turn: reasoning (encrypted, as asked) and one call.
    const toolTurn = Array.isArray(payload.tools) && payload.tools.length > 0;
    const continuing = payload.input.some(
      (item) => item.type === "function_call_output",
    );
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        toolTurn && !continuing
          ? {
              id: "zen-responses-tool",
              status: "completed",
              output: [
                ZEN_REASONING,
                {
                  type: "function_call",
                  id: "fc_zen_1",
                  call_id: "call_zen_1",
                  name: payload.tools[0].name,
                  arguments: '{"city":"Kathmandu"}',
                  status: "completed",
                },
              ],
              usage: { input_tokens: 6, output_tokens: 4, total_tokens: 10 },
            }
          : {
              id: "zen-responses-1",
              status: "completed",
              output: [
                {
                  type: "message",
                  content: [
                    {
                      type: "output_text",
                      text: toolTurn
                        ? "Zen tool answer."
                        : "Zen Responses answer.",
                    },
                  ],
                },
              ],
              usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
            },
      ),
    );
    return;
  }
  if (request.url === "/zen/v1/messages") {
    let body = "";
    for await (const chunk of request) body += chunk;
    zenRequests.push({
      path: "/messages",
      payload: JSON.parse(body),
      authorization: request.headers.authorization,
      apiKey: request.headers["x-api-key"],
      anthropicVersion: request.headers["anthropic-version"],
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: "zen-anthropic-1",
        content: [{ type: "text", text: "Zen Anthropic answer." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 3 },
      }),
    );
    return;
  }
  if (request.url === "/mcp") {
    let body = "";
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    mcpMethods.push(rpc.method);
    if (rpc.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
      return;
    }
    const result =
      rpc.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "e2e", version: "1" },
          }
        : rpc.method === "tools/list"
          ? {
              tools: [
                {
                  name: "mcp_echo",
                  description: "Echo through MCP",
                  inputSchema: { type: "object" },
                },
              ],
            }
          : { content: [{ type: "text", text: "from-mcp-server" }] };
    response.writeHead(200, {
      "Content-Type": "application/json",
      ...(rpc.method === "initialize"
        ? { "Mcp-Session-Id": "chrome-session" }
        : {}),
    });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    return;
  }
  response.writeHead(404);
  response.end("not found");
});
await new Promise((resolveReady) =>
  server.listen(0, "127.0.0.1", resolveReady),
);
const port = server.address().port;
const profile = await mkdtemp(join(tmpdir(), "arjunah-chrome-test-"));
const testExtension = await mockProviderExtension(
  `http://127.0.0.1:${port}/v1`,
);
let browser;
const errors = [];

try {
  const extensionPath = testExtension.directory;
  browser = await puppeteer.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
    userDataDir: profile,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
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
  await settings.goto(`chrome-extension://${extensionId}/options.html`);
  const saveReply = await settings.evaluate(
    (config) =>
      new Promise((resolveReply) =>
        chrome.runtime.sendMessage(
          { kind: "arjunah", method: "provider.save", params: config },
          resolveReply,
        ),
      ),
    {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-test-model",
      apiKey: "e2e-secret",
    },
  );
  assert.equal(saveReply.ok, true, JSON.stringify(saveReply));

  // The model fields are typable comboboxes, not <select>s (SPEC 8.2): the
  // catalog filters as you type and ranks what is left.
  await settings.waitForSelector("#model.combo");
  await settings.$eval("#model .combo-input", (input) => {
    input.focus();
    input.value = "sol";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const ranked = await settings.$$eval(
    "#model .combo-option span:first-child",
    (nodes) => nodes.map((node) => node.textContent),
  );
  assert.deepEqual(ranked, ["gpt-5.6-sol"], JSON.stringify(ranked));
  await settings.$eval("#model .combo-input", (input) =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    ),
  );
  assert.deepEqual(
    await settings.$eval("#model", (node) => ({
      value: node.value,
      closed: node.querySelector(".combo-list").hidden,
    })),
    { value: "gpt-5.6-sol", closed: true },
  );

  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  await page.goto(`http://localhost:${port}/site.html`);
  await page.evaluate(() => window.ready);
  assert.deepEqual(
    await page.evaluate(() => ({
      version: window.ai.arjunah.version,
      writable: Object.getOwnPropertyDescriptor(window.ai, "arjunah").writable,
      configurable: Object.getOwnPropertyDescriptor(window.ai, "arjunah")
        .configurable,
      namespaceWritable: Object.getOwnPropertyDescriptor(window, "ai").writable,
    })),
    {
      version: "1.0.0",
      writable: false,
      configurable: false,
      namespaceWritable: false,
    },
  );

  // Before any grant the root object exposes only the level 0 surface.
  assert.deepEqual(
    await page.evaluate(async () => ({
      enabled: await window.ai.arjunah.isEnabled(),
      rootMembers: Object.keys(window.ai.arjunah).sort(),
    })),
    {
      enabled: false,
      rootMembers: [
        "chat",
        "disable",
        "enable",
        "isEnabled",
        "openSettings",
        "site",
        "version",
      ],
    },
  );

  // Every grant change reaches the page as one event with three fields.
  await page.evaluate(() => {
    window.__grantChanges = [];
    window.addEventListener("arjunah:grantchange", (event) =>
      window.__grantChanges.push(event.detail),
    );
  });
  // A bare enable() asks for level 1 and resolves to the session.
  await page.evaluate(() => {
    window.__session = window.ai.arjunah.enable();
  });
  await page.waitForFunction(
    () => document.activeElement?.id === "arjunah-extension",
  );
  await approveConsent(page);
  const grant = await page.evaluate(async () => (await window.__session).grant);
  assert.equal(grant.origin, `http://localhost:${port}`);
  assert.equal(grant.level, "completion");
  assert.deepEqual(grant.capabilities, ["models.list", "models.generate"]);
  assert.equal(await page.evaluate(() => window.ai.arjunah.isEnabled()), true);
  assert.deepEqual(
    await page.evaluate(async () =>
      (await (await window.__session).models.list()).map((item) => [
        item.id,
        item.kind,
        item.local,
        item.builtinTools,
      ]),
    ),
    [["openai/gpt-test-model", "api-key", false, false]],
  );
  const direct = await page.evaluate(async () => {
    const result = await (
      await window.__session
    ).models.generate({
      messages: [{ role: "user", content: "hello" }],
    });
    return [result.message.content, result.kind, result.local];
  });
  assert.deepEqual(direct, ["Direct model response.", "api-key", false]);
  await waitForAsync(() =>
    page.evaluate(() => window.__grantChanges.length === 1),
  );
  assert.deepEqual(
    await page.evaluate(() => window.__grantChanges),
    [{ level: "completion", model: "openai/gpt-test-model", revoked: false }],
    "consent announced the new grant",
  );

  // A changed `require` asks again; with nothing that qualifies the sheet
  // says so, offers only Close, and the request is NOT_CONFIGURED.
  await page.evaluate(() => {
    window.__restricted = window.ai.arjunah
      .enable({ require: { kinds: ["subscription"] } })
      .then(
        () => "unexpected",
        (error) => error.code,
      );
  });
  await page.waitForFunction(
    () => document.activeElement?.id === "arjunah-extension",
  );
  await approveConsent(page);
  assert.equal(
    await page.evaluate(() => window.__restricted),
    "NOT_CONFIGURED",
  );
  // A constraint the saved model meets is approved and pinned.
  await page.evaluate(() => {
    window.__restricted = window.ai.arjunah
      .enable({ require: { kinds: ["api-key"], builtinTools: false } })
      .then((session) => session.grant.model);
  });
  await page.waitForFunction(
    () => document.activeElement?.id === "arjunah-extension",
  );
  await approveConsent(page);
  assert.equal(
    await page.evaluate(() => window.__restricted),
    "openai/gpt-test-model",
  );
  // The same constraint again needs no prompt.
  assert.equal(
    await page.evaluate(
      async () =>
        (
          await window.ai.arjunah.enable({
            require: { builtinTools: false, kinds: ["api-key"] },
          })
        ).grant.level,
    ),
    "completion",
  );

  // openSettings() needs a user gesture. A script the page runs on its own,
  // long after load and with no input since, is refused; a click is not.
  // Nothing drives the quiet page in the meantime, because every Puppeteer
  // evaluation counts as a gesture for the next five seconds.
  const quiet = await browser.newPage();
  await quiet.evaluateOnNewDocument(() => {
    window.__settings = new Promise((resolveLater) =>
      setTimeout(resolveLater, 5500),
    ).then(() =>
      window.ai.arjunah.openSettings().then(
        () => "opened",
        (error) => error.code,
      ),
    );
  });
  await quiet.goto(`http://localhost:${port}/site.html`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 6500));
  assert.equal(
    await quiet.evaluate(() => window.__settings),
    "PERMISSION_REQUIRED",
  );
  await quiet.close();
  const targetsBefore = new Set(browser.targets());
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "open-settings";
    button.textContent = "AI settings";
    button.addEventListener("click", () => {
      window.__settings = window.ai.arjunah.openSettings();
    });
    document.body.append(button);
  });
  await page.click("#open-settings");
  assert.equal(await page.evaluate(() => window.__settings), true);
  const opened = () =>
    browser
      .targets()
      .find(
        (target) =>
          !targetsBefore.has(target) &&
          /\/(popup|options)\.html/.test(target.url() ?? ""),
      );
  await waitFor(() => opened());
  const settingsView = opened();
  // Headless Chrome has no toolbar to anchor the popup to, so this is the
  // fallback: the settings page at the asking site's row, outlined and
  // focused. The origin in the address is the sender's.
  if (/options\.html/.test(settingsView.url())) {
    const asking = `http://localhost:${port}`;
    assert.equal(
      new URL(settingsView.url()).hash,
      `#grants:${encodeURIComponent(asking)}`,
    );
    const view = await settingsView.page();
    await view.waitForFunction(
      (origin) =>
        [...document.querySelectorAll(".grant.asked")]
          .map((row) => row.dataset.origin)
          .join() === origin &&
        document.activeElement?.dataset.origin === origin,
      { polling: 100 },
      asking,
    );
    await view.close();
  }
  await page.bringToFront();
  assert.equal(modelRequests.at(-1).authorization, "Bearer e2e-secret");
  assert.equal(
    JSON.stringify(
      await page.evaluate(async () => [
        window.ai?.arjunah,
        await window.__session,
      ]),
    ).includes("e2e-secret"),
    false,
  );

  // The model entry reports its bounds, and the bridge enforces exactly them:
  // the request one past `tools` is refused without reaching the mock, with
  // the request id and retryability in `details` (SPEC 5.2, 5.3, 9).
  const bounds = await page.evaluate(async () => {
    const session = await window.__session;
    const [entry] = await session.models.list();
    const tools = (count) =>
      Array.from({ length: count }, (_, index) => ({
        name: `tool_${index}`,
        inputSchema: { type: "object" },
      }));
    const refused = await session.models
      .generate({
        messages: [{ role: "user", content: "x" }],
        tools: tools(entry.limits.tools + 1),
      })
      .then(
        () => null,
        (error) => ({ code: error.code, details: error.details }),
      );
    return { limits: entry.limits, refused };
  });
  assert.deepEqual(bounds.limits, {
    messages: 400,
    messageUnits: 180_000,
    tools: 128,
    toolDescriptionUnits: 2_000,
    toolCallsPerMessage: 32,
    toolArgumentUnits: 65_536,
    schemaBytes: 32_768,
    schemaDepth: 16,
    requestBytes: 12_000_000,
    maxTokens: 32_768,
    timeoutMs: 180_000,
  });
  assert.equal(bounds.refused.code, "INVALID_REQUEST");
  assert.match(bounds.refused.details.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(bounds.refused.details.retryable, false);
  const sentBefore = modelRequests.length;

  // A page aborts a generate the mock is still holding: the promise rejects
  // with ABORTED at once and the provider connection itself is closed.
  await page.evaluate(async () => {
    const session = await window.__session;
    window.__abort = new AbortController();
    window.__held = session.models
      .generate(
        { messages: [{ role: "user", content: "hold this request open" }] },
        { signal: window.__abort.signal },
      )
      .then(
        () => ({ settled: "resolved" }),
        (error) => ({
          name: error.name,
          code: error.code,
          details: error.details,
        }),
      );
  });
  await waitFor(() => held.length === 1);
  assert.equal(modelRequests.length, sentBefore + 1);
  assert.equal(held[0].closed, false);
  const aborted = await page.evaluate(async () => {
    window.__abort.abort();
    return window.__held;
  });
  assert.equal(aborted.name, "AIError");
  assert.equal(aborted.code, "ABORTED");
  assert.match(aborted.details.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(aborted.details.retryable, false);
  await waitFor(() => held[0].closed);
  // The session keeps working after a cancel.
  assert.equal(
    await page.evaluate(
      async () =>
        (
          await (
            await window.__session
          ).models.generate({
            messages: [{ role: "user", content: "hello again" }],
          })
        ).message.content,
    ),
    "Direct model response.",
  );

  // The page streams a round of its own (SPEC 5.3): deltas as the provider
  // writes them, then the result a generate of the same request gives.
  const streamedRound = await page.evaluate(async () => {
    const session = await window.__session;
    const request = {
      messages: [{ role: "user", content: "stream this round" }],
    };
    const events = [];
    for await (const event of session.models.stream(request))
      events.push(event);
    return { events, generated: await session.models.generate(request) };
  });
  const roundDeltas = streamedRound.events.filter(
    (event) => event.type === "output.delta",
  );
  assert.ok(roundDeltas.length >= 2, JSON.stringify(streamedRound.events));
  assert.equal(
    roundDeltas.map((event) => event.text).join(""),
    "Streamed round answer.",
  );
  assert.equal(streamedRound.events.at(-1).type, "result");
  assert.equal(
    streamedRound.events.filter((event) => event.type === "result").length,
    1,
  );
  assert.deepEqual(streamedRound.events.at(-1).result, streamedRound.generated);
  assert.equal(
    streamedRound.generated.message.content,
    "Streamed round answer.",
  );
  assert.equal(
    modelRequests.at(-2).payload.stream,
    true,
    "the stream reached the provider as a streamed request",
  );

  // A second stream is aborted after its first delta: the loop rejects with
  // ABORTED and the provider connection is closed.
  await page.evaluate(async () => {
    const session = await window.__session;
    window.__streamAbort = new AbortController();
    window.__streamSeen = [];
    window.__streamDone = (async () => {
      try {
        for await (const event of session.models.stream(
          { messages: [{ role: "user", content: "stream then hold" }] },
          { signal: window.__streamAbort.signal },
        ))
          window.__streamSeen.push(event);
        return { settled: "finished" };
      } catch (error) {
        return { name: error.name, code: error.code, details: error.details };
      }
    })();
  });
  await waitFor(() => heldStreams.length === 1);
  await page.waitForFunction(() => window.__streamSeen.length >= 1);
  assert.equal(heldStreams[0].closed, false);
  const abortedStream = await page.evaluate(async () => {
    window.__streamAbort.abort();
    return { outcome: await window.__streamDone, seen: window.__streamSeen };
  });
  assert.deepEqual(abortedStream.seen, [
    { type: "output.delta", text: "Partial" },
  ]);
  assert.equal(abortedStream.outcome.name, "AIError");
  assert.equal(abortedStream.outcome.code, "ABORTED");
  assert.match(abortedStream.outcome.details.requestId, /^[0-9a-f-]{36}$/);
  await waitFor(() => heldStreams[0].closed);

  // The widget's bridged mode on this origin's level 1 session: its relayed
  // round runs through `conversation.stream`, so the deltas it draws and
  // posts are the extension's own, followed by the extension's result.
  const widgetPage = await browser.newPage();
  widgetPage.on("pageerror", (error) =>
    errors.push(`widget: ${error.message}`),
  );
  await widgetPage.goto(`http://localhost:${port}/widget-extension.html`, {
    waitUntil: "networkidle0",
  });
  const inWidget = (script) =>
    widgetPage.evaluate(
      (source) =>
        new Function("root", source)(
          document.querySelector("#assistant").shadowRoot,
        ),
      script,
    );
  await widgetPage.waitForFunction(() =>
    document.querySelector("#assistant")?.shadowRoot?.querySelector(".input"),
  );
  await inWidget(`root.querySelector(".input").focus();`);
  await widgetPage.keyboard.type("hello", { delay: 5 });
  await inWidget(`root.querySelector(".send:not(.stop)").click();`);
  // The widget enables access with `composer: "server"` (SPEC 15.3), and this
  // origin's level 1 grant was approved for the page itself, so the visitor
  // is asked again, with the server's wording.
  const composerCdp = await widgetPage.createCDPSession();
  const composerDeadline = Date.now() + 15000;
  for (;;) {
    const tree = JSON.stringify(
      await composerCdp.send("DOM.getDocument", { depth: -1, pierce: true }),
    );
    if (tree.includes("This site's server writes the prompts")) break;
    if (Date.now() > composerDeadline)
      throw new Error("the composer change did not ask again");
    await new Promise((done) => setTimeout(done, 200));
  }
  await composerCdp.detach();
  await approveConsent(widgetPage);
  await waitFor(() =>
    widgetRelay.posts.some((item) => item.result || item.error),
  );
  await widgetPage.waitForFunction(() =>
    [
      ...document
        .querySelector("#assistant")
        .shadowRoot.querySelectorAll(".msg.assistant"),
    ].some((node) =>
      node.textContent.includes("Streamed round answer. (final)"),
    ),
  );
  const relayed = widgetRelay.posts;
  const relayedDeltas = relayed.filter((item) => item.delta);
  assert.ok(relayedDeltas.length >= 2, JSON.stringify(relayed));
  assert.ok(relayed.at(-1).result, "the result is posted last");
  assert.ok(relayed.slice(0, -1).every((item) => item.delta));
  assert.equal(
    relayedDeltas
      .filter((item) => item.delta.type === "output.delta")
      .map((item) => item.delta.text)
      .join(""),
    "Streamed round answer.",
  );
  assert.equal(relayed.at(-1).result.message.content, "Streamed round answer.");
  assert.equal(typeof relayed.at(-1).conversation, "string");
  assert.equal(
    modelRequests.at(-1).payload.stream,
    true,
    "the relayed round reached the provider as a stream",
  );
  await widgetPage.close();

  const isolated = await browser.newPage();
  await isolated.goto(`http://127.0.0.1:${port}/site.html`);
  await isolated.evaluate(() => window.ready);
  assert.equal(
    await isolated.evaluate(() => window.ai.arjunah.isEnabled()),
    false,
    "grants are per exact origin",
  );
  await isolated.evaluate(() => window.registerAutoShow());
  await isolated.waitForFunction(
    () => document.activeElement?.id === "arjunah-extension",
  );
  await isolated.close();

  await page.evaluate(() => {
    window.__contextSession = window.ai.arjunah.enable({
      capabilities: ["context.read"],
      context: ["title", "url", "selection", "text"],
    });
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  await approveConsent(page);
  await page.evaluate(() => window.__contextSession);
  const context = await page.evaluate(async () =>
    (await window.__contextSession).context.get({ fields: ["title", "text"] }),
  );
  assert.equal(context.title, "अर्जुनः test page");
  assert.match(context.text, /cobalt-orchid/);
  assert.equal("url" in context, false);

  // The launcher and panel live in a closed shadow root, so they are read
  // through CDP rather than from page script.
  const pierced = async (className) => {
    const session = await page.createCDPSession();
    const { root } = await session.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    await session.detach();
    const attr = (node, name) => {
      const list = node.attributes ?? [];
      for (let index = 0; index < list.length; index += 2)
        if (list[index] === name) return list[index + 1];
      return null;
    };
    const find = (node) => {
      const classes = (attr(node, "class") ?? "").split(/\s+/);
      if (classes.includes(className)) return node;
      for (const child of [
        ...(node.children ?? []),
        ...(node.shadowRoots ?? []),
      ]) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    };
    const node = find(root);
    return node && { hidden: attr(node, "hidden") !== null, node };
  };
  const launcherState = async () => (await pierced("launcher"))?.hidden;
  const panelState = async () => (await pierced("panel"))?.hidden;

  // The bubble and the panel are two doors to one conversation: never both.
  assert.deepEqual(
    { launcher: await launcherState(), panel: await panelState() },
    { launcher: false, panel: true },
    "before opening, only the launcher is offered",
  );
  await page.evaluate(() => window.ai.arjunah.chat.open());
  assert.deepEqual(
    { launcher: await launcherState(), panel: await panelState() },
    { launcher: true, panel: false },
    "the launcher steps aside while the panel is open",
  );
  await page.evaluate(() => window.ai.arjunah.chat.close());
  assert.deepEqual(
    { launcher: await launcherState(), panel: await panelState() },
    { launcher: false, panel: true },
    "closing the panel brings the launcher back",
  );

  // The bubble wears the extension's own mark, not a stand-in glyph.
  const launcherMarkup = JSON.stringify((await pierced("launcher")).node);
  assert.match(launcherMarkup, /arjunah-bg/);
  assert.match(launcherMarkup, /arjunah-gold/);

  await page.evaluate(() => window.ai.arjunah.chat.open());
  await page.keyboard.type("Please use the echo tool");
  await page.keyboard.press("Enter");
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  await approveConsent(page);
  await page.waitForFunction(() => window.toolCalls === 1, { timeout: 10000 });
  await waitFor(() =>
    modelRequests
      .at(-1)
      .payload.messages.some(
        (item) => item.role === "tool" && item.content.includes("from-model"),
      ),
  );
  // The request is recorded before its deliberately delayed SSE body finishes.
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  const cdp = await page.createCDPSession();
  const rendered = JSON.stringify(
    await cdp.send("DOM.getDocument", { depth: -1, pierce: true }),
  );
  await cdp.detach();
  assert.match(rendered, /"nodeName":"STRONG"/);
  assert.match(rendered, /"nodeName":"TABLE"/);
  assert.match(rendered, /"class","activity done"/);
  assert.match(rendered, /"class","marker ok"/);
  assert.match(rendered, /"data-tool-view","detailed"/);
  assert.match(rendered, /"class","model-menu"/);
  assert.match(rendered, /Your usage limits/);
  assert.match(rendered, /1 step completed/);
  assert.doesNotMatch(rendered, /\*\*round\*\*/);
  assert.ok(
    // The page's own streamed rounds above request one too, so this looks
    // for the hosted tool round.
    modelRequests.some(
      (item) =>
        item.payload.stream === true &&
        item.payload.messages.some((message) => message.role === "tool"),
    ),
    "hosted answers request a provider stream",
  );

  await page.evaluate(() => window.registerBrokerInput());
  await page.evaluate(() => window.ai.arjunah.chat.open());
  await page.keyboard.type("Use the secure echo tool");
  await page.keyboard.press("Enter");
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  await approveConsent(page);
  await page.waitForFunction(() => window.safeInputRequested === true, {
    timeout: 10000,
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  await page.keyboard.type("violet-private-2718");
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => window.receivedUserInput === "violet-private-2718",
    { timeout: 10000 },
  );
  await waitFor(() =>
    modelRequests
      .at(-1)
      .payload.messages.some(
        (item) =>
          item.role === "tool" && item.content.includes('"confirmed":true'),
      ),
  );
  assert.equal(
    JSON.stringify(modelRequests).includes("violet-private-2718"),
    false,
    "broker-collected values must never enter model traffic",
  );
  const secureToolRequest = modelRequests.findLast((item) =>
    item.payload.tools?.some(
      (tool) => tool.function?.name === "site__secure_echo",
    ),
  );
  assert.ok(secureToolRequest, "the secure site tool must reach the model");
  const secureTool = secureToolRequest.payload.tools.find(
    (tool) => tool.function?.name === "site__secure_echo",
  );
  assert.equal(
    Object.hasOwn(secureTool.function.parameters.properties, "confirmation"),
    false,
    "broker-collected input ids must be absent from provider schemas",
  );
  assert.equal(Object.hasOwn(secureTool.function, "userInputs"), false);

  await page.evaluate(() => window.registerImageResult());
  await page.evaluate(() => window.ai.arjunah.chat.open());
  await page.keyboard.type("Look at the canvas image");
  await page.keyboard.press("Enter");
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  await approveConsent(page);
  await page.waitForFunction(() => window.imageToolCalls === 1, {
    timeout: 10000,
  });
  await waitFor(() => {
    const messages = modelRequests.at(-1)?.payload.messages ?? [];
    const toolIndex = messages.findIndex(
      (item) => item.role === "tool" && item.content.includes('"width":1'),
    );
    return (
      toolIndex >= 0 &&
      messages[toolIndex + 1]?.role === "user" &&
      messages[toolIndex + 1]?.content?.some(
        (part) =>
          part.type === "image_url" &&
          part.image_url.url.startsWith("data:image/webp;base64,UklGRi"),
      )
    );
  });
  const imageRound = modelRequests.at(-1).payload.messages;
  const imageToolIndex = imageRound.findIndex(
    (item) => item.role === "tool" && item.content.includes('"width":1'),
  );
  assert.equal(imageRound[imageToolIndex + 1].role, "user");
  const imageCdp = await page.createCDPSession();
  const imageDom = JSON.stringify(
    await imageCdp.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    }),
  );
  await imageCdp.detach();
  assert.doesNotMatch(imageDom, /UklGRiIAAABXRUJQ/);

  const requestsBeforeContractChange = modelRequests.length;
  await page.evaluate(() => window.changeContract());
  await page.evaluate(() => window.ai.arjunah.chat.open());
  await page.keyboard.type("This contract changed");
  await page.keyboard.press("Enter");
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  await denyConsent(page);
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  assert.equal(
    modelRequests.length,
    requestsBeforeContractChange,
    "a changed assistant contract must require fresh consent",
  );

  await page.evaluate(
    (url) => window.registerMcp(url),
    `http://127.0.0.1:${port}/mcp`,
  );
  await page.evaluate(() => window.ai.arjunah.chat.open());
  await page.keyboard.type("Use the MCP echo tool");
  await page.keyboard.press("Enter");
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  await approveConsent(page);
  await waitFor(() => mcpMethods.includes("tools/list"));
  await new Promise((r) => setTimeout(r, 200));
  await approveConsent(page);
  await waitFor(() => mcpMethods.includes("tools/call"));
  assert.deepEqual(mcpMethods, [
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/call",
  ]);
  await waitFor(() =>
    modelRequests
      .at(-1)
      .payload.messages.some(
        (item) =>
          item.role === "tool" && item.content.includes("from-mcp-server"),
      ),
  );

  // The popup has no chat of its own: it reports whether the page implements the protocol.
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.waitForFunction(() =>
    /cannot implement|does not implement|Reload this page/.test(
      document.querySelector("#state").textContent,
    ),
  );
  assert.equal(await popup.$("#prompt"), null);
  await popup.waitForFunction(() =>
    /Sites you approve use OpenAI API \(gpt-test-model\)/.test(
      document.querySelector("#provider-label").textContent,
    ),
  );
  // The wallet view lists providers with a global default selector.
  assert.equal(
    await popup.$eval("#default-model", (node) => node.value),
    "openai/gpt-test-model",
  );
  assert.ok((await popup.$$("#providers .provider")).length >= 1);
  await popup.close();
  await page.bringToFront();

  await page.evaluate(() => {
    window.__grantChanges.length = 0;
  });
  await page.evaluate(() => window.ai.arjunah.disable());
  assert.deepEqual(
    await page.evaluate(async () => [
      await window.ai.arjunah.isEnabled(),
      await (await window.__session).permissions.query(),
    ]),
    [false, null],
  );
  await waitForAsync(() =>
    page.evaluate(() => window.__grantChanges.some((change) => change.revoked)),
  );
  assert.deepEqual(await page.evaluate(() => window.__grantChanges.at(-1)), {
    level: null,
    model: null,
    revoked: true,
  });
  assert.equal(
    await page.evaluate(async () => {
      try {
        await (
          await window.__session
        ).models.generate({
          messages: [{ role: "user", content: "after disable" }],
        });
        return "unexpected";
      } catch (error) {
        return error.code;
      }
    }),
    "PERMISSION_REQUIRED",
    "a session kept from before disable() has no access",
  );
  await page.evaluate(() => {
    window.__denied = window.ai.arjunah
      .enable({ capabilities: ["models.list"] })
      .then(
        () => "unexpected",
        (error) => error.code,
      );
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  await denyConsent(page);
  assert.equal(await page.evaluate(() => window.__denied), "USER_DENIED");

  // An OpenCode Zen key coexists with the saved OpenAI key and routes each
  // model family to its own native wire format through the real extension.
  const zenSave = await settings.evaluate(
    () =>
      new Promise((resolveReply) =>
        chrome.runtime.sendMessage(
          {
            kind: "arjunah",
            method: "opencode.save",
            // No model: the key alone must discover the catalog and pick one.
            params: {
              baseUrl: "https://opencode.ai/zen/v1",
              apiKey: "zen-e2e-secret",
            },
          },
          resolveReply,
        ),
      ),
  );
  assert.equal(zenSave.ok, true, JSON.stringify(zenSave));
  assert.deepEqual(
    zenSave.result.models,
    ["gpt-5.6-luna", "claude-sonnet-4-6"],
    "System One is not a conversational API and must stay out of the catalog",
  );
  assert.equal(
    zenSave.result.model,
    "gpt-5.6-luna",
    "saving a key alone must settle on a usable default model",
  );
  // The settings picker is populated from that discovery, not typed by hand.
  await settings.reload();
  // The combobox is built after the page's own async reads, and a background
  // tab gets no animation frames, so this polls on a timer rather than on rAF.
  await settings.waitForFunction(
    () =>
      document.querySelector("#opencode-model .combo-input")?.disabled ===
      false,
    { polling: 100 },
  );
  // The combobox draws its rows only while open, so this opens it first.
  await settings.$eval("#opencode-model .combo-input", (input) =>
    input.dispatchEvent(new Event("click", { bubbles: true })),
  );
  assert.deepEqual(
    await settings.$$eval("#opencode-model .combo-id", (nodes) =>
      nodes.map((node) => node.textContent),
    ),
    ["gpt-5.6-luna", "claude-sonnet-4-6"],
  );
  assert.equal(
    await settings.$eval("#opencode-model", (node) => node.value),
    "gpt-5.6-luna",
  );

  const zenPage = await browser.newPage();
  zenPage.on("pageerror", (error) => errors.push(`zen page: ${error.message}`));
  await zenPage.goto(`http://127.0.0.1:${port}/site.html`);
  await zenPage.evaluate(() => window.ready);
  await zenPage.evaluate(() => {
    window.__zenSession = window.ai.arjunah.enable();
  });
  await zenPage.waitForFunction(
    () => document.activeElement?.id === "arjunah-extension",
  );
  // A level 1 consent says that working state is kept between tool steps.
  const consentCdp = await zenPage.createCDPSession();
  const consentDom = JSON.stringify(
    await consentCdp.send("DOM.getDocument", { depth: -1, pierce: true }),
  );
  await consentCdp.detach();
  assert.ok(
    consentDom.includes(
      "Keeps the model's working state during a reply's tool steps on this device, for up to 2 days.",
    ),
    "the level 1 consent discloses provider-state retention",
  );
  await approveConsent(zenPage);
  await zenPage.evaluate(() => window.__zenSession);

  // Zen proxies each family to its own vendor, which means that vendor's own
  // credential header: Bearer for the OpenAI route, x-api-key for Anthropic's
  // (see providerHeaders in lib/provider.js).
  for (const [model, path, answer, credential] of [
    [
      "opencode-api/gpt-5.6-luna",
      "/responses",
      "Zen Responses answer.",
      { authorization: "Bearer zen-e2e-secret", apiKey: undefined },
    ],
    [
      "opencode-api/claude-sonnet-4-6",
      "/messages",
      "Zen Anthropic answer.",
      { authorization: undefined, apiKey: "zen-e2e-secret" },
    ],
  ]) {
    const selected = await settings.evaluate(
      (id) =>
        new Promise((resolveReply) =>
          chrome.runtime.sendMessage(
            {
              kind: "arjunah",
              method: "catalog.default",
              params: { model: id },
            },
            resolveReply,
          ),
        ),
      model,
    );
    assert.equal(selected.ok, true, JSON.stringify(selected));
    assert.equal(
      await zenPage.evaluate(
        async () =>
          (
            await (
              await window.__zenSession
            ).models.generate({
              messages: [{ role: "user", content: "hello zen" }],
            })
          ).message.content,
      ),
      answer,
      `${model} must answer through ${path}`,
    );
    assert.equal(zenRequests.at(-1).path, path);
    assert.equal(zenRequests.at(-1).authorization, credential.authorization);
    assert.equal(zenRequests.at(-1).apiKey, credential.apiKey);
  }
  assert.equal(
    zenRequests.at(-1).anthropicVersion,
    "2023-06-01",
    "the Anthropic route must carry its version header",
  );
  // Routing alone is not enough: each body must be in that family's own shape.
  const [responsesRequest, anthropicRequest] = zenRequests;
  assert.equal(responsesRequest.payload.model, "gpt-5.6-luna");
  assert.ok(
    responsesRequest.payload.input.some(
      (item) =>
        item.role === "user" &&
        item.content.some((part) => part.text === "hello zen"),
    ),
    "the Responses route must send input items, not chat messages",
  );
  assert.equal(anthropicRequest.payload.model, "claude-sonnet-4-6");
  assert.ok(
    Number.isInteger(anthropicRequest.payload.max_tokens),
    "Anthropic Messages requires max_tokens",
  );
  assert.ok(
    anthropicRequest.payload.messages.some(
      (item) =>
        item.role === "user" &&
        item.content.some((part) => part.text === "hello zen"),
    ),
    "the Anthropic route must send block content, not a bare string",
  );
  assert.equal(
    modelRequests.some(
      (item) => item.authorization === "Bearer zen-e2e-secret",
    ),
    false,
    "the Zen key must never reach the OpenAI endpoint",
  );
  assert.equal(
    zenRequests.some(
      (item) =>
        item.authorization === "Bearer e2e-secret" ||
        item.apiKey === "e2e-secret",
    ),
    false,
    "the OpenAI key must never reach the Zen endpoint, under either header",
  );
  assert.equal(
    JSON.stringify(
      await zenPage.evaluate(async () => [
        window.ai?.arjunah,
        await window.__zenSession,
      ]),
    ).includes("zen-e2e-secret"),
    false,
    "the Zen key must never be visible to the page",
  );

  // Provider-state continuity (SPEC 5.4): the page runs its own two-round
  // tool turn; round 1's encrypted reasoning waits in the extension's own
  // IndexedDB and goes back on round 2, and the page never sees it.
  const luna = await settings.evaluate(
    () =>
      new Promise((resolveReply) =>
        chrome.runtime.sendMessage(
          {
            kind: "arjunah",
            method: "catalog.default",
            params: { model: "opencode-api/gpt-5.6-luna" },
          },
          resolveReply,
        ),
      ),
  );
  assert.equal(luna.ok, true, JSON.stringify(luna));
  // Read from an extension page, which shares the worker's origin and so its
  // IndexedDB. Opening must never create the database itself.
  const storedState = () =>
    settings.evaluate(
      () =>
        new Promise((resolveRead, rejectRead) => {
          const open = indexedDB.open("arjunah");
          open.onupgradeneeded = () => open.transaction.abort();
          open.onerror = () => resolveRead(null);
          open.onsuccess = () => {
            const db = open.result;
            const read = db
              .transaction("providerState")
              .objectStore("providerState")
              .getAll();
            read.onsuccess = () => {
              db.close();
              resolveRead(read.result);
            };
            read.onerror = () => {
              db.close();
              rejectRead(read.error);
            };
          };
        }),
    );
  const weatherTool = {
    name: "get_weather",
    description: "Weather for a city.",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      additionalProperties: false,
    },
  };
  // The extension mints the conversation; the page keeps only its handle.
  const conversationId = await zenPage.evaluate(async () => {
    const session = await window.__zenSession;
    window.__conversation = await session.conversations.create();
    return window.__conversation.id;
  });
  assert.match(conversationId, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
  const toolRound = (previous) =>
    zenPage.evaluate(
      async ({ tool, previous }) => {
        const ask = { role: "user", content: "Weather in Kathmandu?" };
        return window.__conversation.generate({
          tools: [tool],
          messages: previous
            ? [
                ask,
                {
                  role: "assistant",
                  content: previous.message.content,
                  toolCalls: previous.message.toolCalls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: call.arguments },
                  })),
                },
                {
                  role: "tool",
                  toolCallId: previous.message.toolCalls[0].id,
                  content: '{"tempC":21}',
                },
              ]
            : [ask],
        });
      },
      { tool: weatherTool, previous },
    );
  const roundOne = await toolRound(null);
  assert.equal(roundOne.providerState, "none");
  assert.deepEqual(
    roundOne.message.toolCalls.map((call) => call.id),
    ["call_zen_1"],
  );
  assert.deepEqual(zenRequests.at(-1).payload.include, [
    "reasoning.encrypted_content",
  ]);
  assert.equal(
    JSON.stringify(roundOne).includes(ZEN_REASONING.encrypted_content),
    false,
    "provider state never crosses the page bridge",
  );
  const kept = await storedState();
  assert.equal(kept?.length, 1, JSON.stringify(kept));
  assert.equal(kept[0].origin, `http://127.0.0.1:${port}`);
  assert.equal(kept[0].conversationKey, conversationId);
  assert.deepEqual(kept[0].callIds, ["call_zen_1"]);
  assert.equal(kept[0].model, "opencode-api/gpt-5.6-luna");
  assert.equal(
    JSON.stringify(kept).includes("zen-e2e-secret"),
    false,
    "the stored revision is a digest, never the key",
  );
  const roundTwo = await toolRound(roundOne);
  assert.equal(roundTwo.providerState, "reused");
  assert.equal(roundTwo.message.content, "Zen tool answer.");
  const replay = zenRequests.at(-1).payload.input;
  assert.deepEqual(replay[1], ZEN_REASONING);
  assert.equal(replay[2].type, "function_call");
  assert.equal(replay[2].id, "fc_zen_1");
  assert.equal(replay[2].call_id, "call_zen_1");
  assert.deepEqual(
    await storedState(),
    [],
    "the final round ends the turn and its state",
  );
  // A conversation the page abandons mid-turn is released explicitly, and
  // can be reopened by id later; an id the extension did not mint for this
  // origin is refused.
  await toolRound(null);
  assert.equal((await storedState()).length, 1);
  assert.deepEqual(
    await zenPage.evaluate(async (id) => {
      const session = await window.__zenSession;
      const reopened = await session.conversations.open(id);
      const forged = await session.conversations
        .open(`${id.slice(0, -1)}${id.endsWith("A") ? "B" : "A"}`)
        .then(
          () => "unexpected",
          (error) => error.code,
        );
      return { id: reopened.id, released: await reopened.release(), forged };
    }, conversationId),
    { id: conversationId, released: true, forged: "INVALID_REQUEST" },
  );
  assert.deepEqual(await storedState(), []);
  // The install key that signs conversation ids lives in local storage.
  const installKeyNow = () =>
    settings.evaluate(
      async () => (await chrome.storage.local.get("installKey")).installKey,
    );
  const keyBefore = await installKeyNow();
  assert.match(keyBefore, /^[A-Za-z0-9_-]{43}$/);

  // Settings clear stored conversation state (SPEC 11.2): a one-off round
  // and a conversation round each leave an entry, the options page reports
  // them, and clearing them (after a confirmation) rotates the install key.
  const oneOffRound = (previous) =>
    zenPage.evaluate(
      async ({ tool, previous }) => {
        const session = await window.__zenSession;
        const ask = { role: "user", content: "Weather in Kathmandu?" };
        return session.models.generate({
          tools: [tool],
          messages: previous
            ? [
                ask,
                {
                  role: "assistant",
                  content: previous.message.content,
                  toolCalls: previous.message.toolCalls.map((call) => ({
                    id: call.id,
                    type: "function",
                    function: { name: call.name, arguments: call.arguments },
                  })),
                },
                {
                  role: "tool",
                  toolCallId: previous.message.toolCalls[0].id,
                  content: '{"tempC":21}',
                },
              ]
            : [ask],
        });
      },
      { tool: weatherTool, previous },
    );
  const oneOff = await oneOffRound(null);
  const kept2 = await toolRound(null);
  assert.equal((await storedState()).length, 2);
  // The user works the page in front: a background tab gets no frames.
  await settings.bringToFront();
  // Settings show one view at a time; stored state is on the Sites view.
  await settings.goto(`chrome-extension://${extensionId}/options.html#sites`);
  await settings.reload();
  await settings.waitForFunction(
    () =>
      /^2 provider-state entries \(\S.*\) for 1 site$/.test(
        document.querySelector("#stored-state-summary")?.textContent ?? "",
      ),
    { polling: 100 },
  );
  // The site's own row shows what it keeps and says revoking deletes it.
  assert.match(
    await settings.$eval(
      `.grant[data-origin="http://127.0.0.1:${port}"]`,
      (row) => row.textContent,
    ),
    /Stored conversation state: 2 entries, .*Revoking deletes it\./,
  );
  assert.equal(
    await settings.$eval("#clear-state", (button) =>
      button.classList.contains("btn-danger"),
    ),
    true,
  );
  await settings.click("#clear-state");
  await settings.waitForFunction(
    () => !document.querySelector("#clear-state-confirm").hidden,
    { polling: 100 },
  );
  assert.match(
    await settings.$eval("#clear-state-question", (node) => node.textContent),
    /^This deletes 2 provider-state entries .* sites must start a new one\./,
  );
  // Cancel keeps everything.
  await settings.click("#clear-state-cancel");
  assert.equal((await storedState()).length, 2);
  await settings.click("#clear-state");
  await settings.waitForFunction(
    () => !document.querySelector("#clear-state-confirm").hidden,
    { polling: 100 },
  );
  await settings.click("#clear-state-yes");
  await settings.waitForFunction(
    () =>
      /^Cleared 2 provider-state entries/.test(
        document.querySelector("#state-status")?.textContent ?? "",
      ) &&
      document.querySelector("#stored-state-summary").textContent ===
        "Nothing stored.",
    { polling: 100 },
  );
  assert.deepEqual(await storedState(), []);
  const keyAfter = await installKeyNow();
  assert.match(keyAfter, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(keyAfter, keyBefore, "clearing rotated the install key");
  // The one-off's next round finds nothing to reattach.
  assert.equal((await oneOffRound(oneOff)).providerState, "none");
  // The conversation's id no longer verifies: its next round, open(), and
  // release() are refused, and a new conversation works.
  const afterClear = await zenPage.evaluate(async (id) => {
    const session = await window.__zenSession;
    const code = (promise) =>
      promise.then(
        () => "unexpected",
        (error) => error.code,
      );
    return {
      round: await code(
        window.__conversation.generate({
          messages: [{ role: "user", content: "hello zen" }],
        }),
      ),
      open: await code(session.conversations.open(id)),
      release: await code(window.__conversation.release()),
      fresh: (await session.conversations.create()).id !== id,
    };
  }, conversationId);
  assert.deepEqual(afterClear, {
    round: "INVALID_REQUEST",
    open: "INVALID_REQUEST",
    release: "INVALID_REQUEST",
    fresh: true,
  });
  assert.ok(kept2.message.toolCalls.length);
  await zenPage.close();

  assert.deepEqual(errors, []);
  console.log(
    `Chrome E2E passed with extension ${extensionId}, ${modelRequests.length} OpenAI and ${zenRequests.length} OpenCode Zen provider requests.`,
  );
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(profile, { recursive: true, force: true });
  await testExtension.cleanup();
}

async function waitForAsync(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}
async function waitFor(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for the mock server.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}
