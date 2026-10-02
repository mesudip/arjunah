import test from "node:test";
import assert from "node:assert/strict";
import {
  desktopThreadId,
  fromBase64url,
  importInstallKey,
} from "../src/lib/conversations.js";
import { broker } from "./helpers/broker.mjs";

const COMPANION = "http://127.0.0.1:48123";
const TOKEN = "desktop-token-1234567890";
const OTHER = "https://other.test";

/**
 * A paired companion with one thread-capable agent. It records every
 * `/api/generate` body and every thread it was asked to end.
 */
function companion(b, { supportsThreads = true } = {}) {
  const state = { generates: [], ended: [] };
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
            supportsThreads,
            models: [{ id: "sonnet", displayName: "Sonnet" }],
            defaultModel: "sonnet",
          },
        ],
      });
    if (target.pathname === "/api/sync")
      return Response.json({ revision: 0, updatedAt: null, config: null });
    if (target.pathname.startsWith("/api/threads/")) {
      assert.equal(init.method, "DELETE");
      state.ended.push(decodeURIComponent(target.pathname.slice(13)));
      return Response.json({ ended: true });
    }
    if (target.pathname === "/api/generate") {
      state.generates.push(payload);
      return Response.json({
        id: `d${state.generates.length}`,
        message: { role: "assistant", content: "agent answer", toolCalls: [] },
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        thread: Boolean(payload.threadId),
      });
    }
    return new Response("nope", { status: 404 });
  };
  return state;
}

async function setup(t, options) {
  const b = await broker(t);
  const state = companion(b, options);
  await b.ok("desktop.pair", { code: "123456" }, b.extension);
  await b.ok("catalog.default", { model: "claude-code/sonnet" }, b.extension);
  await b.approve(["models.list", "models.generate"]);
  return { b, state };
}

/** What the companion should be told for this origin and conversation. */
async function expectedThread(b, origin, conversation) {
  const key = await importInstallKey(fromBase64url(b.store.installKey));
  return desktopThreadId(key, origin, conversation);
}

const turn = (content) => ({ messages: [{ role: "user", content }] });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a conversation's rounds resume one agent thread; a one-off completion runs fresh", async (t) => {
  const { b, state } = await setup(t);
  const { id } = await b.ok("conversations.create");
  await b.ok("models.generate", { ...turn("first"), conversationId: id });
  await b.ok("models.generate", {
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "agent answer" },
      { role: "user", content: "second" },
    ],
    conversationId: id,
  });
  const [first, second] = state.generates.map((body) => body.threadId);
  assert.ok(first, "the first round names a thread");
  assert.equal(second, first, "the second turn resumes the same thread");
  assert.match(first, /^[A-Za-z0-9_-]{1,100}$/);
  assert.equal(first, await expectedThread(b, "https://site.test", id));
  // The thread is derived, not the conversation id itself, which a page holds.
  assert.notEqual(first, id);
  assert.equal(first.includes(id.split(".")[0]), false);

  await b.ok("models.generate", turn("one-off"));
  assert.equal(
    state.generates.at(-1).threadId,
    undefined,
    "plain models.generate carries no thread id",
  );

  // The same conversation id is refused for another origin, and another
  // origin's own conversation gets a thread of its own.
  b.sessions.set(2, { origin: OTHER, session: "session-2" });
  await b.approve(["models.list", "models.generate"], {}, b.sender(OTHER, 2));
  const foreign = await b.call(
    "models.generate",
    { ...turn("x"), conversationId: id },
    b.sender(OTHER, 2),
  );
  assert.equal(foreign.error.code, "INVALID_REQUEST");
  const theirs = await b.ok("conversations.create", {}, b.sender(OTHER, 2));
  await b.ok(
    "models.generate",
    { ...turn("x"), conversationId: theirs.id },
    b.sender(OTHER, 2),
  );
  assert.notEqual(state.generates.at(-1).threadId, first);
  assert.equal(
    state.generates.at(-1).threadId,
    await expectedThread(b, OTHER, theirs.id),
  );
});

test("release() ends the conversation's agent thread", async (t) => {
  const { b, state } = await setup(t);
  const { id } = await b.ok("conversations.create");
  await b.ok("models.generate", { ...turn("hi"), conversationId: id });
  const thread = state.generates[0].threadId;
  assert.equal(await b.ok("conversations.release", { id }), true);
  await settle();
  assert.deepEqual(state.ended, [thread]);
  // Ending a document ends nothing at the companion: its one-off rounds
  // never had a thread.
  await b.ok("models.generate", turn("one-off"));
  await b.ok("session.end", { generated: true });
  await settle();
  assert.deepEqual(state.ended, [thread]);
});

test("disable() and revoking end only that origin's threads; revoking all ends every one", async (t) => {
  const { b, state } = await setup(t);
  b.sessions.set(2, { origin: OTHER, session: "session-2" });
  await b.approve(["models.list", "models.generate"], {}, b.sender(OTHER, 2));
  const mine = await b.ok("conversations.create");
  const theirs = await b.ok("conversations.create", {}, b.sender(OTHER, 2));
  await b.ok("models.generate", { ...turn("a"), conversationId: mine.id });
  await b.ok(
    "models.generate",
    { ...turn("b"), conversationId: theirs.id },
    b.sender(OTHER, 2),
  );
  const [myThread, theirThread] = state.generates.map((body) => body.threadId);

  await b.ok("grant.revoke"); // the page's own disable()
  await settle();
  assert.deepEqual(state.ended, [myThread]);

  await b.approve(["models.list", "models.generate"]);
  await b.ok("models.generate", { ...turn("c"), conversationId: mine.id });
  await b.ok("grants.revoke", { origin: OTHER }, b.extension);
  await settle();
  assert.deepEqual(state.ended, [myThread, theirThread]);

  await b.ok("grants.clear", {}, b.extension);
  await settle();
  assert.deepEqual(state.ended, [myThread, theirThread, myThread]);
});

test("an agent without thread support runs every round fresh", async (t) => {
  const { b, state } = await setup(t, { supportsThreads: false });
  const { id } = await b.ok("conversations.create");
  await b.ok("models.generate", { ...turn("hi"), conversationId: id });
  assert.equal(state.generates[0].threadId, undefined);
  await b.ok("grant.revoke");
  await settle();
  assert.deepEqual(state.ended, []);
});
