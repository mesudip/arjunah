import { mockProviderExtension } from "../helpers/browser-extension.mjs";
import { launchFirefox, waitForExtensionOptions } from "../helpers/firefox.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { By, Key, until } from "selenium-webdriver";

const fixture = readFileSync(resolve("tests/fixtures/site.html"));
const modelRequests = [];
const mcpMethods = [];
let holdNext = false,
  heldResponse = null;
const ollamaRequests = [];
const server = createServer(async (request, response) => {
  // A stand-in Ollama server with the real one's Origin check: anything that
  // arrives carrying an Origin header is refused.
  if (request.url.startsWith("/api/")) {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    ollamaRequests.push({
      path: request.url,
      method: request.method,
      origin: request.headers.origin ?? null,
    });
    if (request.headers.origin) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        request.url === "/api/tags"
          ? { models: [{ name: "qwen3-vl:2b", digest: "v" }] }
          : request.url === "/api/show"
            ? { capabilities: ["completion", "vision", "tools"] }
            : { models: [] },
      ),
    );
    return;
  }
  if (request.url === "/site.html") {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(fixture);
    return;
  }
  if (request.url === "/v1/models") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
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
    if (holdNext) {
      holdNext = false;
      heldResponse = response;
      return;
    }
    // A page's own round stream (SPEC 5.3): two deltas further apart than
    // the extension's batch window.
    if (
      payload.stream &&
      payload.messages[0]?.content === "stream this round"
    ) {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const [index, text] of ["Firefox ", "streamed."].entries()) {
        response.write(
          `data: ${JSON.stringify({
            id: "firefox-stream",
            choices: [
              {
                delta: { content: text },
                finish_reason: index ? "stop" : null,
              },
            ],
          })}\n\n`,
        );
        await new Promise((wait) => setTimeout(wait, 400));
      }
      response.end("data: [DONE]\n\n");
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
              id: "call-firefox",
              type: "function",
              function: {
                name: toolName,
                arguments: '{"value":"from-firefox-model"}',
              },
            },
          ],
        }
      : {
          role: "assistant",
          content: hasToolResult
            ? "Firefox tool round completed."
            : "Firefox direct response.",
        };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: `firefox-${modelRequests.length}`,
        model: "test-model",
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
        ? { "Mcp-Session-Id": "firefox-session" }
        : {}),
    });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    return;
  }
  response.writeHead(404);
  response.end("not found");
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const port = server.address().port;
const testExtension = await mockProviderExtension(
  `http://127.0.0.1:${port}/v1`,
  true,
);
const addonPath = testExtension.addonPath;
let driver;

try {
  const launched = await launchFirefox(addonPath);
  driver = launched.driver;
  const { addonId, firefoxPath } = launched;
  assert.equal(addonId, "arjunah@open-web.dev");

  const optionsHandle = await waitForExtensionOptions(driver);
  await driver.switchTo().window(optionsHandle);
  assert.equal(
    await driver.findElement(By.id("base-url")).getProperty("value"),
    "https://api.openai.com/v1",
  );
  // The model field is a typable combobox (SPEC 8.2): the text box inside it is
  // what takes the name, and blurring it commits what was typed.
  const modelBox = await driver.findElement(By.css("#model .combo-input"));
  await modelBox.clear();
  // Tab rather than Escape: leaving the box keeps the typed name, whereas
  // Escape abandons the search. Clicking away would hit the open list instead.
  await modelBox.sendKeys("test-model", Key.TAB);
  await driver.findElement(By.id("api-key")).sendKeys("firefox-e2e-secret");
  await driver
    .findElement(By.css("#provider-form button[type=submit]"))
    .click();
  await driver.wait(
    until.elementTextContains(
      driver.findElement(By.id("provider-status")),
      "OpenAI key saved",
    ),
    5000,
  );

  // Firefox sends the extension's moz-extension:// Origin on every POST, which
  // Ollama refuses; the declarativeNetRequest rule must remove it.
  await driver
    .findElement(By.id("ollama-base-url"))
    .sendKeys(`127.0.0.1:${port}`);
  await driver.findElement(By.css("#ollama-form button[type=submit]")).click();
  await driver.wait(
    until.elementTextContains(
      driver.findElement(By.id("ollama-status")),
      "Saved.",
    ),
    10000,
  );
  assert.ok(
    ollamaRequests.some((item) => item.method === "POST"),
    "discovery POSTs to /api/show",
  );
  assert.deepEqual(
    ollamaRequests.filter((item) => item.origin !== null),
    [],
    "no Firefox request reached Ollama with an Origin",
  );

  await driver.findElement(By.id("open-popup")).click();
  await driver.wait(until.urlContains("/popup.html"), 5000);
  await driver.wait(
    until.elementTextContains(
      driver.findElement(By.id("state")),
      "implement the अर्जुनः protocol",
    ),
    10000,
  );
  assert.equal((await driver.findElements(By.id("prompt"))).length, 0);

  await driver.get(`http://localhost:${port}/site.html`);
  await driver.wait(
    until.elementTextIs(driver.findElement(By.id("status")), "ready"),
    10000,
  );
  assert.deepEqual(
    await driver.executeScript(
      "const d=Object.getOwnPropertyDescriptor(window,'ai'); return {version:window.ai.arjunah.version,writable:d.writable,configurable:d.configurable}",
    ),
    { version: "1.0.0", writable: false, configurable: false },
  );
  assert.equal(
    await invoke(driver, "window.ai.arjunah.isEnabled()", true),
    false,
  );

  // openSettings() needs a user gesture. Nothing has been clicked or typed
  // on this page yet, so a script calling it is refused.
  assert.equal(
    await invoke(driver, "window.ai.arjunah.openSettings()", true),
    "PERMISSION_REQUIRED",
  );
  await driver.executeScript(
    "window.__changes=[];window.addEventListener('arjunah:grantchange',e=>window.__changes.push(e.detail))",
  );
  await start(
    driver,
    "grant",
    "window.ai.arjunah.enable().then(s=>(window.__session=s,s.grant))",
  );
  await driver.sleep(150);
  await driver.actions().sendKeys(Key.ENTER).perform();
  const grant = await result(driver, "grant");
  assert.equal(grant.ok, true);
  assert.equal(grant.value.origin, `http://localhost:${port}`);
  assert.equal(grant.value.level, "completion", "enable() defaults to level 1");
  await driver.wait(
    async () =>
      (await driver.executeScript("return window.__changes.length")) === 1,
    10000,
  );
  assert.deepEqual(await driver.executeScript("return window.__changes"), [
    { level: "completion", model: "openai/test-model", revoked: false },
  ]);
  assert.equal(
    await invoke(driver, "window.ai.arjunah.isEnabled()", true),
    true,
  );
  assert.deepEqual(
    await invoke(driver, "window.__session.models.list()", true),
    [
      {
        id: "openai/test-model",
        provider: "openai",
        displayName: "test-model",
        default: true,
        capabilities: { tools: true, vision: false, reasoning: false },
        contextWindow: null,
        reasoningLevels: [],
        limits: {
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
        },
        kind: "api-key",
        local: false,
        builtinTools: false,
      },
    ],
  );
  // A click is a user gesture, so openSettings() opens the settings page.
  const handlesBefore = await driver.getAllWindowHandles();
  await driver.executeScript(
    "const b=document.createElement('button');b.id='open-settings';b.textContent='AI settings';b.onclick=()=>{window.__settings=null;window.ai.arjunah.openSettings().then(v=>window.__settings={ok:true,value:v},e=>window.__settings={ok:false,error:e.code})};document.body.append(b)",
  );
  await driver.findElement(By.id("open-settings")).click();
  assert.deepEqual(await result(driver, "settings"), { ok: true, value: true });
  // Firefox lets the extension open its toolbar popup here, which is not a
  // window WebDriver can see; where it does not, the settings page opens.
  await driver.sleep(500);
  const settingsTab = (await driver.getAllWindowHandles()).find(
    (handle) => !handlesBefore.includes(handle),
  );
  const settingsSurface = settingsTab ? "options page" : "toolbar popup";
  if (settingsTab) {
    const pageHandle = await driver.getWindowHandle();
    await driver.switchTo().window(settingsTab);
    // The options page lands on the asking site's row, outlined.
    const asking = `http://localhost:${port}`;
    assert.equal(
      new URL(await driver.getCurrentUrl()).hash,
      `#grants:${encodeURIComponent(asking)}`,
    );
    await driver.wait(
      async () =>
        (await driver.executeScript(
          "return [...document.querySelectorAll('.grant.asked')].map(r=>r.dataset.origin).join()",
        )) === asking,
      10000,
    );
    await driver.close();
    await driver.switchTo().window(pageHandle);
  }
  assert.equal(
    (
      await invoke(
        driver,
        "window.__session.models.generate({messages:[{role:'user',content:'hello'}]})",
        true,
      )
    ).message.content,
    "Firefox direct response.",
  );
  assert.equal(modelRequests.at(-1).authorization, "Bearer firefox-e2e-secret");
  const streamed = await invoke(
    driver,
    `(async()=>{const events=[];for await(const event of window.__session.models.stream({messages:[{role:'user',content:'stream this round'}]}))events.push(event);return events;})()`,
    true,
  );
  assert.deepEqual(
    streamed.slice(0, -1),
    [
      { type: "output.delta", text: "Firefox " },
      { type: "output.delta", text: "streamed." },
    ],
    JSON.stringify(streamed),
  );
  assert.equal(streamed.at(-1).type, "result");
  assert.equal(streamed.at(-1).result.message.content, "Firefox streamed.");

  const mainHandle = await driver.getWindowHandle();
  await driver.switchTo().newWindow("tab");
  await driver.get(`http://127.0.0.1:${port}/site.html`);
  await driver.wait(
    until.elementTextIs(driver.findElement(By.id("status")), "ready"),
    10000,
  );
  assert.equal(
    await invoke(driver, "window.ai.arjunah.isEnabled()", true),
    false,
    "grants are per exact origin",
  );
  await invoke(driver, "window.registerAutoShow()", true);
  await driver.wait(
    async () =>
      (await driver.executeScript(
        "return document.activeElement && document.activeElement.id",
      )) === "arjunah-extension",
    5000,
  );
  await driver.close();
  await driver.switchTo().window(mainHandle);

  await start(
    driver,
    "context",
    "window.ai.arjunah.enable({capabilities:['context.read'],context:['title','url','selection','text']}).then(s=>(window.__ctx=s,s.grant))",
  );
  await driver.sleep(150);
  await driver.actions().sendKeys(Key.ENTER).perform();
  assert.equal((await result(driver, "context")).ok, true);
  const context = await invoke(
    driver,
    "window.__ctx.context.get({fields:['title','text']})",
    true,
  );
  assert.equal(context.title, "अर्जुनः test page");
  assert.match(context.text, /cobalt-orchid/);
  assert.equal("url" in context, false);

  await invoke(driver, "window.ai.arjunah.chat.open()", true);
  await driver
    .actions()
    .sendKeys("Please use the echo tool", Key.ENTER)
    .perform();
  await driver.sleep(250);
  await driver.actions().sendKeys(Key.ENTER).perform();
  await driver.wait(
    async () => (await driver.executeScript("return window.toolCalls")) === 1,
    10000,
  );
  await driver.wait(
    () =>
      modelRequests
        .at(-1)
        .payload.messages.some(
          (item) =>
            item.role === "tool" && item.content.includes("from-firefox-model"),
        ),
    10000,
  );

  const requestsBeforeContractChange = modelRequests.length;
  await invoke(driver, "window.changeContract()", true);
  await invoke(driver, "window.ai.arjunah.chat.open()", true);
  await driver.actions().sendKeys("This contract changed", Key.ENTER).perform();
  await driver.sleep(250);
  await driver
    .actions()
    .keyDown(Key.SHIFT)
    .sendKeys(Key.TAB)
    .keyUp(Key.SHIFT)
    .sendKeys(Key.ENTER)
    .perform();
  await driver.sleep(250);
  assert.equal(
    modelRequests.length,
    requestsBeforeContractChange,
    "a changed assistant contract must require fresh consent",
  );

  await invoke(
    driver,
    `window.registerMcp('http://127.0.0.1:${port}/mcp')`,
    true,
  );
  await invoke(driver, "window.ai.arjunah.chat.open()", true);
  await driver.actions().sendKeys("Use the MCP echo tool", Key.ENTER).perform();
  await driver.sleep(250);
  await driver.actions().sendKeys(Key.ENTER).perform();
  await driver.wait(() => mcpMethods.includes("tools/list"), 10000);
  await driver.sleep(200);
  await driver.actions().sendKeys(Key.ENTER).perform();
  await driver.wait(() => mcpMethods.includes("tools/call"), 10000);
  assert.deepEqual(mcpMethods, [
    "initialize",
    "notifications/initialized",
    "tools/list",
    "tools/call",
  ]);
  await driver.wait(
    () =>
      modelRequests
        .at(-1)
        .payload.messages.some(
          (item) =>
            item.role === "tool" && item.content.includes("from-mcp-server"),
        ),
    10000,
  );

  await invoke(driver, "window.ai.arjunah.disable()", true);
  assert.equal(
    await invoke(driver, "window.ai.arjunah.isEnabled()", true),
    false,
  );
  assert.equal(
    await invoke(driver, "window.__session.permissions.query()", true),
    null,
  );
  await start(
    driver,
    "denied",
    "window.ai.arjunah.enable({capabilities:['models.list']})",
  );
  await driver.sleep(150);
  await driver
    .actions()
    .keyDown(Key.SHIFT)
    .sendKeys(Key.TAB)
    .keyUp(Key.SHIFT)
    .sendKeys(Key.ENTER)
    .perform();
  const denied = await result(driver, "denied");
  assert.equal(denied.ok, false);
  assert.equal(denied.error, "USER_DENIED");

  // Regression for the audited cross-origin navigation leak, using a delayed model.
  holdNext = true;
  await invoke(
    driver,
    "window.ai.arjunah.site.register({name:'Navigation probe',tools:[{name:'echo',handler:()=>{window.toolCalls++;return {secret:'must-not-leak'}}}]})",
    true,
  );
  await invoke(driver, "window.ai.arjunah.chat.open()", true);
  await driver.actions().sendKeys("Delayed tool", Key.ENTER).perform();
  await driver.sleep(250);
  await driver.actions().sendKeys(Key.ENTER).perform();
  await driver.wait(() => Boolean(heldResponse), 10000);
  const beforeNavigation = modelRequests.length;
  await driver.get(`http://127.0.0.1:${port}/site.html`);
  await driver.wait(
    until.elementTextIs(driver.findElement(By.id("status")), "ready"),
    10000,
  );
  assert.equal(
    await invoke(driver, "window.ai.arjunah.isEnabled()", true),
    false,
  );
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
  await driver.sleep(750);
  assert.equal(await driver.executeScript("return window.toolCalls"), 0);
  assert.equal(modelRequests.length, beforeNavigation);

  console.log(
    `Firefox E2E passed with ${addonId} on ${firefoxPath} and ${modelRequests.length} provider requests; openSettings() opened the ${settingsSurface}.`,
  );
} finally {
  if (driver) await driver.quit();
  await testExtension.cleanup();
  server.closeAllConnections();
  await new Promise((closed) => server.close(closed));
}

async function start(activeDriver, name, expression) {
  await activeDriver.executeScript(
    `window.__${name}=null;(${expression}).then(value=>window.__${name}={ok:true,value},error=>window.__${name}={ok:false,error:error.code})`,
  );
}
async function result(activeDriver, name) {
  await activeDriver.wait(
    async () =>
      Boolean(await activeDriver.executeScript(`return window.__${name}`)),
    10000,
  );
  return activeDriver.executeScript(`return window.__${name}`);
}
async function invoke(activeDriver, expression, returnValue = false) {
  return activeDriver.executeAsyncScript(
    `const done=arguments[arguments.length-1];(${expression}).then(value=>done(${returnValue ? "value" : "'unexpected'"}),error=>done(error.code||error.message))`,
  );
}
