import test from "node:test";
import assert from "node:assert/strict";
import { generate, wireToolChoice } from "../src/lib/provider.js";
import { validateGenerateRequest } from "../src/lib/validation.js";
import { broker } from "./helpers/broker.mjs";

const tools = [
  { name: "lookup", description: "Find a record." },
  { name: "save", description: "Store a record." },
];
const ask = { messages: [{ role: "user", content: "hi" }], tools };
const capabilities = { tools: true, vision: false, reasoning: true };
const zen = (protocol, model) => ({
  kind: "opencode",
  baseUrl: "https://opencode.ai/zen/v1",
  apiKey: "zen-key",
  model,
  protocol,
  capabilities,
});

test("toolChoice is validated: four forms, needs tools, and names a declared tool", () => {
  for (const choice of ["auto", "none", "required"])
    assert.equal(
      validateGenerateRequest({ ...ask, toolChoice: choice }).toolChoice,
      choice,
    );
  // Members beyond `name` are ignored, as SPEC 3 says of unknown fields.
  assert.deepEqual(
    validateGenerateRequest({
      ...ask,
      toolChoice: { name: "save", type: "function" },
    }).toolChoice,
    { name: "save" },
  );
  assert.equal(
    "toolChoice" in validateGenerateRequest({ ...ask, toolChoice: null }),
    false,
    "null means the provider default",
  );
  for (const [request, pattern] of [
    [{ ...ask, toolChoice: "any" }, /toolChoice must be/],
    [{ ...ask, toolChoice: { name: "delete" } }, /one of the request's tools/],
    [{ ...ask, toolChoice: { name: 3 } }, /toolChoice must be/],
    [{ ...ask, toolChoice: ["auto"] }, /toolChoice must be/],
    [
      { messages: ask.messages, toolChoice: "required" },
      /toolChoice requires tools/,
    ],
    [{ ...ask, tools: [], toolChoice: "none" }, /toolChoice requires tools/],
  ])
    assert.throws(
      () => validateGenerateRequest(request),
      (error) =>
        error.code === "INVALID_REQUEST" &&
        error.details?.field === "toolChoice" &&
        pattern.test(error.message),
      JSON.stringify(request.toolChoice),
    );
});

test("toolChoice maps to each wire format's own control", () => {
  const table = {
    "chat-completions": [
      "auto",
      "none",
      "required",
      { type: "function", function: { name: "save" } },
    ],
    responses: ["auto", "none", "required", { type: "function", name: "save" }],
    anthropic: [
      { type: "auto" },
      { type: "none" },
      { type: "any" },
      { type: "tool", name: "save" },
    ],
    gemini: [
      { functionCallingConfig: { mode: "AUTO" } },
      { functionCallingConfig: { mode: "NONE" } },
      { functionCallingConfig: { mode: "ANY" } },
      {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["save"] },
      },
    ],
  };
  for (const [format, expected] of Object.entries(table))
    assert.deepEqual(
      ["auto", "none", "required", { name: "save" }].map((choice) =>
        wireToolChoice(format, choice),
      ),
      expected,
      format,
    );
});

test("toolChoice reaches the wire of every API format, and only when given", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const cases = [
    [
      "chat completions",
      { baseUrl: "https://provider.test/v1", model: "demo", apiKey: "k" },
      { choices: [{ message: { role: "assistant", content: "ok" } }] },
      (payload) => payload.tool_choice,
      { type: "function", function: { name: "save" } },
    ],
    [
      "responses",
      zen("responses", "gpt-5.6-luna"),
      {
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "ok" }] },
        ],
      },
      (payload) => payload.tool_choice,
      { type: "function", name: "save" },
    ],
    [
      "anthropic",
      zen("anthropic", "claude-sonnet-4-6"),
      { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
      (payload) => payload.tool_choice,
      { type: "tool", name: "save" },
    ],
    [
      "gemini",
      zen("gemini", "gemini-3.1-pro"),
      {
        candidates: [
          { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
        ],
      },
      (payload) => payload.toolConfig,
      {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["save"] },
      },
    ],
  ];
  for (const [name, config, body, choiceOf, expected] of cases) {
    let payload;
    globalThis.fetch = async (_url, init) => {
      payload = JSON.parse(init.body);
      return Response.json(body);
    };
    await generate(config, { ...ask, toolChoice: { name: "save" } });
    assert.deepEqual(choiceOf(payload), expected, name);
    // Tools stay declared: a choice narrows them, it never removes them.
    assert.ok(JSON.stringify(payload).includes('"lookup"'), name);
    await generate(config, ask);
    assert.equal(choiceOf(payload), undefined, `${name}: absent by default`);
  }
});

test("Anthropic drops thinking for a forced tool and keeps it otherwise", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let payload;
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init.body);
    return Response.json({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
    });
  };
  const config = zen("anthropic", "claude-sonnet-4-6");
  // Anthropic refuses extended thinking with `any` or `tool`.
  for (const choice of ["required", { name: "save" }]) {
    await generate(config, { ...ask, reasoning: "high", toolChoice: choice });
    assert.equal(payload.thinking, undefined, JSON.stringify(choice));
  }
  for (const choice of ["auto", "none"]) {
    await generate(config, { ...ask, reasoning: "high", toolChoice: choice });
    assert.deepEqual(payload.thinking, { type: "adaptive" }, choice);
  }
});

test("Ollama and the desktop companion honour only auto, refusing the rest before any request", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const configs = {
    ollama: {
      kind: "ollama",
      providerName: "Ollama (self-hosted)",
      baseUrl: "http://127.0.0.1:11434",
      apiKey: null,
      model: "qwen3-vl:2b",
      capabilities,
    },
    desktop: {
      kind: "desktop",
      baseUrl: "http://127.0.0.1:48123",
      token: "desktop-token-abcdefghijklmnop",
      providerId: "claude-code",
      providerName: "Claude Code",
      model: "sonnet",
      capabilities,
    },
  };
  const bodies = {
    ollama: { message: { role: "assistant", content: "ok" }, done: true },
    desktop: {
      id: "d",
      message: { role: "assistant", content: "ok", toolCalls: [] },
      finishReason: "stop",
    },
  };
  for (const [name, config] of Object.entries(configs)) {
    let requests = 0;
    let payload = null;
    globalThis.fetch = async (url, init) => {
      if (/\/api\/(chat|generate)$/.test(new URL(url).pathname)) {
        requests++;
        payload = JSON.parse(init.body);
      }
      return Response.json(
        new URL(url).pathname === "/api/ps" ? { models: [] } : bodies[name],
      );
    };
    for (const choice of ["none", "required", { name: "save" }]) {
      const error = await generate(config, {
        ...ask,
        toolChoice: choice,
      }).catch((thrown) => thrown);
      assert.equal(error.code, "NOT_SUPPORTED", `${name} ${choice}`);
      assert.doesNotMatch(error.message, /127\.0\.0\.1|token/);
    }
    assert.equal(requests, 0, `${name}: refused before any request`);
    const result = await generate(config, { ...ask, toolChoice: "auto" });
    assert.equal(result.message.content, "ok", name);
    assert.equal(requests, 1);
    // Nothing named tool_choice reaches a wire that has no such field, and
    // the tools themselves are still declared.
    assert.equal(JSON.stringify(payload).includes("tool_choice"), false);
    assert.equal(payload.tools.length, 2, name);
  }
});

test("a page's toolChoice reaches the provider through models.generate", async (t) => {
  const b = await broker(t);
  await b.approve(["models.generate"]);
  await b.ok("models.generate", { ...ask, toolChoice: "required" });
  assert.equal(b.requests.at(-1).payload.tool_choice, "required");
  const refused = await b.call("models.generate", {
    ...ask,
    toolChoice: { name: "missing" },
  });
  assert.equal(refused.error.code, "INVALID_REQUEST");
  assert.equal(refused.error.details.field, "toolChoice");
  assert.equal(b.requests.length, 1, "the refused request sent nothing");
});
