/**
 * Streamed thinking: merged before it crosses to the widget, drawn in chunks
 * of at most fifty words, and folded by the parsers instead of retained.
 */
import test from "node:test";
import assert from "node:assert/strict";
import ArjunahRenderer from "../packages/widget/dist/renderer.js";
import { reasoningBatcher } from "../src/lib/reasoning.js";
import { generate } from "../src/lib/provider.js";
import { LIMITS } from "../src/lib/constants.js";

const { reasoningChunks } = ArjunahRenderer;
const words = (text) => text.split(/\s+/).filter(Boolean).length;

test("thinking tokens become one message per batch, in provider order", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent = [];
  const batch = reasoningBatcher((step) => sent.push(step));
  for (const token of ["Let", " me", " check", " the", " map"])
    batch.push({ type: "reasoning_delta", text: token });
  assert.deepEqual(sent, [], "nothing crosses before the batch closes");
  t.mock.timers.tick(LIMITS.reasoningBatchMs);
  assert.deepEqual(sent, [
    { type: "reasoning_delta", text: "Let me check the map" },
  ]);

  // Any other item sends the pending text first, so order is kept.
  batch.push({ type: "reasoning_delta", text: "Calling" });
  batch.push({ type: "output_delta", text: "Here" });
  assert.deepEqual(sent.slice(1), [
    { type: "reasoning_delta", text: "Calling" },
    { type: "output_delta", text: "Here" },
  ]);

  // A burst past the size bound goes at once, and flush empties the rest.
  batch.push({ type: "reasoning_delta", text: "x".repeat(4_000) });
  assert.equal(sent.length, 4);
  batch.push({ type: "reasoning_delta", text: "tail" });
  batch.flush();
  assert.deepEqual(sent.at(-1), { type: "reasoning_delta", text: "tail" });
  batch.flush();
  t.mock.timers.tick(LIMITS.reasoningBatchMs);
  assert.equal(sent.length, 5, "an empty flush and a spent timer send nothing");
});

test("reasoning is drawn in chunks of at most fifty words", () => {
  const text = Array.from({ length: 120 }, (_, index) => `w${index}`).join(" ");
  const split = reasoningChunks(text, null);
  assert.deepEqual(
    split.pieces.map((piece) => [words(piece.text), piece.fresh]),
    [
      [50, false],
      [50, true],
      [20, true],
    ],
  );
  assert.equal(split.pieces.map((piece) => piece.text).join(""), text);

  // Streamed a token at a time, the chunks come out the same, and a word
  // split across two deltas is counted once and never cut at a boundary.
  const tokens = text.match(/.{1,3}/gs);
  let state = null;
  const chunks = [];
  for (const token of tokens) {
    const next = reasoningChunks(token, state);
    state = next;
    for (const piece of next.pieces)
      if (piece.fresh || !chunks.length) chunks.push(piece.text);
      else chunks[chunks.length - 1] += piece.text;
  }
  assert.deepEqual(
    chunks,
    split.pieces.map((piece) => piece.text),
  );
  assert.ok(chunks.every((chunk) => words(chunk) <= 50));
});

test("Gemini streamed thoughts are folded, not kept part by part", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const event = (parts) =>
    `data: ${JSON.stringify({ candidates: [{ content: { parts } }] })}\n\n`;
  globalThis.fetch = async () =>
    new Response(
      [
        event([{ text: "Think ", thought: true }]),
        event([{ text: "hard", thought: true }]),
        event([{ text: "Answer" }]),
        event([{ functionCall: { name: "site__lookup", args: { id: 1 } } }]),
      ].join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  const deltas = [];
  const result = await generate(
    {
      kind: "opencode",
      providerId: "opencode",
      protocol: "gemini",
      baseUrl: "https://opencode.ai/zen/v1",
      model: "gemini-3-pro",
      apiKey: "zen-key",
      capabilities: { tools: true, vision: false, reasoning: true },
    },
    {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "site__lookup", inputSchema: { type: "object" } }],
    },
    undefined,
    true,
    { progress: { onItem: (item) => deltas.push(item) } },
  );
  assert.equal(result.message.reasoning, "Think hard");
  assert.equal(result.message.content, "Answer");
  assert.equal(result.message.toolCalls[0].arguments, '{"id":1}');
  assert.deepEqual(
    deltas.map((item) => item.type),
    ["reasoning_delta", "reasoning_delta", "output_delta"],
  );
});
