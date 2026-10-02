import test from "node:test";
import assert from "node:assert/strict";
import { validateGenerateRequest } from "../src/lib/validation.js";
import { GENERATE_LIMITS, generateLimits } from "../src/lib/constants.js";
import { validateSchema } from "../src/lib/schema.js";
import { broker } from "./helpers/broker.mjs";

const user = (content) => ({ role: "user", content });
const refused = (input, limits) => {
  try {
    validateGenerateRequest(input, limits);
  } catch (error) {
    return error.code;
  }
  return null;
};
const tool = (index, description = "") => ({
  name: `tool_${index}`,
  description,
  inputSchema: { type: "object", additionalProperties: false },
});
const call = (index, args = "{}") => ({
  id: `call_${index}`,
  type: "function",
  function: { name: "lookup", arguments: args },
});
/** A schema whose deepest `items` sits `depth` levels below the root. */
function nested(depth) {
  let schema = { type: "string" };
  for (let level = 0; level < depth; level++)
    schema = { type: "array", items: schema };
  return { type: "object", properties: { value: schema } };
}

test("the page generate bounds are the ones SPEC 5.3 states", () => {
  assert.deepEqual(GENERATE_LIMITS, {
    messages: 400,
    messageUnits: 180_000,
    tools: 128,
    toolDescriptionUnits: 2_000,
    toolCallsPerMessage: 32,
    toolArgumentUnits: 65_536,
    schemaBytes: 32_768,
    schemaDepth: 16,
    requestBytes: 12_000_000,
    maxTokens: 32_768,
    timeoutMs: 180_000,
  });
});

test("every bound accepts its edge and refuses one past it", () => {
  const L = GENERATE_LIMITS;
  const at = (input) => assert.equal(refused(input), null);
  const past = (input) => assert.equal(refused(input), "INVALID_REQUEST");

  const messages = (count) => Array.from({ length: count }, () => user("x"));
  at({ messages: messages(L.messages) });
  past({ messages: messages(L.messages + 1) });

  // One budget for every role, the same one extension-made messages get.
  for (const role of ["system", "user", "assistant"]) {
    at({ messages: [{ role, content: "a".repeat(L.messageUnits) }] });
    past({ messages: [{ role, content: "a".repeat(L.messageUnits + 1) }] });
  }
  const toolMessage = (length) => ({
    messages: [
      { role: "assistant", content: "", toolCalls: [call(0)] },
      { role: "tool", toolCallId: "call_0", content: "a".repeat(length) },
    ],
  });
  at(toolMessage(L.messageUnits));
  past(toolMessage(L.messageUnits + 1));
  // Text parts share the message's budget: one part may use all of it, and
  // several parts together may not exceed it.
  at({
    messages: [user([{ type: "text", text: "a".repeat(L.messageUnits) }])],
  });
  past({
    messages: [user([{ type: "text", text: "a".repeat(L.messageUnits + 1) }])],
  });
  const half = L.messageUnits / 2;
  at({
    messages: [
      user([
        { type: "text", text: "a".repeat(half) },
        { type: "text", text: "a".repeat(half) },
      ]),
    ],
  });
  past({
    messages: [
      user([
        { type: "text", text: "a".repeat(half) },
        { type: "text", text: "a".repeat(half + 1) },
      ]),
    ],
  });
  // UTF-16 code units, not code points: an astral character counts twice.
  at({ messages: [user("😀".repeat(L.messageUnits / 2))] });
  past({ messages: [user(`${"😀".repeat(L.messageUnits / 2)}a`)] });

  const tools = (count) => Array.from({ length: count }, (_, i) => tool(i));
  at({ messages: [user("x")], tools: tools(L.tools) });
  past({ messages: [user("x")], tools: tools(L.tools + 1) });
  at({
    messages: [user("x")],
    tools: [tool(0, "d".repeat(L.toolDescriptionUnits))],
  });
  past({
    messages: [user("x")],
    tools: [tool(0, "d".repeat(L.toolDescriptionUnits + 1))],
  });

  const calls = (count, args) => ({
    messages: [
      {
        role: "assistant",
        content: "",
        toolCalls: Array.from({ length: count }, (_, i) => call(i, args)),
      },
    ],
  });
  at(calls(L.toolCallsPerMessage));
  past(calls(L.toolCallsPerMessage + 1));
  at(calls(1, "a".repeat(L.toolArgumentUnits)));
  past(calls(1, "a".repeat(L.toolArgumentUnits + 1)));

  // Schema size in UTF-8 bytes of its JSON.
  const sized = (bytes) => {
    const base = { type: "object", description: "" };
    const pad = bytes - new TextEncoder().encode(JSON.stringify(base)).length;
    return { type: "object", description: "d".repeat(pad) };
  };
  const withSchema = (inputSchema) => ({
    messages: [user("x")],
    tools: [{ name: "big", inputSchema }],
  });
  at(withSchema(sized(L.schemaBytes)));
  past(withSchema(sized(L.schemaBytes + 1)));
  // `nested(n)` puts the deepest schema n + 1 levels below the root.
  assert.doesNotThrow(() => validateSchema(nested(L.schemaDepth - 1)));
  assert.throws(() => validateSchema(nested(L.schemaDepth)));
  at(withSchema(nested(L.schemaDepth - 1)));
  past(withSchema(nested(L.schemaDepth)));

  at({ messages: [user("x")], maxTokens: L.maxTokens });
  past({ messages: [user("x")], maxTokens: L.maxTokens + 1 });
  past({ messages: [user("x")], maxTokens: 0 });
});

test("the serialized request bound is exact to the byte", () => {
  const L = GENERATE_LIMITS;
  // Whole messages up to just under the bound, then one sized to land on it.
  const full = Math.floor(L.requestBytes / L.messageUnits);
  const messages = Array.from({ length: full }, () =>
    user("a".repeat(L.messageUnits)),
  );
  const size = (last) =>
    new TextEncoder().encode(
      JSON.stringify({ messages: [...messages, user(last)], tools: [] }),
    ).length;
  const room = L.requestBytes - size("");
  assert.ok(room > 0 && room <= L.messageUnits);
  assert.equal(size("a".repeat(room)), L.requestBytes);
  assert.equal(
    refused({ messages: [...messages, user("a".repeat(room))] }),
    null,
  );
  assert.equal(
    refused({ messages: [...messages, user("a".repeat(room + 1))] }),
    "INVALID_REQUEST",
  );
});

test("a desktop model is held to the companion's caps, and only to those", () => {
  const D = generateLimits(true);
  assert.deepEqual(D, {
    ...GENERATE_LIMITS,
    messages: 300,
    tools: 64,
    toolDescriptionUnits: 500,
  });
  const messages = (count) => Array.from({ length: count }, () => user("x"));
  assert.equal(refused({ messages: messages(300) }, D), null);
  assert.equal(refused({ messages: messages(301) }, D), "INVALID_REQUEST");
  const tools = (count) => Array.from({ length: count }, (_, i) => tool(i));
  assert.equal(refused({ messages: [user("x")], tools: tools(64) }, D), null);
  assert.equal(
    refused({ messages: [user("x")], tools: tools(65) }, D),
    "INVALID_REQUEST",
  );
  assert.equal(
    refused({ messages: [user("x")], tools: [tool(0, "d".repeat(501))] }, D),
    "INVALID_REQUEST",
  );
});

/**
 * The page reads `limits` from models.list and is refused past exactly those
 * numbers on the real background path, before any provider request.
 */
async function reportedEqualsEnforced(b, expected) {
  const [entry] = await b.ok("models.list");
  assert.deepEqual(entry.limits, expected);
  const { limits } = entry;
  const generations = () =>
    b.requests.filter((item) =>
      /\/chat\/completions$|\/api\/generate$/.test(new URL(item.url).pathname),
    ).length;
  const before = generations();
  const generate = (request) => b.call("models.generate", request);
  const many = (count) => Array.from({ length: count }, () => user("x"));
  const tools = (count) => Array.from({ length: count }, (_, i) => tool(i));
  for (const request of [
    { messages: many(limits.messages + 1) },
    { messages: [user("a".repeat(limits.messageUnits + 1))] },
    { messages: [user("x")], tools: tools(limits.tools + 1) },
    {
      messages: [user("x")],
      tools: [tool(0, "d".repeat(limits.toolDescriptionUnits + 1))],
    },
    { messages: [user("x")], maxTokens: limits.maxTokens + 1 },
  ]) {
    const response = await generate(request);
    assert.equal(response.error?.code, "INVALID_REQUEST");
  }
  assert.equal(generations(), before, "nothing past a bound was sent");
  return { limits, many, tools, generate };
}

test("models.list reports the limits models.generate enforces", async (t) => {
  const b = await broker(t);
  await b.approve(["models.list", "models.generate"]);
  const { limits, many, tools, generate } = await reportedEqualsEnforced(
    b,
    GENERATE_LIMITS,
  );
  const response = await generate({
    messages: many(limits.messages - 1).concat(
      user("a".repeat(limits.messageUnits)),
    ),
    tools: tools(limits.tools).map((item, index) =>
      index ? item : tool(0, "d".repeat(limits.toolDescriptionUnits)),
    ),
    maxTokens: limits.maxTokens,
  });
  assert.equal(response.ok, true, JSON.stringify(response.error));
  const sent = b.requests.at(-1).payload;
  assert.equal(sent.messages.length, limits.messages);
  assert.equal(sent.tools.length, limits.tools);
});

test("a desktop model reports and enforces the companion's smaller limits", async (t) => {
  const b = await broker(t);
  let sync = { revision: 0, updatedAt: null, config: null };
  b.hooks.fetch = async (url, init, payload) => {
    const path = new URL(url).pathname;
    if (path === "/api/status")
      return Response.json({
        app: "arjunah-desktop",
        version: "1.0.0",
        device: "Test",
        paired: init.headers?.Authorization === `Bearer ${"t".repeat(32)}`,
        sync: { revision: sync.revision },
      });
    if (path === "/api/pair")
      return Response.json({ token: "t".repeat(32), client: { id: "c" } });
    if (path === "/api/providers")
      return Response.json({
        providers: [
          {
            id: "claude-code",
            name: "Claude Code",
            vendor: "Anthropic",
            installed: true,
            available: true,
            supportsTools: true,
            models: [{ id: "sonnet", displayName: "Sonnet" }],
            defaultModel: "sonnet",
          },
        ],
      });
    if (path === "/api/sync" && init.method === "PUT")
      sync = {
        revision: sync.revision + 1,
        updatedAt: "now",
        config: payload.config,
      };
    if (path === "/api/sync") return Response.json(sync);
    if (path === "/api/generate")
      return Response.json({
        message: { content: "ok", toolCalls: [] },
        usage: {},
      });
    return Response.json({});
  };
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  await b.ok(
    "provider.select",
    { type: "desktop", providerId: "claude-code", model: "sonnet" },
    b.extension,
  );
  await b.approve(["models.list", "models.generate"]);
  const { limits, many, tools, generate } = await reportedEqualsEnforced(
    b,
    generateLimits(true),
  );
  const response = await generate({
    messages: many(limits.messages),
    tools: tools(limits.tools),
  });
  assert.equal(response.ok, true, JSON.stringify(response.error));
  const sent = b.requests.find(
    (item) => new URL(item.url).pathname === "/api/generate",
  ).payload;
  assert.equal(sent.messages.length, 300);
  assert.equal(sent.tools.length, 64);
});
