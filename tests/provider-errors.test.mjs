import test from "node:test";
import assert from "node:assert/strict";
import { generate, listProviderModels } from "../src/lib/provider.js";
import { agentFailureCode } from "../desktop/lib/server.mjs";

const ask = { messages: [{ role: "user", content: "hi" }] };
const openai = {
  baseUrl: "https://provider.test/v1",
  model: "demo",
  apiKey: "private-key",
};
const zen = (protocol, model) => ({
  kind: "opencode",
  baseUrl: "https://opencode.ai/zen/v1",
  apiKey: "zen-key",
  model,
  protocol,
  capabilities: { tools: true, vision: true, reasoning: true },
});
// Provider prose a page must never see: it can quote the conversation back.
const SECRET = "SECRET-PROMPT-TEXT";

async function failure(t, config, status, body, headers = {}, options) {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(body, { status, headers }),
  );
  const error = await generate(
    config,
    ask,
    undefined,
    false,
    options ?? {},
  ).then(
    () => assert.fail("the provider failure should reject"),
    (thrown) => thrown,
  );
  t.mock.restoreAll();
  assert.equal(error.name, "AIError");
  assert.equal(error.message.includes(SECRET), false, error.message);
  assert.equal(error.message.includes("private-key"), false);
  assert.equal(JSON.stringify(error.details ?? {}).includes(SECRET), false);
  return error;
}

test("Chat Completions failures map to CONTEXT_TOO_LONG, RATE_LIMITED, and MODEL_UNAVAILABLE", async (t) => {
  const context = await failure(t, openai, 400, {
    error: {
      message: `This model's maximum context length is 128000 tokens. ${SECRET}`,
      type: "invalid_request_error",
      code: "context_length_exceeded",
    },
  });
  assert.equal(context.code, "CONTEXT_TOO_LONG");
  assert.equal(context.retryable, undefined);
  // An OpenAI-compatible server that sends only prose (vLLM, LM Studio).
  for (const message of [
    `This model's maximum context length is 8192 tokens. However, you requested 9000 tokens. ${SECRET}`,
    `The number of tokens to keep from the initial prompt is greater than the context length. ${SECRET}`,
  ])
    assert.equal(
      (await failure(t, openai, 400, { error: { message } })).code,
      "CONTEXT_TOO_LONG",
    );
  assert.equal(
    (
      await failure(t, openai, 400, {
        error: {
          type: "exceed_context_size_error",
          message: `the request exceeds the available context size ${SECRET}`,
        },
      })
    ).code,
    "CONTEXT_TOO_LONG",
  );
  // `max_tokens` larger than the model's output is the request's own mistake.
  assert.equal(
    (
      await failure(t, openai, 400, {
        error: {
          message: `max_tokens is too large: 50000. This model supports at most 16384 completion tokens. ${SECRET}`,
          code: "invalid_value",
        },
      })
    ).code,
    "PROVIDER_ERROR",
  );

  const limited = await failure(
    t,
    openai,
    429,
    { error: { message: SECRET, code: "rate_limit_exceeded" } },
    { "Retry-After": "7" },
  );
  assert.equal(limited.code, "RATE_LIMITED");
  assert.deepEqual(limited.details, { retryAfterMs: 7000 });
  const precise = await failure(
    t,
    openai,
    429,
    { error: { message: SECRET } },
    { "retry-after-ms": "1250" },
  );
  assert.deepEqual(precise.details, { retryAfterMs: 1250 });
  const dated = await failure(
    t,
    openai,
    429,
    {},
    { "Retry-After": new Date(Date.now() + 60_000).toUTCString() },
  );
  assert.ok(dated.details.retryAfterMs > 55_000);
  assert.ok(dated.details.retryAfterMs <= 60_000);
  // No hint means none is invented.
  assert.equal((await failure(t, openai, 429, {})).details, undefined);
  // An exhausted balance answers 429 too, and waiting does not fix it.
  const quota = await failure(t, openai, 429, {
    error: { message: SECRET, code: "insufficient_quota" },
  });
  assert.equal(quota.code, "PROVIDER_ERROR");
  assert.equal(quota.retryable, false);

  const missing = await failure(t, openai, 404, {
    error: {
      message: `The model \`demo\` does not exist or you do not have access to it. ${SECRET}`,
      code: "model_not_found",
    },
  });
  assert.equal(missing.code, "MODEL_UNAVAILABLE");
  assert.equal(
    (
      await failure(t, openai, 400, {
        error: { message: `Failed to load model "demo". ${SECRET}` },
      })
    ).code,
    "MODEL_UNAVAILABLE",
  );
  // A 404 that names no model is a wrong address, not a missing model.
  const wrongPath = await failure(t, openai, 404, { error: "Not Found" });
  assert.equal(wrongPath.code, "PROVIDER_ERROR");
  assert.equal(wrongPath.retryable, false);
  const down = await failure(t, openai, 503, { error: { message: SECRET } });
  assert.equal(down.code, "PROVIDER_ERROR");
  assert.equal(down.retryable, true);
});

test("Anthropic Messages failures map from its error types", async (t) => {
  const config = zen("anthropic", "claude-sonnet-4-6");
  const body = (type, message) => ({
    type: "error",
    error: { type, message: `${message} ${SECRET}` },
  });
  assert.equal(
    (
      await failure(
        t,
        config,
        400,
        body(
          "invalid_request_error",
          "prompt is too long: 210000 tokens > 200000 maximum",
        ),
      )
    ).code,
    "CONTEXT_TOO_LONG",
  );
  assert.equal(
    (
      await failure(
        t,
        config,
        400,
        body(
          "invalid_request_error",
          "input length and `max_tokens` exceed context limit: 188240 + 21333 > 200000",
        ),
      )
    ).code,
    "CONTEXT_TOO_LONG",
  );
  const limited = await failure(
    t,
    config,
    429,
    body("rate_limit_error", "Number of request tokens has exceeded your rate"),
    { "retry-after": "12" },
  );
  assert.equal(limited.code, "RATE_LIMITED");
  assert.deepEqual(limited.details, { retryAfterMs: 12_000 });
  assert.equal(
    (
      await failure(
        t,
        config,
        404,
        body("not_found_error", "model: claude-nonexistent"),
      )
    ).code,
    "MODEL_UNAVAILABLE",
  );
  const overloaded = await failure(
    t,
    config,
    529,
    body("overloaded_error", "Overloaded"),
  );
  assert.equal(overloaded.code, "PROVIDER_ERROR");
  assert.equal(overloaded.retryable, true);
});

test("Gemini failures map from its status names, RetryInfo included", async (t) => {
  const config = zen("gemini", "gemini-3.1-pro");
  const body = (code, status, message, details) => ({
    error: { code, status, message: `${message} ${SECRET}`, details },
  });
  assert.equal(
    (
      await failure(
        t,
        config,
        400,
        body(
          400,
          "INVALID_ARGUMENT",
          "The input token count (1048577) exceeds the maximum number of tokens allowed (1048576).",
        ),
      )
    ).code,
    "CONTEXT_TOO_LONG",
  );
  const limited = await failure(
    t,
    config,
    429,
    body(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota.", [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure" },
      {
        "@type": "type.googleapis.com/google.rpc.RetryInfo",
        retryDelay: "31s",
      },
    ]),
  );
  assert.equal(limited.code, "RATE_LIMITED");
  assert.deepEqual(limited.details, { retryAfterMs: 31_000 });
  assert.equal(
    (
      await failure(
        t,
        config,
        404,
        body(
          404,
          "NOT_FOUND",
          "models/gemini-9 is not found for API version v1beta, or is not supported for generateContent.",
        ),
      )
    ).code,
    "MODEL_UNAVAILABLE",
  );
});

test("Responses failures map over HTTP and inside the stream", async (t) => {
  const config = zen("responses", "gpt-5.6-luna");
  assert.equal(
    (
      await failure(t, config, 400, {
        error: {
          message: `Your input exceeds the context window of this model. ${SECRET}`,
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      })
    ).code,
    "CONTEXT_TOO_LONG",
  );
  const streamed = async (events) => {
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          events.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(""),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const error = await generate(config, ask, undefined, true, {
      progress: { id: "p", onItem() {} },
    }).then(
      () => assert.fail("the stream failure should reject"),
      (thrown) => thrown,
    );
    t.mock.restoreAll();
    assert.equal(error.message.includes(SECRET), false);
    return error;
  };
  assert.equal(
    (
      await streamed([
        { type: "response.created", response: { id: "r" } },
        {
          type: "response.failed",
          response: {
            id: "r",
            status: "failed",
            error: { code: "context_length_exceeded", message: SECRET },
          },
        },
      ])
    ).code,
    "CONTEXT_TOO_LONG",
  );
  assert.equal(
    (
      await streamed([
        {
          type: "error",
          code: "rate_limit_exceeded",
          message: SECRET,
        },
      ])
    ).code,
    "RATE_LIMITED",
  );
  // An overloaded service saying the model is unavailable is a wait.
  const busy = await streamed([
    {
      type: "error",
      code: "server_error",
      message: `The model is currently unavailable. ${SECRET}`,
    },
  ]);
  assert.equal(busy.code, "PROVIDER_ERROR");
  assert.equal(busy.retryable, true);
  const unknown = await streamed([
    { type: "error", code: "something_new", message: SECRET },
  ]);
  assert.equal(unknown.code, "PROVIDER_ERROR");
  assert.equal(
    unknown.message,
    "The provider reported an error while streaming.",
  );
});

test("a model listing that fails is never read as a missing model or a long prompt", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: { message: "model not found: maximum context length" } },
      { status: 404 },
    ),
  );
  const error = await listProviderModels(openai).then(
    () => assert.fail("listing should fail"),
    (thrown) => thrown,
  );
  assert.equal(error.code, "PROVIDER_ERROR");
});

test("the desktop path carries the companion's classification in the extension's words", async (t) => {
  const config = {
    kind: "desktop",
    providerId: "claude-code",
    providerName: "Claude Code",
    baseUrl: "http://127.0.0.1:48123",
    token: "desktop-token-1234567890",
    model: "sonnet",
    capabilities: { tools: true, vision: false, reasoning: false },
  };
  for (const [status, code, extra, details] of [
    [502, "CONTEXT_TOO_LONG", {}, undefined],
    [429, "RATE_LIMITED", { retryAfterMs: 9000 }, { retryAfterMs: 9000 }],
    [429, "RATE_LIMITED", { retryAfterMs: "soon" }, undefined],
    [502, "MODEL_UNAVAILABLE", {}, undefined],
  ]) {
    const error = await failure(t, config, status, {
      error: {
        code,
        message: `Claude Code failed: ${SECRET} me@example.test`,
        ...extra,
      },
    });
    assert.equal(error.code, code);
    assert.deepEqual(error.details, details);
    assert.equal(error.message.includes("example.test"), false);
  }
  // A code the extension does not classify keeps the companion's own status
  // mapping, as before.
  const other = await failure(t, config, 502, {
    error: { code: "PROVIDER_ERROR", message: "Claude Code failed: crashed" },
  });
  assert.equal(other.code, "PROVIDER_ERROR");
});

test("the companion classifies agent failures from the CLI's own words", () => {
  for (const [message, code] of [
    ["Prompt is too long", "CONTEXT_TOO_LONG"],
    [
      "API Error: 400 input length and `max_tokens` exceed context limit",
      "CONTEXT_TOO_LONG",
    ],
    ["Claude AI usage limit reached|1760000000", "RATE_LIMITED"],
    ["5-hour limit reached ∙ resets 3pm", "RATE_LIMITED"],
    [
      "stream error: exceeded retry limit, last status: 429 Too Many Requests",
      "RATE_LIMITED",
    ],
    ["You've hit your usage limit. Try again in 2 hours.", "RATE_LIMITED"],
    [
      'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-x"}}',
      "MODEL_UNAVAILABLE",
    ],
    ["The model gpt-9 does not exist", "MODEL_UNAVAILABLE"],
    ["Not logged in", "PROVIDER_ERROR"],
    ["Claude Code stopped after 300 turns in one run.", "PROVIDER_ERROR"],
  ])
    assert.equal(agentFailureCode(message), code, message);
});
