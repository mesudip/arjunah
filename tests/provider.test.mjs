import test from "node:test";
import assert from "node:assert/strict";
import { generate, listProviderModels } from "../src/lib/provider.js";
import {
  opencodeDisplayName,
  opencodeProtocol,
  opencodeUnusableReason,
} from "../src/lib/opencode.js";

test("provider adapter does not expose credentials and normalizes output", async () => {
  const originalFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (_url, init) => {
    seen = init;
    return new Response(
      JSON.stringify({
        id: "r1",
        model: "demo",
        choices: [
          {
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const output = await generate(
      {
        baseUrl: "https://provider.test/v1",
        model: "demo",
        apiKey: "private-key",
      },
      { messages: [{ role: "user", content: "hi" }] },
    );
    assert.equal(seen.headers.Authorization, "Bearer private-key");
    assert.equal(output.message.content, "hello");
    assert.equal(JSON.stringify(output).includes("private-key"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("provider adapter aggregates fragmented SSE and emits answer deltas", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const events = [
    { id: "stream-1", choices: [{ delta: { role: "assistant" } }] },
    { choices: [{ delta: { content: "Hello " } }] },
    { choices: [{ delta: { content: "world" }, finish_reason: "stop" }] },
    {
      choices: [],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    },
  ];
  const wire = `${events.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")}data: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(wire);
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body);
    assert.equal(payload.stream, true);
    assert.deepEqual(payload.stream_options, { include_usage: true });
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const boundary of [7, 31, 67, bytes.length]) {
            const start = this.offset ?? 0;
            controller.enqueue(bytes.slice(start, boundary));
            this.offset = boundary;
          }
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const deltas = [];
  const output = await generate(
    { baseUrl: "https://api.openai.com/v1", model: "demo", apiKey: "key" },
    { messages: [{ role: "user", content: "hi" }] },
    undefined,
    true,
    { progress: { onItem: (item) => deltas.push(item) } },
  );
  assert.equal(output.id, "stream-1");
  assert.equal(output.message.content, "Hello world");
  assert.equal(output.usage.totalTokens, 6);
  assert.deepEqual(deltas, [
    { type: "output_delta", text: "Hello " },
    { type: "output_delta", text: "world" },
  ]);
});

test("provider adapter assembles streamed tool-call arguments", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const chunks = [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call-1",
                type: "function",
                function: { name: "site__", arguments: '{"city":' },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { name: "search", arguments: '"Lalitpur"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
  ];
  globalThis.fetch = async () =>
    new Response(
      `${chunks.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("")}data: [DONE]\n\n`,
      { headers: { "Content-Type": "text/event-stream" } },
    );
  const output = await generate(
    { baseUrl: "https://provider.test/v1", model: "demo", apiKey: "key" },
    {
      messages: [{ role: "user", content: "find it" }],
      tools: [
        {
          name: "site__search",
          inputSchema: { type: "object" },
        },
      ],
    },
    undefined,
    true,
    { progress: { onItem() {} } },
  );
  assert.deepEqual(output.message.toolCalls, [
    {
      id: "call-1",
      name: "site__search",
      arguments: '{"city":"Lalitpur"}',
    },
  ]);
  assert.equal(output.finishReason, "tool_calls");
});

test("each OpenCode family sends the credential header its upstream expects", async (t) => {
  // Zen proxies each family to its upstream vendor and wants that vendor's own
  // scheme. Verified live on 2026-09-20: a blanket `Authorization: Bearer`
  // answers 401 AuthError on the Anthropic and Gemini routes, so every family's
  // header is pinned here rather than assumed uniform.
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const bodies = {
    responses: {
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "ok" }] },
      ],
    },
    anthropic: {
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    },
    gemini: {
      candidates: [
        { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
      ],
    },
    "chat-completions": {
      choices: [{ message: { role: "assistant", content: "ok" } }],
    },
  };
  for (const [model, protocol, header] of [
    ["gpt-5.6-luna", "responses", "authorization"],
    ["grok-4.5", "responses", "authorization"],
    ["claude-sonnet-4-6", "anthropic", "x-api-key"],
    ["qwen3.5-plus", "anthropic", "x-api-key"],
    ["gemini-3.1-pro", "gemini", "x-goog-api-key"],
    ["glm-5.3", "chat-completions", "authorization"],
  ]) {
    let seen;
    globalThis.fetch = async (_url, init) => {
      seen = Object.fromEntries(
        Object.entries(init.headers).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      );
      return Response.json(bodies[protocol]);
    };
    const result = await generate(
      {
        kind: "opencode",
        baseUrl: "https://opencode.ai/zen/v1",
        apiKey: "zen-key",
        model,
        protocol,
        capabilities: { tools: true, vision: true, reasoning: true },
      },
      { messages: [{ role: "user", content: "hi" }], maxTokens: 16 },
    );
    assert.equal(result.message.content, "ok", model);
    assert.equal(
      seen[header],
      header === "authorization" ? "Bearer zen-key" : "zen-key",
      `${model} must authenticate with ${header}`,
    );
    // Exactly one credential header: the others must not carry the key too.
    for (const other of ["authorization", "x-api-key", "x-goog-api-key"])
      if (other !== header)
        assert.equal(seen[other], undefined, `${model}/${other}`);
  }
});

test("Gemini tool rounds carry the thought signature back to the provider", async (t) => {
  // Verified live on 2026-09-20: Gemini 3 answers 400 INVALID_ARGUMENT,
  // "Function call is missing a thought_signature in functionCall parts", when a
  // continuation drops the signature it issued beside the call.
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const signature = "AY89a19Umdes663XeiVM9S4Xdw4XJEq2DbxDPIx";
  globalThis.fetch = async () =>
    Response.json({
      candidates: [
        {
          content: {
            parts: [
              {
                thoughtSignature: signature,
                functionCall: {
                  id: "call_1155321",
                  name: "get_weather",
                  args: { city: "Kathmandu" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    });
  const config = {
    kind: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    apiKey: "zen-key",
    model: "gemini-3.1-pro",
    protocol: "gemini",
    capabilities: { tools: true, vision: true, reasoning: true },
  };
  const tools = [
    { name: "get_weather", description: "w", inputSchema: { type: "object" } },
  ];
  const first = await generate(
    config,
    { messages: [{ role: "user", content: "weather?" }], tools },
    undefined,
    false,
  );
  // Gemini's own call id is kept, so the continuation refers to the same call.
  assert.equal(first.message.toolCalls[0].id, "call_1155321");
  assert.equal(first.rawMessage.tool_calls[0].thoughtSignature, signature);
  // The signature is provider state, not something a page is shown.
  assert.equal("thoughtSignature" in first.message.toolCalls[0], false);

  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return Response.json({
      candidates: [
        { content: { parts: [{ text: "21C" }] }, finishReason: "STOP" },
      ],
    });
  };
  await generate(
    config,
    {
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: "",
          toolCalls: first.rawMessage.tool_calls,
        },
        { role: "tool", toolCallId: "call_1155321", content: "{}" },
      ],
      tools,
    },
    undefined,
    false,
  );
  const modelTurn = sent.contents.find((item) => item.role === "model");
  assert.equal(modelTurn.parts[0].thoughtSignature, signature);
  assert.equal(modelTurn.parts[0].functionCall.id, "call_1155321");
});

test("OpenCode hides models an API key is not allowed to call", async () => {
  // Measured against the live Zen API on 2026-09-20: every `-free` id answers
  // 403 FreeTierError on both /responses and /chat/completions, while the paid
  // sibling of the same family answers normally.
  for (const model of [
    "muse-spark-1.3-contributor-free",
    "muse-spark-1.2-contributor-free",
    "nemotron-3-ultra-free",
    "mimo-v2.5-free",
    "ling-3.0-flash-fin-free",
    "deepseek-v4-flash-free",
    "jev-1.13-free",
    "jev-1.13",
  ])
    assert.equal(opencodeProtocol(model), null, model);
  // The paid models of those same families stay selectable, on their own route.
  assert.equal(opencodeProtocol("muse-spark-1.3"), "responses");
  assert.equal(opencodeProtocol("deepseek-v4-flash"), "chat-completions");
  assert.equal(opencodeProtocol("nemotron-3.5-lightning"), "chat-completions");
  assert.match(opencodeUnusableReason("muse-spark-1.3-free"), /free tier/);
  assert.equal(opencodeUnusableReason("muse-spark-1.3"), null);
});

test("OpenCode model names read the way each vendor writes them", () => {
  // Zen splits a version across segments (`-4-6`), which must not read as two
  // separate words. Ids are from the live 74-model catalog.
  assert.deepEqual(
    [
      "claude-sonnet-4-6",
      "claude-opus-5",
      "claude-fable-5-1",
      "gpt-5.6-luna",
      "gpt-5.1-codex-max",
      "glm-5.3-flash",
      "deepseek-v4.1-flash",
      "minimax-m3",
      "kimi-k2.7-code",
      "qwen3.5-plus",
      "grok-4.5",
      "muse-spark-1.3",
      "big-pickle",
    ].map(opencodeDisplayName),
    [
      "Claude Sonnet 4.6",
      "Claude Opus 5",
      "Claude Fable 5.1",
      "GPT-5.6 Luna",
      "GPT-5.1 Codex Max",
      "GLM-5.3 Flash",
      "DeepSeek-V4.1 Flash",
      "MiniMax M3",
      "Kimi K2.7 Code",
      "Qwen3.5 Plus",
      "Grok 4.5",
      "Muse Spark 1.3",
      "Big Pickle",
    ],
  );
});

test("a refused OpenCode model explains itself without quoting the provider", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        type: "error",
        error: {
          type: "FreeTierError",
          message:
            "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
        },
      },
      { status: 403 },
    ),
  );
  const error = await generate(
    {
      kind: "opencode",
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: "zen-key",
      model: "muse-spark-1.3",
      protocol: "responses",
      capabilities: { tools: true, vision: true, reasoning: true },
    },
    { messages: [{ role: "user", content: "hi" }] },
  ).then(
    () => null,
    (thrown) => thrown,
  );
  assert.equal(error.code, "PROVIDER_ERROR");
  assert.match(error.message, /free tier can only be used from inside/);
  // The provider's own prose can quote the request back, so none of it is shown.
  assert.doesNotMatch(error.message, /Error from provider|Console/);
  assert.equal(error.message.includes("zen-key"), false);
});

test("model listing is normalized", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), {
      status: 200,
    });
  try {
    assert.deepEqual(
      (
        await listProviderModels({
          baseUrl: "https://provider.test/v1",
          model: "a",
          apiKey: "test-key",
        })
      ).map((item) => item.id),
      ["a", "b"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI endpoint paths are appended to the canonical API base", async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return Response.json({ data: [] });
  };
  try {
    await listProviderModels({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.6",
      apiKey: "test-key",
    });
    assert.deepEqual(urls, ["https://api.openai.com/v1/models"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAI generation uses the current completion-token parameter", async () => {
  const originalFetch = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init.body);
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  };
  try {
    await generate(
      {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-5.6",
        apiKey: "test-key",
      },
      { messages: [{ role: "user", content: "hi" }], maxTokens: 16 },
    );
    assert.equal(payload.max_completion_tokens, 16);
    assert.equal("max_tokens" in payload, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenCode Responses preserves conversation images and streams text and tools", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let url;
  let payload;
  globalThis.fetch = async (nextUrl, init) => {
    url = nextUrl;
    payload = JSON.parse(init.body);
    const events = [
      { type: "response.created", response: { id: "resp-zen" } },
      { type: "response.output_text.delta", delta: "I see " },
      { type: "response.output_text.delta", delta: "red." },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          type: "function_call",
          call_id: "call-zen",
          name: "site__inspect",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 1,
        delta: '{"color":"red"}',
      },
      {
        type: "response.completed",
        response: {
          id: "resp-zen",
          status: "completed",
          usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
        },
      },
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const deltas = [];
  const result = await generate(
    {
      kind: "opencode",
      providerId: "opencode",
      providerName: "OpenCode Zen API",
      protocol: "responses",
      baseUrl: "https://opencode.ai/zen/v1",
      model: "gpt-5.6-luna",
      apiKey: "zen-key",
      capabilities: { tools: true, vision: true, reasoning: true },
    },
    {
      messages: [
        { role: "system", content: "Be concise." },
        {
          role: "user",
          content: [
            { type: "text", text: "What color?" },
            { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
          ],
        },
        {
          role: "assistant",
          content: "Checking",
          toolCalls: [
            {
              id: "old-call",
              type: "function",
              function: { name: "site__old", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "done", toolCallId: "old-call" },
      ],
      tools: [{ name: "site__inspect", inputSchema: { type: "object" } }],
    },
    undefined,
    true,
    { progress: { onItem: (item) => deltas.push(item) } },
  );
  assert.equal(url, "https://opencode.ai/zen/v1/responses");
  assert.equal(payload.store, false);
  assert.equal(payload.input[0].role, "developer");
  assert.match(
    payload.input[1].content[1].image_url,
    /^data:image\/png;base64,/,
  );
  assert.equal(payload.input[3].type, "function_call");
  assert.equal(payload.input[4].type, "function_call_output");
  assert.equal(result.message.content, "I see red.");
  assert.equal(result.message.toolCalls[0].name, "site__inspect");
  assert.equal(result.usage.totalTokens, 13);
  assert.deepEqual(deltas, [
    { type: "output_delta", text: "I see " },
    { type: "output_delta", text: "red." },
  ]);
});

test("OpenCode Anthropic Messages preserves images and streamed tool arguments", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init, payload: JSON.parse(init.body) };
    const events = [
      {
        type: "message_start",
        message: { id: "msg-zen", usage: { input_tokens: 5 } },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Claude text" },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "anthropic-call",
          name: "site__lookup",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"id":1}' },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 3 },
      },
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const deltas = [];
  const result = await generate(
    {
      kind: "opencode",
      providerId: "opencode",
      protocol: "anthropic",
      baseUrl: "https://opencode.ai/zen/v1",
      model: "claude-sonnet-4-6",
      apiKey: "zen-key",
      capabilities: { tools: true, vision: true, reasoning: true },
    },
    {
      messages: [
        { role: "system", content: "System" },
        {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            { type: "image", mediaType: "image/jpeg", data: "aGVsbG8=" },
          ],
        },
      ],
      tools: [{ name: "site__lookup", inputSchema: { type: "object" } }],
    },
    undefined,
    true,
    { progress: { onItem: (item) => deltas.push(item) } },
  );
  assert.equal(seen.url, "https://opencode.ai/zen/v1/messages");
  assert.equal(seen.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(seen.payload.system[0].text, "System");
  assert.equal(seen.payload.messages[0].content[1].source.type, "base64");
  assert.equal(seen.payload.tools[0].input_schema.type, "object");
  assert.equal(result.message.content, "Claude text");
  assert.equal(result.message.toolCalls[0].arguments, '{"id":1}');
  assert.deepEqual(deltas, [{ type: "output_delta", text: "Claude text" }]);
});

test("OpenCode Gemini uses generateContent image and incremental formats", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, payload: JSON.parse(init.body) };
    const events = [
      {
        candidates: [{ content: { parts: [{ text: "Gemini " }] } }],
      },
      {
        candidates: [
          {
            content: {
              parts: [
                { text: "answer" },
                { functionCall: { name: "site__go", args: { ok: true } } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 2,
          totalTokenCount: 6,
        },
      },
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  };
  const deltas = [];
  const result = await generate(
    {
      kind: "opencode",
      providerId: "opencode",
      protocol: "gemini",
      baseUrl: "https://opencode.ai/zen/v1",
      model: "gemini-3.1-pro",
      apiKey: "zen-key",
      capabilities: { tools: true, vision: true, reasoning: true },
    },
    {
      messages: [
        { role: "system", content: "System" },
        {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            { type: "image", mediaType: "image/webp", data: "aGVsbG8=" },
          ],
        },
      ],
      tools: [{ name: "site__go", inputSchema: { type: "object" } }],
    },
    undefined,
    true,
    { progress: { onItem: (item) => deltas.push(item) } },
  );
  assert.equal(
    seen.url,
    "https://opencode.ai/zen/v1/models/gemini-3.1-pro:streamGenerateContent?alt=sse",
  );
  assert.equal(seen.payload.systemInstruction.parts[0].text, "System");
  assert.equal(
    seen.payload.contents[0].parts[1].inlineData.mimeType,
    "image/webp",
  );
  assert.equal(result.message.content, "Gemini answer");
  assert.equal(result.message.toolCalls[0].name, "site__go");
  assert.equal(result.usage.totalTokens, 6);
  assert.deepEqual(deltas, [
    { type: "output_delta", text: "Gemini " },
    { type: "output_delta", text: "answer" },
  ]);
});

test("OpenCode Chat Completions uses the Zen route with image parts", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, payload: JSON.parse(init.body) };
    return Response.json({
      id: "chat-zen",
      choices: [{ message: { content: "vision answer" } }],
    });
  };
  const result = await generate(
    {
      kind: "opencode",
      providerId: "opencode",
      protocol: "chat-completions",
      baseUrl: "https://opencode.ai/zen/v1",
      model: "deepseek-v4-flash-vision-exp",
      apiKey: "zen-key",
      capabilities: { tools: true, vision: true, reasoning: true },
    },
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
          ],
        },
      ],
    },
  );
  assert.equal(seen.url, "https://opencode.ai/zen/v1/chat/completions");
  assert.match(
    seen.payload.messages[0].content[1].image_url.url,
    /^data:image\/png;base64,/,
  );
  assert.equal(result.message.content, "vision answer");
});

for (const kind of ["http", "json", "shape", "read-timeout", "oversized"]) {
  test(`provider ${kind} failures are bounded and safe to expose`, async (t) => {
    const original = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = original;
    });
    let cancelled = false;
    globalThis.fetch = async () => {
      if (kind === "http")
        return new Response("secret-provider-body", { status: 401 });
      if (kind === "json") return new Response("secret-provider-body");
      if (kind === "shape")
        return Response.json({ secret: "secret-provider-body" });
      if (kind === "read-timeout")
        return new Response(
          new ReadableStream({
            start(c) {
              c.error(new DOMException("secret-provider-body", "TimeoutError"));
            },
          }),
        );
      return new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array(1000000));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    };
    await assert.rejects(
      generate(
        { baseUrl: "https://provider.test", model: "a", apiKey: "secret-key" },
        { messages: [{ role: "user", content: "hi" }] },
      ),
      (error) =>
        ["TIMEOUT", "PROVIDER_ERROR"].includes(error.code) &&
        !/secret-provider-body|secret-key/.test(error.message),
    );
    if (kind === "oversized") assert.equal(cancelled, true);
  });
}

test("unusable provider tool calls are repaired and reported, not thrown away", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              // No name: unroutable, so the turn must be told why.
              { id: "x", type: "function", function: {} },
              // A zero-argument call spelled "" rather than "{}": the same
              // intent, repaired silently rather than reported.
              {
                id: "y",
                type: "function",
                function: { name: "ok_tool", arguments: "" },
              },
              // Repeated id: repaired, because a result can only answer one call.
              {
                id: "y",
                type: "function",
                function: { name: "ok_tool", arguments: "{}" },
              },
            ],
          },
        },
      ],
    });
  const result = await generate(
    { baseUrl: "https://provider.test", model: "a", apiKey: "secret-key" },
    { messages: [{ role: "user", content: "hi" }] },
  );
  assert.equal(result.message.toolCalls.length, 3);
  assert.equal(result.message.toolCalls[1].name, "ok_tool");
  assert.equal(result.message.toolCalls[1].arguments, "{}");
  assert.equal(result.rejectedToolCalls.size, 1);
  assert.match(result.rejectedToolCalls.get("x"), /tool call with no name/);
  // Every id is distinct, so each call can be answered by exactly one result.
  assert.equal(
    new Set(result.message.toolCalls.map((call) => call.id)).size,
    3,
  );
  assert.equal(
    /secret-key/.test(JSON.stringify([...result.rejectedToolCalls])),
    false,
  );
});

for (const model of [
  "gpt-5.6",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.6-sol-2026-08-01",
]) {
  test(`${model} completes a tool round trip against the GPT-5.6 wire constraints`, async (t) => {
    const original = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = original;
    });
    const config = {
      baseUrl: "https://api.openai.com/v1",
      model,
      apiKey: "test-key",
    };
    const tools = [
      {
        name: "site__get_sample_status",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ];
    const messages = [
      { role: "user", content: "Use the site tool and report readiness." },
    ];
    const requests = [];
    globalThis.fetch = async (_url, init) => {
      const payload = JSON.parse(init.body);
      requests.push(payload);
      if (payload.reasoning_effort !== "none")
        return Response.json(
          {
            error: {
              message:
                "Function tools with reasoning_effort are not supported.",
            },
          },
          { status: 400 },
        );
      const output = payload.messages.find(
        (message) => message.role === "tool",
      );
      if (output) {
        assert.equal(output.tool_call_id, "call-1");
        assert.deepEqual(JSON.parse(output.content), { ready: true });
        assert.equal(
          payload.messages[1].tool_calls[0].function.name,
          "site__get_sample_status",
        );
        return Response.json({
          choices: [{ message: { content: "The sample is ready." } }],
        });
      }
      assert.equal(payload.tools[0].function.name, "site__get_sample_status");
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: {
                    name: "site__get_sample_status",
                    arguments: "{}",
                  },
                },
              ],
            },
          },
        ],
      });
    };
    const first = await generate(config, { messages, tools });
    assert.equal(first.message.toolCalls[0].name, "site__get_sample_status");
    messages.push({
      role: "assistant",
      content: first.message.content,
      toolCalls: first.rawMessage.tool_calls,
    });
    messages.push({
      role: "tool",
      toolCallId: first.message.toolCalls[0].id,
      content: JSON.stringify({ ready: true }),
    });
    // The public API can continue with tool results without repeating definitions.
    const final = await generate(config, { messages });
    assert.equal(final.message.content, "The sample is ready.");
    assert.equal(requests.length, 2);
    assert.ok(requests.every((payload) => payload.model === model));
  });
}

test("compatibility setting leaves plain chat and other model families unchanged", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (_url, init) => {
    assert.equal("reasoning_effort" in JSON.parse(init.body), false);
    return Response.json({ choices: [{ message: { content: "ok" } }] });
  };
  for (const model of ["gpt-5.6-sol", "gpt-4.1", "o3", "gpt-5.60"]) {
    await generate(
      { baseUrl: "https://api.openai.com/v1", model, apiKey: "test-key" },
      {
        messages: [{ role: "user", content: "hello" }],
        ...(model === "gpt-5.6-sol" ? {} : { tools: [{ name: "echo" }] }),
      },
    );
  }
});

test("a vision desktop provider forwards image parts beside the flattened text", async () => {
  const originalFetch = globalThis.fetch;
  const pixel =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = JSON.parse(init.body);
    return Response.json({
      id: "desk-1",
      model: "claude-code/opus",
      message: { role: "assistant", content: "red", toolCalls: [] },
      finishReason: "stop",
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });
  };
  const config = {
    kind: "desktop",
    baseUrl: "http://127.0.0.1:48123",
    token: "desktop-token-abcdefghijklmnop",
    providerId: "claude-code",
    providerName: "Claude Code",
    model: "opus",
    capabilities: { tools: true, vision: true },
  };
  const request = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What colour?" },
          { type: "image", mediaType: "image/png", data: pixel },
        ],
      },
    ],
  };
  try {
    await generate(config, request);
    assert.equal(seen.messages[0].content, "What colour?\n[image]");
    assert.deepEqual(seen.messages[0].images, [
      { mediaType: "image/png", data: pixel },
    ]);
    // The same provider without vision refuses the request outright rather than
    // sending a prompt whose picture has silently become the text "[image]".
    await assert.rejects(
      generate(
        { ...config, capabilities: { tools: true, vision: false } },
        request,
      ),
      (error) => error.code === "NOT_SUPPORTED",
    );
    seen = undefined;
    await generate(
      { ...config, capabilities: { tools: true, vision: false } },
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
    );
    assert.equal(seen.messages[0].images, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("desktop provider configurations dispatch to the paired desktop app with the bearer token", async () => {
  const originalFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return Response.json({
      id: "desk-1",
      model: "opencode/default",
      message: { role: "assistant", content: "hi from desktop", toolCalls: [] },
      finishReason: "stop",
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    });
  };
  try {
    const config = {
      kind: "desktop",
      baseUrl: "http://127.0.0.1:48123",
      token: "desktop-token-abcdefghijklmnop",
      providerId: "opencode",
      providerName: "OpenCode",
      model: "opencode/big-pickle",
    };
    const output = await generate(config, {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "site__echo", inputSchema: { type: "object" } }],
    });
    assert.equal(seen.url, "http://127.0.0.1:48123/api/generate");
    assert.equal(
      seen.init.headers.Authorization,
      "Bearer desktop-token-abcdefghijklmnop",
    );
    const payload = JSON.parse(seen.init.body);
    assert.equal(payload.providerId, "opencode");
    assert.equal(payload.model, "opencode/big-pickle");
    assert.equal(payload.tools[0].name, "site__echo");
    assert.equal(output.message.content, "hi from desktop");
    assert.equal(output.model, "opencode/opencode/big-pickle");
    assert.equal(output.usage.totalTokens, 5);
    await assert.rejects(
      generate(
        { ...config, token: "" },
        { messages: [{ role: "user", content: "hi" }] },
      ),
      (error) => error.code === "NOT_CONFIGURED",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// A reasoning model routinely needs longer than the old 30s request deadline
// before its first token, and the deadline covered the streamed body too, so a
// round that was answering fine died mid-stream. Generation is unbounded now;
// only metadata calls keep a clock.
test("a generation round carries no deadline while model listing keeps one", async () => {
  const originalFetch = globalThis.fetch;
  const signals = [];
  globalThis.fetch = async (url, init) => {
    signals.push({ url: String(url), signal: init.signal });
    return String(url).endsWith("/models")
      ? new Response(JSON.stringify({ data: [{ id: "gpt-5.6-luna" }] }), {
          headers: { "Content-Type": "application/json" },
        })
      : new Response(
          `data: ${JSON.stringify({
            type: "response.completed",
            response: { id: "r", status: "completed", usage: {} },
          })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
  };
  const config = {
    kind: "opencode",
    providerId: "opencode",
    providerName: "OpenCode Zen API",
    protocol: "responses",
    baseUrl: "https://opencode.ai/zen/v1",
    model: "gpt-5.6-luna",
    apiKey: "zen-key",
    capabilities: { tools: true, vision: true, reasoning: true },
  };
  try {
    await generate(
      config,
      { messages: [{ role: "user", content: "hi" }] },
      null,
      true,
      { progress: { id: "p", onItem: () => {} } },
    );
    await listProviderModels(config, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const round = signals.find((call) => call.url.endsWith("/responses"));
  const models = signals.find((call) => call.url.endsWith("/models"));
  assert.equal(round.signal, undefined);
  assert.ok(models.signal instanceof AbortSignal);
});

// `providerResponse` returns as soon as the headers land, so anything the body
// read throws escapes its wrapper. Unwrapped, a stop mid-stream reached the
// page as a bare INTERNAL_ERROR that named nothing.
for (const [protocol, path] of [
  ["responses", "/responses"],
  ["anthropic", "/messages"],
  ["gemini", ":streamGenerateContent"],
])
  test(`${protocol}: an abort mid-stream is a broker error, not INTERNAL_ERROR`, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      assert.ok(String(url).includes(path));
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"x":1}\n\n'));
            controller.error(
              new DOMException("The user aborted a request.", "AbortError"),
            );
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };
    try {
      await generate(
        {
          kind: "opencode",
          providerId: "opencode",
          providerName: "OpenCode Zen API",
          protocol,
          baseUrl: "https://opencode.ai/zen/v1",
          model:
            protocol === "anthropic" ? "claude-sonnet-4-6" : "gpt-5.6-luna",
          apiKey: "zen-key",
          capabilities: { tools: true, vision: true, reasoning: true },
        },
        { messages: [{ role: "user", content: "hi" }] },
        null,
        true,
        { progress: { id: "p", onItem: () => {} } },
      );
      assert.fail("the aborted stream should have thrown");
    } catch (error) {
      assert.equal(error.name, "AIError");
      assert.equal(error.code, "TIMEOUT");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
