import test from "node:test";
import assert from "node:assert/strict";
import { broker } from "./helpers/broker.mjs";

const SERVER = "http://172.31.7.3:11434";
const PNG = "iVBORw0KGgo=";
const TAGS = [
  { name: "qwen3-vl:2b", digest: "v1" },
  { name: "qwen3.8:4b-distill", digest: "t1" },
  { name: "nomic-embed-text:latest", digest: "e1" },
];
const SHOWS = {
  "qwen3-vl:2b": {
    capabilities: ["completion", "vision", "tools", "thinking"],
    model_info: { "qwen3vl.context_length": 262144 },
  },
  "qwen3.8:4b-distill": { capabilities: ["completion"] },
  "nomic-embed-text:latest": { capabilities: ["embedding"] },
  "gpt-oss:20b": {
    capabilities: ["completion", "tools", "thinking"],
    thinking: { values: ["low", "medium", "high"], default: "medium" },
    model_info: { "gptoss.context_length": 131072 },
  },
};

function ndjson(lines) {
  return new Response(
    lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    {
      headers: { "Content-Type": "application/x-ndjson" },
    },
  );
}

/**
 * One fetch router for an Ollama server, Ollama Cloud, and a minimal paired
 * desktop companion. `chat` answers `/api/chat`; the rest is metadata.
 */
function servers(b, options = {}) {
  const state = {
    tags: options.tags ?? TAGS,
    cloudTags: options.cloudTags ?? [{ name: "gpt-oss:20b", digest: "c1" }],
    down: false,
    // Models that start failing to load after discovery (an Ollama upgrade).
    broken: new Set(),
    chat:
      options.chat ??
      (() =>
        Response.json({
          message: { role: "assistant", content: "Connected." },
          done: true,
          prompt_eval_count: 5,
          eval_count: 2,
        })),
    sync: { revision: 0, updatedAt: null, config: null },
  };
  b.hooks.fetch = async (url, init, payload) => {
    const target = new URL(url);
    if (target.origin === "http://127.0.0.1:48123") {
      if (target.pathname === "/api/status")
        return Response.json({
          app: "arjunah-desktop",
          version: "1.0.0",
          paired:
            init.headers?.Authorization === "Bearer desktop-token-1234567890",
          sync: { revision: state.sync.revision },
        });
      if (target.pathname === "/api/pair")
        return Response.json({
          token: "desktop-token-1234567890",
          client: { id: "c1" },
        });
      if (target.pathname === "/api/providers")
        return Response.json({ providers: [] });
      if (target.pathname === "/api/sync" && init.method === "PUT") {
        state.sync = {
          revision: state.sync.revision + 1,
          updatedAt: "now",
          config: payload.config,
        };
        return Response.json(state.sync);
      }
      if (target.pathname === "/api/sync") return Response.json(state.sync);
      return new Response("nope", { status: 404 });
    }
    const cloud = target.origin === "https://ollama.com";
    if (target.origin !== SERVER && !cloud)
      return Response.json({ choices: [{ message: { content: "openai" } }] });
    if (!cloud && state.down) throw new TypeError("Failed to fetch");
    if (
      cloud &&
      init.headers?.Authorization !== "Bearer cloud-secret" &&
      target.pathname === "/api/chat"
    )
      return Response.json({ error: "unauthorized" }, { status: 401 });
    if (target.pathname === "/api/tags")
      return Response.json({ models: cloud ? state.cloudTags : state.tags });
    if (
      ["/api/show", "/api/chat"].includes(target.pathname) &&
      (payload.model === "broken:20b" || state.broken.has(payload.model))
    )
      return Response.json(
        { error: 'tensor "blk.0.ffn_down_exps.weight" size overflow' },
        { status: 500 },
      );
    if (target.pathname === "/api/show")
      return Response.json(
        SHOWS[payload.model] ?? { capabilities: ["completion"] },
      );
    if (target.pathname === "/api/ps")
      return Response.json({
        models: [
          {
            name: "qwen3-vl:2b",
            context_length: 32768,
            size: 4000,
            size_vram: 1000,
            expires_at: "2026-10-01T14:20:15.092913192+05:45",
          },
        ],
      });
    if (target.pathname === "/api/chat") return state.chat(payload, init);
    return new Response("nope", { status: 404 });
  };
  return state;
}

function chats(b) {
  return b.requests.filter(
    (item) => new URL(item.url).pathname === "/api/chat",
  );
}

test("a self-hosted Ollama server is reached by address alone and exposes its own capabilities", async (t) => {
  const b = await broker(t);
  servers(b);
  const saved = await b.ok(
    "ollama.save",
    { provider: "ollama", baseUrl: `${SERVER}/api` },
    b.extension,
  );
  assert.equal(saved.baseUrl, SERVER, "a pasted /api suffix is trimmed");
  assert.equal(saved.hasApiKey, false);
  assert.deepEqual(
    saved.models.map((model) => [
      model.id,
      model.capabilities.vision,
      model.capabilities.tools,
    ]),
    [
      ["qwen3-vl:2b", true, true],
      ["qwen3.8:4b-distill", false, false],
    ],
    "embedding models are not offered",
  );
  assert.equal(b.store.ollama.apiKey, null);
  assert.equal(
    JSON.stringify(
      await b.ok("ollama.get", { provider: "ollama" }, b.extension),
    ).includes('apiKey"'),
    false,
  );
  assert.ok(
    chats(b).every((item) => item.init.headers.Authorization === undefined),
    "no key, no header",
  );
  const catalog = await b.ok("catalog.get", {}, b.extension);
  const provider = catalog.providers.find((item) => item.id === "ollama");
  assert.equal(provider.kind, "self-hosted");
  assert.equal(provider.available, true);
  assert.match(provider.account, /172\.31\.7\.3:11434/);
  assert.deepEqual(
    provider.models.find((model) => model.id === "ollama/qwen3-vl:2b")
      .reasoningLevels,
    ["none", "high"],
  );
  const selected = await b.ok(
    "provider.select",
    { type: "ollama", model: "qwen3-vl:2b" },
    b.extension,
  );
  assert.equal(selected.label, "Ollama (self-hosted) (qwen3-vl:2b)");
  assert.equal(b.store.ollama.model, "qwen3-vl:2b");

  // The page sees the provider's kind and models, never the server address.
  await b.approve(["models.list", "models.generate", "models.catalog"]);
  const providers = await b.ok("providers.list");
  const listed = providers.find((item) => item.id === "ollama");
  assert.deepEqual(listed, {
    id: "ollama",
    name: "Ollama (self-hosted)",
    // A server the user runs can be anything that speaks Ollama's API.
    vendor: null,
    kind: "self-hosted",
    models: ["ollama/qwen3-vl:2b", "ollama/qwen3.8:4b-distill"],
  });
  assert.equal(JSON.stringify(providers).includes("172.31.7.3"), false);
  const models = await b.ok("models.list");
  assert.equal(JSON.stringify(models).includes("172.31.7.3"), false);

  b.requests.length = 0;
  const result = await b.ok("models.generate", {
    model: "ollama/qwen3-vl:2b",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image", mediaType: "image/png", data: PNG },
        ],
      },
    ],
  });
  assert.equal(result.model, "ollama/qwen3-vl:2b");
  assert.equal(result.contextWindow, 32768);
  assert.equal(
    "processor" in result,
    false,
    "a page never learns where the model runs",
  );
  const [chat] = chats(b);
  assert.equal(chat.url, `${SERVER}/api/chat`);
  assert.deepEqual(chat.payload.messages, [
    { role: "user", content: "describe", images: [PNG] },
  ]);

  // A model the server says has no vision is refused before any request.
  b.requests.length = 0;
  const refused = await b.call("models.generate", {
    model: "ollama/qwen3.8:4b-distill",
    messages: [
      {
        role: "user",
        content: [{ type: "image", mediaType: "image/png", data: PNG }],
      },
    ],
  });
  assert.equal(refused.error.code, "NOT_SUPPORTED");
  assert.equal(chats(b).length, 0);
});

test("unsafe addresses and a missing cloud key are refused before any request", async (t) => {
  const b = await broker(t);
  servers(b);
  for (const baseUrl of [
    "http://ollama.example.com:11434",
    "http://u:p@localhost:11434",
    "file:///etc",
  ]) {
    const response = await b.call(
      "ollama.save",
      { provider: "ollama", baseUrl },
      b.extension,
    );
    assert.equal(response.error.code, "INVALID_REQUEST", baseUrl);
  }
  const cloud = await b.call(
    "ollama.save",
    { provider: "ollama-cloud" },
    b.extension,
  );
  assert.match(cloud.error.message, /Ollama Cloud API key is required/);
  assert.equal(b.requests.length, 0);
  assert.equal(
    (await b.call("ollama.save", { provider: "other" }, b.extension)).error
      .code,
    "INVALID_REQUEST",
  );
  // Settings-only methods are not reachable from a page.
  assert.equal(
    (await b.call("ollama.get", { provider: "ollama" })).error.code,
    "PERMISSION_REQUIRED",
  );
});

test("an unreachable server says where it looked and how to expose Ollama", async (t) => {
  const b = await broker(t);
  const state = servers(b);
  state.down = true;
  const response = await b.call(
    "ollama.save",
    { provider: "ollama", baseUrl: SERVER },
    b.extension,
  );
  assert.equal(response.error.code, "PROVIDER_ERROR");
  assert.match(
    response.error.message,
    /Could not reach an Ollama server at http:\/\/172\.31\.7\.3:11434/,
  );
  assert.match(response.error.message, /OLLAMA_HOST=0\.0\.0\.0/);
});

test("Ollama Cloud keeps its key, reuses it only on request, and sends it as a bearer", async (t) => {
  const b = await broker(t);
  servers(b);
  const saved = await b.ok(
    "ollama.save",
    { provider: "ollama-cloud", apiKey: "cloud-secret" },
    b.extension,
  );
  assert.equal(saved.baseUrl, "https://ollama.com");
  assert.equal(saved.model, "gpt-oss:20b");
  assert.equal(saved.hasApiKey, true);
  assert.equal(b.store.ollamaCloud.apiKey, "cloud-secret");
  const tested = await b.ok(
    "ollama.test",
    { provider: "ollama-cloud" },
    b.extension,
  );
  assert.equal(tested.generationVerified, true);
  const probe = chats(b).at(-1);
  assert.equal(probe.url, "https://ollama.com/api/chat");
  assert.equal(probe.init.headers.Authorization, "Bearer cloud-secret");
  assert.equal(probe.payload.tools[0].function.name, "connection_check");
  // gpt-oss publishes levels without an off switch, so the probe leaves think alone.
  assert.equal(probe.payload.think, undefined);
  const without = await b.call(
    "ollama.test",
    { provider: "ollama-cloud", keepApiKey: false },
    b.extension,
  );
  assert.match(without.error.message, /API key is required/);
  await b.ok(
    "provider.select",
    { type: "ollama-cloud", model: "gpt-oss:20b" },
    b.extension,
  );
  const catalog = await b.ok("catalog.get", {}, b.extension);
  assert.equal(catalog.defaultModel, "ollama-cloud/gpt-oss:20b");
  const entry = catalog.providers.find((item) => item.id === "ollama-cloud");
  assert.equal(entry.kind, "api-key");
  assert.deepEqual(entry.models[0].reasoningLevels, ["low", "medium", "high"]);
  assert.equal(entry.models[0].contextWindow, 131072);
  await b.ok("ollama.clear", { provider: "ollama-cloud" }, b.extension);
  assert.equal(b.store.ollamaCloud, undefined);
  assert.equal(
    b.store.active,
    undefined,
    "clearing the default provider clears the default",
  );
});

test("a self-hosted key is kept only for its own server", async (t) => {
  const b = await broker(t);
  servers(b);
  await b.ok(
    "ollama.save",
    { provider: "ollama", baseUrl: SERVER, apiKey: "proxy-key" },
    b.extension,
  );
  assert.equal(b.store.ollama.apiKey, "proxy-key");
  await b.ok(
    "ollama.save",
    { provider: "ollama", baseUrl: SERVER, keepApiKey: true },
    b.extension,
  );
  assert.equal(b.store.ollama.apiKey, "proxy-key");
  assert.ok(chats(b).length === 0);
  assert.ok(
    b.requests
      .filter((item) => item.url.startsWith(SERVER))
      .every((item) => item.init.headers?.Authorization === "Bearer proxy-key"),
  );
  // Saving without asking to keep it means no key: that is a valid choice here.
  await b.ok(
    "ollama.save",
    { provider: "ollama", baseUrl: SERVER },
    b.extension,
  );
  assert.equal(b.store.ollama.apiKey, null);
});

test("hosted chat streams from Ollama, drops tools for a tool-less model, and round-trips site tools", async (t) => {
  const b = await broker(t);
  const state = servers(b);
  await b.ok(
    "ollama.save",
    { provider: "ollama", baseUrl: SERVER, model: "qwen3-vl:2b" },
    b.extension,
  );
  await b.ok(
    "provider.select",
    { type: "ollama", model: "qwen3-vl:2b" },
    b.extension,
  );
  state.chat = (payload) =>
    payload.messages.some((message) => message.role === "tool")
      ? ndjson([
          { message: { role: "assistant", content: "", thinking: "Got it." } },
          { message: { role: "assistant", content: "Echoed." } },
          {
            message: { role: "assistant", content: "" },
            done: true,
            prompt_eval_count: 50,
            eval_count: 4,
          },
        ])
      : ndjson([
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_7",
                  function: {
                    index: 0,
                    name: "site__echo",
                    arguments: { value: "x" },
                  },
                },
              ],
            },
          },
          {
            message: { role: "assistant", content: "" },
            done: true,
            prompt_eval_count: 30,
            eval_count: 9,
          },
        ]);
  b.hooks.tool = () => ({ echoed: "x" });
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
  const prepared = await b.prepare(manifest);
  b.requests.length = 0;
  const done = await b.ok("chat.complete", { ...prepared, turnId: "turn-1" });
  assert.equal(done.message.content, "Echoed.");
  assert.equal(done.contextWindow, 32768);
  assert.deepEqual(done.processor, {
    placement: "split",
    gpuPercent: 25,
    label: "75%/25% CPU/GPU",
    until: "2026-10-01T08:35:15.092Z",
  });
  const [first, second] = chats(b);
  assert.equal(first.payload.stream, true);
  assert.equal(first.payload.tools[0].function.name, "site__echo");
  assert.deepEqual(second.payload.messages.at(-2).tool_calls, [
    {
      id: "call_7",
      function: { index: 0, name: "site__echo", arguments: { value: "x" } },
    },
  ]);
  const toolMessage = second.payload.messages.at(-1);
  assert.equal(toolMessage.role, "tool");
  assert.equal(toolMessage.tool_call_id, "call_7");
  assert.equal(toolMessage.tool_name, "site__echo");
  assert.match(toolMessage.content, /echoed/);
  assert.ok(
    b.events.some(
      (event) => event.type === "output.delta" && event.text === "Echoed.",
    ),
  );
  // Every round reports where the model runs, so the widget shows it mid-turn.
  const rounds = b.events.filter((event) => event.type === "model.end");
  assert.equal(rounds.length, 2);
  assert.ok(
    rounds.every(
      (event) =>
        event.processor?.label === "75%/25% CPU/GPU" &&
        event.contextWindow === 32768,
    ),
  );
  // And the widget's settings carry it before the visitor sends anything.
  const settings = await b.ok("hosted.settings");
  assert.deepEqual(settings.model.processor, {
    placement: "split",
    gpuPercent: 25,
    label: "75%/25% CPU/GPU",
    until: "2026-10-01T08:35:15.092Z",
  });
  assert.equal(settings.model.contextWindow, 32768);

  // The widget sends the visitor's effort with each turn; Ollama receives its
  // own switch for it.
  b.requests.length = 0;
  await b.ok("chat.complete", {
    ...(await b.prepare(manifest)),
    turnId: "turn-2",
    reasoning: "none",
  });
  assert.equal(chats(b)[0].payload.think, false);

  // A model the server reports without tools still chats, with no tools sent.
  await b.ok(
    "site.update",
    { origin: "https://site.test", model: "ollama/qwen3.8:4b-distill" },
    b.extension,
  );
  state.chat = () =>
    ndjson([
      { message: { role: "assistant", content: "Plain answer." } },
      { message: { role: "assistant", content: "" }, done: true },
    ]);
  b.requests.length = 0;
  const plain = await b.ok("chat.complete", {
    ...(await b.prepare(manifest)),
    turnId: "turn-3",
  });
  assert.equal(plain.message.content, "Plain answer.");
  assert.equal(chats(b)[0].payload.tools, undefined);
  assert.equal(
    chats(b)[0].payload.think,
    undefined,
    "no thinking switch for a model without it",
  );
});

test("refreshing reads newly pulled models, and a server that stops answering keeps its catalog", async (t) => {
  const b = await broker(t);
  const state = servers(b);
  await b.ok(
    "ollama.save",
    { provider: "ollama", baseUrl: SERVER },
    b.extension,
  );
  state.tags = [...TAGS, { name: "gpt-oss:20b", digest: "g1" }];
  const refreshed = await b.ok(
    "ollama.refresh",
    { provider: "ollama" },
    b.extension,
  );
  assert.ok(refreshed.models.some((model) => model.id === "gpt-oss:20b"));
  // An explicit refresh re-reads every model; a background one would not.
  const shows = b.requests
    .filter((item) => item.url.endsWith("/api/show"))
    .map((item) => item.payload.model);
  assert.equal(
    shows.filter((model) => model === "qwen3-vl:2b").length,
    2,
    "save and the explicit refresh each describe the model",
  );
  state.down = true;
  const stale = await b.ok(
    "ollama.refresh",
    { provider: "ollama" },
    b.extension,
  );
  assert.equal(stale.models.length, 3);
  assert.match(stale.lastError, /Could not refresh the model list/);
  const catalog = await b.ok("catalog.get", {}, b.extension);
  const provider = catalog.providers.find((item) => item.id === "ollama");
  assert.equal(
    provider.available,
    true,
    "a server that is down does not silently move sites elsewhere",
  );
  assert.match(provider.notice, /Could not refresh/);
});

test("the Origin rule follows the saved server and only covers this extension's requests", async (t) => {
  const b = await broker(t);
  servers(b);
  const rules = new Map();
  const updates = [];
  globalThis.chrome.declarativeNetRequest = {
    async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
      updates.push({
        removeRuleIds,
        addRules: addRules.map((rule) => rule.id),
      });
      for (const id of removeRuleIds) rules.delete(id);
      for (const rule of addRules) rules.set(rule.id, rule);
    },
  };
  await b.ok(
    "ollama.save",
    { provider: "ollama", baseUrl: SERVER },
    b.extension,
  );
  // The probe rule exists while discovery runs, then only the saved rule stays.
  assert.ok(updates.some((update) => update.addRules.includes(4102)));
  assert.deepEqual([...rules.keys()], [4101]);
  assert.deepEqual(rules.get(4101).condition, {
    urlFilter: `|${SERVER}/`,
    initiatorDomains: ["test"],
    resourceTypes: ["xmlhttprequest"],
  });
  assert.deepEqual(rules.get(4101).action.requestHeaders, [
    { header: "origin", operation: "remove" },
  ]);
  // Testing another address leaves the saved rule alone.
  await b.call(
    "ollama.test",
    { provider: "ollama", baseUrl: "http://10.0.0.9:11434" },
    b.extension,
  );
  assert.deepEqual([...rules.keys()], [4101]);
  assert.equal(rules.get(4101).condition.urlFilter, `|${SERVER}/`);
  await b.ok("ollama.clear", { provider: "ollama" }, b.extension);
  assert.equal(rules.size, 0);
});

test("Ollama settings sync to a paired desktop without the catalog, and synced input is validated", async (t) => {
  const b = await broker(t);
  const state = servers(b);
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  await b.ok(
    "ollama.save",
    { provider: "ollama", baseUrl: SERVER, apiKey: "proxy-key" },
    b.extension,
  );
  await b.ok(
    "ollama.save",
    { provider: "ollama-cloud", apiKey: "cloud-secret" },
    b.extension,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(state.sync.config.ollama, {
    baseUrl: SERVER,
    model: "qwen3-vl:2b",
    apiKey: "proxy-key",
  });
  assert.deepEqual(state.sync.config.ollamaCloud, {
    model: "gpt-oss:20b",
    apiKey: "cloud-secret",
  });
});

test("synced Ollama settings are validated as if typed, and the catalog is read fresh", async (t) => {
  const b = await broker(t);
  const state = servers(b);
  delete b.store.provider;
  state.sync = {
    revision: 7,
    updatedAt: "now",
    config: {
      // A public plain-http address is ignored; a valid cloud entry is applied.
      ollama: {
        baseUrl: "http://ollama.example.com:11434",
        model: "x",
        apiKey: null,
      },
      ollamaCloud: {
        model: "gpt-oss:20b",
        apiKey: "cloud-secret",
        models: [{ id: "forged" }],
      },
      active: { type: "ollama-cloud" },
    },
  };
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  assert.equal(b.store.ollama, undefined);
  assert.deepEqual(b.store.ollamaCloud, {
    baseUrl: "https://ollama.com",
    apiKey: "cloud-secret",
    model: "gpt-oss:20b",
    models: [],
    skipped: [],
    ignored: [],
    lastError: null,
  });
  assert.deepEqual(b.store.active, { type: "ollama-cloud" });
  // The first catalog read discovers the models from the service itself.
  await b.ok("catalog.get", {}, b.extension);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    b.store.ollamaCloud.models.map((model) => model.id),
    ["gpt-oss:20b"],
  );
  const catalog = await b.ok("catalog.get", {}, b.extension);
  assert.equal(catalog.defaultModel, "ollama-cloud/gpt-oss:20b");
});

test("a model the server cannot load is reported in settings and never offered", async (t) => {
  const b = await broker(t);
  servers(b, { tags: [...TAGS, { name: "broken:20b", digest: "b1" }] });
  const refused = await b.call(
    "ollama.save",
    { provider: "ollama", baseUrl: SERVER, model: "broken:20b" },
    b.extension,
  );
  assert.equal(refused.error.code, "NOT_SUPPORTED");
  assert.match(
    refused.error.message,
    /broken:20b cannot be used\. The server could not read it: tensor "blk\.0\.ffn_down_exps\.weight" size overflow/,
  );
  const saved = await b.ok(
    "ollama.save",
    { provider: "ollama", baseUrl: SERVER },
    b.extension,
  );
  assert.equal(
    saved.model,
    "qwen3-vl:2b",
    "the default is a model that can use site tools",
  );
  assert.deepEqual(saved.skipped, [
    {
      id: "broken:20b",
      reason:
        'The server could not read it: tensor "blk.0.ffn_down_exps.weight" size overflow',
    },
  ]);
  assert.deepEqual(
    saved.models.find((model) => model.id === "qwen3-vl:2b").parameterSize,
    null,
  );
  const catalog = await b.ok("catalog.get", {}, b.extension);
  const provider = catalog.providers.find((item) => item.id === "ollama");
  assert.equal(
    provider.models.some((model) => model.model === "broken:20b"),
    false,
  );
});

test("a server that stops answering says so, and the page never sees its address", async (t) => {
  const b = await broker(t);
  const state = servers(b);
  await b.ok(
    "ollama.save",
    { provider: "ollama", baseUrl: SERVER },
    b.extension,
  );
  await b.ok(
    "provider.select",
    { type: "ollama", model: "qwen3-vl:2b" },
    b.extension,
  );
  await b.approve(["models.generate"]);
  state.down = true;
  const failed = await b.call("models.generate", {
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(failed.error.code, "PROVIDER_ERROR");
  assert.equal(
    failed.error.message,
    "The Ollama server is not answering. Check that it is running and reachable.",
  );
  assert.equal(JSON.stringify(failed).includes("172.31.7.3"), false);
});

test("a model that stops loading after discovery is re-checked and then held back", async (t) => {
  const b = await broker(t);
  const state = servers(b);
  await b.ok(
    "ollama.save",
    { provider: "ollama", baseUrl: SERVER },
    b.extension,
  );
  await b.ok(
    "provider.select",
    { type: "ollama", model: "qwen3-vl:2b" },
    b.extension,
  );
  await b.approve(["models.generate"]);
  // Same file, same digest: only the server changed.
  state.broken.add("qwen3-vl:2b");
  const failed = await b.call("models.generate", {
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(
    failed.error.message,
    "The Ollama server could not load this model. Refresh models in extension settings to see the server's reason.",
  );
  // The failed turn queues a re-check of that one model; no Refresh needed.
  let summary;
  for (let i = 0; i < 50; i++) {
    summary = await b.ok("ollama.get", { provider: "ollama" }, b.extension);
    if (summary.skipped.length) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(summary.skipped, [
    {
      id: "qwen3-vl:2b",
      reason:
        'The server could not read it: tensor "blk.0.ffn_down_exps.weight" size overflow',
    },
  ]);
  assert.equal(
    summary.models.some((model) => model.id === "qwen3-vl:2b"),
    false,
  );
  assert.equal(
    summary.model,
    "qwen3.8:4b-distill",
    "the default moves to a model that works",
  );
  // Only the failed model was described again.
  const reshown = b.requests
    .filter((item) => item.url.endsWith("/api/show"))
    .slice(-1)
    .map((item) => item.payload.model);
  assert.deepEqual(reshown, ["qwen3-vl:2b"]);
});
