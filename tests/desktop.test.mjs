import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createDesktopApp } from "../desktop/lib/server.mjs";
import { Store } from "../desktop/lib/store.mjs";
import {
  buildPrompt,
  collectImages,
  trailingToolResults,
} from "../desktop/lib/transcript.mjs";
import {
  ToolSession,
  SessionRegistry,
  SESSION_LIMITS,
} from "../desktop/lib/sessions.mjs";

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

function fakeAdapter(behavior, { supportsVision = false } = {}) {
  return {
    id: "fake",
    name: "Fake",
    vendor: "Test",
    supportsTools: true,
    supportsThreads: true,
    supportsVision,
    async detect() {
      return {
        installed: true,
        available: true,
        binary: "/bin/fake",
        models: [{ id: "default", displayName: "Default" }],
        defaultModel: "default",
      };
    },
    start(options) {
      return behavior(options);
    },
  };
}

async function app(t, behavior, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "arjunah-desktop-test-"));
  const store = new Store(directory);
  const adapter = fakeAdapter(
    behavior ??
      (() => ({
        child: null,
        output: Promise.resolve({
          content: "hello",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "default",
        }),
      })),
    options,
  );
  const instance = createDesktopApp({
    store,
    adapters: (id) => (id === "fake" ? adapter : null),
    detect: async () => [
      {
        id: "fake",
        name: "Fake",
        vendor: "Test",
        supportsVision: adapter.supportsVision,
        ...(await adapter.detect()),
      },
    ],
  });
  const address = await instance.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await instance.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = async (path, { method = "GET", body, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: EXTENSION,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
      headers: response.headers,
    };
  };
  const pair = async () => {
    const result = await call("/api/pair", {
      method: "POST",
      body: {
        code: instance.pairing.current().code,
        client: { name: "Test browser", browser: "test" },
      },
    });
    assert.equal(result.status, 200);
    return { Authorization: `Bearer ${result.body.token}` };
  };
  return { instance, store, base, call, pair, adapter };
}

test("loopback guard rejects foreign hosts and web origins but allows extension origins with CORS", async (t) => {
  const { call, base } = await app(t);
  const foreignHost = await new Promise((resolve, reject) => {
    const request = httpRequest(
      `${base}/api/status`,
      { headers: { Host: "evil.test" } },
      (response) => resolve(response.statusCode),
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(foreignHost, 403);
  const web = await call("/api/status", {
    headers: { Origin: "https://site.test" },
  });
  assert.equal(web.status, 403);
  const ok = await call("/api/status");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.app, "arjunah-desktop");
  assert.equal(ok.body.paired, false);
  assert.equal(ok.headers.get("access-control-allow-origin"), EXTENSION);
  const preflight = await fetch(`${base}/api/generate`, {
    method: "OPTIONS",
    headers: { Origin: EXTENSION, "Access-Control-Request-Method": "POST" },
  });
  assert.equal(preflight.status, 204);
});

test("pairing requires the current code, issues a hashed token, and can be revoked", async (t) => {
  const { call, store, instance, pair } = await app(t);
  const wrong = await call("/api/pair", {
    method: "POST",
    body: { code: "000000" },
  });
  assert.equal(wrong.status, 403);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const headers = await pair();
  const token = headers.Authorization.slice(7);
  assert.equal(
    JSON.stringify(store.data).includes(token),
    false,
    "the raw token must not be stored",
  );
  assert.equal((statSync(store.path).mode & 0o777).toString(8), "600");
  assert.notEqual(instance.pairing.current().code, undefined);
  const providers = await call("/api/providers", { headers });
  assert.equal(providers.status, 200);
  assert.equal(providers.body.providers.length, 1);
  assert.equal("binary" in providers.body.providers[0], false);
  const status = await call("/api/status", { headers });
  assert.equal(status.body.paired, true);
  const unpair = await call("/api/pair", { method: "DELETE", headers });
  assert.equal(unpair.status, 200);
  assert.equal((await call("/api/providers", { headers })).status, 401);
});

test("authenticated websocket events carry revisions and invalidate changed desktop state", async (t) => {
  const { call, instance, base } = await app(t);
  const paired = await call("/api/pair", {
    method: "POST",
    body: {
      code: instance.pairing.current().code,
      client: { name: "Live browser", browser: "test" },
    },
  });
  assert.equal(paired.status, 200);
  const socket = new WebSocket(
    `${base.replace(/^http:/, "ws:")}/api/events`,
    `arjunah.v1.client.${paired.body.token}`,
  );
  t.after(() => socket.close());
  const messages = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  const nextMessage = () =>
    messages.length
      ? Promise.resolve(messages.shift())
      : new Promise((resolve) => waiters.push(resolve));
  const helloPromise = nextMessage();
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const hello = await helloPromise;
  assert.equal(hello.type, "hello");
  assert.ok(Number.isInteger(hello.revision));

  const changedPromise = (async () => {
    for (;;) {
      const message = await nextMessage();
      if (message.type === "state.changed" && message.topic === "sync")
        return message;
    }
  })();
  const synced = await call("/api/sync", {
    method: "PUT",
    headers: { Authorization: `Bearer ${paired.body.token}` },
    body: { config: { active: { type: "openai" } } },
  });
  assert.equal(synced.status, 200);
  const changed = await changedPromise;
  assert.ok(changed.revision > hello.revision);
});

test("sync stores browser configuration with increasing revisions and masks keys on the dashboard", async (t) => {
  const { call, pair, instance, base } = await app(t);
  const headers = await pair();
  const first = await call("/api/sync", {
    method: "PUT",
    headers,
    body: {
      config: {
        openai: { model: "gpt-5.6-sol", apiKey: "sk-secret-value-1234" },
        opencode: {
          model: "gpt-5.6-luna",
          apiKey: "zen-secret-value-5678",
        },
        active: { type: "openai" },
      },
    },
  });
  assert.equal(first.body.revision, 1);
  const read = await call("/api/sync", { headers });
  assert.equal(read.body.config.openai.apiKey, "sk-secret-value-1234");
  assert.equal(read.body.config.opencode.apiKey, "zen-secret-value-5678");
  const dashboard = await fetch(`${base}/api/dashboard/state`, {
    headers: { "X-Dashboard-Token": instance.dashboardToken },
  });
  const state = await dashboard.json();
  assert.equal(JSON.stringify(state).includes("sk-secret-value-1234"), false);
  assert.equal(JSON.stringify(state).includes("zen-secret-value-5678"), false);
  assert.match(state.sync.config.openai.apiKey, /…/);
  assert.match(state.sync.config.opencode.apiKey, /…/);
  const forbidden = await fetch(`${base}/api/dashboard/state`, {
    headers: { "X-Dashboard-Token": "nope" },
  });
  assert.equal(forbidden.status, 403);
});

test("generate runs the adapter with system prompt and prompt split from messages", async (t) => {
  let seen;
  const { call, pair } = await app(t, (options) => {
    seen = options;
    return {
      child: null,
      output: Promise.resolve({
        content: "answer",
        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        contextTokens: 3,
        contextCachedTokens: 2,
        model: "default",
      }),
    };
  });
  const headers = await pair();
  const result = await call("/api/generate", {
    method: "POST",
    headers,
    body: {
      providerId: "fake",
      model: "default",
      messages: [
        { role: "system", content: "Rules." },
        { role: "user", content: "Hi" },
      ],
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.message.content, "answer");
  assert.equal(result.body.finishReason, "stop");
  assert.equal(result.body.contextTokens, 3);
  assert.equal(result.body.contextCachedTokens, 2);
  assert.equal(seen.systemPrompt, "Rules.");
  assert.equal(seen.prompt, "Hi");
  assert.equal(seen.mcp, null);
  const unknown = await call("/api/generate", {
    method: "POST",
    headers,
    body: { providerId: "nope", messages: [{ role: "user", content: "x" }] },
  });
  assert.equal(unknown.status, 400);
});

test("bridged tool calls pause the agent until the browser returns results through the next request", async (t) => {
  let mcpConfig;
  const { call, pair } = await app(t, (options) => {
    mcpConfig = options.mcp;
    const output = (async () => {
      const rpc = async (method, params, id = 1) => {
        const response = await fetch(options.mcp.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.mcp.token}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
        return response.status === 202 ? null : response.json();
      };
      const init = await rpc("initialize", { protocolVersion: "2025-03-26" });
      assert.equal(init.result.serverInfo.name, "arjunah-desktop");
      await rpc("notifications/initialized");
      const list = await rpc("tools/list", {});
      assert.deepEqual(
        list.result.tools.map((tool) => tool.name),
        ["site__echo"],
      );
      const unknown = await rpc("tools/call", { name: "other", arguments: {} });
      assert.equal(unknown.result.isError, true);
      const result = await rpc(
        "tools/call",
        { name: "site__echo", arguments: { value: "ping" } },
        2,
      );
      return {
        content: `tool said ${result.result.content[0].text}`,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "default",
      };
    })();
    return { child: null, output };
  });
  const headers = await pair();
  const tools = [
    {
      name: "site__echo",
      description: "Echo",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
      },
    },
  ];
  const messages = [{ role: "user", content: "Use the echo tool" }];
  const first = await call("/api/generate", {
    method: "POST",
    headers,
    body: { providerId: "fake", messages, tools },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.finishReason, "tool_calls");
  const [callItem] = first.body.message.toolCalls;
  assert.equal(callItem.name, "site__echo");
  assert.equal(callItem.arguments, '{"value":"ping"}');
  assert.match(mcpConfig.url, /\/mcp\//);
  const unauthorizedMcp = await fetch(mcpConfig.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
  });
  assert.equal(unauthorizedMcp.status, 401);
  const second = await call("/api/generate", {
    method: "POST",
    headers,
    body: {
      providerId: "fake",
      tools,
      messages: [
        ...messages,
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: callItem.id,
              type: "function",
              function: { name: callItem.name, arguments: callItem.arguments },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: callItem.id,
          content: '{"echoed":"ping"}',
        },
      ],
    },
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.message.content, 'tool said {"echoed":"ping"}');
});

test("concurrent MCP calls cross the browser loop without a debounce or all-results barrier", async (t) => {
  const { call, pair } = await app(t, (options) => {
    const invoke = async (name, id) => {
      const response = await fetch(options.mcp.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.mcp.token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: {} },
        }),
      });
      return (await response.json()).result.content[0].text;
    };
    return {
      child: null,
      output: Promise.all([invoke("site__a", 1), invoke("site__b", 2)]).then(
        (results) => ({
          content: results.join(" + "),
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "default",
        }),
      ),
    };
  });
  const headers = await pair();
  const tools = ["site__a", "site__b"].map((name) => ({
    name,
    inputSchema: { type: "object", properties: {} },
  }));
  const messages = [{ role: "user", content: "Use both tools" }];
  const round = async () => {
    const response = await call("/api/generate", {
      method: "POST",
      headers,
      body: { providerId: "fake", messages, tools },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    if (response.body.finishReason === "tool_calls") {
      const item = response.body.message.toolCalls[0];
      messages.push(
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: item.id,
              type: "function",
              function: { name: item.name, arguments: item.arguments },
            },
          ],
        },
        { role: "tool", tool_call_id: item.id, content: item.name },
      );
    }
    return response.body;
  };
  const first = await round();
  const second = await round();
  const final = await round();
  assert.deepEqual(
    [first, second].map((item) => item.message.toolCalls[0].name).sort(),
    ["site__a", "site__b"],
  );
  assert.equal(final.finishReason, "stop");
  assert.equal(final.message.content, "site__a + site__b");
  assert.equal("batchMs" in SESSION_LIMITS, false);
});

test("agent failures surface as provider errors without internals", async (t) => {
  const { call, pair } = await app(t, () => ({
    child: null,
    output: Promise.resolve({ isError: true, errorMessage: "Not logged in" }),
  }));
  const headers = await pair();
  const result = await call("/api/generate", {
    method: "POST",
    headers,
    body: { providerId: "fake", messages: [{ role: "user", content: "x" }] },
  });
  assert.equal(result.status, 502);
  assert.equal(result.body.error.code, "PROVIDER_ERROR");
  assert.match(result.body.error.message, /Not logged in/);
});

const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a vision provider receives image attachments and a text-only one does not", async (t) => {
  let seen;
  const behavior = (options) => {
    seen = options;
    return {
      child: null,
      output: Promise.resolve({
        content: "red",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "default",
      }),
    };
  };
  const vision = await app(t, behavior, { supportsVision: true });
  const visionHeaders = await vision.pair();
  const body = {
    providerId: "fake",
    model: "default",
    messages: [
      {
        role: "user",
        content: "What colour is this?\n[image]",
        images: [{ mediaType: "image/png", data: PIXEL }],
      },
    ],
  };
  const answered = await vision.call("/api/generate", {
    method: "POST",
    headers: visionHeaders,
    body,
  });
  assert.equal(answered.status, 200);
  assert.deepEqual(seen.images, [{ mediaType: "image/png", data: PIXEL }]);
  assert.match(seen.prompt, /What colour is this\?/);

  seen = undefined;
  const textOnly = await app(t, behavior);
  const textHeaders = await textOnly.pair();
  const dropped = await textOnly.call("/api/generate", {
    method: "POST",
    headers: textHeaders,
    body,
  });
  assert.equal(dropped.status, 200);
  assert.deepEqual(
    seen.images,
    [],
    "a provider without vision never sees the bytes",
  );
});

test("tool-result images resume the suspended MCP call instead of starting a second agent", async (t) => {
  let runs = 0;
  let returnedContent = null;
  const { call, pair } = await app(
    t,
    (options) => {
      runs++;
      options.onThread?.("agent-image-session");
      const output = (async () => {
        const response = await fetch(options.mcp.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.mcp.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "look", arguments: {} },
          }),
        });
        returnedContent = (await response.json()).result.content;
        return {
          content: "I can see it.",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "default",
          thread: "agent-image-session",
        };
      })();
      return { child: null, output };
    },
    { supportsVision: true },
  );
  const headers = await pair();
  const firstMessages = [{ role: "user", content: "Inspect the canvas." }];
  const first = await call("/api/generate", {
    method: "POST",
    headers,
    body: {
      providerId: "fake",
      model: "default",
      threadId: "canvas-1",
      messages: firstMessages,
      tools: [{ name: "look", inputSchema: { type: "object" } }],
    },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.finishReason, "tool_calls");
  const wireCall = first.body.message.toolCalls[0];
  const second = await call("/api/generate", {
    method: "POST",
    headers,
    body: {
      providerId: "fake",
      model: "default",
      threadId: "canvas-1",
      messages: [
        ...firstMessages,
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: wireCall.id,
              type: "function",
              function: { name: wireCall.name, arguments: wireCall.arguments },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: wireCall.id,
          content: "Canvas snapshot.",
        },
        {
          role: "user",
          content: "Image returned by the look tool.",
          images: [{ mediaType: "image/png", data: PIXEL }],
        },
      ],
      tools: [{ name: "look", inputSchema: { type: "object" } }],
    },
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.message.content, "I can see it.");
  assert.equal(runs, 1, "the original agent process remains the only writer");
  assert.deepEqual(returnedContent, [
    {
      type: "text",
      text: "Canvas snapshot.\n\nImage returned by the look tool.",
    },
    { type: "image", data: PIXEL, mimeType: "image/png" },
  ]);
});

test("image attachments are bounded and refused on non-user messages", async (t) => {
  const { call, pair } = await app(t, undefined, { supportsVision: true });
  const headers = await pair();
  const send = (message) =>
    call("/api/generate", {
      method: "POST",
      headers,
      body: { providerId: "fake", model: "default", messages: [message] },
    });
  const wrongRole = await send({
    role: "assistant",
    content: "x",
    images: [{ mediaType: "image/png", data: PIXEL }],
  });
  assert.equal(wrongRole.status, 400);
  const badType = await send({
    role: "user",
    content: "x",
    images: [{ mediaType: "image/svg+xml", data: PIXEL }],
  });
  assert.equal(badType.status, 400);
  const badData = await send({
    role: "user",
    content: "x",
    images: [{ mediaType: "image/png", data: "not base64!" }],
  });
  assert.equal(badData.status, 400);
});

test("prompt images come from the messages that prompt carries, newest kept", () => {
  const image = (tag) => ({ mediaType: "image/png", data: tag });
  const messages = [
    { role: "user", content: "a", images: [image("one")] },
    { role: "assistant", content: "ok" },
    { role: "user", content: "b", images: [image("two"), image("three")] },
  ];
  assert.deepEqual(
    collectImages(messages).map((item) => item.data),
    ["one", "two", "three"],
  );
  assert.deepEqual(
    collectImages(messages, 2).map((item) => item.data),
    ["two", "three"],
  );
  assert.deepEqual(collectImages([{ role: "user", content: "a" }]), []);
});

test("Claude Code sends images as a stream-json user message and Codex as files", async () => {
  const { streamJsonUserMessage } = await import(
    "../desktop/lib/providers/claude-code.mjs"
  );
  const line = streamJsonUserMessage("Describe it.", [
    { mediaType: "image/png", data: PIXEL },
  ]);
  assert.equal(line.endsWith("\n"), true);
  const parsed = JSON.parse(line);
  assert.equal(parsed.type, "user");
  assert.deepEqual(parsed.message.content, [
    { type: "text", text: "Describe it." },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: PIXEL },
    },
  ]);

  const { imageArguments } = await import("../desktop/lib/providers/codex.mjs");
  const directory = mkdtempSync(join(tmpdir(), "arjunah-image-test-"));
  const args = imageArguments(
    [
      { mediaType: "image/png", data: PIXEL },
      { mediaType: "image/webp", data: PIXEL },
    ],
    directory,
  );
  assert.deepEqual(args.filter((item) => item === "-i").length, 2);
  assert.match(args[1], /arjunah-image-0\.png$/);
  assert.match(args[3], /arjunah-image-1\.webp$/);
  assert.equal(statSync(args[1]).size > 0, true);
  rmSync(directory, { recursive: true, force: true });
});

test("transcript builder flattens history and detects trailing tool results", () => {
  const single = buildPrompt([
    { role: "system", content: "S" },
    { role: "user", content: "Only" },
  ]);
  assert.deepEqual(single, {
    systemPrompt: "S",
    prompt: "Only",
    transcript: false,
  });
  const messages = [
    { role: "system", content: "A" },
    { role: "system", content: "B" },
    { role: "user", content: "Q1" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "site__x", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
  ];
  const multi = buildPrompt(messages);
  assert.equal(multi.systemPrompt, "A\n\nB");
  assert.match(multi.prompt, /user: Q1/);
  assert.match(multi.prompt, /requested tool "site__x"/);
  assert.match(multi.prompt, /tool \(c1\): \{"ok":true\}/);
  assert.deepEqual(trailingToolResults(messages), [
    { id: "c1", content: '{"ok":true}' },
  ]);
  assert.equal(trailingToolResults([{ role: "user", content: "x" }]), null);
  assert.deepEqual(
    trailingToolResults([
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "look", function: { name: "look" } }],
      },
      { role: "tool", tool_call_id: "look", content: "Canvas snapshot." },
      {
        role: "user",
        content: "Image returned by the look tool.",
        images: [{ mediaType: "image/png", data: "aGVsbG8=" }],
      },
    ]),
    [
      {
        id: "look",
        content: "Canvas snapshot.\n\nImage returned by the look tool.",
        images: [{ mediaType: "image/png", data: "aGVsbG8=" }],
      },
    ],
  );
  assert.equal(
    trailingToolResults([
      { role: "assistant", content: "", tool_calls: [{ id: "a" }] },
      { role: "tool", tool_call_id: "b", content: "" },
    ]),
    null,
  );
});

test("sessions surface concurrent tool calls immediately and resume each result independently", async () => {
  const session = new ToolSession({ tools: [], model: "m", providerId: "p" });
  const a = session.call("site__a", { n: 1 });
  const b = session.call("site__b", { n: 2 });
  const first = await session.nextEvent();
  const second = await session.nextEvent();
  assert.deepEqual(
    [first, second].map((event) => event.calls[0].name),
    ["site__a", "site__b"],
  );
  assert.equal(session.matches([{ id: first.calls[0].id }]), true);
  session.resume([{ id: first.calls[0].id, content: "one" }]);
  assert.equal((await a).content, "one");
  assert.equal(session.pending.size, 1, "the sibling call remains pending");
  assert.equal(session.matches([{ id: second.calls[0].id }]), true);
  session.resume([{ id: second.calls[0].id, content: "two" }]);
  assert.equal((await b).content, "two");
  const other = new ToolSession({ tools: [], model: "m", providerId: "p" });
  const pending = other.call("site__c", {});
  other.end(true);
  assert.equal((await pending).isError, true);
  assert.ok(SESSION_LIMITS.resumeMs > 0);
});

test("partial tool results resume their live session without retiring sibling calls", async () => {
  const registry = new SessionRegistry();
  const session = registry.create({ tools: [], model: "m", providerId: "p" });
  const a = session.call("site__a", {});
  const b = session.call("site__b", {});
  const event = await session.nextEvent();
  const partial = [{ id: event.calls[0].id, content: "one" }];
  assert.equal(registry.findByResults(partial), session);
  assert.equal(registry.findByAnyResult(partial), session);
  session.resume(partial);
  assert.equal((await a).content, "one");
  assert.equal(session.pending.size, 1);
  session.end(true);
  assert.equal((await b).isError, true);
});

test("an agent that exits without draining stdin does not take the companion down", async () => {
  const { spawnAgent } = await import("../desktop/lib/providers/common.mjs");
  const { output } = spawnAgent({
    binary: "/bin/sh",
    args: ["-c", "exit 1"],
    // Larger than the pipe buffer, so the write cannot be absorbed and the
    // broken pipe surfaces as an EPIPE on the child's stdin stream.
    stdin: "x".repeat(2_000_000),
    parse: (stdout, stderr, code) => ({ stdout, stderr, code }),
  });
  assert.equal((await output).code, 1);
});

test("jwtPayload decodes an ID token payload and tolerates junk", async () => {
  const { jwtPayload } = await import("../desktop/lib/providers/common.mjs");
  const payload = Buffer.from(
    JSON.stringify({ email: "me@example.test", name: "Me" }),
  ).toString("base64url");
  assert.deepEqual(jwtPayload(`header.${payload}.sig`), {
    email: "me@example.test",
    name: "Me",
  });
  assert.equal(jwtPayload("not-a-token"), null);
  assert.equal(jwtPayload("a.!!!.c"), null);
  assert.equal(jwtPayload(null), null);
});

test("Codex output parsing keeps the commands the agent ran and the outer sandbox denies the home folder", async () => {
  const { parseCodexOutput, progressItem } = await import(
    "../desktop/lib/providers/codex.mjs"
  );
  const { outerSandbox } = await import("../desktop/lib/providers/common.mjs");
  const { mkdtempSync, readFileSync, readdirSync, rmSync } = await import(
    "node:fs"
  );
  const { tmpdir, homedir } = await import("node:os");
  const { join } = await import("node:path");
  const stdout = [
    JSON.stringify({ type: "thread.started" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "ls -la /Users/me/Documents",
        aggregated_output:
          "sandbox-exec: sandbox_apply: Operation not permitted\n",
        exit_code: 71,
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "I could not list that folder." },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 10, output_tokens: 4 },
    }),
  ].join("\n");
  const parsed = parseCodexOutput(stdout, "", 0, "default");
  assert.equal(parsed.content, "I could not list that folder.");
  assert.deepEqual(
    progressItem({
      type: "item.completed",
      item: { type: "agent_message", text: "I could not list that folder." },
    }),
    {
      type: "output_delta",
      text: "I could not list that folder.",
    },
  );
  // Codex can spend half a minute between launch and its first item, so every
  // lifecycle event becomes a line the browser can show.
  assert.deepEqual(progressItem({ type: "thread.started" }), {
    type: "phase",
    text: "Codex session started; sending the prompt…",
  });
  assert.deepEqual(progressItem({ type: "turn.started" }), {
    type: "phase",
    text: "Codex is working on the answer…",
  });
  assert.deepEqual(
    progressItem({ type: "item.started", item: { type: "reasoning" } }),
    { type: "phase", text: "Codex is reasoning…" },
  );
  assert.equal(progressItem({ type: "item.started", item: null }), null);
  assert.deepEqual(parsed.steps, [
    {
      type: "command",
      command: "ls -la /Users/me/Documents",
      exitCode: 71,
      output: "sandbox-exec: sandbox_apply: Operation not permitted\n",
    },
  ]);
  assert.equal(parsed.usage.totalTokens, 14);
  const scratch = mkdtempSync(join(tmpdir(), "arjunah-sandbox-test-"));
  try {
    const wrapped = outerSandbox({
      binary: "/opt/codex",
      args: ["exec", "--json"],
      scratch,
      allow: [join(homedir(), ".codex")],
    });
    if (process.platform !== "darwin") {
      assert.equal(wrapped, null);
      return;
    }
    assert.equal(wrapped.binary, "/usr/bin/sandbox-exec");
    assert.deepEqual(wrapped.args.slice(2), ["/opt/codex", "exec", "--json"]);
    const profile = readFileSync(wrapped.profilePath, "utf8");
    assert.match(
      profile,
      /\(deny file-read\* file-write\* \(subpath "[^"]+"\)\)/,
    );
    assert.ok(
      profile.includes(
        `(deny file-read-data (literal ${JSON.stringify(homedir())}))`,
      ),
    );
    assert.equal(
      profile.includes(
        `(subpath ${JSON.stringify(join(homedir(), ".codex"))})`,
      ),
      false,
      "the agent's own login data stays readable",
    );
    for (const entry of readdirSync(homedir())
      .filter((item) => item !== ".codex")
      .slice(0, 3))
      assert.ok(
        profile.includes(`(subpath ${JSON.stringify(join(homedir(), entry))})`),
      );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("Codex app-server parsing separates turn totals from the final request context", async () => {
  const { parseCodexAppServerMessages } = await import(
    "../desktop/lib/providers/codex.mjs"
  );
  const usage = (input, output, cached, total) => ({
    jsonrpc: "2.0",
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: {
        total: {
          totalTokens: total,
          inputTokens: total - output,
          cachedInputTokens: cached,
          cacheWriteInputTokens: 0,
          outputTokens: output,
          reasoningOutputTokens: 0,
        },
        last: {
          totalTokens: input + output,
          inputTokens: input,
          cachedInputTokens: cached,
          cacheWriteInputTokens: 0,
          outputTokens: output,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 258400,
      },
    },
  });
  const messages = [
    { id: "thread", result: { thread: { id: "thread-1" } } },
    { id: "turn", result: { turn: { id: "turn-1" } } },
    usage(100, 10, 80, 110),
    usage(200, 20, 160, 330),
    // app-server may repeat the final snapshot; it must not inflate the turn.
    usage(200, 20, 160, 330),
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "agentMessage", text: "Done" },
      },
    },
    {
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      },
    },
  ];
  const parsed = parseCodexAppServerMessages(messages, "", 0, "gpt-5.6-sol");
  assert.equal(parsed.content, "Done");
  assert.equal(parsed.usage.promptTokens, 300);
  assert.equal(parsed.usage.completionTokens, 30);
  assert.equal(parsed.usage.cachedTokens, 240);
  assert.equal(parsed.contextTokens, 200);
  assert.equal(parsed.contextCachedTokens, 160);
  assert.equal(parsed.contextWindow, 258400);
  assert.equal(parsed.thread, "thread-1");
});

test("live agent progress is recorded per turn and served to the paired browser", async (t) => {
  const { call, pair } = await app(t, ({ onProgress }) => {
    onProgress?.({ type: "command", phase: "start", id: "c1", command: "ls" });
    onProgress?.({
      type: "command",
      phase: "end",
      id: "c1",
      command: "ls",
      exitCode: 71,
      output: "denied",
    });
    onProgress?.({ type: "output_delta", text: "blo" });
    onProgress?.({ type: "output_delta", text: "cked" });
    return {
      child: null,
      output: Promise.resolve({
        content: "blocked",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "default",
        steps: [
          { type: "command", command: "ls", exitCode: 71, output: "denied" },
        ],
        reasoning: "I tried to list the folder.",
      }),
    };
  });
  const headers = await pair();
  const generated = await call("/api/generate", {
    method: "POST",
    headers,
    body: {
      providerId: "fake",
      model: "default",
      messages: [{ role: "user", content: "hi" }],
      progressId: "turn-1",
    },
  });
  assert.equal(generated.status, 200);
  assert.equal(generated.body.reasoning, "I tried to list the folder.");
  assert.equal(generated.body.steps[0].exitCode, 71);
  const all = await call("/api/progress/turn-1", { headers });
  assert.equal(all.body.done, true);
  // The run opens with phases, so a browser can say what the wait is for long
  // before the agent produces anything (SPEC 12.3.1).
  assert.deepEqual(
    all.body.items.filter((item) => item.type === "phase"),
    [
      { type: "phase", text: "Checking Fake on this computer…" },
      { type: "phase", text: "Starting Fake…" },
    ],
  );
  const progress = await call("/api/progress/turn-1?after=3", { headers });
  assert.equal(progress.body.total, 5);
  assert.equal(progress.body.items[0].phase, "end");
  assert.deepEqual(progress.body.items[1], {
    type: "output_delta",
    text: "blocked",
  });
  const anonymous = await call("/api/progress/turn-1");
  assert.equal(anonymous.status, 401);
});

test("text a browser already collected is never merged into, and the log explains the run", async (t) => {
  let emit = null;
  const { call, pair } = await app(t, ({ onProgress }) => {
    emit = onProgress;
    onProgress?.({ type: "output_delta", text: "one" });
    return {
      child: null,
      output: new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              content: "one two",
              usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
              model: "default",
            }),
          60,
        ),
      ),
    };
  });
  const headers = await pair();
  const generated = call("/api/generate", {
    method: "POST",
    headers,
    body: {
      providerId: "fake",
      model: "default",
      messages: [{ role: "user", content: "hi" }],
      progressId: "turn-2",
    },
  });
  // Poll the way the browser does, then let the agent append more text.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const first = await call("/api/progress/turn-2", { headers });
  assert.deepEqual(first.body.items.at(-1), {
    type: "output_delta",
    text: "one",
  });
  emit({ type: "output_delta", text: " two" });
  const second = await call(
    `/api/progress/turn-2?after=${first.body.items.length}`,
    { headers },
  );
  assert.deepEqual(second.body.items, [{ type: "output_delta", text: " two" }]);
  await generated;
  const logs = await call("/api/logs", { headers });
  assert.equal(logs.status, 200);
  assert.ok(logs.body.latest > 0);
  const messages = logs.body.entries.map((entry) => entry.message);
  assert.ok(messages.some((message) => message.startsWith("Checking Fake")));
  assert.ok(messages.some((message) => message.includes("detection finished")));
  assert.ok(
    logs.body.entries.every(
      (entry) =>
        typeof entry.seq === "number" &&
        typeof entry.at === "string" &&
        ["debug", "info", "warn", "error"].includes(entry.level),
    ),
  );
  const anonymous = await call("/api/logs");
  assert.equal(anonymous.status, 401);
  const cleared = await call("/api/logs", { method: "DELETE", headers });
  assert.equal(cleared.status, 200);
  const after = await call("/api/logs", { headers });
  assert.ok(after.body.entries.length <= 1);
});

test("a browser conversation reuses one agent thread and sends only the new messages", async (t) => {
  const runs = [];
  const { call, pair, instance } = await app(t, (options) => {
    runs.push(options);
    options.onThread?.("agent-session-1");
    return {
      child: null,
      output: Promise.resolve({
        content: `reply ${runs.length}`,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "default",
        thread: "agent-session-1",
      }),
    };
  });
  const headers = await pair();
  const first = await call("/api/generate", {
    method: "POST",
    headers,
    body: {
      providerId: "fake",
      model: "default",
      threadId: "conv-1",
      reasoning: "high",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Remember ZEBRA." },
      ],
    },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.thread, true);
  assert.equal(
    runs[0].thread?.handle ?? null,
    null,
    "first run: no handle yet",
  );
  assert.equal(runs[0].reasoning, "high");
  assert.match(runs[0].prompt, /Remember ZEBRA/);
  const second = await call("/api/generate", {
    method: "POST",
    headers,
    body: {
      providerId: "fake",
      model: "default",
      threadId: "conv-1",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Remember ZEBRA." },
        { role: "assistant", content: "reply 1" },
        { role: "user", content: "What was the word?" },
      ],
    },
  });
  assert.equal(second.status, 200);
  assert.equal(runs[1].thread?.handle, "agent-session-1", "second run resumes");
  assert.equal(
    runs[1].prompt,
    "What was the word?",
    "only the new message is sent",
  );
  assert.equal(
    runs[1].scratch.directory,
    runs[0].scratch.directory,
    "same working directory",
  );
  // A different system prompt (e.g. widget options changed) starts a fresh thread.
  await call("/api/generate", {
    method: "POST",
    headers,
    body: {
      providerId: "fake",
      model: "default",
      threadId: "conv-1",
      messages: [
        { role: "system", content: "Be verbose." },
        { role: "user", content: "Hi" },
      ],
    },
  });
  assert.equal(runs[2].thread?.handle ?? null, null, "fresh thread");
  assert.notEqual(runs[2].scratch.directory, runs[0].scratch.directory);
  assert.match(runs[2].prompt, /Be verbose|Hi/);
  // Ending the conversation removes the thread; the next call starts over.
  const ended = await call("/api/threads/conv-1", {
    method: "DELETE",
    headers,
  });
  assert.equal(ended.body.ended, true);
  const again = await call("/api/threads/conv-1", {
    method: "DELETE",
    headers,
  });
  assert.equal(again.body.ended, false);
  assert.equal(
    (await call("/api/threads/conv-1", { method: "DELETE" })).status,
    401,
  );
});

test("Claude Code stream output yields text, thinking tokens, context window, and rate-limit quota", async () => {
  const { parseClaudeOutput, progressItem } = await import(
    "../desktop/lib/providers/claude-code.mjs"
  );
  const lines = [
    { type: "system", subtype: "init", session_id: "s-1" },
    { type: "system", subtype: "thinking_tokens", estimated_tokens: 102 },
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Count the primes." },
          { type: "text", text: "5" },
        ],
        usage: {
          input_tokens: 7,
          cache_read_input_tokens: 3000,
          cache_creation_input_tokens: 400,
          output_tokens: 10,
        },
      },
    },
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: {
          five_hour: { utilization: 0.56, resetsAt: 1789249800 },
          seven_day: { utilization: 0.25 },
        },
      },
    },
    {
      type: "result",
      subtype: "success",
      result: "5",
      session_id: "s-1",
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 4341,
        cache_creation_input_tokens: 758,
        output_tokens: 83,
        output_tokens_details: { thinking_tokens: 80 },
      },
      modelUsage: { "claude-opus-5[1m]": { contextWindow: 1000000 } },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
  const parsed = parseClaudeOutput(lines, "", 0, "default");
  assert.equal(parsed.content, "5");
  assert.equal(parsed.usage.promptTokens, 5101);
  assert.equal(parsed.usage.cachedTokens, 4341);
  assert.equal(parsed.usage.reasoningTokens, 80);
  assert.equal(parsed.contextWindow, 1000000);
  assert.equal(parsed.contextTokens, 3407);
  assert.equal(parsed.contextCachedTokens, 3000);
  assert.equal(parsed.reasoning, "Count the primes.");
  assert.equal(parsed.thread, "s-1");
  assert.deepEqual(parsed.quota, {
    used: 56,
    limit: 100,
    unit: "% of the 5-hour window",
    resetsAt: new Date(1789249800 * 1000).toISOString(),
    label: "7-day window 25% used",
  });
  assert.deepEqual(
    progressItem({
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: 102,
    }),
    { type: "thinking", tokens: 102 },
  );
  assert.deepEqual(
    progressItem({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "partial" },
      },
    }),
    { type: "output_delta", text: "partial" },
  );
  assert.deepEqual(progressItem({ type: "system", subtype: "init" }), {
    type: "phase",
    text: "Claude Code session ready; sending the prompt…",
  });
  assert.equal(parseClaudeOutput("", "boom", 1, "default").isError, true);
});

test("a Claude Code run that hits a ceiling reports why instead of an empty message", async () => {
  const { parseClaudeOutput } = await import(
    "../desktop/lib/providers/claude-code.mjs"
  );
  // The CLI reports these with an empty `result`, so the subtype is the message.
  const ceiling = parseClaudeOutput(
    `${JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      num_turns: 121,
      result: "",
      session_id: "s-1",
    })}\n`,
    "",
    0,
    "default",
  );
  assert.equal(ceiling.isError, true);
  assert.match(ceiling.errorMessage, /^Claude Code stopped after \d+ turns/);
  const unknown = parseClaudeOutput(
    `${JSON.stringify({
      type: "result",
      subtype: "error_surprise",
      is_error: true,
      result: "   ",
    })}\n`,
    "",
    0,
    "default",
  );
  assert.equal(
    unknown.errorMessage,
    "Claude Code reported error_surprise.",
    "an unknown subtype still says something",
  );
  assert.equal(
    parseClaudeOutput(
      `${JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "the model refused",
      })}\n`,
      "",
      0,
      "default",
    ).errorMessage,
    "the model refused",
    "a reported reason still wins over the subtype",
  );
});

test("a conversation keeps its CLI session between turns and loses it after ten idle minutes", async (t) => {
  // Faked before the app exists, so the thread's clock and the sweep agree.
  t.mock.timers.enable({ apis: ["Date"] });
  const runs = [];
  const { call, pair } = await app(t, (options) => {
    runs.push(options);
    options.onThread?.("agent-session-1");
    return {
      child: null,
      output: Promise.resolve({
        content: `reply ${runs.length}`,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "default",
        thread: "agent-session-1",
      }),
    };
  });
  // The faked clock starts at zero, where the pairing throttle sees no gap yet.
  t.mock.timers.tick(2_000);
  const headers = await pair();
  // The browser posts the whole conversation so far on every turn.
  const history = [];
  const turn = async (content) => {
    history.push({ role: "user", content });
    const response = await call("/api/generate", {
      method: "POST",
      headers,
      body: {
        providerId: "fake",
        model: "default",
        threadId: "conv-idle",
        messages: history,
      },
    });
    history.push({
      role: "assistant",
      content: response.body?.message?.content,
    });
    return response;
  };
  assert.equal((await turn("Remember ZEBRA.")).status, 200);
  t.mock.timers.tick(9 * 60_000);
  assert.equal((await turn("Still there?")).status, 200);
  assert.equal(
    runs[1].thread?.handle,
    "agent-session-1",
    "a conversation that is still warm resumes its CLI session",
  );
  t.mock.timers.tick(11 * 60_000);
  assert.equal((await turn("And now?")).status, 200);
  assert.equal(
    runs[2].thread?.handle ?? null,
    null,
    "past ten idle minutes the session is gone and the next turn starts fresh",
  );
  assert.notEqual(
    runs[2].scratch.directory,
    runs[0].scratch.directory,
    "the expired thread's working directory went with it",
  );
});

test("Claude Code's own turn ceiling sits above the protocol's tool-round limit", async () => {
  const { start } = await import("../desktop/lib/providers/claude-code.mjs");
  const { LIMITS } = await import("../src/lib/constants.js");
  let spawned = null;
  const run = start({
    binary: "/bin/echo",
    model: "default",
    systemPrompt: "",
    prompt: "hi",
    onLog: (_level, message) => {
      spawned ??= message;
    },
  });
  run.child?.kill?.("SIGKILL");
  await run.output.catch(() => {});
  // Every tool round of a turn runs inside one `claude -p` process, because the
  // MCP call blocks until the browser answers. A ceiling at or below the
  // protocol's own limit would end the run before the browser's limit spoke.
  const args = run.child?.spawnargs ?? [];
  const turns = Number(args[args.indexOf("--max-turns") + 1]);
  assert.ok(
    turns > LIMITS.toolRounds,
    `--max-turns ${turns} must exceed the ${LIMITS.toolRounds}-round protocol ceiling`,
  );
});

test("ending a Claude Code thread deletes the conversation behind a symlinked scratch path", async (t) => {
  const { endThread, sessionDirectories } = await import(
    "../desktop/lib/providers/claude-code.mjs"
  );
  const root = mkdtempSync(join(tmpdir(), "arjunah-claude-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = join(root, "config");
  const real = join(root, "real-scratch");
  const link = join(root, "linked-scratch");
  mkdirSync(real, { recursive: true });
  symlinkSync(real, link, "dir");
  // Claude Code slugifies the working directory it resolved, not the spelling
  // it was handed — the difference macOS's /var → /private/var symlink creates.
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  });
  const handle = "6f1d6a9e-40bb-4f0e-9a0a-6a9b0f2a5c31";
  const [resolvedDirectory] = sessionDirectories(link);
  assert.equal(
    resolvedDirectory,
    join(config, "projects", realpathSync(real).replace(/[^A-Za-z0-9]/g, "-")),
  );
  mkdirSync(join(resolvedDirectory, "memory"), { recursive: true });
  const transcript = join(resolvedDirectory, `${handle}.jsonl`);
  writeFileSync(transcript, '{"type":"user"}\n');
  endThread(handle, link);
  assert.equal(
    existsSync(transcript),
    false,
    "the conversation must not survive the thread that made it",
  );
  assert.equal(
    existsSync(resolvedDirectory),
    false,
    "the emptied project directory goes too, memory folder and all",
  );
});

test("a logged command line keeps flags and drops long values", async () => {
  const { describeCommand } = await import(
    "../desktop/lib/providers/common.mjs"
  );
  const line = describeCommand("/bin/claude", [
    "-p",
    "--system-prompt",
    "You are a site assistant. ".repeat(20),
  ]);
  assert.ok(line.includes("-p --system-prompt"));
  assert.ok(!line.includes("site assistant"));
});

test("the log buffer is bounded, ordered, and readable by sequence", async () => {
  const { LogBuffer } = await import("../desktop/lib/logs.mjs");
  const seen = [];
  const logs = new LogBuffer({ limit: 3, sink: (entry) => seen.push(entry) });
  for (const index of [1, 2, 3, 4]) logs.add("info", "codex", `line ${index}`);
  assert.deepEqual(
    logs.entries.map((entry) => entry.message),
    ["line 2", "line 3", "line 4"],
  );
  assert.equal(seen.length, 4);
  assert.deepEqual(
    logs.since(3).map((entry) => entry.message),
    ["line 4"],
  );
  assert.equal(logs.add("nonsense", "x", "y").level, "info");
  logs.clear();
  assert.deepEqual(logs.entries, []);
});

test("OpenCode verbose model listing yields limits and capabilities", async () => {
  const { parseModelList } = await import(
    "../desktop/lib/providers/opencode.mjs"
  );
  const stdout = `opencode/big-pickle\n{\n  "id": "big-pickle",\n  "name": "Big Pickle",\n  "limit": { "context": 200000, "output": 32000 },\n  "capabilities": { "reasoning": true, "toolcall": true, "input": { "text": true, "image": false } }\n}\nother/plain\n`;
  const models = parseModelList(stdout);
  assert.equal(models.length, 2);
  assert.equal(models[0].contextWindow, 200000);
  assert.deepEqual(models[0].capabilities, {
    tools: true,
    vision: false,
    reasoning: true,
  });
  // `opencode run` has no image input, so an image-capable upstream model is
  // still advertised as text only rather than accepting bytes it would drop.
  const imageCapable = parseModelList(
    `x/sees\n{ "id": "sees", "capabilities": { "input": { "text": true, "image": true } } }\n`,
  );
  assert.equal(imageCapable[0].capabilities.vision, false);
  assert.equal(models[0].displayName, "Big Pickle (opencode/big-pickle)");
  assert.equal(models[1].contextWindow, null);
  assert.equal(models[1].capabilities.reasoning, false);
  const { describeOpenCodeCredentials } = await import(
    "../desktop/lib/providers/opencode.mjs"
  );
  assert.deepEqual(
    describeOpenCodeCredentials({
      "opencode-go": { type: "api", key: "secret" },
      anthropic: { type: "oauth", access: "x" },
    }),
    [
      { id: "opencode-go", label: "OpenCode Go", type: "API key" },
      { id: "anthropic", label: "Anthropic", type: "sign-in" },
    ],
  );
  const retired = parseModelList(
    `x/old\n{ "id": "old", "status": "deprecated" }\nx/free-one\n{ "id": "free-one", "name": "Free One", "status": "active", "cost": { "input": 0, "output": 0 } }\n`,
  );
  assert.deepEqual(
    retired.map((model) => `${model.id}:${model.free}`),
    ["x/free-one:true"],
  );
});

test("Claude Code control-protocol probe yields account, model list, and plan windows", async () => {
  const { parseClaudeProbe, claudePlanLabel } = await import(
    "../desktop/lib/providers/claude-code.mjs"
  );
  const messages = [
    { type: "system", subtype: "init" },
    {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "init",
        response: {
          account: {
            email: "me@example.test",
            organization: "Acme",
            subscriptionType: "Claude Team",
            apiProvider: "firstParty",
          },
          models: [
            {
              value: "default",
              resolvedModel: "claude-opus-5[1m]",
              displayName: "Default (recommended)",
              description: "Opus 5 with 1M context",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
            },
            {
              value: "sonnet",
              resolvedModel: "claude-sonnet-5",
              displayName: "Sonnet",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "ultrathink"],
            },
            {
              value: "haiku",
              resolvedModel: "claude-haiku-4-5",
              displayName: "Haiku",
              supportsEffort: false,
            },
          ],
        },
      },
    },
    {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "usage",
        response: {
          subscription_type: "team",
          rate_limits_available: true,
          rate_limits: {
            five_hour: {
              utilization: 18,
              resets_at: "2026-09-13T08:50:00.037064+00:00",
            },
            seven_day: {
              utilization: 31,
              resets_at: "2026-09-18T13:00:00+00:00",
            },
            nimbus_quill: { utilization: 0, resets_at: null },
            model_scoped: [
              {
                display_name: "Fable",
                utilization: 47,
                resets_at: "2026-09-18T13:00:00+00:00",
              },
            ],
          },
        },
      },
    },
  ];
  const probe = parseClaudeProbe(messages);
  assert.equal(probe.account.email, "me@example.test");
  assert.equal(probe.account.organization, "Acme");
  assert.equal(probe.models.length, 3);
  assert.equal(probe.models[0].contextWindow, 1_000_000);
  assert.equal(probe.models[1].contextWindow, 200_000);
  assert.equal(
    parseClaudeProbe([
      messages[0],
      {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "init",
          response: {
            account: {},
            models: [
              {
                value: "fable[1m]",
                resolvedModel: "claude-fable-5-1",
                displayName: "Fable",
              },
            ],
          },
        },
      },
    ]).models[0].contextWindow,
    1_000_000,
    "the [1m] marker may sit on the selectable value",
  );
  assert.deepEqual(probe.models[1].reasoningLevels, ["low", "medium", "high"]);
  assert.equal(probe.models[2].capabilities.reasoning, false);
  assert.equal(probe.quota.used, 18);
  assert.equal(probe.quota.resetsAt, "2026-09-13T08:50:00.037Z");
  assert.deepEqual(
    probe.quota.windows.map((w) => `${w.id}:${w.usedPercent}`),
    ["five_hour:18", "seven_day:31", "seven_day_fable:47"],
  );
  assert.equal(probe.quota.label, "Weekly 31% · Weekly · Fable 47%");
  assert.equal(claudePlanLabel("Claude Team"), "Claude Team");
  assert.equal(
    claudePlanLabel("claude_max_20x_subscription"),
    "Claude Max 20x",
  );
  assert.equal(claudePlanLabel("pro"), "Claude Pro");
  assert.equal(parseClaudeProbe([]), null);
});

test("Codex app-server probe yields account, rate-limit windows, spend, and models", async () => {
  const { parseCodexProbe } = await import(
    "../desktop/lib/providers/codex.mjs"
  );
  const messages = [
    { id: "init", result: { userAgent: "codex/0.153.4" } },
    { method: "remoteControl/status/changed", params: {} },
    {
      id: "account",
      result: {
        account: {
          type: "chatgpt",
          email: "me@example.test",
          planType: "team",
        },
        requiresOpenaiAuth: true,
      },
    },
    {
      id: "limits",
      result: {
        rateLimits: {
          limitId: "codex",
          planType: "team",
          primary: {
            usedPercent: 3,
            windowDurationMins: 300,
            resetsAt: 1789293465,
          },
          secondary: {
            usedPercent: 16,
            windowDurationMins: 10080,
            resetsAt: 1789833137,
          },
          individualLimit: {
            limit: "20",
            used: "9.100202322006226",
            remainingPercent: 54,
            resetsAt: 1790812801,
          },
        },
      },
    },
    {
      id: "models",
      result: {
        data: [
          {
            id: "gpt-6-astra",
            displayName: "GPT-6-Astra",
            isDefault: true,
            hidden: false,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "high" },
              { reasoningEffort: "ultra" },
            ],
            inputModalities: ["text", "image"],
          },
          {
            id: "secret",
            displayName: "Hidden",
            hidden: true,
            supportedReasoningEfforts: [],
          },
        ],
        nextCursor: null,
      },
    },
  ];
  const probe = parseCodexProbe(messages);
  assert.deepEqual(probe.account, {
    type: "chatgpt",
    email: "me@example.test",
    planType: "team",
  });
  assert.equal(probe.models.length, 1, "hidden models are dropped");
  assert.deepEqual(probe.models[0].reasoningLevels, ["low", "high"]);
  assert.equal(probe.models[0].defaultReasoning, "low");
  assert.equal(probe.models[0].acceptsImages, true);
  assert.equal(probe.quota.used, 3);
  assert.equal(probe.quota.windows[0].label, "Session (5h)");
  assert.equal(probe.quota.windows[1].label, "Weekly");
  assert.equal(
    probe.quota.windows[1].resetsAt,
    new Date(1789833137 * 1000).toISOString(),
  );
  assert.match(probe.quota.label, /Spend \$9\.10 of \$20 · Weekly 16%/);
  assert.equal(probe.quota.note, "Spend $9.10 of $20");
});
