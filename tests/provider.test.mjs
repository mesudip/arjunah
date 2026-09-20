import test from "node:test";
import assert from "node:assert/strict";
import { generate, listProviderModels } from "../src/lib/provider.js";

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

for (const kind of [
  "http",
  "json",
  "shape",
  "calls",
  "read-timeout",
  "oversized",
]) {
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
      if (kind === "calls")
        return Response.json({
          choices: [{ message: { tool_calls: [{ id: "x", function: {} }] } }],
        });
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
