import test from "node:test";
import assert from "node:assert/strict";
import { broker, toolReply } from "./helpers/broker.mjs";

/**
 * Broker behaviour for the hosted surfaces: declared remote tools (7.7), transcript cards
 * (7.4) reaching the widget but not the model, and site-supplied history (7.6)
 * arriving marked as untrusted.
 */

const declaredServer = {
  id: "backend",
  url: "https://api.site.test/mcp",
  tools: [
    {
      name: "quote",
      description: "Price a trip on the site's own server",
      inputSchema: { type: "object", additionalProperties: false },
    },
  ],
};

function mcpCallMock(calls) {
  return async (_url, _init, request) => {
    if (!request.method)
      return Response.json({ choices: [{ message: { content: "done" } }] });
    if (request.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    calls.push(request);
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result:
        request.method === "initialize"
          ? { protocolVersion: "2025-03-26" }
          : { content: [{ type: "text", text: "420 USD" }] },
    });
  };
}

test("declared remote tools skip discovery and need only the contract approval", async (t) => {
  const b = await broker(t);
  const manifest = { name: "Trips", mcpServers: [declaredServer] };
  const reg = await b.register(manifest);
  const capabilities = ["chat.hosted", "tools.mcp"];
  await b.approve(capabilities, {
    registrationId: reg.id,
    _resources: {
      contractFingerprint: reg.fingerprint,
      mcpOrigins: ["https://api.site.test"],
    },
  });
  const calls = [];
  b.hooks.fetch = mcpCallMock(calls);
  const prep = await b.ok("chat.prepare", {
    manifest,
    registrationId: reg.id,
  });
  // The definitions came from the contract, so nothing was discovered and the
  // second consent stage does not apply.
  assert.equal(prep.declaredOnly, true);
  assert.equal(prep.tools[0].name, "quote");
  assert.equal(
    prep.tools[0].description,
    "Price a trip on the site's own server",
  );
  assert.equal(calls.filter((call) => call.method === "tools/list").length, 0);

  b.hooks.fetch = async (url, init, request) => {
    if (!request.method)
      return b.requests.filter((item) => !item.payload.method).length === 1
        ? toolReply("mcp_backend__quote")
        : Response.json({ choices: [{ message: { content: "done" } }] });
    return mcpCallMock(calls)(url, init, request);
  };
  await b.ok("chat.complete", {
    preparedId: prep.id,
    fingerprint: reg.fingerprint,
    registrationId: reg.id,
    history: [{ role: "user", content: "how much?" }],
    conversationId: "conv-1",
  });
  const call = calls.find((item) => item.method === "tools/call");
  assert.ok(call, "the declared tool was called");
  assert.equal(call.params.name, "quote");
  // The backend can correlate the call without the page taking part.
  assert.deepEqual(call.params._meta, {
    arjunah: { conversationId: "conv-1" },
  });
});

test("a changed tool declaration requires fresh consent before the next turn", async (t) => {
  const b = await broker(t);
  const manifest = { name: "Trips", mcpServers: [declaredServer] };
  const reg = await b.register(manifest);
  await b.approve(["chat.hosted", "tools.mcp"], {
    registrationId: reg.id,
    _resources: {
      contractFingerprint: reg.fingerprint,
      mcpOrigins: ["https://api.site.test"],
    },
  });
  b.hooks.fetch = mcpCallMock([]);
  await b.ok("chat.prepare", { manifest, registrationId: reg.id });
  // Re-declaring the same tool with different semantics is a different
  // contract, so the earlier approval no longer covers it.
  const changed = {
    name: "Trips",
    mcpServers: [
      {
        ...declaredServer,
        tools: [{ ...declaredServer.tools[0], description: "Charge the card" }],
      },
    ],
  };
  const reg2 = await b.register(changed);
  assert.notEqual(reg.fingerprint, reg2.fingerprint);
  const response = await b.call("chat.prepare", {
    manifest: changed,
    registrationId: reg2.id,
  });
  assert.equal(response.error.code, "PERMISSION_REQUIRED");
});

test("a card reaches the widget but never the model", async (t) => {
  const b = await broker(t);
  const card = {
    type: "card",
    id: "seatmap",
    children: [
      { type: "text", text: "Seat 12A" },
      {
        type: "button",
        label: "Book",
        action: { type: "message", text: "Book 12A" },
      },
    ],
  };
  b.hooks.tool = async () => ({
    kind: "content",
    content: [
      { type: "text", text: "One window seat is free: 12A." },
      { type: "card", card },
    ],
  });
  const events = [];
  const tabs = globalThis.chrome.tabs;
  const originalSend = tabs.sendMessage;
  tabs.sendMessage = async (tabId, message, options) => {
    if (message.kind === "arjunah-progress") {
      events.push(message);
      return { ok: true };
    }
    return originalSend(tabId, message, options);
  };
  t.after(() => {
    tabs.sendMessage = originalSend;
  });
  const params = await b.prepare({
    name: "Seats",
    tools: [
      {
        name: "seatmap",
        inputSchema: { type: "object" },
        outputContent: ["text", "card"],
      },
    ],
  });
  let round = 0;
  b.hooks.fetch = async () =>
    round++ === 0
      ? toolReply("site__seatmap")
      : Response.json({ choices: [{ message: { content: "Booked." } }] });
  await b.ok("chat.complete", { ...params, turnId: "turn-1" });
  const end = events.find((event) => event.type === "tool.end");
  assert.deepEqual(end.card, card);
  assert.equal(end.result, "One window seat is free: 12A.");
  const toolMessages = b.requests
    .filter((item) => !item.payload.method)
    .flatMap((item) => item.payload.messages)
    .filter((message) => message.role === "tool");
  assert.equal(toolMessages.length, 1);
  assert.equal(toolMessages[0].content, "One window seat is free: 12A.");
  // Nothing the model received mentions the card.
  assert.ok(
    !b.requests
      .filter((item) => !item.payload.method)
      .some((item) => JSON.stringify(item.payload).includes('"type":"card"')),
  );
});

test("site-supplied history is labelled untrusted before the model sees it", async (t) => {
  const b = await broker(t);
  const params = await b.prepare({ name: "Stored", threads: {} });
  await b.ok("chat.complete", {
    ...params,
    history: [
      { role: "user", content: "earlier question" },
      { role: "assistant", content: "earlier answer" },
      { role: "user", content: "new question" },
    ],
    untrustedPrefix: 2,
  });
  const messages = b.requests.at(-1).payload.messages;
  const marker = messages.findIndex((message) =>
    String(message.content).includes("supplied by the website"),
  );
  assert.ok(marker >= 0, "the untrusted marker is present");
  assert.equal(messages[marker + 1].content, "earlier question");
  assert.equal(messages[marker + 2].content, "earlier answer");
  assert.ok(
    String(messages[marker + 3].content).includes(
      "End of the website-supplied",
    ),
  );
  assert.equal(messages.at(-1).content, "new question");
});

test("without a site store the history carries no untrusted marker", async (t) => {
  const b = await broker(t);
  const params = await b.prepare({ name: "Plain" });
  await b.ok("chat.complete", { ...params, untrustedPrefix: 0 });
  assert.ok(
    !b.requests
      .at(-1)
      .payload.messages.some((message) =>
        String(message.content).includes("supplied by the website"),
      ),
  );
});
