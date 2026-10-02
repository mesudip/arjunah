/**
 * The standalone widget's stream plumbing without a DOM (SPEC 14.3, 14.6):
 * its `text/event-stream` parser against WHATWG EventSource framing, the
 * `eventStreamResponse` iterator lifecycle, and the bridged-mode access
 * request the README documents, checked against the extension's validator.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createEventStreamParser,
  eventStreamResponse,
} from "../packages/widget/dist/index.js";
import { validateAccessRequest } from "../src/lib/validation.js";

const bytes = (text) => new TextEncoder().encode(text);

/** Feeds `chunks` (strings or byte arrays) and returns every event. */
function parse(chunks) {
  const parser = createEventStreamParser();
  const events = [];
  for (const chunk of chunks)
    events.push(
      ...parser.push(typeof chunk === "string" ? bytes(chunk) : chunk),
    );
  return events;
}

/** Splits `text` into one-byte chunks: every boundary a network may pick. */
function byteByByte(text) {
  return [...bytes(text)].map((value) => Uint8Array.of(value));
}

const STREAM = [
  ": a comment line\r\n",
  "event: turn.start\r\n",
  'data: {"turnId":"t1"}\r\n',
  "\r\n",
  "event: message\r",
  'data: {"text":\r',
  'data: "two lines"}\r',
  "\r",
  "event: turn.end\n",
  "data: {}\n",
  "\n",
].join("");
const EXPECTED = [
  { type: "turn.start", data: '{"turnId":"t1"}' },
  { type: "message", data: '{"text":\n"two lines"}' },
  { type: "turn.end", data: "{}" },
];

test("CRLF, CR and LF line ends all frame events", () => {
  assert.deepEqual(parse([STREAM]), EXPECTED);
  // Every byte boundary, including a CR in one chunk and its LF in the next.
  assert.deepEqual(parse(byteByByte(STREAM)), EXPECTED);
  // CRLF-only framing, which a "\n\n" split never dispatched.
  assert.deepEqual(
    parse(["event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n"]),
    [
      { type: "a", data: "1" },
      { type: "b", data: "2" },
    ],
  );
});

test("a CR closing a chunk and the LF opening the next are one line end", () => {
  // Were the LF read as a second line end it would be a blank line, and the
  // first event would dispatch before its data line.
  assert.deepEqual(parse(["event: a\r", "\ndata: 1\r", "\n\r", "\n"]), [
    { type: "a", data: "1" },
  ]);
  // A CR followed by a CR is two line ends, so the event dispatches.
  assert.deepEqual(parse(["data: 1\r", "\r"]), [
    { type: "message", data: "1" },
  ]);
  // An empty chunk between the CR and the LF does not lose the pairing.
  assert.deepEqual(parse(["data: 1\r", new Uint8Array(0), "\n", "\n"]), [
    { type: "message", data: "1" },
  ]);
});

test("a leading BOM is dropped once, and multi-byte characters survive any split", () => {
  const text = "﻿event: x\ndata: héllo ✓ 𝄞\n\n";
  assert.deepEqual(parse(byteByByte(text)), [{ type: "x", data: "héllo ✓ 𝄞" }]);
  const parser = createEventStreamParser();
  assert.deepEqual(parser.push(Uint8Array.of(0xef, 0xbb, 0xbf)), []);
  assert.deepEqual(parser.push(bytes("event: y\ndata: 1\n\n")), [
    { type: "y", data: "1" },
  ]);
  // A second U+FEFF is content, not a BOM: the field is "﻿data".
  assert.deepEqual(parse(["﻿﻿data: 1\n\n"]), []);
});

test("field parsing follows the EventSource algorithm", () => {
  assert.deepEqual(
    parse([
      // Only one leading space is dropped; no colon means an empty value.
      "data:  two spaces\n",
      "data\n",
      "data:no space\n",
      "\n",
    ]),
    [{ type: "message", data: " two spaces\n\nno space" }],
  );
  // Comments and unknown fields are ignored; id and retry change nothing.
  assert.deepEqual(
    parse([
      ":keepalive\n",
      "id: 7\nretry: 10\nfoo: bar\nevent: e\n",
      "data: 1\n\n",
    ]),
    [{ type: "e", data: "1" }],
  );
  // A blank line with no data dispatches nothing and resets the type.
  assert.deepEqual(parse(["event: lost\n\n", "data: 2\n\n"]), [
    { type: "message", data: "2" },
  ]);
  // An empty event name is the default type; a colon in the value stays.
  assert.deepEqual(parse(["event:\ndata: a:b\n\n"]), [
    { type: "message", data: "a:b" },
  ]);
  // An event never closed by a blank line is discarded at the end.
  assert.deepEqual(parse(["data: 1\n\n", "event: open\ndata: 2\n"]), [
    { type: "message", data: "1" },
  ]);
});

/** Reads a Response body to its end, returning its text or the error. */
async function drain(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { text };
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    return { text, error };
  }
}

test("eventStreamResponse frames events the widget's parser reads back", async () => {
  const response = eventStreamResponse([
    { type: "turn.start", turnId: "u1" },
    { type: "message", entry: { content: "line one\r\nline two" } },
  ]);
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  const { text, error } = await drain(response);
  assert.equal(error, undefined);
  assert.deepEqual(
    parse([text]).map((event) => ({ ...event, data: JSON.parse(event.data) })),
    [
      { type: "turn.start", data: { turnId: "u1" } },
      {
        type: "message",
        data: { entry: { content: "line one\r\nline two" } },
      },
    ],
  );
});

test("an invalid item ends the stream and runs the generator's finally", async () => {
  for (const bad of [
    { type: "two words" },
    { notype: true },
    "a string",
    { type: "big", value: 1n },
  ]) {
    const seen = { finally: 0, after: false };
    async function* events() {
      try {
        yield { type: "turn.start", turnId: "u1" };
        yield bad;
        seen.after = true;
      } finally {
        seen.finally++;
      }
    }
    const { text, error } = await drain(eventStreamResponse(events()));
    assert.match(text, /event: turn\.start/);
    assert.equal(error?.code, "INVALID_REQUEST", JSON.stringify(String(bad)));
    // `return()` is asynchronous for an async generator; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(seen.finally, 1);
    assert.equal(seen.after, false);
  }
  // A sync generator is closed too.
  let closed = 0;
  function* sync() {
    try {
      yield { type: "ok" };
      yield { type: "" };
    } finally {
      closed++;
    }
  }
  assert.ok((await drain(eventStreamResponse(sync()))).error);
  assert.equal(closed, 1);
});

test("a throwing next() errors the stream and return() runs exactly once", async () => {
  const calls = { return: 0 };
  let step = 0;
  const iterator = {
    next() {
      if (step++ === 0) return { done: false, value: { type: "ok" } };
      throw new Error("next exploded");
    },
    return() {
      calls.return++;
      throw new Error("return exploded too");
    },
    [Symbol.iterator]() {
      return this;
    },
  };
  const response = eventStreamResponse(iterator);
  const { error } = await drain(response);
  assert.equal(error?.message, "next exploded");
  // The stream is already errored; cancelling it does not close it again.
  await response.body.cancel().catch(() => {});
  assert.equal(calls.return, 1);
});

test("cancel runs return() once and an exhausted iterator is left alone", async () => {
  let finished = 0;
  async function* forever() {
    try {
      for (;;) yield { type: "tick" };
    } finally {
      finished++;
    }
  }
  const response = eventStreamResponse(forever());
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel("stopped");
  await reader.cancel("again").catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(finished, 1);

  let returned = 0;
  const list = [{ type: "only" }];
  const iterator = list[Symbol.iterator]();
  iterator.return = () => {
    returned++;
    return { done: true };
  };
  const { error } = await drain(
    eventStreamResponse({ [Symbol.iterator]: () => iterator }),
  );
  assert.equal(error, undefined);
  assert.equal(returned, 0);
});

test("the bridged access request the README documents is one enable() accepts", () => {
  // `bridge: { arjunah: request }` reaches enable() as { composer, ...request }.
  const documented = {
    level: "completion",
    capabilities: ["context.read"],
    context: ["title", "url"],
    reason: "Answers questions about this page.",
    require: { local: true },
  };
  const accepted = validateAccessRequest({ composer: "server", ...documented });
  assert.deepEqual(accepted.capabilities, [
    "models.list",
    "models.generate",
    "context.read",
  ]);
  assert.deepEqual(accepted.context, ["title", "url"]);
  assert.deepEqual(accepted.require, { local: true });
  assert.equal(accepted.composer, "server");
  // Level 2 with context, and the bare default, are accepted as well.
  assert.ok(
    validateAccessRequest({
      composer: "webapp",
      level: "catalog",
      capabilities: ["context.read"],
      context: ["selection"],
    }).capabilities.includes("models.catalog"),
  );
  assert.ok(validateAccessRequest({ composer: "webapp" }));
  // The shape the types used to allow: context without context.read.
  assert.throws(
    () =>
      validateAccessRequest({
        composer: "server",
        level: "completion",
        context: ["title"],
      }),
    /context fields require context.read/,
  );
});
