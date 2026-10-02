import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { broker } from "./helpers/broker.mjs";
import { BrokerError, publicError } from "../src/lib/errors.js";

const ask = { messages: [{ role: "user", content: "hi" }] };

/**
 * A provider request that hangs until its signal aborts, the way a real fetch
 * of a slow model does. `seen` holds the signal so a test can check that the
 * HTTP request itself was cancelled, not just the promise above it.
 */
function hangingProvider(b) {
  const seen = {};
  seen.started = new Promise((resolve) => {
    b.hooks.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        seen.signal = init.signal;
        resolve();
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
  });
  return seen;
}

test("a page cancel ends its own generate with ABORTED and aborts the provider fetch", async (t) => {
  const b = await broker(t);
  await b.approve(["models.generate"]);
  const seen = hangingProvider(b);
  const pending = b.call("models.generate", { ...ask, _request: "req-1" });
  await seen.started;
  assert.equal(seen.signal.aborted, false);

  // Another tab, another document of the same tab, or another id: none of
  // them reaches this request.
  b.sessions.set(2, { origin: "https://site.test", session: "session-2" });
  assert.equal(
    await b.ok("models.cancel", { request: "req-1" }, b.sender(undefined, 2)),
    false,
  );
  assert.equal(
    await b.ok("models.cancel", { request: "req-1", _session: "other" }),
    false,
  );
  assert.equal(await b.ok("models.cancel", { request: "req-2" }), false);
  assert.equal(
    (await b.call("models.cancel", { request: "../x" })).error.code,
    "INVALID_REQUEST",
  );
  assert.equal(seen.signal.aborted, false);

  assert.equal(await b.ok("models.cancel", { request: "req-1" }), true);
  const response = await pending;
  assert.equal(seen.signal.aborted, true, "the provider request was cancelled");
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "ABORTED");
  assert.equal(response.error.details.retryable, false);
  // The id the page sees in `details.requestId` is in the log line too.
  const { entries } = await b.ok("logs.get", {}, b.extension);
  assert.ok(
    entries.some((entry) =>
      /models\.generate req-1 cancelled by the page/.test(entry.message),
    ),
  );
  assert.ok(
    entries.some((entry) =>
      /models\.generate req-1 failed \(ABORTED\)/.test(entry.message),
    ),
  );
  // Once settled, the id names nothing.
  assert.equal(await b.ok("models.cancel", { request: "req-1" }), false);
});

test("revocation, navigation, and a model change mid-request stay PERMISSION_REQUIRED", async (t) => {
  for (const end of [
    (b) => b.ok("grant.revoke"),
    (b) => b.ok("session.end", {}),
    (b) =>
      b.ok(
        "site.update",
        { origin: "https://site.test", model: "openai/gpt-5.6-terra" },
        b.extension,
      ),
  ]) {
    const b = await broker(t);
    await b.approve(["models.generate"]);
    const seen = hangingProvider(b);
    const pending = b.call("models.generate", { ...ask, _request: "req-1" });
    await seen.started;
    await end(b);
    const response = await pending;
    assert.equal(seen.signal.aborted, true);
    // The provider fetch reports an abort as TIMEOUT in its own words; who
    // aborted it decides the code the page sees.
    assert.equal(response.error.code, "PERMISSION_REQUIRED");
    assert.equal(response.error.details.retryable, false);
  }
});

test("a page that stops waiting leaves an orphaned request that ends as TIMEOUT", async (t) => {
  const b = await broker(t);
  await b.approve(["models.generate"]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seen = hangingProvider(b);
  const pending = b.call("models.generate", { ...ask, _request: "req-1" });
  await seen.started;
  t.mock.timers.tick(179_999);
  assert.equal(seen.signal.aborted, false);
  t.mock.timers.tick(1);
  const response = await pending;
  assert.equal(seen.signal.aborted, true);
  assert.equal(response.error.code, "TIMEOUT");
  assert.equal(response.error.details.retryable, true);
});

test("a provider's own timeout is TIMEOUT, not a cancellation", async (t) => {
  const b = await broker(t);
  await b.approve(["models.generate"]);
  b.hooks.fetch = async () => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  };
  const response = await b.call("models.generate", ask);
  assert.equal(response.error.code, "TIMEOUT");
  assert.equal(response.error.details.retryable, true);
});

test("every broker error carries a JSON-safe details object with retryable", () => {
  assert.deepEqual(
    publicError(new BrokerError("INVALID_REQUEST", "bad", { field: "x" }))
      .details,
    { field: "x", retryable: false },
  );
  assert.deepEqual(
    publicError(new BrokerError("RATE_LIMITED", "wait", { retryAfterMs: 5 }))
      .details,
    { retryAfterMs: 5, retryable: true },
  );
  assert.deepEqual(
    publicError(
      new BrokerError("PROVIDER_ERROR", "5xx", undefined, { retryable: true }),
    ).details,
    { retryable: true },
  );
  // Anything that is not a broker error says nothing about itself.
  const hidden = publicError(new Error("secret stack /Users/me"));
  assert.equal(hidden.code, "INTERNAL_ERROR");
  assert.deepEqual(hidden.details, { retryable: false });
  assert.equal(JSON.stringify(hidden).includes("secret"), false);
  for (const code of [
    "ABORTED",
    "CONTEXT_TOO_LONG",
    "RATE_LIMITED",
    "MODEL_UNAVAILABLE",
  ])
    assert.equal(new BrokerError(code, "x").code, code);
  assert.equal(new BrokerError("SOMETHING_NEW", "x").code, "INTERNAL_ERROR");
});

/**
 * Runs the real page-api.js against a window whose other side is played by
 * the test, standing in for the content script.
 */
function pageWorld() {
  const nonce = "nonce-1";
  const win = new EventTarget();
  const posted = [];
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
    console,
  });
  vm.runInContext(readFileSync("src/page-api.js", "utf8"), context);
  const answer = (request, payload) =>
    win.postMessage({
      channel: request.channel,
      direction: "extension-to-page",
      nonce,
      kind: "response",
      id: request.id,
      ...payload,
    });
  // `enable` answers with a grant so the test holds a session.
  reply = (message) => {
    if (message.kind === "request" && message.method === "enable")
      answer(message, { ok: true, result: { origin: "https://site.test" } });
  };
  return {
    api: win.ai.arjunah,
    posted,
    nonce,
    answer,
    onRequest(fn) {
      reply = fn;
    },
  };
}

test("page API: an already-aborted signal rejects ABORTED and posts nothing", async () => {
  const world = pageWorld();
  const session = await world.api.enable();
  const before = world.posted.length;
  const controller = new AbortController();
  controller.abort();
  const error = await session.models
    .generate(ask, { signal: controller.signal })
    .catch((thrown) => thrown);
  assert.equal(error.name, "AIError");
  assert.equal(error.code, "ABORTED");
  assert.equal(typeof error.details.requestId, "string");
  assert.equal(error.details.retryable, false);
  assert.equal(world.posted.length, before);
  // A value that is not a signal is refused before anything is sent.
  const invalid = await session.models
    .generate(ask, { signal: "stop" })
    .catch((thrown) => thrown);
  assert.equal(invalid.code, "INVALID_REQUEST");
  assert.equal(world.posted.length, before);
});

test("page API: aborting in flight posts a cancel for that id and rejects at once", async () => {
  const world = pageWorld();
  const session = await world.api.enable();
  let request = null;
  world.onRequest((message) => {
    if (message.kind === "request") request = message;
  });
  const controller = new AbortController();
  const pending = session.models.generate(ask, { signal: controller.signal });
  assert.equal(request.method, "models.generate");
  controller.abort();
  const error = await pending.catch((thrown) => thrown);
  assert.equal(error.code, "ABORTED");
  assert.equal(error.details.requestId, request.id);
  const cancel = world.posted.at(-1);
  // Same channel, direction, and nonce as the request it names.
  assert.deepEqual(cancel, {
    channel: request.channel,
    direction: "page-to-extension",
    nonce: world.nonce,
    kind: "cancel",
    id: request.id,
  });
  // A late answer for the cancelled id is ignored, and a second abort sends
  // nothing more.
  world.answer(request, { ok: true, result: { id: "late" } });
  controller.abort();
  assert.equal(world.posted.at(-1), cancel);
});

test("page API: an extension error keeps its details, request id included", async () => {
  const world = pageWorld();
  const session = await world.api.enable();
  world.onRequest((message) => {
    if (message.kind === "request")
      world.answer(message, {
        ok: false,
        error: {
          code: "RATE_LIMITED",
          message: "Try again later.",
          details: {
            retryAfterMs: 2000,
            retryable: true,
            requestId: message.id,
          },
        },
      });
  });
  const controller = new AbortController();
  const error = await session.models
    .generate(ask, { signal: controller.signal })
    .catch((thrown) => thrown);
  assert.equal(error.code, "RATE_LIMITED");
  assert.equal(error.details.retryAfterMs, 2000);
  assert.equal(typeof error.details.requestId, "string");
  // Settled requests drop their abort listener: aborting later sends nothing.
  const count = world.posted.length;
  controller.abort();
  assert.equal(world.posted.length, count);
});
