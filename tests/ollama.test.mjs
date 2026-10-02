import test from "node:test";
import assert from "node:assert/strict";
import { generate, listOllamaModels } from "../src/lib/provider.js";
import { publicError } from "../src/lib/errors.js";
import {
  OLLAMA_KEY_REFUSAL,
  OLLAMA_ORIGIN_REFUSAL,
  OLLAMA_PROXY_REFUSAL,
  normalizeOllamaModels,
  ollamaDisplayName,
  ollamaPreferredModel,
  ollamaProcessor,
  ollamaRefusal,
  ollamaServerText,
  ollamaSkipReason,
  ollamaVersionAtLeast,
  ollamaBaseUrl,
  ollamaLocalHost,
  ollamaModelInfo,
  ollamaOriginRule,
  ollamaThink,
} from "../src/lib/ollama.js";

const PNG = "iVBORw0KGgo=";

function ndjson(lines) {
  return new Response(
    lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
    {
      headers: { "Content-Type": "application/x-ndjson" },
    },
  );
}

function local(model = "qwen3-vl:2b", extra = {}) {
  return {
    kind: "ollama",
    cloud: false,
    providerId: "ollama",
    providerName: "Ollama (self-hosted)",
    baseUrl: "http://192.168.1.20:11434",
    apiKey: null,
    model,
    capabilities: { tools: true, vision: true, reasoning: true },
    contextWindow: 262144,
    reasoningLevels: ["none", "high"],
    think: "boolean",
    ...extra,
  };
}

function withFetch(t, handler) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const request = {
      url: String(url),
      init,
      payload: init.body ? JSON.parse(init.body) : null,
    };
    requests.push(request);
    return handler(request);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return requests;
}

test("only local-network hosts may use plain http, and pasted endpoints are trimmed", () => {
  for (const host of [
    "localhost",
    "127.0.0.1",
    "10.0.0.7",
    "172.31.7.3",
    "192.168.1.20",
    "100.101.102.103",
    "169.254.1.1",
    "[::1]",
    "[fd12:3456::1]",
    "[fe80::1]",
    "gpubox",
    "gpu.local",
    "nas.home.arpa",
    "box.tail1234.ts.net",
  ])
    assert.equal(ollamaLocalHost(host), true, host);
  for (const host of [
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "example.com",
    "[2001:db8::1]",
  ])
    assert.equal(ollamaLocalHost(host), false, host);
  assert.equal(ollamaBaseUrl(""), "http://127.0.0.1:11434");
  assert.equal(ollamaBaseUrl("172.31.7.3:11434"), "http://172.31.7.3:11434");
  assert.equal(
    ollamaBaseUrl("http://172.31.7.3:11434/api/"),
    "http://172.31.7.3:11434",
  );
  assert.equal(
    ollamaBaseUrl("https://ai.example.com/ollama/v1"),
    "https://ai.example.com/ollama",
  );
  assert.throws(
    () => ollamaBaseUrl("http://ai.example.com:11434"),
    /local network/,
  );
  assert.throws(
    () => ollamaBaseUrl("http://user:pw@localhost:11434"),
    /credentials/,
  );
  assert.throws(() => ollamaBaseUrl("ftp://localhost"), /http or https/);
  assert.throws(() => ollamaBaseUrl("http://localhost:11434/?x=1"), /query/);
});

test("model metadata comes from the server: embeddings drop out, capabilities and thinking map", () => {
  assert.equal(
    ollamaModelInfo(
      { name: "nomic-embed-text:latest" },
      { capabilities: ["embedding"] },
    ),
    null,
  );
  const vision = ollamaModelInfo(
    { name: "qwen3-vl:2b", digest: "abc", details: { context_length: 4096 } },
    {
      capabilities: ["completion", "vision", "tools", "thinking"],
      model_info: { "qwen3vl.context_length": 262144 },
    },
  );
  assert.deepEqual(vision, {
    id: "qwen3-vl:2b",
    digest: "abc",
    capabilities: { tools: true, vision: true, reasoning: true },
    contextWindow: 262144,
    reasoningLevels: ["none", "high"],
    defaultReasoning: null,
    think: "boolean",
    parameterSize: null,
    quantization: null,
    remote: false,
  });
  // The tags entry under-reports; /api/show wins.
  const shown = ollamaModelInfo(
    { name: "gemma4:e2b", capabilities: ["completion", "tools", "thinking"] },
    { capabilities: ["completion", "vision", "audio", "tools", "thinking"] },
  );
  assert.equal(shown.capabilities.vision, true);
  // Without /api/show the tags capabilities are used, and without either the
  // model is offered with nothing it might refuse.
  assert.deepEqual(ollamaModelInfo({ name: "old:1b" }, null).capabilities, {
    tools: false,
    vision: false,
    reasoning: false,
  });
  // Cloud servers publish their thinking levels.
  const levels = ollamaModelInfo(
    { name: "deepseek-v4.1-flash" },
    {
      capabilities: ["completion", "thinking", "tools", "vision"],
      thinking: { values: [false, "low", "high", "max"], default: "high" },
    },
  );
  assert.deepEqual(levels.reasoningLevels, ["none", "low", "high", "max"]);
  assert.equal(levels.defaultReasoning, "high");
  assert.equal(levels.think, "levels");
  const toggle = ollamaModelInfo(
    { name: "gemma4:31b" },
    {
      capabilities: ["completion", "thinking"],
      thinking: { values: [false, true], default: false },
    },
  );
  assert.deepEqual(toggle.reasoningLevels, ["none", "high"]);
  assert.equal(toggle.defaultReasoning, "none");
  // A local server that does not publish levels still knows gpt-oss takes them.
  const oss = ollamaModelInfo(
    { name: "gpt-oss:20b", details: { family: "gptoss" } },
    { capabilities: ["completion", "tools", "thinking"] },
  );
  assert.deepEqual(oss.reasoningLevels, ["low", "medium", "high"]);
  assert.equal(oss.think, "levels");
  // Stored or synced entries are re-validated.
  assert.deepEqual(
    normalizeOllamaModels([
      { id: "b", capabilities: { vision: "yes" }, reasoningLevels: ["huge"] },
      {
        id: "a",
        capabilities: { reasoning: true },
        reasoningLevels: ["none", "high"],
        think: "boolean",
      },
      { id: "a" },
      { id: 7 },
    ]).map((model) => [
      model.id,
      model.capabilities.vision,
      model.reasoningLevels,
    ]),
    [
      ["a", false, ["none", "high"]],
      ["b", false, []],
    ],
  );
});

test("thinking effort maps to Ollama's think field and never reaches a model without it", () => {
  const toggle = local();
  assert.equal(ollamaThink(toggle, undefined), undefined);
  assert.equal(ollamaThink(toggle, "none"), false);
  assert.equal(ollamaThink(toggle, "low"), true);
  const levels = local("deepseek", {
    reasoningLevels: ["none", "low", "high", "max"],
    think: "levels",
  });
  assert.equal(ollamaThink(levels, "high"), "high");
  assert.equal(ollamaThink(levels, "medium"), "high");
  assert.equal(ollamaThink(levels, "xhigh"), "max");
  const oss = local("gpt-oss", {
    reasoningLevels: ["low", "medium", "high"],
    think: "levels",
  });
  assert.equal(ollamaThink(oss, "none"), undefined);
  assert.equal(ollamaThink(oss, "max"), "high");
  const plain = local("glm-ocr", {
    capabilities: { tools: true, vision: true, reasoning: false },
    reasoningLevels: [],
    think: null,
  });
  assert.equal(ollamaThink(plain, "high"), undefined);
});

test("the native chat request carries bare images, object arguments, tool names, and options", async (t) => {
  const requests = withFetch(t, ({ url }) =>
    url.endsWith("/api/ps")
      ? Response.json({
          models: [
            {
              name: "qwen3-vl:2b",
              context_length: 32768,
              size: 1000,
              size_vram: 1000,
            },
          ],
        })
      : Response.json({
          model: "qwen3-vl:2b",
          message: {
            role: "assistant",
            content: "Done.",
            thinking: "Considered it.",
          },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 40,
          eval_count: 9,
        }),
  );
  const result = await generate(local(), {
    messages: [
      { role: "system", content: "Be brief." },
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          { type: "image", mediaType: "image/png", data: PNG },
        ],
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "site__lookup", arguments: '{"q":"x"}' },
          },
        ],
      },
      { role: "tool", toolCallId: "call_1", content: '{"found":true}' },
    ],
    tools: [
      {
        name: "site__lookup",
        description: "Look something up",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ],
    temperature: 0.2,
    maxTokens: 300,
    reasoning: "none",
  });
  const chat = requests[0];
  assert.equal(chat.url, "http://192.168.1.20:11434/api/chat");
  assert.equal(chat.init.method, "POST");
  assert.equal(chat.init.headers.Authorization, undefined, "no key, no header");
  assert.deepEqual(chat.payload, {
    model: "qwen3-vl:2b",
    stream: false,
    think: false,
    options: { temperature: 0.2, num_predict: 300 },
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "What is this?", images: [PNG] },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            function: { index: 0, name: "site__lookup", arguments: { q: "x" } },
          },
        ],
      },
      {
        role: "tool",
        content: '{"found":true}',
        tool_call_id: "call_1",
        tool_name: "site__lookup",
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "site__lookup",
          description: "Look something up",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      },
    ],
  });
  assert.equal(result.model, "ollama/qwen3-vl:2b");
  assert.equal(result.message.content, "Done.");
  assert.equal(result.message.reasoning, "Considered it.");
  assert.deepEqual(result.usage, {
    promptTokens: 40,
    completionTokens: 9,
    totalTokens: 49,
    cachedTokens: 0,
    reasoningTokens: 0,
  });
  // The loaded context, not the trained maximum, is what bounds the prompt.
  assert.equal(result.contextWindow, 32768);
  assert.deepEqual(result.processor, {
    placement: "gpu",
    gpuPercent: 100,
    label: "100% GPU",
    until: null,
  });
  assert.equal(requests[1].url, "http://192.168.1.20:11434/api/ps");
});

test("a streamed answer forwards thinking and text deltas and assembles whole tool calls", async (t) => {
  withFetch(t, ({ url }) =>
    url.endsWith("/api/ps")
      ? Response.json({ models: [] })
      : ndjson([
          { message: { role: "assistant", content: "", thinking: "Need " } },
          { message: { role: "assistant", content: "", thinking: "weather." } },
          { message: { role: "assistant", content: "Checking" } },
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_a",
                  function: {
                    index: 0,
                    name: "get_weather",
                    arguments: { city: "Kathmandu" },
                  },
                },
              ],
            },
          },
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                { function: { index: 1, name: "get_time", arguments: {} } },
              ],
            },
          },
          {
            message: { role: "assistant", content: "" },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 12,
            eval_count: 30,
          },
        ]),
  );
  const items = [];
  const result = await generate(
    local("qwen3-vl:2b", {
      contextWindow: 262144,
      // A different server, so the previous test's cached runtime context
      // (30 s per server and model) does not answer for this one.
      baseUrl: "http://192.168.1.21:11434",
    }),
    {
      messages: [{ role: "user", content: "Weather?" }],
      tools: [
        { name: "get_weather", inputSchema: { type: "object" } },
        { name: "get_time", inputSchema: { type: "object" } },
      ],
    },
    undefined,
    false,
    { progress: { onItem: (item) => items.push(item) } },
  );
  assert.deepEqual(items, [
    { type: "reasoning_delta", text: "Need " },
    { type: "reasoning_delta", text: "weather." },
    { type: "output_delta", text: "Checking" },
  ]);
  assert.equal(result.message.reasoning, "Need weather.");
  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(
    result.message.toolCalls.map((call) => [call.name, call.arguments]),
    [
      ["get_weather", '{"city":"Kathmandu"}'],
      ["get_time", "{}"],
    ],
  );
  assert.equal(result.message.toolCalls[0].id, "call_a");
  assert.ok(result.message.toolCalls[1].id, "a missing id is minted");
  // An unloaded model leaves the catalog's context window in place.
  assert.equal(result.contextWindow, 262144);
});

test("Ollama refusals become our own sentences, and a cut-off stream is an error", async (t) => {
  let reply;
  withFetch(t, () => reply());
  const ask = { messages: [{ role: "user", content: "hi" }] };
  const cases = [
    // Ollama's own Origin check answers 403 with no body at all.
    [
      () => new Response(null, { status: 403 }),
      "PROVIDER_ERROR",
      OLLAMA_ORIGIN_REFUSAL,
    ],
    // Anything that says something is not Ollama's Origin check.
    [
      () => new Response("Forbidden", { status: 403 }),
      "PROVIDER_ERROR",
      OLLAMA_PROXY_REFUSAL,
    ],
    [
      () => Response.json({ error: "model 'x' not found" }, { status: 404 }),
      "MODEL_UNAVAILABLE",
      /does not have this model/,
    ],
    [
      () =>
        Response.json(
          { error: '"m" does not support thinking' },
          { status: 400 },
        ),
      "NOT_SUPPORTED",
      /does not support thinking/,
    ],
    [
      () =>
        Response.json(
          {
            error:
              '{"error":{"message":"image input is not supported - hint: provide the mmproj"}}',
          },
          { status: 500 },
        ),
      "NOT_SUPPORTED",
      /does not accept images/,
    ],
    [
      () =>
        Response.json(
          { error: "secret prompt text echoed back" },
          { status: 500 },
        ),
      "PROVIDER_ERROR",
      /rejected the request \(500\)/,
    ],
  ];
  for (const [response, code, message] of cases) {
    reply = response;
    await assert.rejects(generate(local(), ask), (error) => {
      assert.equal(error.code, code);
      if (message instanceof RegExp) assert.match(error.message, message);
      else assert.equal(error.message, message);
      assert.doesNotMatch(error.message, /secret prompt/);
      return true;
    });
  }
  const stream = { progress: { onItem() {} } };
  reply = () => ndjson([{ message: { role: "assistant", content: "par" } }]);
  await assert.rejects(
    generate(local(), ask, undefined, false, stream),
    /ended without a response/,
  );
  reply = () =>
    ndjson([
      { message: { content: "a" } },
      { error: "llama runner process has terminated" },
    ]);
  await assert.rejects(
    generate(local(), ask, undefined, false, stream),
    /reported an error while streaming/,
  );
  reply = () =>
    ndjson([
      { error: "model requires more system memory (12 GiB) than is available" },
    ]);
  await assert.rejects(
    generate(local(), ask, undefined, false, stream),
    /not have enough memory/,
  );
});

test("an Ollama refusal reaches the page with its retry advice", async (t) => {
  let reply;
  withFetch(t, () => reply());
  const ask = { messages: [{ role: "user", content: "hi" }] };
  const seen = async () => {
    try {
      await generate(local(), ask);
    } catch (error) {
      return publicError(error);
    }
    assert.fail("the request should have been refused");
  };

  reply = () =>
    Response.json(
      { error: "too many requests" },
      { status: 429, headers: { "Retry-After": "30" } },
    );
  const limited = await seen();
  assert.equal(limited.code, "RATE_LIMITED");
  assert.deepEqual(limited.details, { retryAfterMs: 30000, retryable: true });

  reply = () =>
    Response.json(
      { error: 'tensor "blk.0.ffn_down_exps.weight" size overflow' },
      { status: 500 },
    );
  const unloadable = await seen();
  assert.equal(unloadable.code, "MODEL_UNAVAILABLE");
  assert.equal(unloadable.details.retryable, false);

  const stream = { progress: { onItem() {} } };
  reply = () =>
    ndjson([{ message: { content: "a" } }, { error: "llama runner died" }]);
  try {
    await generate(local(), ask, undefined, false, stream);
    assert.fail("the stream should have failed");
  } catch (error) {
    assert.equal(publicError(error).details.retryable, true);
  }

  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const unreachable = await seen();
  assert.equal(unreachable.code, "PROVIDER_ERROR");
  assert.equal(unreachable.details.retryable, true);
});

test("Ollama Cloud sends its bearer key and the key never appears in results", async (t) => {
  const requests = withFetch(t, () =>
    Response.json({
      message: { role: "assistant", content: "hi" },
      done: true,
    }),
  );
  const result = await generate(
    local("gpt-oss:20b", {
      cloud: true,
      providerId: "ollama-cloud",
      baseUrl: "https://ollama.com",
      apiKey: "cloud-secret",
    }),
    { messages: [{ role: "user", content: "hi" }] },
  );
  assert.equal(requests[0].url, "https://ollama.com/api/chat");
  assert.equal(requests[0].init.headers.Authorization, "Bearer cloud-secret");
  assert.equal(requests.length, 1, "no /api/ps lookup for a hosted service");
  assert.equal(JSON.stringify(result).includes("cloud-secret"), false);
  assert.equal(result.model, "ollama-cloud/gpt-oss:20b");
});

test("discovery reads each changed model once, skips models the server cannot run, and surfaces a refused origin", async (t) => {
  let showStatus = 200;
  let flaky = false;
  let serverVersion = "0.25.0";
  const requests = withFetch(t, ({ url, payload }) => {
    if (url.endsWith("/api/version"))
      return Response.json({ version: serverVersion });
    if (url.endsWith("/api/tags"))
      return Response.json({
        models: [
          {
            name: "qwen3-vl:2b",
            digest: "d1",
            details: { parameter_size: "2.1B", quantization_level: "Q4_K_M" },
          },
          { name: "nomic-embed-text:latest", digest: "d2" },
          {
            name: "llama3.2:latest",
            digest: "d3",
            capabilities: ["completion", "tools"],
          },
          {
            name: "gpt-oss:20b",
            digest: "d4",
            capabilities: ["completion", "tools"],
          },
          { name: "minicpm-v4.5:8b", digest: "d5" },
          {
            name: "gpt-oss:120b-cloud",
            digest: "d6",
            remote_host: "https://ollama.com:443",
          },
        ],
      });
    if (showStatus !== 200)
      return new Response(showStatus === 403 ? null : "no", {
        status: showStatus,
      });
    if (payload.model === "llama3.2:latest" && flaky)
      throw new TypeError("Failed to fetch");
    if (payload.model === "gpt-oss:20b")
      return Response.json(
        { error: 'tensor "blk.0.ffn_down_exps.weight" size overflow' },
        { status: 500 },
      );
    if (payload.model === "minicpm-v4.5:8b")
      return Response.json({
        capabilities: ["completion", "vision"],
        requires: "0.30.0",
      });
    return Response.json({
      capabilities:
        payload.model === "nomic-embed-text:latest"
          ? ["embedding"]
          : payload.model === "qwen3-vl:2b"
            ? ["completion", "vision", "tools", "thinking"]
            : ["completion", "tools"],
    });
  });
  const config = {
    kind: "ollama",
    cloud: false,
    baseUrl: "http://localhost:11434",
    apiKey: null,
  };
  const found = await listOllamaModels(config);
  assert.equal(found.version, "0.25.0");
  assert.deepEqual(
    found.models.map((model) => [model.id, model.capabilities, model.remote]),
    [
      [
        "gpt-oss:120b-cloud",
        { tools: true, vision: false, reasoning: false },
        true,
      ],
      [
        "llama3.2:latest",
        { tools: true, vision: false, reasoning: false },
        false,
      ],
      ["qwen3-vl:2b", { tools: true, vision: true, reasoning: true }, false],
    ],
    "embedding models drop out; a cloud-forwarded model is marked",
  );
  const vl = found.models.find((model) => model.id === "qwen3-vl:2b");
  assert.equal(vl.parameterSize, "2.1B");
  assert.equal(vl.quantization, "Q4_K_M");
  assert.deepEqual(
    found.skipped.map(({ id, reason }) => ({ id, reason })),
    [
      {
        id: "gpt-oss:20b",
        reason:
          'Ollama 0.25.0 on the server could not read it: tensor "blk.0.ffn_down_exps.weight" size overflow',
      },
      {
        id: "minicpm-v4.5:8b",
        reason: "It needs Ollama 0.30.0 or newer; this server runs 0.25.0.",
      },
    ],
  );
  // Every outcome is stamped with the server version it was checked on.
  assert.ok(
    [...found.models, ...found.skipped, ...found.ignored].every(
      (item) => item.checkedWith === "2:0.25.0",
    ),
  );
  assert.deepEqual(
    found.ignored.map((item) => item.id),
    ["nomic-embed-text:latest"],
  );
  // Nothing unchanged is described again: not the chat models, not the
  // skipped ones, not the embedding model.
  requests.length = 0;
  await listOllamaModels(config, found);
  assert.deepEqual(
    requests.filter((item) => item.url.endsWith("/api/show")),
    [],
  );
  // An Ollama upgrade can break or fix the same file, so a new server
  // version re-reads everything, as does an explicit forced refresh.
  serverVersion = "0.26.0";
  requests.length = 0;
  await listOllamaModels(config, found);
  assert.equal(
    requests.filter((item) => item.url.endsWith("/api/show")).length,
    6,
  );
  serverVersion = "0.25.0";
  requests.length = 0;
  await listOllamaModels(config, found, { force: true });
  assert.equal(
    requests.filter((item) => item.url.endsWith("/api/show")).length,
    6,
  );
  // A description that never arrived keeps the model's last entry.
  flaky = true;
  const changed = found.models.map((model) =>
    model.id === "llama3.2:latest" ? { ...model, digest: "old" } : model,
  );
  const again = await listOllamaModels(config, changed);
  assert.ok(again.models.some((model) => model.id === "llama3.2:latest"));
  assert.equal(
    again.skipped.some((item) => item.id === "llama3.2:latest"),
    false,
  );
  flaky = false;
  showStatus = 403;
  await assert.rejects(
    listOllamaModels(config),
    (error) => error.message === OLLAMA_ORIGIN_REFUSAL,
  );
});

test("a model left out carries the server's own words, cleaned, and never a guessed cause", () => {
  assert.equal(
    ollamaSkipReason({
      status: 500,
      text: 'tensor "x" size overflow',
      version: "0.32.15",
    }),
    'Ollama 0.32.15 on the server could not read it: tensor "x" size overflow',
  );
  // Ollama nests runner errors as JSON inside its own error string.
  assert.equal(
    ollamaServerText(
      '{"error":{"code":500,"message":"unknown model architecture: \'qwen9\'"}}',
    ),
    "unknown model architecture: 'qwen9'",
  );
  assert.equal(
    ollamaServerText("line one\n\u0007line\ttwo"),
    "line one line two",
  );
  assert.equal(ollamaServerText("x".repeat(500)).length, 200);
  assert.equal(
    ollamaSkipReason({ status: 500 }),
    "The server could not read it (HTTP 500).",
  );
  assert.equal(
    ollamaSkipReason({ kind: "retired", text: "retired at …" }),
    "Ollama has retired this model.",
  );
});

test("versions compare numerically and catalog details are normalized", () => {
  assert.equal(ollamaVersionAtLeast("0.32.15", "0.30.0"), true);
  assert.equal(ollamaVersionAtLeast("0.9.1", "0.10.0"), false);
  assert.equal(ollamaVersionAtLeast("0.30.0", "0.30.0"), true);
  assert.equal(
    ollamaVersionAtLeast("unknown", "0.30.0"),
    true,
    "an unreadable version blocks nothing",
  );
  // Ollama Cloud reports a raw parameter count; a cloud provider never marks models remote.
  const hosted = ollamaModelInfo(
    { name: "gpt-oss:20b-cloud", details: { parameter_size: "" } },
    {
      capabilities: ["completion"],
      details: { parameter_size: "20914757184", quantization_level: "MXFP4" },
    },
    { cloud: true },
  );
  assert.equal(hosted.parameterSize, "20.9B");
  assert.equal(hosted.quantization, "MXFP4");
  assert.equal(hosted.remote, false);
  assert.deepEqual(
    normalizeOllamaModels([
      {
        id: "m",
        parameterSize: "<b>7B</b>",
        quantization: "unknown",
        remote: "yes",
      },
    ]).map((model) => [model.parameterSize, model.quantization, model.remote]),
    [[null, null, false]],
  );
  assert.equal(ollamaDisplayName("llama3.2:latest"), "llama3.2");
  assert.equal(ollamaDisplayName("work-model", true), "work-model (cloud)");
  assert.equal(
    ollamaDisplayName("gpt-oss:120b-cloud", true),
    "gpt-oss:120b-cloud",
  );
  assert.deepEqual(
    ollamaPreferredModel(
      [
        { id: "a-cloud", capabilities: { tools: true }, remote: true },
        { id: "b", capabilities: { tools: false } },
        { id: "c", capabilities: { tools: true } },
      ],
      "gone",
    ),
    "c",
    "the default runs on the server and can use site tools",
  );
});

test("the Origin rule targets one server and only this extension's own requests", () => {
  assert.deepEqual(
    ollamaOriginRule("http://172.31.7.3:11434/proxy", "abcdef"),
    {
      id: 4101,
      priority: 1,
      condition: {
        urlFilter: "|http://172.31.7.3:11434/",
        initiatorDomains: ["abcdef"],
        resourceTypes: ["xmlhttprequest"],
      },
      action: {
        type: "modifyHeaders",
        requestHeaders: [{ header: "origin", operation: "remove" }],
      },
    },
  );
  assert.equal(ollamaOriginRule("http://localhost:11434", ""), null);
  assert.equal(ollamaOriginRule("not a url", "abcdef"), null);
});

test("processor placement reads the way ollama ps prints it", () => {
  assert.deepEqual(ollamaProcessor(3704115690, 3704115690), {
    placement: "gpu",
    gpuPercent: 100,
    label: "100% GPU",
  });
  assert.deepEqual(ollamaProcessor(1000, 0), {
    placement: "cpu",
    gpuPercent: 0,
    label: "100% CPU",
  });
  assert.deepEqual(ollamaProcessor(1000, undefined).label, "100% CPU");
  assert.deepEqual(ollamaProcessor(1000, 520), {
    placement: "split",
    gpuPercent: 52,
    label: "48%/52% CPU/GPU",
  });
  assert.equal(ollamaProcessor(0, 0), null);
  assert.equal(
    ollamaProcessor(1000, 2000),
    null,
    "inconsistent counts are not shown",
  );
  assert.equal(ollamaProcessor(undefined, 5), null);
});

test("Ollama refusals map to the SPEC 9 codes with our own sentences", () => {
  const local = { cloud: false };
  const map = (status, text, options) => {
    const { code, retryable, details, message } = ollamaRefusal(
      status,
      text,
      local,
      options,
    );
    assert.doesNotMatch(
      message,
      /tensor|3009|blk\./,
      "never the server's words",
    );
    return [code, retryable, details ?? null];
  };
  // Seen live on Ollama 0.32.15 with truncate: false.
  assert.deepEqual(
    map(
      400,
      '{"error":{"code":400,"message":"request (3009 tokens) exceeds the available context size (2048 tokens), try increasing it","type":"exceed_context_size_error","n_prompt_tokens":3009,"n_ctx":2048}}',
    ),
    ["CONTEXT_TOO_LONG", false, null],
  );
  // Seen live: gpt-oss:20b on the same server.
  assert.deepEqual(
    map(500, 'tensor "blk.0.ffn_down_exps.weight" size overflow'),
    ["MODEL_UNAVAILABLE", false, null],
  );
  assert.deepEqual(map(404, "model 'x' not found"), [
    "MODEL_UNAVAILABLE",
    false,
    null,
  ]);
  assert.deepEqual(map(400, "qwen3-vl:235b was retired at 2026-06-16"), [
    "MODEL_UNAVAILABLE",
    false,
    null,
  ]);
  assert.deepEqual(
    map(
      500,
      "model requires more system memory (12.0 GiB) than is available (4.1 GiB)",
    ),
    ["MODEL_UNAVAILABLE", false, null],
  );
  assert.deepEqual(map(429, "too many requests", { retryAfterMs: 30_000 }), [
    "RATE_LIMITED",
    true,
    { retryAfterMs: 30_000 },
  ]);
  assert.deepEqual(
    map(429, ""),
    ["RATE_LIMITED", true, null],
    "no header, no wait",
  );
  assert.deepEqual(map(400, '"m" does not support tools'), [
    "NOT_SUPPORTED",
    false,
    null,
  ]);
  assert.deepEqual(map(401, "unauthorized"), ["NOT_CONFIGURED", false, null]);
  assert.deepEqual(map(403, "", { emptyBody: true }), [
    "PROVIDER_ERROR",
    false,
    null,
  ]);
  assert.deepEqual(map(403, "Forbidden"), ["PROVIDER_ERROR", false, null]);
  // With a key, a 403 that is not Ollama's own Origin check is most likely
  // the proxy refusing the key.
  const keyed = ollamaRefusal(403, "", { ...local, apiKey: "k" });
  assert.equal(keyed.code, "NOT_CONFIGURED");
  assert.equal(keyed.message, OLLAMA_KEY_REFUSAL);
  assert.equal(
    ollamaRefusal(403, "", local, { emptyBody: true }).message,
    OLLAMA_ORIGIN_REFUSAL,
  );
  assert.equal(ollamaRefusal(403, "", local).message, OLLAMA_PROXY_REFUSAL);
  assert.deepEqual(map(503, "busy"), ["PROVIDER_ERROR", true, null]);
  assert.deepEqual(map(400, "bad request"), ["PROVIDER_ERROR", false, null]);
  // A 404 on the model list is a wrong address, not a missing model.
  assert.deepEqual(map(404, "404 page not found", { listing: true }), [
    "PROVIDER_ERROR",
    false,
    null,
  ]);
  assert.equal(ollamaRefusal(404, "", local).kind, "missing");
  assert.equal(
    ollamaRefusal(500, "failed to load model", local).kind,
    "unloadable",
  );
});
