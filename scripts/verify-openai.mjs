import assert from "node:assert/strict";
import { OPENAI_BASE_URL, OPENAI_DEFAULT_MODEL } from "../src/lib/openai.js";
import { generate, listProviderModels } from "../src/lib/provider.js";

const baseUrl = (process.env.OPENAI_BASE_URL ?? OPENAI_BASE_URL).replace(
  /\/$/,
  "",
);
const model = process.env.OPENAI_DEFAULT_MODEL ?? OPENAI_DEFAULT_MODEL;
const apiKey = process.env.OPENAI_DEFAULT_API_KEY;
if (baseUrl !== OPENAI_BASE_URL)
  throw new Error(`OPENAI_BASE_URL must be ${OPENAI_BASE_URL}.`);
if (!apiKey) throw new Error("OPENAI_DEFAULT_API_KEY is required.");
const config = { baseUrl, model, apiKey };
const models = await listProviderModels(config);
const tools = [
  {
    name: "connection_check",
    description:
      "Return the readiness state of this synthetic connection test.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];
const messages = [
  {
    role: "user",
    content:
      "Call connection_check once, then report whether its result is ready.",
  },
];
const first = await generate(config, { messages, tools, maxTokens: 1024 });
assert.equal(
  first.message.toolCalls.length,
  1,
  "The connection test must request its test tool.",
);
const call = first.message.toolCalls[0];
assert.equal(call.name, "connection_check");
assert.deepEqual(JSON.parse(call.arguments), {});
messages.push({
  role: "assistant",
  content: first.message.content,
  toolCalls: first.rawMessage.tool_calls,
});
messages.push({
  role: "tool",
  toolCallId: call.id,
  content: JSON.stringify({ ready: true }),
});
const final = await generate(config, { messages, tools, maxTokens: 1024 });
assert.equal(final.message.toolCalls.length, 0);
assert.ok(
  final.message.content.trim(),
  "The model must answer after receiving the tool result.",
);
console.log(
  `OpenAI tool round trip verified: ${model}; ${models.length} models reported; ${final.message.content}`,
);
