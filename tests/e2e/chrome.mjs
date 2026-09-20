import { mockProviderExtension } from "../helpers/browser-extension.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer";

const fixture = await readFile(resolve("tests/fixtures/site.html"));
const modelRequests = [];
const mcpMethods = [];
const server = createServer(async (request, response) => {
  if (request.url === "/site.html") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(fixture);
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
        "site",
        "version",
      ],
    },
  );

  // A bare enable() asks for level 1 and resolves to the session.
  await page.evaluate(() => {
    window.__session = window.ai.arjunah.enable();
  });
  await page.waitForFunction(
    () => document.activeElement?.id === "arjunah-extension",
  );
  await page.keyboard.press("Enter");
  const grant = await page.evaluate(async () => (await window.__session).grant);
  assert.equal(grant.origin, `http://localhost:${port}`);
  assert.equal(grant.level, "completion");
  assert.deepEqual(grant.capabilities, ["models.list", "models.generate"]);
  assert.equal(await page.evaluate(() => window.ai.arjunah.isEnabled()), true);
  assert.deepEqual(
    await page.evaluate(async () =>
      (await (await window.__session).models.list()).map((item) => item.id),
    ),
    ["openai/gpt-test-model"],
  );
  assert.equal(
    await page.evaluate(
      async () =>
        (
          await (
            await window.__session
          ).models.generate({
            messages: [{ role: "user", content: "hello" }],
          })
        ).message.content,
    ),
    "Direct model response.",
  );
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
  await page.keyboard.press("Enter");
  await page.evaluate(() => window.__contextSession);
  const context = await page.evaluate(async () =>
    (await window.__contextSession).context.get({ fields: ["title", "text"] }),
  );
  assert.equal(context.title, "अर्जुनः test page");
  assert.match(context.text, /cobalt-orchid/);
  assert.equal("url" in context, false);

  await page.evaluate(() => window.ai.arjunah.chat.open());
  await page.keyboard.type("Please use the echo tool");
  await page.keyboard.press("Enter");
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  await page.keyboard.press("Enter");
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
    modelRequests.some((item) => item.payload.stream === true),
    "hosted answers request a provider stream",
  );

  await page.evaluate(() => window.registerBrokerInput());
  await page.evaluate(() => window.ai.arjunah.chat.open());
  await page.keyboard.type("Use the secure echo tool");
  await page.keyboard.press("Enter");
  await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  await page.keyboard.press("Enter");
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
  await page.keyboard.press("Enter");
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
  await page.keyboard.down("Shift");
  await page.keyboard.press("Tab");
  await page.keyboard.up("Shift");
  await page.keyboard.press("Enter");
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
  await page.keyboard.press("Enter");
  await waitFor(() => mcpMethods.includes("tools/list"));
  await new Promise((r) => setTimeout(r, 200));
  await page.keyboard.press("Enter");
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

  await page.evaluate(() => window.ai.arjunah.disable());
  assert.deepEqual(
    await page.evaluate(async () => [
      await window.ai.arjunah.isEnabled(),
      await (await window.__session).permissions.query(),
    ]),
    [false, null],
  );
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
  await page.keyboard.down("Shift");
  await page.keyboard.press("Tab");
  await page.keyboard.up("Shift");
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => window.__denied), "USER_DENIED");

  assert.deepEqual(errors, []);
  console.log(
    `Chrome E2E passed with extension ${extensionId} and ${modelRequests.length} provider requests.`,
  );
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(profile, { recursive: true, force: true });
  await testExtension.cleanup();
}

async function waitFor(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for the mock server.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}
