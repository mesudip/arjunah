import { mockProviderExtension } from "../helpers/browser-extension.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import puppeteer from "puppeteer";

const fixture = await readFile(resolve("tests/fixtures/site.html"));
const modelRequests = [];
const zenRequests = [];
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
    zenRequests.push({
      path: "/responses",
      payload: JSON.parse(body),
      authorization: request.headers.authorization,
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: "zen-responses-1",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Zen Responses answer." }],
          },
        ],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      }),
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
  await zenPage.keyboard.press("Enter");
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

async function waitFor(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for the mock server.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}
