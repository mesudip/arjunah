// Ollama through the real, unmodified extension in Chrome.
//
// By default a mock server stands in for Ollama. It answers 403 to any request
// that carries an Origin header, which is what a real server does for a
// browser extension's origin, so every extension request succeeding proves the
// declarativeNetRequest rule strips it. A request a web page makes to the same
// server must still arrive with its Origin.
//
// ARJUNAH_E2E_OLLAMA=http://host:11434 runs the same flow against a real
// server through a recording pass-through proxy (Origin forwarded untouched,
// so the real server's own check applies). ARJUNAH_E2E_OLLAMA_MODEL picks the
// model; it must report vision and tools (default qwen3-vl:2b).
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import puppeteer from "puppeteer";

const LIVE = process.env.ARJUNAH_E2E_OLLAMA ?? "";
const MODEL = process.env.ARJUNAH_E2E_OLLAMA_MODEL ?? "qwen3-vl:2b";
const TEXT_ONLY = "text-only:1b";
const fixture = await readFile(resolve("tests/fixtures/site.html"));

/** A 128×64 PNG, blue on the left and yellow on the right. */
function splitPng() {
  const width = 128;
  const height = 64;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = [0];
    for (let x = 0; x < width; x++)
      row.push(...(x < width / 2 ? [20, 40, 230] : [240, 220, 20]));
    rows.push(Buffer.from(row));
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}
const IMAGE = splitPng();

const seen = [];
async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function ndjson(response, lines) {
  response.writeHead(200, { "Content-Type": "application/x-ndjson" });
  for (const line of lines) response.write(`${JSON.stringify(line)}\n`);
  response.end();
}

/** The mock: the API surface and the Origin rule of a real Ollama server. */
async function mockOllama(request, response, raw) {
  const payload = raw.length ? JSON.parse(raw) : null;
  if (request.headers.origin) {
    response.writeHead(403, { "Content-Type": "text/plain" });
    return response.end("Forbidden");
  }
  const json = (value) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(value));
  };
  if (request.url === "/api/tags")
    return json({
      models: [
        { name: MODEL, digest: "vision" },
        { name: TEXT_ONLY, digest: "text" },
        { name: "nomic-embed-text:latest", digest: "embed" },
      ],
    });
  if (request.url === "/api/show")
    return json({
      capabilities:
        payload.model === MODEL
          ? ["completion", "vision", "tools", "thinking"]
          : payload.model === TEXT_ONLY
            ? ["completion"]
            : ["embedding"],
      model_info: { "x.context_length": 262144 },
    });
  if (request.url === "/api/ps")
    return json({
      models: [
        {
          name: MODEL,
          context_length: 32768,
          size: 1000,
          size_vram: 520,
          // Ollama unloads an idle model after keep_alive; the widget must
          // stop showing where it runs once that time has passed.
          expires_at: new Date(Date.now() + 12_000).toISOString(),
        },
      ],
    });
  if (request.url === "/api/chat") {
    const answered = payload.messages.some((item) => item.role === "tool");
    const image = payload.messages.some((item) => item.images?.length);
    const done = {
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 21,
      eval_count: 7,
    };
    if (
      payload.tools?.some((tool) => tool.function.name === "site__echo") &&
      !answered
    )
      return ndjson(response, [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_e2e",
                function: {
                  index: 0,
                  name: "site__echo",
                  arguments: { value: "from-ollama" },
                },
              },
            ],
          },
        },
        done,
      ]);
    const content = answered
      ? "The echo tool returned from-ollama."
      : image
        ? "Blue on the left, yellow on the right."
        : "Connected.";
    if (!payload.stream)
      return json({
        ...done,
        message: { role: "assistant", content, thinking: "Checked." },
      });
    return ndjson(response, [
      {
        message: {
          role: "assistant",
          content: "",
          thinking: "Thinking it over.",
        },
      },
      { message: { role: "assistant", content } },
      done,
    ]);
  }
  response.writeHead(404);
  response.end();
}

/** The live proxy: forwards everything, Origin included, and records it. */
function proxy(request, response, raw) {
  const target = new URL(request.url, LIVE);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = { ...request.headers, host: target.host };
  delete headers.connection;
  const upstream = send(
    target,
    { method: request.method, headers },
    (reply) => {
      response.writeHead(reply.statusCode, reply.headers);
      reply.pipe(response);
    },
  );
  upstream.on("error", () => {
    response.writeHead(502);
    response.end();
  });
  upstream.end(raw);
}

const ollama = createServer(async (request, response) => {
  const raw = await body(request);
  seen.push({
    path: request.url,
    method: request.method,
    origin: request.headers.origin ?? null,
    payload: raw.length ? JSON.parse(raw) : null,
  });
  if (LIVE) proxy(request, response, raw);
  else await mockOllama(request, response, raw);
});
const site = createServer((request, response) => {
  if (request.url === "/site.html") {
    response.writeHead(200, { "Content-Type": "text/html" });
    return response.end(fixture);
  }
  response.writeHead(404);
  response.end();
});
await new Promise((done) => ollama.listen(0, "127.0.0.1", done));
await new Promise((done) => site.listen(0, "127.0.0.1", done));
const OLLAMA = `http://127.0.0.1:${ollama.address().port}`;
const SITE = `http://localhost:${site.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "arjunah-ollama-e2e-"));
const extension = resolve("src");
const errors = [];
let browser;
const waitFor = async (
  check,
  timeout = LIVE ? 180_000 : 10_000,
  label = "condition",
) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const chats = () => seen.filter((item) => item.path === "/api/chat");
let processorShown = "";

try {
  browser = await puppeteer.launch({
    headless: true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
    userDataDir: profile,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
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

  // Connect the server the way a person does: type the address, press save.
  const settings = await browser.newPage();
  settings.on("pageerror", (error) =>
    errors.push(`settings: ${error.message}`),
  );
  await settings.goto(`chrome-extension://${extensionId}/options.html`);
  await settings.waitForSelector("#ollama-form");
  await settings.type("#ollama-base-url", OLLAMA.replace("http://", ""));
  await settings.click("#ollama-form button[type=submit]");
  await settings.waitForFunction(
    () =>
      /^Saved\.|error/i.test(
        document.querySelector("#ollama-status").textContent,
      ) || document.querySelector("#ollama-status").classList.contains("error"),
    { timeout: 60000 },
  );
  const saved = await settings.$eval("#ollama-status", (node) => ({
    text: node.textContent,
    error: node.classList.contains("error"),
  }));
  assert.equal(saved.error, false, saved.text);
  const discovery = seen.filter((item) => item.path === "/api/show");
  assert.ok(discovery.length >= 1, "discovery reads each model's metadata");
  assert.ok(
    discovery.every((item) => item.origin === null),
    `extension requests reach the server without an Origin (${JSON.stringify(discovery.map((item) => item.origin))})`,
  );

  // The test sends a tool-enabled probe and reports what the model accepts.
  const select = (config) =>
    settings.evaluate(
      (params) =>
        new Promise((done) =>
          chrome.runtime.sendMessage(
            { kind: "arjunah", method: params.method, params: params.params },
            done,
          ),
        ),
      config,
    );
  const tested = await select({
    method: "ollama.test",
    params: { provider: "ollama", baseUrl: OLLAMA, model: MODEL },
  });
  assert.equal(tested.ok, true, JSON.stringify(tested));
  assert.equal(
    tested.result.capabilities.vision,
    true,
    `${MODEL} must report vision`,
  );
  assert.equal(
    tested.result.capabilities.tools,
    true,
    `${MODEL} must report tools`,
  );
  const chosen = await select({
    method: "provider.select",
    params: { type: "ollama", model: MODEL },
  });
  assert.equal(chosen.ok, true, JSON.stringify(chosen));
  assert.match(chosen.result.label, /Ollama \(self-hosted\)/);
  const catalog = await select({ method: "catalog.get", params: {} });
  const provider = catalog.result.providers.find(
    (item) => item.id === "ollama",
  );
  assert.equal(provider.kind, "self-hosted");
  assert.ok(
    provider.models.some(
      (model) => model.id === `ollama/${MODEL}` && model.capabilities.vision,
    ),
  );
  if (!LIVE)
    assert.deepEqual(
      provider.models.map((model) => model.model),
      [MODEL, TEXT_ONLY].sort(),
      "embedding models are not offered",
    );

  const dom = async () => {
    const session = await page.createCDPSession();
    const tree = JSON.stringify(
      await session.send("DOM.getDocument", { depth: -1, pierce: true }),
    );
    await session.detach();
    return tree;
  };
  const processorHidden = async () => {
    const session = await page.createCDPSession();
    const { root } = await session.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    await session.detach();
    const find = (node) => {
      const attrs = node.attributes ?? [];
      if (
        attrs.includes("class") &&
        attrs[attrs.indexOf("class") + 1] === "processor"
      )
        return node;
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
    return !node || (node.attributes ?? []).includes("hidden");
  };
  // A web page: level 1, a direct completion with an image.
  const page = await browser.newPage();
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  await page.goto(`${SITE}/site.html`);
  await page.evaluate(() => window.ready);
  await page.evaluate(() => {
    window.__session = window.ai.arjunah.enable();
  });
  await page.waitForFunction(
    () => document.activeElement?.id === "arjunah-extension",
  );
  await page.keyboard.press("Enter");
  const listed = await page.evaluate(async () =>
    (await (await window.__session).models.list()).map((item) => item.id),
  );
  assert.deepEqual(listed, [`ollama/${MODEL}`]);
  const before = chats().length;
  const answer = await page.evaluate(
    async (image) =>
      (
        await (
          await window.__session
        ).models.generate({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Name the two colors in this image, left then right. Answer in at most six words.",
                },
                { type: "image", mediaType: "image/png", data: image },
              ],
            },
          ],
          reasoning: "none",
        })
      ).message.content,
    IMAGE,
  );
  const imageRequest = chats()[before];
  assert.deepEqual(
    imageRequest.payload.messages[0].images,
    [IMAGE],
    "the image travels as bare base64",
  );
  assert.equal(imageRequest.payload.think, false);
  assert.match(answer, /blue/i, `the model saw the image: ${answer}`);
  assert.match(answer, /yellow/i, `the model saw the image: ${answer}`);
  assert.equal(imageRequest.origin, null);

  // The rule is scoped to the extension: the page's own request keeps its Origin.
  await page.evaluate(
    (url) =>
      fetch(`${url}/api/show`, {
        method: "POST",
        mode: "no-cors",
        body: JSON.stringify({ model: "page-probe" }),
      }).catch(() => null),
    OLLAMA,
  );
  await waitFor(
    () => seen.some((item) => item.payload?.model === "page-probe"),
    5000,
    "the page's request",
  );
  assert.equal(
    seen.find((item) => item.payload?.model === "page-probe").origin,
    SITE,
    "a web page's request to the server keeps its Origin",
  );

  // Hosted chat: consent, a streamed site-tool round trip, and the answer drawn.
  await page.evaluate(() => window.ai.arjunah.chat.open());
  // The model is already loaded from the request above, so where it runs is
  // shown as soon as the chat opens, before anything is sent.
  await waitFor(
    async () =>
      /"class","processor"(?!,"hidden")/.test(await dom()) &&
      !(await processorHidden()),
    10_000,
    "the processor marker on open",
  );
  await page.keyboard.type(
    "Call the echo tool with the value from-ollama, then tell me what it returned.",
  );
  await page.keyboard.press("Enter");
  await new Promise((done) => setTimeout(done, 200));
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.toolCalls >= 1, {
    timeout: LIVE ? 180_000 : 10_000,
  });
  await waitFor(
    () =>
      chats().some((item) =>
        item.payload.messages.some((message) => message.role === "tool"),
      ),
    undefined,
    "the tool result round",
  );
  const toolRound = chats().find((item) =>
    item.payload.messages.some((message) => message.role === "tool"),
  );
  const toolMessage = toolRound.payload.messages.find(
    (message) => message.role === "tool",
  );
  assert.equal(toolMessage.tool_name, "site__echo");
  assert.ok(toolMessage.tool_call_id);
  assert.equal(toolRound.payload.stream, true, "hosted answers stream");
  assert.ok(
    toolRound.payload.tools.some((tool) => tool.function.name === "site__echo"),
  );
  // Where the model runs sits beside the context size while the turn is still
  // running: the tool round is done, the answer may not be.
  await waitFor(
    async () => /"class","processor"/.test(await dom()),
    undefined,
    "the processor marker",
  );
  const marker = JSON.parse(await dom());
  const find = (node) => {
    const attrs = node.attributes ?? [];
    if (
      attrs[attrs.indexOf("class") + 1] === "processor" &&
      attrs.includes("class")
    )
      return node;
    for (const child of [
      ...(node.children ?? []),
      ...(node.shadowRoots ?? []),
    ]) {
      const hit = find(child);
      if (hit) return hit;
    }
    return null;
  };
  const pill = find(marker.root);
  const pillText = pill?.children?.[0]?.nodeValue ?? "";
  const pillAttrs = pill?.attributes ?? [];
  assert.equal(pillAttrs.includes("hidden"), false, "the marker is shown");
  if (LIVE) assert.match(pillText, /^(GPU|CPU|CPU\+GPU \d+%)$/, pillText);
  else {
    assert.equal(pillText, "CPU+GPU 52%");
    assert.equal(pillAttrs[pillAttrs.indexOf("data-placement") + 1], "split");
  }
  processorShown = pillText;
  // A small live model can think for minutes, so live runs report an answer
  // still in progress rather than failing on the model's pace.
  const drawn = await waitFor(
    async () => /1 step completed/.test(await dom()),
    LIVE ? 120_000 : 10_000,
    "the drawn answer",
  ).then(
    () => true,
    (error) => {
      if (!LIVE) throw error;
      return false;
    },
  );
  if (!LIVE) assert.match(await dom(), /The echo tool returned from-ollama\./);
  if (!LIVE) {
    // No request is made for this: the widget's own timer hides the marker
    // at the unload time the server reported.
    const before = seen.length;
    await waitFor(processorHidden, 45_000, "the marker to hide after unload");
    assert.equal(
      seen.filter((item) => item.path === "/api/ps").length,
      seen.slice(0, before).filter((item) => item.path === "/api/ps").length,
      "hiding the marker needs no polling",
    );
  }
  if (!drawn)
    console.log(
      `Note: ${MODEL} was still answering after 120 s; the tool round and the processor marker were verified, the final answer was not.`,
    );
  assert.ok(
    chats().every((item) => item.origin === null),
    "every chat request reached the server without an Origin",
  );
  assert.deepEqual(errors, []);
  console.log(
    `Ollama ${LIVE ? `live (${LIVE}, ${MODEL})` : "mock"} browser checks passed: ${chats().length} chat requests, image answer ${JSON.stringify(answer)}, processor marker ${JSON.stringify(processorShown)}.`,
  );
} finally {
  await browser?.close();
  ollama.close();
  site.close();
  await rm(profile, { recursive: true, force: true });
}
