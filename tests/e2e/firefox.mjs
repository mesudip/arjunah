import { mockProviderExtension } from "../helpers/browser-extension.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Builder, Browser, By, Key, until } from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import {
  getInstalledBrowsers,
  detectBrowserPlatform,
} from "@puppeteer/browsers";

const fixture = readFileSync(resolve("tests/fixtures/site.html"));
const modelRequests = [];
const mcpMethods = [];
let holdNext = false,
  heldResponse = null;
const server = createServer(async (request, response) => {
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
const firefoxPath = await findFirefox();
const testExtension = await mockProviderExtension(
  `http://127.0.0.1:${port}/v1`,
  true,
);
const addonPath = testExtension.addonPath;
let driver;

try {
  const options = new firefox.Options()
    .setBinary(firefoxPath)
    .addArguments("-headless");
  options.setPreference("browser.tabs.warnOnClose", false);
  options.setPreference("browser.shell.checkDefaultBrowser", false);
  driver = await new Builder()
    .forBrowser(Browser.FIREFOX)
    .setFirefoxOptions(options)
    .build();
  const addonId = await driver.installAddon(addonPath, true);
  assert.equal(addonId, "arjunah@open-web.dev");

  const optionsHandle = await waitForExtensionOptions(driver);
  await driver.switchTo().window(optionsHandle);
  assert.equal(
    await driver.findElement(By.id("base-url")).getProperty("value"),
    "https://api.openai.com/v1",
  );
  await driver.findElement(By.id("model")).clear();
  await driver.findElement(By.id("model")).sendKeys("test-model");
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
      },
    ],
  );
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
    `Firefox E2E passed with ${addonId} on ${firefoxPath} and ${modelRequests.length} provider requests.`,
  );
} finally {
  if (driver) await driver.quit();
  await testExtension.cleanup();
  server.closeAllConnections();
  await new Promise((closed) => server.close(closed));
}

async function findFirefox() {
  if (process.env.FIREFOX_PATH) {
    if (existsSync(process.env.FIREFOX_PATH)) return process.env.FIREFOX_PATH;
    throw new Error("FIREFOX_PATH does not exist.");
  }
  const cacheDir =
    process.env.PUPPETEER_CACHE_DIR ?? join(homedir(), ".cache", "puppeteer");
  const installed = await getInstalledBrowsers({ cacheDir });
  const candidates = installed.filter(
    (item) =>
      item.browser === "firefox" &&
      item.platform === detectBrowserPlatform() &&
      existsSync(item.executablePath),
  );
  candidates.sort((a, b) =>
    b.buildId.localeCompare(a.buildId, undefined, { numeric: true }),
  );
  if (candidates.length) return candidates[0].executablePath;
  throw new Error(
    "Firefox was not found. Run: npx puppeteer browsers install firefox@stable, or set FIREFOX_PATH.",
  );
}

async function waitForExtensionOptions(activeDriver) {
  return activeDriver.wait(async () => {
    for (const handle of await activeDriver.getAllWindowHandles()) {
      await activeDriver.switchTo().window(handle);
      if ((await activeDriver.getCurrentUrl()).startsWith("moz-extension://"))
        return handle;
    }
    return false;
  }, 10000);
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
