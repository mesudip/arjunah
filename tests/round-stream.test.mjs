/**
 * A page's own round stream (SPEC 5.3, 10): `models.stream` and
 * `conversation.stream`. The background sends bounded, coalesced deltas for
 * the requesting document and request only, the result is the one generate
 * gives, and leaving or aborting the stream cancels the round.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { broker } from "./helpers/broker.mjs";
import { roundBatcher } from "../src/lib/reasoning.js";
import { LIMITS } from "../src/lib/constants.js";

const ask = { messages: [{ role: "user", content: "hi" }] };
const COMPANION = "http://127.0.0.1:48123";
const TOKEN = "desktop-token-1234567890";
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function until(check) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (check()) return;
    await flush();
  }
  throw new Error("condition not reached");
}

/** A Chat Completions event stream the test writes chunk by chunk. */
function liveStream(init) {
  const encoder = new TextEncoder();
  let controller;
  const body = new ReadableStream({
    start(value) {
      controller = value;
    },
  });
  init?.signal?.addEventListener("abort", () =>
    controller.error(
      new DOMException("The operation was aborted.", "AbortError"),
    ),
  );
  return {
    response: new Response(body, {
      headers: { "Content-Type": "text/event-stream" },
    }),
    send(chunk) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    },
    end() {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  };
}
const delta = (value, finish = null) => ({
  id: "response-1",
  choices: [{ delta: value, finish_reason: finish }],
});

/** The broker with one streaming round per request, written by `script`. */
function streamingProvider(b, script) {
  const seen = { streams: [] };
  b.hooks.fetch = (_url, init, payload) => {
    if (!payload.stream)
      return Response.json({
        id: "response-1",
        choices: [
          {
            message: { content: "Hello there", reasoning_content: "Think" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    const stream = liveStream(init);
    seen.signal = init.signal;
    seen.streams.push(stream);
    queueMicrotask(() => script(stream));
    return stream.response;
  };
  return seen;
}
const answer = (stream) => {
  stream.send(delta({ reasoning_content: "Think" }));
  stream.send(delta({ content: "Hello" }));
  stream.send(delta({ content: " there" }, "stop"));
  stream.send({
    choices: [],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
  stream.end();
};

test("a streamed round sends its deltas in order, then the result generate gives", async (t) => {
  const b = await broker(t);
  await b.approve(["models.generate"]);
  streamingProvider(b, answer);
  const plain = await b.ok("models.generate", { ...ask, _request: "req-0" });
  assert.equal(b.requests.at(-1).payload.stream, false);
  assert.deepEqual(b.rounds, [], "a plain generate streams nothing");

  const streamed = await b.ok("models.generate", {
    ...ask,
    _request: "req-1",
    _stream: true,
  });
  assert.equal(b.requests.at(-1).payload.stream, true);
  assert.deepEqual(streamed, plain, "the stream's result is generate's");
  assert.deepEqual(
    b.rounds.map((item) => item.event),
    [
      { type: "reasoning.delta", text: "Think" },
      { type: "output.delta", text: "Hello there" },
    ],
  );
  // Bound to the requesting document and request, and nothing else crosses.
  for (const item of b.rounds) {
    assert.deepEqual(Object.keys(item).sort(), [
      "event",
      "kind",
      "request",
      "session",
    ]);
    assert.equal(item.request, "req-1");
    assert.equal(item.session, "session-1");
  }
  assert.deepEqual(b.events, [], "no hosted-chat progress for a page round");

  // Without a bridge id there is nothing to post deltas under.
  b.rounds.length = 0;
  await b.ok("models.generate", { ...ask, _stream: true });
  assert.deepEqual(b.rounds, []);
});

test("deltas are coalesced for at most the batch window and size, and capped per round", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const b = await broker(t);
  await b.approve(["models.generate"]);
  let stream;
  streamingProvider(b, (value) => {
    stream = value;
  });
  const pending = b.ok("models.generate", {
    ...ask,
    _request: "req-1",
    _stream: true,
  });
  await until(() => stream);
  for (const word of ["a", "b", "c", "d", "e"])
    stream.send(delta({ content: word }));
  await flush();
  await flush();
  assert.deepEqual(b.rounds, [], "nothing crosses before the window closes");
  t.mock.timers.tick(LIMITS.reasoningBatchMs);
  await until(() => b.rounds.length === 1);
  assert.deepEqual(b.rounds[0].event, { type: "output.delta", text: "abcde" });

  // A change of type sends what is pending first, so order holds.
  stream.send(delta({ reasoning_content: "r" }));
  stream.send(delta({ content: "x" }));
  await until(() => b.rounds.length === 2);
  assert.deepEqual(b.rounds[1].event, { type: "reasoning.delta", text: "r" });
  // A burst goes at once in pieces of at most the batch size.
  stream.send(delta({ content: "y".repeat(10_000) }));
  await until(() => b.rounds.length === 4);
  stream.send(delta({}, "stop"));
  stream.end();
  const result = await pending;
  const texts = b.rounds.map((item) => item.event.text);
  assert.ok(texts.every((text) => text.length <= LIMITS.reasoningBatchChars));
  assert.equal(
    texts.slice(2).join(""),
    `x${"y".repeat(10_000)}`,
    "the rest is flushed before the answer",
  );
  assert.equal(result.message.content, `abcdex${"y".repeat(10_000)}`);
});

test("the batcher holds each text to the result's own bound", () => {
  const sent = [];
  const batch = roundBatcher((item) => sent.push(item), {
    output_delta: LIMITS.answerChars,
    reasoning_delta: LIMITS.reasoningChars,
  });
  for (let index = 0; index < 40; index++) {
    batch.push("output_delta", "o".repeat(4_000));
    batch.push("reasoning_delta", "r".repeat(4_000));
  }
  batch.flush();
  const total = (type) =>
    sent
      .filter((item) => item.type === type)
      .reduce((sum, item) => sum + item.text.length, 0);
  assert.equal(total("output_delta"), LIMITS.answerChars);
  assert.equal(total("reasoning_delta"), LIMITS.reasoningChars);
  assert.ok(sent.every((item) => item.text.length <= 4_000));
  batch.push("output_delta", "more");
  batch.flush();
  assert.equal(total("output_delta"), LIMITS.answerChars);
});

test("a silent round reports stalled every 20 seconds until it ends", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const b = await broker(t);
  await b.approve(["models.generate"]);
  let stream;
  const seen = streamingProvider(b, (value) => {
    stream = value;
  });
  const pending = b.call("models.generate", {
    ...ask,
    _request: "req-1",
    _stream: true,
  });
  await until(() => stream);
  t.mock.timers.tick(LIMITS.stallNoticeMs - 1);
  await flush();
  assert.deepEqual(b.rounds, []);
  t.mock.timers.tick(1);
  await until(() => b.rounds.length === 1);
  assert.deepEqual(b.rounds[0].event, { type: "stalled" });
  // Any sign of life re-arms it.
  t.mock.timers.tick(LIMITS.stallNoticeMs - 5);
  stream.send(delta({ reasoning_content: "hmm" }));
  await flush();
  await flush();
  t.mock.timers.tick(LIMITS.reasoningBatchMs);
  await until(() => b.rounds.length === 2);
  t.mock.timers.tick(LIMITS.stallNoticeMs - LIMITS.reasoningBatchMs - 1);
  await flush();
  assert.equal(b.rounds.length, 2);
  t.mock.timers.tick(LIMITS.reasoningBatchMs + 1);
  await until(() => b.rounds.length === 3);
  t.mock.timers.tick(LIMITS.stallNoticeMs);
  await until(() => b.rounds.length === 4);
  assert.deepEqual(
    b.rounds.map((item) => item.event.type),
    ["stalled", "reasoning.delta", "stalled", "stalled"],
  );
  assert.equal(await b.ok("models.cancel", { request: "req-1" }), true);
  const response = await pending;
  assert.equal(response.error.code, "ABORTED");
  assert.equal(seen.signal.aborted, true);
  // Nothing more after the round ended.
  t.mock.timers.tick(LIMITS.stallNoticeMs * 3);
  await flush();
  assert.equal(b.rounds.length, 4);
});

test("cancelling a stream mid-round aborts the provider request and sends nothing more", async (t) => {
  const b = await broker(t);
  await b.approve(["models.generate"]);
  let stream;
  const seen = streamingProvider(b, (value) => {
    stream = value;
    value.send(delta({ content: "partial" }));
  });
  const pending = b.call("models.generate", {
    ...ask,
    _request: "req-1",
    _stream: true,
  });
  await until(() => stream);
  assert.equal(await b.ok("models.cancel", { request: "req-1" }), true);
  const response = await pending;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "ABORTED");
  assert.equal(response.error.details.retryable, false);
  assert.equal(seen.signal.aborted, true, "the provider request was cancelled");
  // The batched "partial" belonged to a round the page left; it is dropped.
  await new Promise((resolve) =>
    setTimeout(resolve, LIMITS.reasoningBatchMs * 2),
  );
  assert.deepEqual(b.rounds, []);
});

test("an error mid-stream follows the deltas already sent, with generate's code", async (t) => {
  const b = await broker(t);
  await b.approve(["models.generate"]);
  streamingProvider(b, (stream) => {
    stream.send(delta({ content: "Half an" }));
    stream.send({
      error: { code: "rate_limit_exceeded", message: "secret body" },
    });
    stream.end();
  });
  const response = await b.call("models.generate", {
    ...ask,
    _request: "req-1",
    _stream: true,
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "RATE_LIMITED");
  assert.equal(response.error.details.retryable, true);
  assert.equal(JSON.stringify(response).includes("secret body"), false);
  assert.deepEqual(
    b.rounds.map((item) => item.event),
    [{ type: "output.delta", text: "Half an" }],
  );
});

test("tool calls arrive only in the result, never as deltas", async (t) => {
  const b = await broker(t);
  await b.approve(["models.generate"]);
  streamingProvider(b, (stream) => {
    stream.send(delta({ content: "Checking" }));
    stream.send(
      delta(
        {
          tool_calls: [
            {
              index: 0,
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: '{"q":"x"}' },
            },
          ],
        },
        "tool_calls",
      ),
    );
    stream.end();
  });
  const result = await b.ok("models.generate", {
    ...ask,
    tools: [{ name: "lookup", inputSchema: { type: "object" } }],
    _request: "req-1",
    _stream: true,
  });
  assert.deepEqual(result.message.toolCalls, [
    { id: "call-1", name: "lookup", arguments: '{"q":"x"}' },
  ]);
  assert.deepEqual(
    b.rounds.map((item) => item.event),
    [{ type: "output.delta", text: "Checking" }],
  );
  assert.equal(JSON.stringify(b.rounds).includes("lookup"), false);
});

test("a desktop round forwards the companion's answer and reasoning deltas only", async (t) => {
  const b = await broker(t);
  const generates = [];
  let progress = [];
  b.hooks.fetch = async (url, init, payload) => {
    const target = new URL(url);
    if (target.origin !== COMPANION)
      return Response.json({ choices: [{ message: { content: "api" } }] });
    if (target.pathname === "/api/status")
      return Response.json({
        app: "arjunah-desktop",
        version: "1.0.0",
        paired: init.headers?.Authorization === `Bearer ${TOKEN}`,
        sync: { revision: 0 },
      });
    if (target.pathname === "/api/pair")
      return Response.json({ token: TOKEN, client: { id: "c1" } });
    if (target.pathname === "/api/providers")
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
    if (target.pathname === "/api/sync")
      return Response.json({ revision: 0, updatedAt: null, config: null });
    if (target.pathname.startsWith("/api/progress/"))
      return Response.json({ items: progress.splice(0), total: 0, done: true });
    if (target.pathname === "/api/generate") {
      generates.push(payload);
      return Response.json({
        id: "d1",
        message: { role: "assistant", content: "agent answer", toolCalls: [] },
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      });
    }
    return new Response("nope", { status: 404 });
  };
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  await b.ok("catalog.default", { model: "claude-code/sonnet" }, b.extension);
  await b.approve(["models.list", "models.generate"]);

  const plain = await b.ok("models.generate", { ...ask, _request: "req-0" });
  assert.equal(generates.at(-1).progressId, undefined);
  progress = [
    { type: "phase", text: "Launching Claude Code" },
    { type: "command", phase: "start", id: "c", command: "ls" },
    { type: "reasoning_delta", text: "Plan" },
    { type: "output_delta", text: "agent " },
    { type: "output_delta", text: "answer" },
    { type: "reasoning", text: "Plan" },
    { type: "thinking", tokens: 12 },
    // Past the answer bound: 30 more full items.
    ...Array.from({ length: 30 }, () => ({
      type: "output_delta",
      text: "z".repeat(4_000),
    })),
  ];
  const streamed = await b.ok("models.generate", {
    ...ask,
    _request: "req-1",
    _stream: true,
  });
  assert.match(generates.at(-1).progressId, /^round-[0-9a-f-]{36}$/);
  assert.deepEqual(streamed, plain);
  const events = b.rounds.map((item) => item.event);
  assert.ok(
    events.every((event) =>
      ["output.delta", "reasoning.delta"].includes(event.type),
    ),
  );
  assert.deepEqual(events[0], { type: "reasoning.delta", text: "Plan" });
  const output = events
    .filter((event) => event.type === "output.delta")
    .map((event) => event.text)
    .join("");
  assert.equal(output.length, LIMITS.answerChars);
  assert.ok(output.startsWith("agent answerzzz"));
  assert.equal(JSON.stringify(b.rounds).includes("Launching"), false);
  assert.equal(JSON.stringify(b.rounds).includes('"ls"'), false);
});

/**
 * Runs the real page-api.js against a window whose other side is played by
 * the test, standing in for the content script.
 */
function pageWorld() {
  const nonce = "nonce-1";
  const win = new EventTarget();
  const posted = [];
  const warnings = [];
  let reply = null;
  win.postMessage = (data) => {
    const copy = structuredClone(data);
    if (copy.direction === "page-to-extension") {
      posted.push(copy);
      reply?.(copy);
      return;
    }
    const event = new Event("message");
    event.source = win;
    event.data = copy;
    win.dispatchEvent(event);
  };
  const context = vm.createContext({
    window: win,
    document: { currentScript: { dataset: { arjunahNonce: nonce } } },
    crypto,
    CustomEvent,
    TextEncoder,
    setTimeout,
    clearTimeout,
    console: { ...console, warn: (text) => warnings.push(text) },
  });
  vm.runInContext(readFileSync("src/page-api.js", "utf8"), context);
  const toPage = (payload) =>
    win.postMessage({
      channel: "arjunah-v0.1",
      direction: "extension-to-page",
      nonce,
      ...payload,
    });
  const requests = [];
  reply = (message) => {
    if (message.kind !== "request") return;
    if (message.method === "enable")
      toPage({
        kind: "response",
        id: message.id,
        ok: true,
        result: { origin: "https://site.test" },
      });
    else if (message.method === "conversations.create")
      toPage({
        kind: "response",
        id: message.id,
        ok: true,
        result: { id: "conv-1" },
      });
    else requests.push(message);
  };
  return {
    api: win.ai.arjunah,
    posted,
    requests,
    warnings,
    nonce,
    event: (request, event) =>
      toPage({ kind: "stream", id: request.id, event }),
    answer: (request, payload) =>
      toPage({ kind: "response", id: request.id, ...payload }),
  };
}
const RESULT = {
  id: "r1",
  model: "openai/allowed",
  message: {
    role: "assistant",
    content: "Hello there",
    toolCalls: [],
    attachments: [],
    reasoning: null,
  },
  finishReason: "stop",
};

test("page API: a stream yields its events in order and the result last", async () => {
  const world = pageWorld();
  const session = await world.api.enable();
  const stream = session.models.stream({ ...ask, conversationId: "forged" });
  const [request] = world.requests;
  assert.equal(request.method, "models.stream");
  assert.equal("conversationId" in request.params, false);
  world.event(request, { type: "reasoning.delta", text: "Think" });
  world.event(request, { type: "stalled" });
  // Malformed, unknown, oversized, or another request's: all ignored.
  world.event(request, { type: "tool.call", text: "x" });
  world.event(request, { type: "output.delta", text: 5 });
  world.event(request, { type: "output.delta", text: "" });
  world.event(request, { type: "output.delta", text: "o".repeat(4_001) });
  world.event({ id: "other" }, { type: "output.delta", text: "nope" });
  world.event(request, { type: "output.delta", text: "Hello there", extra: 1 });
  world.answer(request, {
    ok: true,
    result: { ...RESULT, _warnings: ["temperature was ignored"] },
  });
  const events = [];
  for await (const event of stream) events.push(event);
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    { type: "reasoning.delta", text: "Think" },
    { type: "stalled" },
    { type: "output.delta", text: "Hello there" },
    { type: "result", result: RESULT },
  ]);
  assert.deepEqual(world.warnings, ["[अर्जुनः] temperature was ignored"]);
  // A delta for a settled stream goes nowhere.
  world.event(request, { type: "output.delta", text: "late" });
  assert.equal((await stream.next()).done, true);
});

test("page API: a conversation's stream carries its id and the result equals generate's shape", async () => {
  const world = pageWorld();
  const session = await world.api.enable();
  const conversation = await session.conversations.create();
  const stream = conversation.stream(ask);
  const request = world.requests.at(-1);
  assert.equal(request.method, "models.stream");
  assert.equal(request.params.conversationId, "conv-1");
  const reading = stream.next();
  world.event(request, { type: "output.delta", text: "Hi" });
  assert.deepEqual(JSON.parse(JSON.stringify(await reading)), {
    value: { type: "output.delta", text: "Hi" },
    done: false,
  });
  world.answer(request, { ok: true, result: RESULT });
  const last = await stream.next();
  assert.equal(last.value.type, "result");
  assert.deepEqual(JSON.parse(JSON.stringify(last.value.result)), RESULT);
  assert.equal((await stream.next()).done, true);
});

test("page API: an error rejects next() with generate's error, after the deltas", async () => {
  const world = pageWorld();
  const session = await world.api.enable();
  const stream = session.models.stream(ask);
  const [request] = world.requests;
  world.event(request, { type: "output.delta", text: "Half" });
  world.answer(request, {
    ok: false,
    error: {
      code: "RATE_LIMITED",
      message: "Try again later.",
      details: { requestId: request.id, retryable: true, retryAfterMs: 5 },
    },
  });
  assert.equal((await stream.next()).value.text, "Half");
  const error = await stream.next().catch((thrown) => thrown);
  assert.equal(error.name, "AIError");
  assert.equal(error.code, "RATE_LIMITED");
  assert.deepEqual(JSON.parse(JSON.stringify(error.details)), {
    requestId: request.id,
    retryable: true,
    retryAfterMs: 5,
  });
  assert.equal((await stream.next()).done, true);
});

test("page API: leaving the loop or aborting the signal cancels the round", async () => {
  const world = pageWorld();
  const session = await world.api.enable();

  // `break` calls return(): a cancel for that id, and nothing more is read.
  const stream = session.models.stream(ask);
  const first = world.requests.at(-1);
  world.event(first, { type: "output.delta", text: "a" });
  for await (const event of stream) {
    assert.equal(event.text, "a");
    break;
  }
  assert.deepEqual(world.posted.at(-1), {
    channel: first.channel,
    direction: "page-to-extension",
    nonce: world.nonce,
    kind: "cancel",
    id: first.id,
  });
  world.event(first, { type: "output.delta", text: "b" });
  world.answer(first, { ok: true, result: RESULT });
  assert.equal((await stream.next()).done, true);

  // An aborted signal ends next() with ABORTED and cancels the same way.
  const controller = new AbortController();
  const aborted = session.models.stream(ask, { signal: controller.signal });
  const second = world.requests.at(-1);
  const waiting = aborted.next();
  controller.abort();
  const error = await waiting.catch((thrown) => thrown);
  assert.equal(error.code, "ABORTED");
  assert.equal(error.details.requestId, second.id);
  assert.equal(error.details.retryable, false);
  assert.equal(world.posted.at(-1).kind, "cancel");
  assert.equal(world.posted.at(-1).id, second.id);

  // Already aborted: ABORTED, and nothing is posted.
  const before = world.posted.length;
  const early = session.models.stream(ask, { signal: controller.signal });
  assert.equal((await early.next().catch((thrown) => thrown)).code, "ABORTED");
  // Not a signal: INVALID_REQUEST, and nothing is posted.
  const invalid = session.models.stream(ask, { signal: "stop" });
  assert.equal(
    (await invalid.next().catch((thrown) => thrown)).code,
    "INVALID_REQUEST",
  );
  assert.equal(world.posted.length, before);
});

test("page API: a stream holds each text to the result's bound", async () => {
  const world = pageWorld();
  const session = await world.api.enable();
  const stream = session.models.stream(ask);
  const [request] = world.requests;
  for (let index = 0; index < 5; index++)
    world.event(request, { type: "reasoning.delta", text: "r".repeat(4_000) });
  world.answer(request, { ok: true, result: RESULT });
  let reasoning = 0;
  for await (const event of stream)
    if (event.type === "reasoning.delta") reasoning += event.text.length;
  assert.equal(reasoning, 12_000);
});
