import test from "node:test";
import assert from "node:assert/strict";
import { broker, toolReply } from "./helpers/broker.mjs";

const manifest = {
  name: "Test",
  tools: [
    {
      name: "echo",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
    },
  ],
};

test("direct tool fields survive the actual background/provider path; unlisted models never fetch", async (t) => {
  const b = await broker(t);
  await b.approve(["models.generate"]);
  await b.ok("models.generate", {
    messages: [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "c",
            type: "function",
            function: { name: "echo", arguments: "{}" },
          },
        ],
      },
      { role: "tool", content: "ok", toolCallId: "c" },
    ],
  });
  const messages = b.requests[0].payload.messages;
  assert.equal(messages[0].tool_calls[0].id, "c");
  assert.equal(messages[1].tool_call_id, "c");
  assert.equal(
    (
      await b.call("models.generate", {
        model: "expensive",
        messages: [{ role: "user", content: "hi" }],
      })
    ).error.code,
    "INVALID_REQUEST",
  );
  assert.equal(b.requests.length, 1);
});

test("OpenAI key retention works for both Save and Test, and settings never receives the secret", async (t) => {
  const b = await broker(t);
  const input = {
    baseUrl: "https://api.openai.com/v1",
    model: "allowed",
    keepApiKey: true,
  };
  b.hooks.fetch = async (url) =>
    Response.json(
      url.endsWith("/models")
        ? { data: [{ id: "allowed" }] }
        : { choices: [{ message: { content: "Connected." } }] },
    );
  assert.equal(
    (await b.call("provider.test", input, b.extension)).error.message,
    "An OpenAI API key is required. Enter a key or select Use saved API key.",
  );
  assert.equal(b.requests.length, 0);
  await b.ok("provider.save", { ...input, apiKey: "new-secret" }, b.extension);
  await b.ok("provider.test", input, b.extension);
  assert.equal(b.requests[0].init.headers.Authorization, "Bearer new-secret");
  assert.equal(b.store.provider.apiKey, "new-secret");
  assert.equal((await b.ok("provider.get", {}, b.extension)).apiKey, undefined);
});

test("OpenCode Zen key, catalog, and default selection stay independent from OpenAI", async (t) => {
  const b = await broker(t);
  const input = {
    baseUrl: "https://opencode.ai/zen/v1",
    model: "gpt-5.6-luna",
    keepApiKey: true,
  };
  b.hooks.fetch = async (url) => {
    if (url.endsWith("/models"))
      return Response.json({
        data: [
          { id: "gpt-5.6-luna" },
          { id: "claude-sonnet-4-6" },
          { id: "gemini-3.1-pro" },
          { id: "deepseek-v4-flash-vision-exp" },
          { id: "jev-1.13" },
        ],
      });
    return Response.json({
      id: "response-1",
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Connected." }],
        },
      ],
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    });
  };
  assert.equal(
    (await b.call("opencode.test", input, b.extension)).error.message,
    "An OpenCode Zen API key is required.",
  );
  const saved = await b.ok(
    "opencode.save",
    { ...input, apiKey: "zen-secret" },
    b.extension,
  );
  assert.deepEqual(saved.models.sort(), [
    "claude-sonnet-4-6",
    "deepseek-v4-flash-vision-exp",
    "gemini-3.1-pro",
    "gpt-5.6-luna",
  ]);
  const tested = await b.ok("opencode.test", input, b.extension);
  assert.equal(tested.generationVerified, true);
  assert.equal(b.store.opencode.apiKey, "zen-secret");
  assert.equal((await b.ok("opencode.get", {}, b.extension)).apiKey, undefined);
  await b.ok(
    "provider.select",
    { type: "opencode", model: "gpt-5.6-luna" },
    b.extension,
  );
  const catalog = await b.ok("catalog.get", {}, b.extension);
  assert.equal(catalog.defaultModel, "opencode/gpt-5.6-luna");
  assert.ok(
    catalog.providers
      .find((provider) => provider.id === "opencode")
      .models.some((model) => model.id === "opencode/claude-sonnet-4-6"),
  );
  assert.equal(b.store.provider.apiKey, "dummy-audit-key");
});

test("an OpenCode Zen key alone discovers the catalog and picks a default", async (t) => {
  const b = await broker(t);
  const catalogs = [];
  b.hooks.fetch = async (url) => {
    if (url.endsWith("/models")) {
      catalogs.push(url);
      return Response.json({
        data: [
          { id: "jev-1.13" },
          { id: "claude-sonnet-4-6" },
          { id: "gemini-3.1-pro" },
        ],
      });
    }
    throw new Error(`unexpected request to ${url}`);
  };
  // No model is sent: the key is what discovers which models exist, so asking
  // for one first would mean asking the user to guess.
  const saved = await b.ok(
    "opencode.save",
    { baseUrl: "https://opencode.ai/zen/v1", apiKey: "zen-secret" },
    b.extension,
  );
  assert.equal(catalogs.length, 1);
  assert.deepEqual(saved.models, ["claude-sonnet-4-6", "gemini-3.1-pro"]);
  assert.equal(
    saved.model,
    "claude-sonnet-4-6",
    "the account's own catalog picks the default when the preferred id is absent",
  );
  // The picker must offer exactly what the key discovered, and nothing else.
  const catalog = await b.ok("catalog.get", {}, b.extension);
  const provider = catalog.providers.find((item) => item.id === "opencode");
  assert.deepEqual(
    provider.models.map((model) => model.id),
    ["opencode/claude-sonnet-4-6", "opencode/gemini-3.1-pro"],
  );
  assert.equal(provider.defaultModel, "opencode/claude-sonnet-4-6");
  assert.equal(provider.available, true);
  // Saving a second provider's key must not hijack the global default.
  assert.equal(catalog.defaultModel, "openai/allowed");
  // A model this key cannot call is refused rather than silently substituted.
  assert.equal(
    (
      await b.call(
        "opencode.save",
        { baseUrl: "https://opencode.ai/zen/v1", model: "gpt-5.6-luna" },
        b.extension,
      )
    ).error.message,
    "OpenCode Zen does not offer gpt-5.6-luna on this key. Choose a model from the list.",
  );
  // Changing only the default reuses the stored key rather than demanding it again.
  const moved = await b.ok(
    "opencode.save",
    { baseUrl: "https://opencode.ai/zen/v1", model: "gemini-3.1-pro" },
    b.extension,
  );
  assert.equal(moved.model, "gemini-3.1-pro");
  assert.equal(b.store.opencode.apiKey, "zen-secret");
});

test("malformed extension grant origins are rejected as invalid requests", async (t) => {
  const b = await broker(t);
  const result = await b.call(
    "grants.revoke",
    { origin: "not an origin" },
    b.extension,
  );
  assert.equal(result.error.code, "INVALID_REQUEST");
});

for (const change of [
  "navigation",
  "registration",
  "revoke",
  "clear",
  "tab-close",
]) {
  test(`${change} during a model round prevents tool execution and further transmission`, async (t) => {
    const b = await broker(t);
    const params = await b.prepare(manifest);
    b.hooks.fetch = async () => {
      if (change === "navigation")
        b.sessions.set(1, {
          origin: "https://other.test",
          session: "new-session",
          registrationId: "new",
        });
      if (change === "registration") b.sessions.get(1).registrationId = "new";
      if (change === "revoke") await b.ok("grant.revoke");
      if (change === "clear") await b.ok("grants.clear", {}, b.extension);
      if (change === "tab-close") b.removed(1);
      return toolReply("site__echo", '{"value":"test"}');
    };
    assert.equal(
      (await b.call("chat.complete", params)).error.code,
      "PERMISSION_REQUIRED",
    );
    assert.equal(b.invocations.length, 0);
    assert.equal(b.requests.length, 1);
  });
}

test("revocation during a tool handler prevents its result reaching the provider", async (t) => {
  const b = await broker(t);
  const params = await b.prepare(manifest);
  b.hooks.fetch = async () => toolReply("site__echo", '{"value":"test"}');
  b.hooks.tool = async () => {
    await b.ok("grant.revoke");
    return { secret: "do not send" };
  };
  assert.equal(
    (await b.call("chat.complete", params)).error.code,
    "PERMISSION_REQUIRED",
  );
  assert.equal(b.requests.length, 1);
  assert.equal(b.invocations.length, 1);
});

test("grant mutation queue prevents a stale approval from resurrecting a revocation", async (t) => {
  const b = await broker(t);
  await b.approve(["models.generate"]);
  const senderB = b.sender("https://b.test", 2);
  b.sessions.set(2, { origin: "https://b.test", session: "b" });
  let release, arrived;
  const reached = new Promise((r) => (arrived = r)),
    held = new Promise((r) => (release = r));
  b.hooks.set = async (value) => {
    if (
      value.grants?.["https://b.test"] &&
      value.grants?.["https://site.test"]
    ) {
      arrived();
      await held;
    }
  };
  const approval = b.approve(["models.list"], {}, senderB);
  await reached;
  const revoke = b.ok("grant.revoke");
  release();
  await Promise.all([approval, revoke]);
  assert.equal(await b.ok("grant.query"), null);
  assert.deepEqual((await b.ok("grant.query", {}, senderB)).capabilities, [
    "models.list",
  ]);
});

test("concurrent approvals preserve both origins and clear-all is ordered", async (t) => {
  const b = await broker(t);
  const senderB = b.sender("https://b.test", 2);
  b.sessions.set(2, { origin: "https://b.test", session: "b" });
  await Promise.all([
    b.approve(["models.list"]),
    b.approve(["models.generate"], {}, senderB),
  ]);
  assert.equal(Object.keys(b.store.grants).length, 2);
  await Promise.all([
    b.approve(["context.read"]),
    b.ok("grants.clear", {}, b.extension),
  ]);
  assert.equal(Object.keys(b.store.grants ?? {}).length, 0);
});

test("documented context and tool-result maxima reach the model intact", async (t) => {
  const b = await broker(t);
  const text = "\u0001".repeat(20000);
  assert.equal(
    (await b.call("extension.chat", { history: [] }, b.extension)).error.code,
    "NOT_SUPPORTED",
    "the popup no longer hosts its own chat",
  );
  const params = await b.prepare(manifest, ["text"]);
  let count = 0;
  b.hooks.fetch = async () =>
    ++count === 1
      ? toolReply("site__echo", '{"value":"test"}')
      : Response.json({ choices: [{ message: { content: "done" } }] });
  b.hooks.tool = () => "x".repeat(65534);
  await b.ok("chat.complete", { ...params, context: { text } });
  assert.ok(
    b.requests[0].payload.messages.some((m) =>
      m.content.includes(JSON.stringify(text)),
    ),
  );
  assert.equal(
    b.requests.at(-1).payload.messages.find((m) => m.role === "tool").content
      .length,
    65536,
  );
});

test("long valid site names receive callable provider aliases", async (t) => {
  const b = await broker(t);
  const name = "x".repeat(64);
  const params = await b.prepare({ name: "Long", tools: [{ name }] });
  let count = 0;
  b.hooks.fetch = async (_url, _init, payload) =>
    ++count === 1
      ? toolReply(payload.tools[0].function.name)
      : Response.json({ choices: [{ message: { content: "done" } }] });
  await b.ok("chat.complete", params);
  assert.equal(b.invocations[0].name, name);
  assert.ok(b.requests[0].payload.tools[0].function.name.length <= 64);
});

for (const args of ["not JSON", "{}", '{"value":42}']) {
  test(`invalid tool arguments are returned as a safe tool error without invoking a handler: ${args}`, async (t) => {
    const b = await broker(t);
    const params = await b.prepare(manifest);
    let count = 0;
    b.hooks.fetch = async () =>
      ++count === 1
        ? toolReply("site__echo", args)
        : Response.json({ choices: [{ message: { content: "done" } }] });
    await b.ok("chat.complete", params);
    assert.equal(b.invocations.length, 0);
    assert.equal(
      JSON.parse(b.requests[1].payload.messages.at(-1).content).isError,
      true,
    );
  });
}

test("unapproved contracts, foreign preparation tokens, and subframes are rejected", async (t) => {
  const b = await broker(t);
  const reg = await b.register(manifest);
  await b.approve(["models.generate", "chat.hosted", "tools.site"]);
  assert.equal(
    (await b.call("chat.prepare", { manifest, registrationId: reg.id })).error
      .code,
    "PERMISSION_REQUIRED",
  );
  const params = await b.prepare(manifest);
  b.sessions.get(1).session = "changed";
  assert.equal(
    (await b.call("chat.complete", params)).error.code,
    "PERMISSION_REQUIRED",
  );
  assert.equal(
    (await b.call("models.list", {}, { ...b.sender(), frameId: 1 })).error.code,
    "NOT_SUPPORTED",
  );
  assert.equal(b.requests.length, 0);
});

function mcpMock(b, remoteTools) {
  return async (_url, _init, request) => {
    if (!request.method)
      return Response.json({ choices: [{ message: { content: "done" } }] });
    if (request.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result:
        request.method === "initialize"
          ? { protocolVersion: "2025-03-26" }
          : { tools: remoteTools },
    });
  };
}

test("MCP tool discovery requires origin approval and execution requires the exact disclosed tool set", async (t) => {
  const b = await broker(t);
  const remote = {
    name: "Remote",
    mcpServers: [{ id: "remote", url: "https://mcp.test/rpc" }],
  };
  const reg = await b.register(remote);
  const capabilities = ["chat.hosted", "models.generate", "tools.mcp"];
  await b.approve(capabilities, {
    registrationId: reg.id,
    _resources: { contractFingerprint: reg.fingerprint },
  });
  assert.equal(
    (await b.call("chat.prepare", { manifest: remote, registrationId: reg.id }))
      .error.code,
    "PERMISSION_REQUIRED",
  );
  assert.equal(b.requests.length, 0);
  const resources = {
    contractFingerprint: reg.fingerprint,
    mcpOrigins: ["https://mcp.test"],
  };
  await b.approve(capabilities, {
    registrationId: reg.id,
    _resources: resources,
  });
  b.hooks.fetch = mcpMock(b, [
    {
      name: "dangerous",
      description: "Delete a document",
      inputSchema: { type: "object" },
    },
  ]);
  const prep = await b.ok("chat.prepare", {
    manifest: remote,
    registrationId: reg.id,
  });
  assert.equal(prep.tools[0].description, "Delete a document");
  assert.equal(
    (
      await b.call("chat.complete", {
        preparedId: prep.id,
        fingerprint: reg.fingerprint,
        registrationId: reg.id,
        history: [{ role: "user", content: "hi" }],
      })
    ).error.code,
    "PERMISSION_REQUIRED",
  );
  assert.equal(b.requests.filter((r) => !r.payload.method).length, 0);
  const prep2 = await b.ok("chat.prepare", {
    manifest: remote,
    registrationId: reg.id,
  });
  await b.approve(capabilities, {
    registrationId: reg.id,
    preparedId: prep2.id,
    _resources: { ...resources, toolFingerprint: prep2.toolFingerprint },
  });
  await b.ok("chat.complete", {
    preparedId: prep2.id,
    fingerprint: reg.fingerprint,
    registrationId: reg.id,
    history: [{ role: "user", content: "hi" }],
  });
  assert.equal(b.requests.filter((r) => !r.payload.method).length, 1);
  b.hooks.fetch = mcpMock(b, [
    {
      name: "dangerous",
      description: "Changed semantics",
      inputSchema: { type: "object" },
    },
  ]);
  const prep3 = await b.ok("chat.prepare", {
    manifest: remote,
    registrationId: reg.id,
  });
  assert.notEqual(prep3.toolFingerprint, prep2.toolFingerprint);
  assert.equal(
    (
      await b.call("chat.complete", {
        preparedId: prep3.id,
        fingerprint: reg.fingerprint,
        registrationId: reg.id,
        history: [{ role: "user", content: "hi" }],
      })
    ).error.code,
    "PERMISSION_REQUIRED",
  );
});

test("MCP aliases preserve distinct names and aggregate limits fail before model requests", async (t) => {
  const b = await broker(t);
  const remote = {
    name: "Remote",
    mcpServers: [{ id: "s".repeat(64), url: "https://mcp.test/rpc" }],
  };
  b.hooks.fetch = mcpMock(b, [
    { name: "a.b" },
    { name: "a_b" },
    { name: "x".repeat(128) },
  ]);
  const params = await b.prepare(remote);
  await b.ok("chat.complete", params);
  const aliases = b.requests.at(-1).payload.tools.map((t) => t.function.name);
  assert.equal(new Set(aliases).size, 3);
  assert.ok(aliases.every((name) => name.length <= 64));
  b.hooks.fetch = mcpMock(
    b,
    Array.from({ length: 64 }, (_, i) => ({ name: `tool_${i}` })),
  );
  const tooMany = { ...remote, tools: [{ name: "site_tool" }] };
  const before = b.requests.filter((r) => !r.payload.method).length;
  await assert.rejects(
    b.prepare(tooMany),
    (error) => error.code === "INVALID_REQUEST",
  );
  assert.equal(b.requests.filter((r) => !r.payload.method).length, before);
});

test("throwing or oversized site results become safe tool errors", async (t) => {
  const b = await broker(t);
  for (const bad of [
    () => {
      throw new Error("private tool details");
    },
    () => "界".repeat(30000),
  ]) {
    const params = await b.prepare(manifest);
    let count = 0;
    b.hooks.tool = bad;
    b.hooks.fetch = async () =>
      ++count === 1
        ? toolReply("site__echo", '{"value":"test"}')
        : Response.json({ choices: [{ message: { content: "done" } }] });
    await b.ok("chat.complete", params);
    const result = JSON.parse(
      b.requests.at(-1).payload.messages.at(-1).content,
    );
    assert.equal(result.isError, true);
    assert.equal(
      JSON.stringify(result).includes("private tool details"),
      false,
    );
  }
});

test("connection test verifies selected-model tool requests without saving or invoking site tools", async (t) => {
  const b = await broker(t);
  const saved = structuredClone(b.store.provider);
  b.hooks.fetch = async (url, _init, payload) => {
    if (url.endsWith("/models"))
      return Response.json({ data: [{ id: "gpt-5.6-sol" }] });
    assert.equal(payload.model, "gpt-5.6-sol");
    assert.equal(payload.reasoning_effort, "none");
    assert.equal(payload.tools[0].function.name, "connection_check");
    return Response.json({ choices: [{ message: { content: "Connected." } }] });
  };
  const result = await b.ok(
    "provider.test",
    {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.6-sol",
      apiKey: "test-key",
    },
    b.extension,
  );
  assert.equal(result.generationVerified, true);
  assert.equal(b.requests.length, 2);
  assert.equal(b.invocations.length, 0);
  assert.deepEqual(b.store.provider, saved);
});

for (const kind of ["rejected", "empty", "tool-call"]) {
  test(`connection test does not report success for ${kind} generation`, async (t) => {
    const b = await broker(t);
    b.hooks.fetch = async (url) => {
      if (url.endsWith("/models"))
        return Response.json({ data: [{ id: "gpt-5.6-sol" }] });
      if (kind === "rejected")
        return new Response("secret-provider-body", { status: 400 });
      if (kind === "tool-call") return toolReply("connection_check", "{}");
      return Response.json({ choices: [{ message: { content: "" } }] });
    };
    const result = await b.call(
      "provider.test",
      {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.6-sol",
        apiKey: "test-key",
      },
      b.extension,
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "PROVIDER_ERROR");
    assert.equal(
      JSON.stringify(result).includes("secret-provider-body"),
      false,
    );
    assert.equal(b.invocations.length, 0);
  });
}

const DESKTOP = "http://127.0.0.1:48123";
function desktopMock(b, options = {}) {
  const state = {
    paired: options.paired ?? true,
    sync: options.sync ?? { revision: 0, updatedAt: null, config: null },
    generate: options.generate,
  };
  b.hooks.fetch = async (url, init, payload) => {
    const target = new URL(url);
    if (target.origin !== "http://127.0.0.1:48123")
      return Response.json({ choices: [{ message: { content: "openai" } }] });
    const authorized =
      init.headers?.Authorization === "Bearer desktop-token-1234567890";
    if (target.pathname === "/api/status")
      return Response.json({
        app: "arjunah-desktop",
        version: "0.2.0",
        device: "Mac",
        paired: authorized,
        sync: { revision: state.sync.revision },
      });
    if (target.pathname === "/api/pair")
      return payload?.code === "123456"
        ? Response.json({
            token: "desktop-token-1234567890",
            client: { id: "c1" },
          })
        : Response.json(
            {
              error: {
                code: "USER_DENIED",
                message: "Incorrect pairing code.",
              },
            },
            { status: 403 },
          );
    if (!authorized)
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: "Pair first." } },
        { status: 401 },
      );
    if (target.pathname === "/api/providers")
      return Response.json({
        providers: [
          {
            id: "claude-code",
            name: "Claude Code",
            vendor: "Anthropic",
            installed: true,
            available: true,
            supportsTools: true,
            supportsThreads: true,
            account: "me@example.test",
            models: [
              { id: "default", displayName: "Default" },
              { id: "sonnet", displayName: "Sonnet" },
            ],
            defaultModel: "default",
          },
          {
            id: "codex",
            name: "Codex",
            vendor: "OpenAI",
            installed: true,
            available: false,
            reason: "Not signed in.",
            models: [],
          },
        ],
      });
    if (target.pathname === "/api/sync" && init.method === "PUT") {
      state.sync = {
        revision: state.sync.revision + 1,
        updatedAt: "now",
        config: payload.config,
      };
      return Response.json(state.sync);
    }
    if (target.pathname === "/api/sync") return Response.json(state.sync);
    if (target.pathname.startsWith("/api/threads/"))
      return Response.json({ ended: true });
    if (target.pathname.startsWith("/api/progress/"))
      return Response.json({
        items: state.progress?.splice(0) ?? [],
        total: 0,
        done: true,
      });
    if (target.pathname === "/api/logs")
      return Response.json({
        version: "0.2.0",
        device: "Mac",
        latest: 2,
        entries: [
          {
            seq: 2,
            at: "2026-01-01T00:00:00.000Z",
            level: "debug",
            source: "claude-code",
            message: "Starting Claude Code…",
          },
        ],
      });
    if (target.pathname === "/api/generate")
      return state.generate
        ? state.generate(payload)
        : Response.json({
            id: "d1",
            model: "claude-code/default",
            message: {
              role: "assistant",
              content: "from desktop",
              toolCalls: [],
            },
            finishReason: "stop",
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          });
    return new Response("nope", { status: 404 });
  };
  return state;
}

test("desktop pairing stores the token privately, lists providers, and syncs browser settings up", async (t) => {
  const b = await broker(t);
  const mock = desktopMock(b);
  const wrong = await b.call("desktop.pair", { code: "000000" }, b.extension);
  assert.equal(wrong.error.code, "USER_DENIED");
  const paired = await b.ok("desktop.pair", { code: "123456" }, b.extension);
  assert.equal(paired.paired, true);
  assert.equal(paired.accepted, true);
  assert.deepEqual(
    paired.providers.map((item) => item.id),
    ["claude-code", "codex"],
  );
  assert.equal(b.store.desktop.token, "desktop-token-1234567890");
  assert.equal(
    mock.sync.config.openai.apiKey,
    "dummy-audit-key",
    "the browser's saved key syncs to the desktop app",
  );
  assert.deepEqual(mock.sync.config.active, { type: "openai" });
  assert.equal(
    JSON.stringify(paired).includes("desktop-token"),
    false,
    "settings never receives the desktop token",
  );
  let unchangedDesktopWrites = 0;
  b.hooks.set = async (value) => {
    if (value.desktop) unchangedDesktopWrites++;
  };
  const summary = await b.ok("desktop.status", {}, b.extension);
  assert.equal(summary.label, "OpenAI API (allowed)");
  await b.ok("desktop.status", {}, b.extension);
  assert.equal(
    unchangedDesktopWrites,
    0,
    "unchanged provider snapshots do not create storage invalidation loops",
  );
  assert.equal(
    (await b.call("desktop.pair", { code: "123456" }, b.sender())).error.code,
    "PERMISSION_REQUIRED",
  );
});

test("selecting a desktop provider routes generation through the desktop app and exposes its model", async (t) => {
  const b = await broker(t);
  const mock = desktopMock(b);
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  const unavailable = await b.call(
    "provider.select",
    { type: "desktop", providerId: "codex" },
    b.extension,
  );
  assert.equal(unavailable.error.code, "NOT_CONFIGURED");
  const selected = await b.ok(
    "provider.select",
    { type: "desktop", providerId: "claude-code", model: "sonnet" },
    b.extension,
  );
  assert.equal(selected.label, "Claude Code on this computer (sonnet)");
  assert.deepEqual(mock.sync.config.active, {
    type: "desktop",
    providerId: "claude-code",
    model: "sonnet",
  });
  await b.approve(["models.list", "models.generate"]);
  assert.deepEqual(await b.ok("models.list"), [
    {
      id: "claude-code/sonnet",
      provider: "claude-code",
      displayName: "Sonnet",
      default: true,
      capabilities: { tools: true, vision: false, reasoning: false },
      contextWindow: null,
      reasoningLevels: [],
    },
  ]);
  const status = await b.ok("broker.status");
  assert.equal(status.provider, "Claude Code on this computer (Sonnet)");
  const result = await b.ok("models.generate", {
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(result.message.content, "from desktop");
  assert.equal(result.model, "claude-code/sonnet");
  const request = b.requests.find(
    (item) => new URL(item.url).pathname === "/api/generate",
  );
  assert.equal(request.payload.providerId, "claude-code");
  assert.equal(request.payload.model, "sonnet");
  assert.equal(
    request.init.headers.Authorization,
    "Bearer desktop-token-1234567890",
  );
  assert.equal(
    (
      await b.call("models.generate", {
        model: "allowed",
        messages: [{ role: "user", content: "hi" }],
      })
    ).error.code,
    "INVALID_REQUEST",
  );
  await b.ok("provider.select", { type: "openai" }, b.extension);
  assert.deepEqual(
    (await b.ok("models.list")).map((item) => item.id),
    ["openai/allowed"],
  );
});

test("hosted chat tool rounds work through a desktop provider", async (t) => {
  const b = await broker(t);
  desktopMock(b, {
    generate: (payload) =>
      payload.messages.some((item) => item.role === "tool")
        ? Response.json({
            id: "d2",
            message: {
              role: "assistant",
              content: `tool gave ${payload.messages.at(-1).content}`,
              toolCalls: [],
            },
            finishReason: "stop",
            usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
          })
        : Response.json({
            id: "d1",
            message: {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "call_1",
                  name: "site__echo",
                  arguments: '{"value":"x"}',
                },
              ],
            },
            finishReason: "tool_calls",
            usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
          }),
  });
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  await b.ok(
    "provider.select",
    { type: "desktop", providerId: "claude-code" },
    b.extension,
  );
  b.hooks.tool = () => ({ echoed: "x" });
  const prepared = await b.prepare(manifest);
  const result = await b.ok("chat.complete", prepared);
  assert.equal(result.message.content, 'tool gave {"echoed":"x"}');
  assert.equal(b.invocations.length, 1);
  const rounds = b.requests.filter(
    (item) => new URL(item.url).pathname === "/api/generate",
  );
  assert.equal(rounds.length, 2);
  assert.equal(rounds[1].payload.messages.at(-2).tool_calls[0].id, "call_1");
  const usage = await b.ok("usage.get", {}, b.extension);
  assert.equal(usage["claude-code"].dayRequests, 1);
  assert.equal(usage["claude-code"].dayPromptTokens, 4);
  assert.equal(usage["claude-code"].dayCompletionTokens, 6);
});

test("a hosted turn that fails mid-way still records the tokens it spent", async (t) => {
  const b = await broker(t);
  desktopMock(b, {
    // The second round asks for a tool the site never declared, which aborts
    // the turn after the first round has already been billed by the provider.
    generate: (payload) =>
      Response.json({
        id: payload.messages.some((item) => item.role === "tool") ? "d2" : "d1",
        message: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "call_1",
              name: payload.messages.some((item) => item.role === "tool")
                ? "site__undeclared"
                : "site__echo",
              arguments: "{}",
            },
          ],
        },
        finishReason: "tool_calls",
        usage: { promptTokens: 5, completionTokens: 6, totalTokens: 11 },
      }),
  });
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  await b.ok(
    "provider.select",
    { type: "desktop", providerId: "claude-code" },
    b.extension,
  );
  b.hooks.tool = () => ({ echoed: "x" });
  const prepared = await b.prepare(manifest);
  assert.equal(
    (await b.call("chat.complete", prepared)).error.code,
    "TOOL_ERROR",
  );
  const usage = await b.ok("usage.get", {}, b.extension);
  assert.equal(usage["claude-code"].dayRequests, 1);
  assert.equal(usage["claude-code"].dayPromptTokens, 10);
  assert.equal(usage["claude-code"].dayCompletionTokens, 12);
});

test("a narrowed level 2 site keeps its pinned model in the widget switcher, and desktop agents warn about sampling controls", async (t) => {
  const b = await broker(t);
  desktopMock(b);
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  await b.approve(["models.generate", "models.list"], {
    model: "openai/allowed",
  });
  await b.approve(["models.catalog"]);
  const summary = await b.ok(
    "site.update",
    { origin: "https://site.test", providers: ["claude-code"] },
    b.extension,
  );
  assert.deepEqual(summary.providers.sort(), ["claude-code", "openai"]);
  const settings = await b.ok("hosted.settings");
  assert.equal(settings.model.id, "openai/allowed");
  assert.ok(
    settings.models.some((item) => item.id === settings.model.id),
    "the model that answers is selectable in its own switcher",
  );
  // An API-key provider accepts sampling controls; a subscription agent does
  // not, and says so in the page console instead of failing the request.
  assert.equal(
    (
      await b.ok("models.generate", {
        model: "openai/allowed",
        temperature: 0.2,
        messages: [{ role: "user", content: "hi" }],
      })
    )._warnings,
    undefined,
  );
  const viaDesktop = await b.ok("models.generate", {
    model: "claude-code/sonnet",
    temperature: 0.2,
    maxTokens: 64,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(viaDesktop.model, "claude-code/sonnet");
  assert.deepEqual(
    viaDesktop._warnings.map((item) => item.split(" ")[0]),
    ["temperature", "maxTokens"],
  );
  const sent = b.requests
    .filter((item) => new URL(item.url).pathname === "/api/generate")
    .at(-1).payload;
  assert.equal(sent.temperature, undefined);
  assert.equal(sent.maxTokens, undefined);
});

test("a newer desktop revision is pulled into the browser and a bad desktop payload is rejected safely", async (t) => {
  const b = await broker(t);
  const mock = desktopMock(b, {
    sync: {
      revision: 5,
      updatedAt: "now",
      config: {
        openai: { model: "gpt-5.6-luna", apiKey: "synced-key" },
        active: { type: "desktop", providerId: "claude-code", model: "opus" },
      },
    },
  });
  delete b.store.provider;
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  assert.equal(b.store.provider.apiKey, "synced-key");
  assert.equal(b.store.provider.model, "gpt-5.6-luna");
  assert.deepEqual(b.store.active, {
    type: "desktop",
    providerId: "claude-code",
    model: "opus",
  });
  assert.equal(b.store.desktop.revision, 5);
  mock.generate = () =>
    Response.json({
      id: "d",
      message: {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "", name: "bad name!", arguments: 1 }],
      },
    });
  await b.approve(["models.generate"]);
  const failed = await b.call("models.generate", {
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(failed.error.code, "PROVIDER_ERROR");
  mock.generate = () => new Response("secret desktop body", { status: 502 });
  const rejected = await b.call("models.generate", {
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(rejected.error.code, "PROVIDER_ERROR");
  assert.equal(JSON.stringify(rejected).includes("secret desktop body"), false);
  await b.ok("desktop.unpair", {}, b.extension);
  assert.equal(b.store.desktop, undefined);
  // Without the desktop link the browser falls back to its own synced OpenAI key.
  await b.approve(["models.list"]);
  assert.deepEqual(
    (await b.ok("models.list")).map((item) => item.id),
    ["openai/gpt-5.6-luna"],
  );
  delete b.store.provider;
  assert.equal(
    (
      await b.call("models.generate", {
        messages: [{ role: "user", content: "hi" }],
      })
    ).error.code,
    "NOT_CONFIGURED",
  );
});

test("level 1 sites see exactly their model, level 2 sites see the exposed catalog and never account details", async (t) => {
  const b = await broker(t);
  desktopMock(b);
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  // Level 1: the user picks Claude Code for this site in the consent dialog.
  const grant = await b.approve(["models.generate", "models.list"], {
    model: "claude-code/sonnet",
  });
  assert.equal(grant.level, "completion");
  assert.equal(grant.model, "claude-code/sonnet");
  assert.deepEqual(
    (await b.ok("models.list")).map((item) => item.id),
    ["claude-code/sonnet"],
  );
  assert.equal(
    (await b.call("providers.list")).error.code,
    "PERMISSION_REQUIRED",
  );
  assert.equal(
    (
      await b.call("models.generate", {
        model: "openai/allowed",
        messages: [{ role: "user", content: "hi" }],
      })
    ).error.code,
    "INVALID_REQUEST",
  );
  const routed = await b.ok("models.generate", {
    model: "default",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(routed.model, "claude-code/sonnet");
  assert.equal(routed.message.content, "from desktop");
  assert.deepEqual(routed.message.attachments, []);
  assert.equal(routed.message.reasoning, null);
  // Level 2: catalog access exposes both available providers.
  const upgraded = await b.approve(["models.catalog"]);
  assert.equal(upgraded.level, "catalog");
  const providers = await b.ok("providers.list");
  assert.deepEqual(providers.map((item) => item.id).sort(), [
    "claude-code",
    "openai",
  ]);
  assert.equal(
    JSON.stringify(providers).includes("me@example.test"),
    false,
    "account identities never reach the page",
  );
  const models = await b.ok("models.list");
  assert.equal(models.filter((item) => item.default).length, 1);
  assert.ok(models.some((item) => item.id === "openai/allowed"));
  const viaOpenAI = await b.ok("models.generate", {
    model: "openai/allowed",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(viaOpenAI.model, "openai/allowed");
  // The user narrows the exposed providers from the popup.
  const summary = await b.ok(
    "site.update",
    { origin: "https://site.test", providers: ["claude-code"] },
    b.extension,
  );
  assert.deepEqual(summary.providers, ["claude-code"]);
  assert.equal(
    (
      await b.call("models.generate", {
        model: "openai/allowed",
        messages: [{ role: "user", content: "hi" }],
      })
    ).error.code,
    "INVALID_REQUEST",
  );
  // The widget switcher follows the narrowing, and consent does not: consent is
  // how the user would widen the grant again.
  assert.deepEqual(
    (await b.ok("hosted.settings")).models.map((item) => item.id),
    ["claude-code/default", "claude-code/sonnet"],
  );
  assert.deepEqual(
    (await b.ok("broker.status")).providers.map((item) => item.id).sort(),
    ["claude-code", "openai"],
  );
  const usage = await b.ok("usage.get", {}, b.extension);
  assert.equal(usage["claude-code"].dayRequests, 1);
  assert.equal(usage.openai.dayRequests, 1);
  const wallet = await b.ok("catalog.get", {}, b.extension);
  assert.equal(
    wallet.providers.find((item) => item.id === "claude-code").account,
    "me@example.test",
  );
});

test("the site model follows the global default until pinned, and pinning cancels in-flight work", async (t) => {
  const b = await broker(t);
  desktopMock(b);
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  await b.approve(["models.generate", "models.list"], {
    model: "openai/allowed",
  });
  assert.equal((await b.ok("grant.query")).model, "openai/allowed");
  await b.ok(
    "provider.select",
    { type: "desktop", providerId: "claude-code", model: "sonnet" },
    b.extension,
  );
  assert.equal(
    (await b.ok("grant.query")).model,
    "claude-code/sonnet",
    "an unpinned site follows the new global default",
  );
  await b.ok(
    "site.update",
    { origin: "https://site.test", model: "openai/allowed" },
    b.extension,
  );
  await b.ok("provider.select", { type: "openai" }, b.extension);
  await b.ok(
    "provider.select",
    { type: "desktop", providerId: "claude-code", model: "sonnet" },
    b.extension,
  );
  assert.equal(
    (await b.ok("grant.query")).model,
    "openai/allowed",
    "a pinned site keeps its model",
  );
  assert.equal(
    (await b.call("hosted.model", { model: "claude-code/sonnet" })).error.code,
    "PERMISSION_REQUIRED",
    "the widget model switch requires a hosted-chat grant",
  );
});

test("widget controls reach the model only when disclosed, and tool handlers receive them", async (t) => {
  const b = await broker(t);
  const withControls = {
    ...manifest,
    widget: {
      controls: [
        { id: "verbose", type: "toggle", label: "Verbose", default: false },
        {
          id: "tone",
          type: "select",
          label: "Tone",
          options: [{ value: "a" }, { value: "b" }],
          model: false,
        },
      ],
    },
  };
  const prepared = await b.prepare(withControls);
  await b.ok("chat.complete", {
    ...prepared,
    controls: { verbose: true, tone: "b" },
  });
  const systemLines = b.requests[0].payload.messages.filter(
    (item) => item.role === "system",
  );
  const disclosed = systemLines.find((item) =>
    item.content.startsWith("Widget options"),
  );
  assert.ok(disclosed);
  assert.match(disclosed.content, /"verbose":true/);
  assert.equal(disclosed.content.includes("tone"), false);
  const again = await b.prepare(withControls);
  const bad = await b.call("chat.complete", {
    ...again,
    controls: { verbose: "yes" },
  });
  assert.equal(bad.error.code, "INVALID_REQUEST");
});

test("image parts are converted for vision models and refused for models without vision", async (t) => {
  const b = await broker(t);
  b.store.provider.model = "gpt-5.6-sol";
  const image = { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" };
  await b.approve(["models.generate", "models.list"]);
  await b.ok("models.generate", {
    messages: [
      { role: "user", content: [{ type: "text", text: "describe" }, image] },
    ],
  });
  const wire = b.requests[0].payload.messages[0].content;
  assert.equal(wire[1].type, "image_url");
  assert.equal(wire[1].image_url.url, "data:image/png;base64,iVBORw0KGgo=");
  desktopMock(b);
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  await b.ok(
    "site.update",
    { origin: "https://site.test", model: "claude-code/sonnet" },
    b.extension,
  );
  const refused = await b.call("models.generate", {
    messages: [{ role: "user", content: [image] }],
  });
  assert.equal(refused.error.code, "NOT_SUPPORTED");
  assert.equal(
    b.requests.some((item) => new URL(item.url).pathname === "/api/generate"),
    false,
    "no provider request is made for unsupported images",
  );
});

test("hosted chat emits progress events to the initiating document only", async (t) => {
  const b = await broker(t);
  const events = [];
  const original = globalThis.chrome.tabs.sendMessage;
  globalThis.chrome.tabs.sendMessage = async (tabId, message, options) => {
    if (message.kind === "arjunah-progress") {
      events.push({ tabId, ...message });
      return undefined;
    }
    return original(tabId, message, options);
  };
  b.hooks.fetch = async (url, init, payload) => {
    if (!payload.messages.some((item) => item.role === "tool"))
      return toolReply("site__echo", '{"value":"x"}');
    assert.equal(payload.stream, true);
    return new Response(
      [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "do" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ne" }, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  b.hooks.tool = () => ({ echoed: "x" });
  const prepared = await b.prepare(manifest);
  await b.ok("chat.complete", { ...prepared, turnId: "turn-1" });
  assert.deepEqual(
    events.map((item) => item.type),
    [
      "model.start",
      "model.end",
      "tool.start",
      "tool.end",
      "model.start",
      "output.delta",
      "output.delta",
      "model.end",
    ],
  );
  assert.ok(
    events.every((item) => item.turnId === "turn-1" && item.tabId === 1),
  );
  assert.equal(events[2].name, "echo");
  assert.match(events[3].result, /echoed/);
  assert.equal(
    events
      .filter((item) => item.type === "output.delta")
      .map((item) => item.text)
      .join(""),
    "done",
  );
});

test("hosted content tools send text normally and inject images only for vision models", async (t) => {
  const contentManifest = {
    name: "Canvas",
    tools: [
      {
        name: "look",
        outputContent: ["text", "image"],
        inputSchema: { type: "object", additionalProperties: false },
      },
    ],
  };
  const imageResult = {
    kind: "content",
    content: [
      { type: "text", text: '{"objects":1,"summary":"blue dot"}' },
      { type: "image", mediaType: "image/webp", data: "UklGRg==" },
    ],
  };
  for (const [model, vision] of [
    ["gpt-5.6-sol", true],
    ["allowed", false],
  ]) {
    const b = await broker(t);
    b.store.provider.model = model;
    b.hooks.tool = () => imageResult;
    b.hooks.fetch = async (_url, _init, payload) =>
      payload.messages.some((message) => message.role === "tool")
        ? Response.json({ choices: [{ message: { content: "done" } }] })
        : toolReply("site__look");
    const prepared = await b.prepare(contentManifest);
    await b.ok("chat.complete", prepared);
    const messages = b.requests.at(-1).payload.messages;
    const toolIndex = messages.findIndex((message) => message.role === "tool");
    assert.equal(messages[toolIndex].content, imageResult.content[0].text);
    assert.equal(messages[toolIndex].tool_call_id, "call-1");
    assert.equal(messages[toolIndex + 1]?.role === "user", vision);
    assert.equal(JSON.stringify(messages).includes("UklGRg=="), vision);
  }
});

test("declared output modes change the assistant contract fingerprint", async (t) => {
  const b = await broker(t);
  const legacy = await b.register({
    name: "Canvas",
    tools: [{ name: "look", inputSchema: { type: "object" } }],
  });
  const content = await b.register({
    name: "Canvas",
    tools: [
      {
        name: "look",
        inputSchema: { type: "object" },
        outputContent: ["text", "image"],
      },
    ],
  });
  assert.notEqual(legacy.fingerprint, content.fingerprint);
});

test("commands a desktop agent ran are shown as activity but never returned to the page", async (t) => {
  const b = await broker(t);
  desktopMock(b, {
    generate: () =>
      Response.json({
        id: "d1",
        message: { role: "assistant", content: "done", toolCalls: [] },
        finishReason: "stop",
        usage: {},
        steps: [
          {
            command: "ls ~/Documents",
            exitCode: 71,
            output: "Operation not permitted",
          },
        ],
      }),
  });
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  await b.ok(
    "provider.select",
    { type: "desktop", providerId: "claude-code" },
    b.extension,
  );
  const events = [];
  const original = globalThis.chrome.tabs.sendMessage;
  globalThis.chrome.tabs.sendMessage = async (tabId, message, options) => {
    if (message.kind === "arjunah-progress") {
      events.push(message);
      return undefined;
    }
    return original(tabId, message, options);
  };
  const prepared = await b.prepare(manifest);
  const result = await b.ok("chat.complete", { ...prepared, turnId: "t" });
  assert.equal(result.agentSteps, undefined);
  const step = events.find((item) => item.type === "agent.step");
  assert.equal(step.command, "ls ~/Documents");
  assert.equal(step.exitCode, 71);
  assert.equal(step.provider, "Claude Code");
  const generateCall = b.requests.find(
    (item) => new URL(item.url).pathname === "/api/generate",
  );
  assert.equal(generateCall.payload.progressId, "t-0");
  assert.ok(
    b.requests.some((item) =>
      new URL(item.url).pathname.startsWith("/api/progress/t-0"),
    ),
    "live progress is polled while the desktop generates",
  );
  await b.approve(["models.generate"]);
  const direct = await b.ok("models.generate", {
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal("agentSteps" in direct, false);
});

test("reasoning effort reaches OpenAI as reasoning_effort and is validated", async (t) => {
  const b = await broker(t);
  b.store.provider.model = "gpt-5.6-sol";
  await b.approve(["models.generate"]);
  await b.ok("models.generate", {
    messages: [{ role: "user", content: "hi" }],
    reasoning: { effort: "high" },
  });
  assert.equal(b.requests[0].payload.reasoning_effort, "high");
  const bad = await b.call("models.generate", {
    messages: [{ role: "user", content: "hi" }],
    reasoning: "ultra",
  });
  assert.equal(bad.error.code, "INVALID_REQUEST");
  // Function tools on GPT-5.6 still force non-reasoning mode (API limitation).
  await b.ok("models.generate", {
    messages: [{ role: "user", content: "hi" }],
    reasoning: "high",
    tools: [{ name: "t", inputSchema: { type: "object" } }],
  });
  assert.equal(b.requests.at(-1).payload.reasoning_effort, "none");
});

test("hosted conversations carry a thread id to the desktop app and release it on session end", async (t) => {
  const b = await broker(t);
  const mock = desktopMock(b);
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  await b.ok(
    "provider.select",
    { type: "desktop", providerId: "claude-code" },
    b.extension,
  );
  const prepared = await b.prepare(manifest);
  await b.ok("chat.complete", {
    ...prepared,
    conversationId: "conv-abc",
    reasoning: "medium",
  });
  const generateCall = b.requests.find(
    (item) => new URL(item.url).pathname === "/api/generate",
  );
  assert.equal(generateCall.payload.threadId, "conv-abc");
  assert.equal(generateCall.payload.reasoning, "medium");
  await b.ok("session.end", { conversationId: "conv-abc" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const ended = b.requests.find(
    (item) =>
      new URL(item.url).pathname === "/api/threads/conv-abc" &&
      item.init.method === "DELETE",
  );
  assert.ok(ended, "the thread is released when the page session ends");
  void mock;
  const settings = await b.ok("hosted.settings");
  assert.equal(settings.model.threads, true);
  assert.deepEqual(settings.model.reasoningLevels, []);
});

test("a paired but unreachable desktop app makes its providers unavailable everywhere, with a clear error", async (t) => {
  const b = await broker(t);
  desktopMock(b);
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  await b.ok(
    "provider.select",
    { type: "desktop", providerId: "claude-code", model: "sonnet" },
    b.extension,
  );
  await b.approve(["models.generate", "models.list"]);
  // The companion goes away: every request to its origin now fails.
  const live = b.hooks.fetch;
  b.hooks.fetch = async (url, init, payload) => {
    if (new URL(url).origin === "http://127.0.0.1:48123")
      throw new TypeError("fetch failed");
    return live(url, init, payload);
  };
  const wallet = await b.ok("catalog.get", {}, b.extension);
  assert.deepEqual(wallet.desktop, {
    paired: true,
    running: false,
    accepted: false,
  });
  const claude = wallet.providers.find((item) => item.id === "claude-code");
  assert.equal(claude.available, false);
  assert.match(claude.reason, /अर्जुनः Desktop is not running/);
  const failed = await b.call("models.generate", {
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(failed.error.code, "NOT_CONFIGURED");
  assert.match(failed.error.message, /अर्जुनः Desktop is not running/);
  const settings = await b.ok("hosted.settings");
  assert.equal(settings.desktop.running, false);
  assert.equal(settings.model, null);
});

test("a companion that forgot this browser's pairing is reported as unpaired, not as available", async (t) => {
  const b = await broker(t);
  desktopMock(b);
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  await b.ok(
    "provider.select",
    { type: "desktop", providerId: "claude-code", model: "sonnet" },
    b.extension,
  );
  await b.approve(["models.generate", "models.list"]);
  const live = b.hooks.fetch;
  b.hooks.fetch = async (url, init, payload) => {
    const target = new URL(url);
    if (target.origin !== "http://127.0.0.1:48123")
      return live(url, init, payload);
    if (target.pathname === "/api/status")
      return Response.json({
        app: "arjunah-desktop",
        version: "1.0.0",
        paired: false,
        sync: { revision: 0 },
      });
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "Pair first." } },
      { status: 401 },
    );
  };
  const wallet = await b.ok("catalog.get", {}, b.extension);
  assert.deepEqual(wallet.desktop, {
    paired: true,
    running: true,
    accepted: false,
  });
  assert.match(
    wallet.providers.find((item) => item.id === "claude-code").reason,
    /no longer recognises this browser's pairing/,
  );
  const failed = await b.call("models.generate", {
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(failed.error.code, "NOT_CONFIGURED");
  assert.match(failed.error.message, /pair again/);
  const settings = await b.ok("hosted.settings");
  assert.equal(settings.model, null);
  assert.equal(settings.desktop.accepted, false);
});

test("a desktop phase reaches the widget as a live label and both logs stay metadata-only", async (t) => {
  const b = await broker(t);
  const mock = desktopMock(b);
  mock.progress = [
    { type: "phase", text: "Checking Claude Code on this computer…" },
    { type: "output_delta", text: "moon-garden-answer" },
  ];
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  await b.ok(
    "provider.select",
    { type: "desktop", providerId: "claude-code", model: "sonnet" },
    b.extension,
  );
  const params = await b.prepare(manifest);
  await b.ok("chat.complete", { ...params, turnId: "turn-9" });
  const phases = b.events.filter((event) => event.type === "agent.phase");
  assert.deepEqual(
    phases.map((event) => event.text),
    ["Checking Claude Code on this computer…"],
  );
  assert.equal(phases[0].provider, "Claude Code");

  // Settings read both logs; neither carries the conversation.
  const logs = await b.ok("logs.get", {}, b.extension);
  const lines = logs.entries.map((entry) => entry.message);
  assert.ok(
    lines.some((line) => line.includes("round 0 → claude-code/sonnet")),
  );
  assert.ok(lines.some((line) => /answered in \d+ms/.test(line)));
  assert.ok(
    !JSON.stringify(logs).includes("moon-garden-answer"),
    "model output never reaches the diagnostic log",
  );
  assert.equal(logs.desktop.available, true);
  assert.deepEqual(
    logs.desktop.entries.map((entry) => entry.message),
    ["Starting Claude Code…"],
  );
  assert.equal(
    (await b.call("logs.get", {}, b.sender())).error.code,
    "PERMISSION_REQUIRED",
    "only extension pages may read the log",
  );
  const desktopCleared = await b.ok(
    "logs.clear",
    { target: "desktop" },
    b.extension,
  );
  assert.deepEqual(
    desktopCleared.entries.map((entry) => entry.message),
    lines,
    "clearing the selected desktop log leaves the extension log intact",
  );
  assert.ok(
    b.requests.some(
      (request) =>
        new URL(request.url).pathname === "/api/logs" &&
        request.init.method === "DELETE",
    ),
  );
  const cleared = await b.ok(
    "logs.clear",
    { target: "extension" },
    b.extension,
  );
  assert.ok(cleared.entries.length <= 1);
});
