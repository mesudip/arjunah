import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCatalog,
  findModel,
  modelTraits,
  publicModelEntry,
  publicProvider,
} from "../src/lib/catalog.js";
import { validateAccessRequest } from "../src/lib/validation.js";
import { broker } from "./helpers/broker.mjs";

const LOCAL = "http://127.0.0.1:11434";
const ask = { messages: [{ role: "user", content: "hi" }] };

function ollamaSettings(baseUrl) {
  return {
    baseUrl,
    model: "qwen3-vl:2b",
    models: [
      { id: "qwen3-vl:2b", capabilities: { tools: true } },
      // Pulled from ollama.com: the server forwards it there.
      { id: "gpt-oss:120b-cloud", capabilities: { tools: true }, remote: true },
    ],
  };
}

function catalogWith(overrides = {}) {
  return buildCatalog({
    openai: { apiKey: "k", model: "gpt-5.6-sol" },
    opencode: { apiKey: "z", model: "muse-spark-1.3", models: [] },
    ollama: ollamaSettings(LOCAL),
    ollamaCloud: {
      baseUrl: "https://ollama.com",
      apiKey: "c",
      model: "gpt-oss:20b",
      models: [{ id: "gpt-oss:20b", capabilities: { tools: true } }],
    },
    desktop: {
      token: "t",
      providers: [
        {
          id: "claude-code",
          name: "Claude Code",
          vendor: "Anthropic",
          installed: true,
          available: true,
          models: [{ id: "sonnet" }],
        },
        {
          id: "codex",
          name: "Codex",
          vendor: "OpenAI",
          installed: true,
          available: true,
          models: [{ id: "gpt-5.5" }],
        },
        {
          id: "opencode",
          name: "OpenCode",
          vendor: "OpenCode",
          installed: true,
          available: true,
          models: [{ id: "opencode/big-pickle" }],
        },
      ],
    },
    active: { type: "openai" },
    ...overrides,
  });
}

function traitsOf(catalog, id) {
  const { provider, model } = findModel(catalog, id);
  const entry = publicModelEntry(provider, model, false);
  return [entry.kind, entry.local, entry.builtinTools];
}

test("every model entry says its kind, whether it runs locally, and whether it has tools of its own", () => {
  const catalog = catalogWith();
  assert.deepEqual(traitsOf(catalog, "openai/gpt-5.6-sol"), [
    "api-key",
    false,
    false,
  ]);
  assert.deepEqual(traitsOf(catalog, "opencode-api/muse-spark-1.3"), [
    "api-key",
    false,
    false,
  ]);
  assert.deepEqual(traitsOf(catalog, "ollama/qwen3-vl:2b"), [
    "self-hosted",
    true,
    false,
  ]);
  assert.deepEqual(
    traitsOf(catalog, "ollama/gpt-oss:120b-cloud"),
    ["self-hosted", false, false],
    "a model the server forwards to ollama.com is not local",
  );
  assert.deepEqual(traitsOf(catalog, "ollama-cloud/gpt-oss:20b"), [
    "api-key",
    false,
    false,
  ]);
  assert.deepEqual(traitsOf(catalog, "claude-code/sonnet"), [
    "subscription",
    false,
    false,
  ]);
  assert.deepEqual(
    traitsOf(catalog, "codex/gpt-5.5"),
    ["subscription", false, true],
    "Codex keeps a read-only shell of its own",
  );
  assert.deepEqual(traitsOf(catalog, "opencode-cli/opencode/big-pickle"), [
    "subscription",
    false,
    false,
  ]);
  // A desktop model the list does not name still gets its provider's traits.
  const typed = findModel(catalog, "codex/typed-model");
  assert.deepEqual(modelTraits(typed.provider, typed.model), {
    kind: "subscription",
    local: false,
    builtinTools: true,
  });
});

test("local is true only at a loopback or private IP literal, never for a name it cannot resolve", () => {
  for (const [baseUrl, local] of [
    ["http://127.0.0.1:11434", true],
    ["http://localhost:11434", true],
    ["http://[::1]:11434", true],
    ["http://192.168.1.20:11434", true],
    ["http://10.0.0.5:11434", true],
    ["https://172.20.1.1/ollama", true],
    ["http://100.101.1.2:11434", true],
    ["http://gpu-box:11434", false],
    ["http://nas.lan:11434", false],
    ["https://ollama.example.com", false],
    ["https://8.8.8.8", false],
    [undefined, false],
  ]) {
    const catalog = catalogWith({ ollama: ollamaSettings(baseUrl) });
    assert.equal(
      traitsOf(catalog, "ollama/qwen3-vl:2b")[1],
      local,
      String(baseUrl),
    );
  }
});

test("vendor is null wherever the configured address does not settle it", () => {
  const vendors = (catalog) =>
    Object.fromEntries(
      catalog.providers
        .filter((provider) => provider.available)
        .map((provider) => [provider.id, publicProvider(provider).vendor]),
    );
  assert.deepEqual(vendors(catalogWith()), {
    openai: "OpenAI",
    "opencode-api": "OpenCode",
    ollama: null,
    "ollama-cloud": "Ollama",
    "claude-code": "Anthropic",
    codex: "OpenAI",
    "opencode-cli": null,
  });
  const custom = vendors(
    catalogWith({
      openai: {
        apiKey: "k",
        model: "llama",
        baseUrl: "https://llm.internal.example/v1",
      },
      opencode: {
        apiKey: "z",
        model: "muse-spark-1.3",
        baseUrl: "https://proxy.example/zen/v1",
      },
    }),
  );
  assert.equal(custom.openai, null, "a custom OpenAI base URL");
  assert.equal(custom["opencode-api"], null);
  assert.equal(
    vendors(
      catalogWith({
        openai: {
          apiKey: "k",
          model: "gpt-5.6-sol",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
    ).openai,
    "OpenAI",
  );
});

test("require is validated member by member and kept only with model access", () => {
  const level = (input) => validateAccessRequest(input).require;
  assert.equal(level({}), undefined, "absent");
  assert.equal(level({ require: null }), undefined);
  assert.deepEqual(level({ require: {} }), {}, "an explicit empty constraint");
  assert.deepEqual(
    level({
      require: {
        kinds: ["subscription", "self-hosted"],
        local: true,
        builtinTools: false,
      },
    }),
    {
      kinds: ["subscription", "self-hosted"],
      local: true,
      builtinTools: false,
    },
  );
  assert.deepEqual(
    level({ require: { kinds: ["self-hosted", "api-key"] } }),
    { kinds: ["api-key", "self-hosted"] },
    "kinds are normalized to one order",
  );
  for (const require of [
    "local",
    [],
    { kinds: [] },
    { kinds: ["cloud"] },
    { kinds: ["api-key", "api-key"] },
    { kinds: "api-key" },
    { local: false },
    { local: "yes" },
    { builtinTools: true },
    { vendor: "OpenAI" },
  ])
    assert.throws(
      () => validateAccessRequest({ require }),
      (error) =>
        error.code === "INVALID_REQUEST" && error.details?.field === "require",
      JSON.stringify(require),
    );
  assert.throws(
    () =>
      validateAccessRequest({
        capabilities: ["context.read"],
        context: ["title"],
        require: { local: true },
      }),
    (error) => error.code === "INVALID_REQUEST",
    "require without model access",
  );
});

/**
 * An Ollama server at 127.0.0.1 with one model of its own and one it forwards
 * to ollama.com, beside the broker's default OpenAI-compatible provider at a
 * custom address. `chat` counts what reached the Ollama server.
 */
async function localSetup(t) {
  const b = await broker(t);
  const chats = [];
  b.hooks.fetch = async (url, init, payload) => {
    const target = new URL(url);
    if (target.origin === LOCAL) {
      if (target.pathname === "/api/tags")
        return Response.json({
          models: [
            { name: "qwen3-vl:2b", digest: "v1" },
            { name: "gpt-oss:120b-cloud", digest: "c1" },
          ],
        });
      if (target.pathname === "/api/show")
        return Response.json({ capabilities: ["completion", "tools"] });
      if (target.pathname === "/api/ps") return Response.json({ models: [] });
      if (target.pathname === "/api/chat") {
        chats.push(payload);
        return Response.json({
          message: { role: "assistant", content: "local answer" },
          done: true,
        });
      }
      return new Response("nope", { status: 404 });
    }
    return Response.json({
      choices: [{ message: { content: "remote answer" } }],
    });
  };
  await b.ok(
    "ollama.save",
    { provider: "ollama", baseUrl: LOCAL, model: "qwen3-vl:2b" },
    b.extension,
  );
  await b.ok("catalog.default", { model: "openai/allowed" }, b.extension);
  return { b, chats };
}

test("consent offers only the models a site's require accepts, and pins the choice", async (t) => {
  const { b } = await localSetup(t);
  const status = await b.ok("broker.status", { require: { local: true } });
  assert.deepEqual(status.require, { local: true });
  assert.deepEqual(
    status.models.map((model) => model.id),
    ["ollama/qwen3-vl:2b"],
  );
  assert.equal(status.model, "ollama/qwen3-vl:2b", "preselects one that fits");
  assert.deepEqual(
    status.providers.map((provider) => provider.id),
    ["ollama"],
  );
  // Without a constraint consent lists everything, as before.
  const open = await b.ok("broker.status", {});
  assert.equal(open.require, null);
  assert.ok(open.models.length > 1);

  // A model that does not qualify is refused even if the sheet were bypassed.
  const refused = await b.call("grant.approve", {
    capabilities: ["models.list", "models.generate"],
    require: { local: true },
    model: "openai/allowed",
  });
  assert.equal(refused.error.code, "NOT_SUPPORTED");
  assert.equal(b.store.grants["https://site.test"], undefined);

  const grant = await b.approve(["models.list", "models.generate"], {
    require: { local: true },
    model: "ollama/qwen3-vl:2b",
  });
  assert.equal(grant.model, "ollama/qwen3-vl:2b");
  assert.deepEqual(b.store.grants["https://site.test"].require, {
    local: true,
  });
  assert.equal(
    Object.hasOwn(grant, "require"),
    false,
    "the stored constraint is not part of the public grant",
  );
  // A request without require keeps the stored one.
  await b.approve(["models.list", "models.generate"]);
  assert.deepEqual(b.store.grants["https://site.test"].require, {
    local: true,
  });
  // The hosted consent of a restricted grant is restricted too.
  const hosted = await b.ok("broker.status", {});
  assert.deepEqual(
    hosted.models.map((model) => model.id),
    ["ollama/qwen3-vl:2b"],
  );
});

test("with nothing that qualifies, consent says so and approval is NOT_CONFIGURED", async (t) => {
  const b = await broker(t);
  const status = await b.ok("broker.status", {
    require: { kinds: ["subscription"] },
  });
  assert.deepEqual(status.models, []);
  assert.equal(status.configured, false);
  const refused = await b.call("grant.approve", {
    capabilities: ["models.list", "models.generate"],
    require: { kinds: ["subscription"] },
  });
  assert.equal(refused.error.code, "NOT_CONFIGURED");
  assert.equal(b.store.grants["https://site.test"], undefined);
});

test("level 2 lists only qualifying models and generate refuses the rest before any request", async (t) => {
  const { b, chats } = await localSetup(t);
  await b.approve(["models.list", "models.generate", "models.catalog"], {
    require: { local: true },
    model: "ollama/qwen3-vl:2b",
  });
  const models = await b.ok("models.list");
  assert.deepEqual(
    models.map((model) => [
      model.id,
      model.kind,
      model.local,
      model.builtinTools,
      model.default,
    ]),
    [["ollama/qwen3-vl:2b", "self-hosted", true, false, true]],
  );
  assert.deepEqual(
    (await b.ok("providers.list")).map((provider) => [
      provider.id,
      provider.vendor,
      provider.models,
    ]),
    [["ollama", null, ["ollama/qwen3-vl:2b"]]],
  );
  assert.equal(JSON.stringify(models).includes("127.0.0.1"), false);

  const result = await b.ok("models.generate", ask);
  assert.equal(result.message.content, "local answer");
  assert.deepEqual(
    [result.model, result.kind, result.local, result.builtinTools],
    ["ollama/qwen3-vl:2b", "self-hosted", true, false],
  );
  const sent = b.requests.length;
  for (const model of ["ollama/gpt-oss:120b-cloud", "openai/allowed"]) {
    const refused = await b.call("models.generate", { ...ask, model });
    assert.ok(
      ["NOT_SUPPORTED", "INVALID_REQUEST"].includes(refused.error.code),
      model,
    );
  }
  // The cloud model is exposed (its provider is) but does not qualify.
  const cloud = await b.call("models.generate", {
    ...ask,
    model: "ollama/gpt-oss:120b-cloud",
  });
  assert.equal(cloud.error.code, "NOT_SUPPORTED");
  assert.equal(
    b.requests
      .slice(sent)
      .filter((item) => /\/(api\/chat|chat\/completions)$/.test(item.url))
      .length,
    0,
    "no provider was contacted",
  );
  assert.equal(chats.length, 1);
});

test("a later site-model change must qualify on every surface, and following the default pins it", async (t) => {
  const { b } = await localSetup(t);
  await b.approve(["models.list", "models.generate"], {
    require: { kinds: ["self-hosted"] },
    model: "ollama/qwen3-vl:2b",
  });
  const origin = "https://site.test";
  // Popup and options use site.update; the hosted header uses hosted.model.
  const popup = await b.call(
    "site.update",
    { origin, model: "openai/allowed" },
    b.extension,
  );
  assert.equal(popup.error.code, "NOT_SUPPORTED");
  const unpinned = await b.call(
    "site.update",
    { origin, model: null },
    b.extension,
  );
  assert.equal(
    unpinned.error.code,
    "NOT_SUPPORTED",
    "the global default (OpenAI) does not qualify",
  );
  assert.equal(b.store.grants[origin].model, "ollama/qwen3-vl:2b");
  // Self-hosted, but forwarded to ollama.com: still a self-hosted kind.
  const moved = await b.ok(
    "site.update",
    { origin, model: "ollama/gpt-oss:120b-cloud" },
    b.extension,
  );
  assert.equal(moved.grant.model, "ollama/gpt-oss:120b-cloud");
  assert.deepEqual(moved.require, { kinds: ["self-hosted"] });
  assert.deepEqual(moved.acceptedModels.sort(), [
    "ollama/gpt-oss:120b-cloud",
    "ollama/qwen3-vl:2b",
  ]);

  await b.approve(["chat.hosted"]);
  const header = await b.call("hosted.model", { model: "openai/allowed" });
  assert.equal(header.error.code, "NOT_SUPPORTED");
  const settings = await b.ok("hosted.settings");
  assert.deepEqual(
    settings.models.map((model) => model.id).sort(),
    ["ollama/gpt-oss:120b-cloud", "ollama/qwen3-vl:2b"],
    "the header offers only what qualifies",
  );

  // When the default itself qualifies, "follow the default" pins it.
  await b.ok("catalog.default", { model: "ollama/qwen3-vl:2b" }, b.extension);
  await b.ok("site.update", { origin, model: null }, b.extension);
  assert.equal(b.store.grants[origin].model, "ollama/qwen3-vl:2b");
});

test("a grant whose pinned model went away refuses a fallback that does not qualify", async (t) => {
  const { b, chats } = await localSetup(t);
  await b.approve(["models.list", "models.generate"], {
    require: { local: true },
    model: "ollama/qwen3-vl:2b",
  });
  // The Ollama server is removed; the global default (OpenAI) would answer.
  await b.ok("ollama.clear", { provider: "ollama" }, b.extension);
  const sent = b.requests.length;
  const refused = await b.call("models.generate", ask);
  assert.equal(refused.error.code, "NOT_SUPPORTED");
  assert.equal(b.requests.length, sent, "nothing was sent");
  assert.equal(chats.length, 0);
});
