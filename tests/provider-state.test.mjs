import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { broker } from "./helpers/broker.mjs";
import { generate } from "../src/lib/provider.js";
import {
  PROVIDER_STATE,
  createProviderStateStore,
  memoryBackend,
} from "../src/lib/provider-state.js";
import {
  importInstallKey,
  mintConversationId,
  verifyConversationId,
} from "../src/lib/conversations.js";

// Provider state between the rounds of a page-composed tool turn (SPEC 5.4),
// tested against each wire format that carries it.

const ZEN = "https://opencode.ai/zen/v1";
const MODELS = {
  anthropic: "opencode-api/claude-sonnet-4-6",
  gemini: "opencode-api/gemini-3.1-pro",
  responses: "opencode-api/gpt-5.6-luna",
};
const tools = [
  {
    name: "get_weather",
    description: "Weather for a city.",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      additionalProperties: false,
    },
  },
];
const ask = { role: "user", content: "Weather in Kathmandu?" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

async function zen(t) {
  const b = await broker(t);
  b.store.opencode = {
    baseUrl: ZEN,
    apiKey: "zen-secret",
    model: "claude-sonnet-4-6",
    models: [
      "claude-sonnet-4-6",
      "claude-opus-4-6",
      "gemini-3.1-pro",
      "gpt-5.6-luna",
    ],
    tier: "paid",
  };
  await b.approve(["models.list", "models.generate", "models.catalog"]);
  return b;
}

/**
 * A conversation minted for the sender. The requests below are what its
 * handle sends on the bridge: the ordinary request plus `conversationId`.
 */
async function conversation(b, sender) {
  return (await b.ok("conversations.create", {}, sender)).id;
}

/** The assistant message and tool result a page sends back for round 2. */
function continued(result, extra = []) {
  return [
    ask,
    {
      role: "assistant",
      content: result.message.content,
      toolCalls: result.message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    },
    ...result.message.toolCalls.map((call) => ({
      role: "tool",
      toolCallId: call.id,
      content: '{"tempC":21}',
    })),
    ...extra,
  ];
}

const SIGNATURE = "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds";
const REDACTED =
  "EmwKAhgBEgy3va3pzix/LafPsn4aDFIT2Xlxh0L5L8rLVyIwxtE3rAFBa8cr3qpP";
const THINKING = {
  type: "thinking",
  thinking: "The user wants the weather, so I call the tool.",
  signature: SIGNATURE,
};

function anthropicTurn(b, { final = "It is 21C." } = {}) {
  let round = 0;
  b.hooks.fetch = async (url, _init, payload) => {
    assert.equal(url, `${ZEN}/messages`);
    // A request that ends in tool results continues the turn; one that ends
    // in the user's own words starts one.
    const continuing =
      payload.messages.at(-1).content.at(-1).type === "tool_result";
    round++;
    return Response.json(
      continuing
        ? {
            id: `msg_${round}`,
            content: [{ type: "text", text: final }],
            stop_reason: "end_turn",
            usage: { input_tokens: 9, output_tokens: 3 },
          }
        : {
            id: `msg_${round}`,
            content: [
              THINKING,
              { type: "redacted_thinking", data: REDACTED },
              { type: "text", text: "Checking." },
              {
                type: "tool_use",
                id: `toolu_${round}`,
                name: "get_weather",
                input: { city: "Kathmandu" },
              },
            ],
            stop_reason: "tool_use",
            usage: { input_tokens: 7, output_tokens: 5 },
          },
    );
  };
}

test("Anthropic: signed thinking from round 1 goes back byte-for-byte with the same call ids", async (t) => {
  const b = await zen(t);
  const id = await conversation(b);
  anthropicTurn(b);
  const first = await b.ok("models.generate", {
    model: MODELS.anthropic,
    conversationId: id,
    messages: [ask],
    tools,
  });
  assert.equal(first.providerState, "none");
  assert.deepEqual(
    first.message.toolCalls.map((call) => call.id),
    ["toolu_1"],
  );
  // The signature and the redacted block never reach the page.
  const shown = JSON.stringify(first);
  assert.equal(shown.includes(SIGNATURE), false);
  assert.equal(shown.includes(REDACTED), false);
  assert.equal("rawMessage" in first, false);
  assert.equal(b.providerState.records.size, 1);
  const [record] = b.providerState.records.values();
  assert.equal(record.origin, "https://site.test");
  assert.equal(record.conversationKey, id);
  assert.deepEqual(record.callIds, ["toolu_1"]);
  assert.equal(record.model, MODELS.anthropic);
  assert.equal(record.providerId, "opencode-api");
  assert.match(record.revision, /^[0-9a-f]{64}$/);
  assert.equal(
    JSON.stringify(record).includes("zen-secret"),
    false,
    "the key itself is never stored",
  );

  const second = await b.ok("models.generate", {
    model: MODELS.anthropic,
    conversationId: id,
    messages: continued(first),
    tools,
  });
  assert.equal(second.providerState, "reused");
  assert.equal(second.message.content, "It is 21C.");
  const wire = b.requests.at(-1);
  const assistant = wire.payload.messages[1];
  assert.equal(assistant.role, "assistant");
  assert.deepEqual(assistant.content.slice(0, 2), [
    THINKING,
    { type: "redacted_thinking", data: REDACTED },
  ]);
  assert.deepEqual(assistant.content.slice(2), [
    { type: "text", text: "Checking." },
    {
      type: "tool_use",
      id: "toolu_1",
      name: "get_weather",
      input: { city: "Kathmandu" },
    },
  ]);
  // Byte-for-byte on the wire, not just structurally equal.
  assert.ok(wire.init.body.includes(JSON.stringify(THINKING)));
  // The final round ended the turn, and with it the turn's state.
  assert.equal(b.providerState.records.size, 0);
});

test("Gemini: thought signatures return on the function-call parts, long ones included", async (t) => {
  const b = await zen(t);
  const id = await conversation(b);
  // Longer than `signatureChars`, which the hosted path's own copy drops.
  const signature = `CiQB${"x".repeat(9_000)}`;
  b.hooks.fetch = async (url, _init, payload) => {
    assert.match(url, /\/models\/gemini-3\.1-pro:generateContent$/);
    const continuing = payload.contents.some((content) =>
      content.parts.some((part) => part.functionResponse),
    );
    return Response.json(
      continuing
        ? {
            candidates: [
              { content: { parts: [{ text: "21C" }] }, finishReason: "STOP" },
            ],
          }
        : {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    { text: "Thinking about it.", thought: true },
                    {
                      thoughtSignature: signature,
                      functionCall: {
                        id: "call_a",
                        name: "get_weather",
                        args: { city: "Kathmandu" },
                      },
                    },
                    // Parallel calls: only the first carries a signature.
                    {
                      functionCall: {
                        id: "call_b",
                        name: "get_weather",
                        args: { city: "Pokhara" },
                      },
                    },
                  ],
                },
                finishReason: "STOP",
              },
            ],
          },
    );
  };
  const first = await b.ok("models.generate", {
    model: MODELS.gemini,
    conversationId: id,
    messages: [ask],
    tools,
  });
  assert.equal(first.providerState, "none");
  assert.deepEqual(
    first.message.toolCalls.map((call) => call.id),
    ["call_a", "call_b"],
  );
  assert.equal(JSON.stringify(first).includes(signature), false);

  const second = await b.ok("models.generate", {
    model: MODELS.gemini,
    conversationId: id,
    messages: continued(first),
    tools,
  });
  assert.equal(second.providerState, "reused");
  const wire = b.requests.at(-1);
  const modelTurn = wire.payload.contents.find(
    (content) => content.role === "model",
  );
  assert.deepEqual(
    modelTurn.parts.map((part) => [
      part.functionCall?.id,
      part.thoughtSignature ?? null,
    ]),
    [
      ["call_a", signature],
      ["call_b", null],
    ],
  );
  assert.ok(wire.init.body.includes(JSON.stringify(signature)));
});

const REASONING = {
  type: "reasoning",
  id: "rs_1",
  summary: [{ type: "summary_text", text: "Need the weather tool." }],
  encrypted_content: "gAAAAABpZ3J5cHRlZC1yZWFzb25pbmctYmxvYg==",
};

test("Responses: encrypted reasoning items are requested, kept, and replayed in their place", async (t) => {
  const b = await zen(t);
  const id = await conversation(b);
  b.hooks.fetch = async (url, _init, payload) => {
    assert.equal(url, `${ZEN}/responses`);
    assert.equal(payload.store, false);
    assert.deepEqual(payload.include, ["reasoning.encrypted_content"]);
    const continuing = payload.input.some(
      (item) => item.type === "function_call_output",
    );
    return Response.json(
      continuing
        ? {
            id: "resp_2",
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "21C." }],
              },
            ],
          }
        : {
            id: "resp_1",
            status: "completed",
            output: [
              REASONING,
              {
                type: "function_call",
                id: "fc_1",
                call_id: "call_1",
                name: "get_weather",
                arguments: '{"city":"Kathmandu"}',
                status: "completed",
              },
            ],
          },
    );
  };
  const first = await b.ok("models.generate", {
    model: MODELS.responses,
    conversationId: id,
    messages: [ask],
    tools,
  });
  assert.equal(first.providerState, "none");
  assert.equal(
    JSON.stringify(first).includes(REASONING.encrypted_content),
    false,
  );
  const second = await b.ok("models.generate", {
    model: MODELS.responses,
    conversationId: id,
    messages: continued(first),
    tools,
  });
  assert.equal(second.providerState, "reused");
  const wire = b.requests.at(-1);
  assert.deepEqual(wire.payload.input.slice(1), [
    REASONING,
    {
      id: "fc_1",
      type: "function_call",
      call_id: "call_1",
      name: "get_weather",
      arguments: '{"city":"Kathmandu"}',
    },
    {
      type: "function_call_output",
      call_id: "call_1",
      output: '{"tempC":21}',
    },
  ]);
  assert.ok(wire.init.body.includes(JSON.stringify(REASONING)));
});

test("state goes back only to the model and the key revision that issued it", async (t) => {
  const b = await zen(t);
  const id1 = await conversation(b);
  const id2 = await conversation(b);
  anthropicTurn(b);
  const first = await b.ok("models.generate", {
    model: MODELS.anthropic,
    conversationId: id1,
    messages: [ask],
    tools,
  });
  // Another model of the same provider and wire format.
  const other = await b.ok("models.generate", {
    model: "opencode-api/claude-opus-4-6",
    conversationId: id1,
    messages: continued(first),
    tools,
  });
  assert.equal(other.providerState, "none");
  assert.equal(
    b.requests.at(-1).init.body.includes(SIGNATURE),
    false,
    "another model never receives the state",
  );

  const again = await b.ok("models.generate", {
    model: MODELS.anthropic,
    conversationId: id2,
    messages: [ask],
    tools,
  });
  b.store.opencode = { ...b.store.opencode, apiKey: "zen-rotated" };
  const rotated = await b.ok("models.generate", {
    model: MODELS.anthropic,
    conversationId: id2,
    messages: continued(again),
    tools,
  });
  assert.equal(rotated.providerState, "none");
  assert.equal(b.requests.at(-1).init.body.includes(SIGNATURE), false);
  assert.equal(b.requests.at(-1).init.headers["x-api-key"], "zen-rotated");
});

test("a mismatched entry is dropped rather than kept for later", async (t) => {
  const b = await zen(t);
  const id = await conversation(b);
  anthropicTurn(b);
  const first = await b.ok("models.generate", {
    model: MODELS.anthropic,
    conversationId: id,
    messages: [ask],
    tools,
  });
  // A round on another model that itself ends in a tool call stores nothing
  // of its own (no thinking), so only the lookup could have removed it.
  b.hooks.fetch = async () =>
    Response.json({
      content: [
        { type: "tool_use", id: "toolu_9", name: "get_weather", input: {} },
      ],
      stop_reason: "tool_use",
    });
  await b.ok("models.generate", {
    model: "opencode-api/claude-opus-4-6",
    conversationId: id,
    messages: continued(first),
    tools,
  });
  assert.equal(b.providerState.records.size, 0);
});

test("a new user message starts a new turn: earlier assistant messages get no state", async (t) => {
  const b = await zen(t);
  const id = await conversation(b);
  anthropicTurn(b);
  const first = await b.ok("models.generate", {
    model: MODELS.anthropic,
    conversationId: id,
    messages: [ask],
    tools,
  });
  const next = await b.ok("models.generate", {
    model: MODELS.anthropic,
    conversationId: id,
    messages: continued(first, [{ role: "user", content: "And tomorrow?" }]),
    tools,
  });
  assert.equal(next.providerState, "none");
  assert.equal(b.requests.at(-1).init.body.includes(SIGNATURE), false);
  // That round called a tool again, so the store holds its state and has let
  // go of the previous turn's.
  assert.deepEqual(
    [...b.providerState.records.values()].map((record) => record.callIds),
    [["toolu_2"]],
  );
});

test("every round of the turn keeps its state until the turn ends", async (t) => {
  const b = await zen(t);
  const id = await conversation(b);
  let round = 0;
  b.hooks.fetch = async (_url, _init, payload) => {
    round++;
    const results = payload.messages
      .flatMap((message) => message.content)
      .filter((part) => part.type === "tool_result").length;
    return Response.json(
      results < 2
        ? {
            content: [
              { ...THINKING, signature: `${SIGNATURE}-${round}` },
              {
                type: "tool_use",
                id: `toolu_${round}`,
                name: "get_weather",
                input: {},
              },
            ],
            stop_reason: "tool_use",
          }
        : {
            content: [{ type: "text", text: "done" }],
            stop_reason: "end_turn",
          },
    );
  };
  const r1 = await b.ok("models.generate", {
    model: MODELS.anthropic,
    conversationId: id,
    messages: [ask],
    tools,
  });
  const messages2 = continued(r1);
  const r2 = await b.ok("models.generate", {
    model: MODELS.anthropic,
    conversationId: id,
    messages: messages2,
    tools,
  });
  assert.equal(r2.providerState, "reused");
  assert.equal(b.providerState.records.size, 2);
  const messages3 = [...continued(r2).slice(1)];
  const r3 = await b.ok("models.generate", {
    model: MODELS.anthropic,
    conversationId: id,
    messages: [...messages2, ...messages3],
    tools,
  });
  assert.equal(r3.providerState, "reused");
  // Both earlier rounds' thinking went back, each with its own message.
  const body = b.requests.at(-1).init.body;
  assert.ok(body.includes(`${SIGNATURE}-1`));
  assert.ok(body.includes(`${SIGNATURE}-2`));
  assert.equal(b.providerState.records.size, 0);
});

test("conversations are scoped by origin and by id; release and revocation clear them", async (t) => {
  const b = await zen(t);
  anthropicTurn(b);
  const shared = await conversation(b);
  const first = await b.ok("models.generate", {
    model: MODELS.anthropic,
    conversationId: shared,
    messages: [ask],
    tools,
  });
  // Another origin cannot even use the id, let alone its state.
  b.sessions.set(2, { origin: "https://other.test", session: "session-2" });
  const otherSender = b.sender("https://other.test", 2);
  await b.approve(
    ["models.list", "models.generate", "models.catalog"],
    {},
    otherSender,
  );
  const sent = b.requests.length;
  const foreign = await b.call(
    "models.generate",
    {
      model: MODELS.anthropic,
      conversationId: shared,
      messages: continued(first),
      tools,
    },
    otherSender,
  );
  assert.equal(foreign.error.code, "INVALID_REQUEST");
  assert.equal(b.requests.length, sent, "no provider request was made");
  // Nor does another conversation of the same origin find it.
  const elsewhere = await b.ok("models.generate", {
    model: MODELS.anthropic,
    conversationId: await conversation(b),
    messages: continued(first),
    tools,
  });
  assert.equal(elsewhere.providerState, "none");

  anthropicTurn(b);
  const kept = await conversation(b);
  await b.ok("models.generate", {
    model: MODELS.anthropic,
    conversationId: kept,
    messages: [ask],
    tools,
  });
  const conversations = () =>
    [...b.providerState.records.values()]
      .map((record) => record.conversationKey)
      .sort();
  assert.deepEqual(conversations(), [kept, shared].sort());
  // Releasing through the other origin is refused and changes nothing.
  assert.equal(
    (await b.call("conversations.release", { id: shared }, otherSender)).error
      .code,
    "INVALID_REQUEST",
  );
  assert.equal(await b.ok("conversations.release", { id: shared }), true);
  // A conversation that never kept anything releases just the same.
  assert.equal(
    await b.ok("conversations.release", { id: await conversation(b) }),
    true,
  );
  assert.deepEqual(conversations(), [kept]);
  // disable() is grant.revoke for this origin.
  assert.equal(await b.ok("grant.revoke"), true);
  assert.deepEqual(conversations(), []);
  for (const method of [
    "conversations.create",
    "conversations.open",
    "conversations.release",
  ])
    assert.equal(
      (await b.call(method, { id: kept })).error.code,
      "PERMISSION_REQUIRED",
      `${method} needs models.generate`,
    );
});

test("revoking one site from settings, or all of them, deletes their state", async (t) => {
  const b = await zen(t);
  b.sessions.set(2, { origin: "https://other.test", session: "session-2" });
  const otherSender = b.sender("https://other.test", 2);
  await b.approve(
    ["models.list", "models.generate", "models.catalog"],
    {},
    otherSender,
  );
  for (const sender of [b.sender(), otherSender]) {
    anthropicTurn(b);
    await b.ok(
      "models.generate",
      {
        model: MODELS.anthropic,
        conversationId: await conversation(b, sender),
        messages: [ask],
        tools,
      },
      sender,
    );
  }
  assert.equal(b.providerState.records.size, 2);
  await b.ok("grants.revoke", { origin: "https://other.test" }, b.extension);
  assert.deepEqual(
    [...b.providerState.records.values()].map((record) => record.origin),
    ["https://site.test"],
  );
  await b.ok("grants.clear", {}, b.extension);
  assert.equal(b.providerState.records.size, 0);
});

test("settings report stored state from index keys and clearing it rotates the install key", async (t) => {
  const b = await zen(t);
  b.sessions.set(2, { origin: "https://other.test", session: "session-2" });
  const otherSender = b.sender("https://other.test", 2);
  await b.approve(
    ["models.list", "models.generate", "models.catalog"],
    {},
    otherSender,
  );
  const ids = [];
  const firsts = [];
  for (const sender of [b.sender(), otherSender]) {
    anthropicTurn(b);
    const id = await conversation(b, sender);
    ids.push(id);
    firsts.push(
      await b.ok(
        "models.generate",
        { model: MODELS.anthropic, conversationId: id, messages: [ask], tools },
        sender,
      ),
    );
  }
  // A one-off completion's state is keyed by its document, not by an id.
  anthropicTurn(b);
  const oneOff = await b.ok("models.generate", {
    model: MODELS.anthropic,
    messages: [ask],
    tools,
  });
  assert.equal(b.providerState.records.size, 3);
  const sizes = [...b.providerState.records.values()].map(
    (record) => record.bytes,
  );
  const report = await b.ok("grants.storedState", {}, b.extension);
  assert.equal(report.entries, 3);
  assert.equal(
    report.bytes,
    sizes.reduce((sum, bytes) => sum + bytes, 0),
  );
  assert.equal(report.origins["https://site.test"].entries, 2);
  assert.equal(report.origins["https://other.test"].entries, 1);
  assert.equal(report.threads, 0);
  assert.equal(
    JSON.stringify(report).includes(SIGNATURE),
    false,
    "the report never carries stored state",
  );

  // Settings only: neither a page nor the popup may read or clear it.
  for (const method of ["grants.storedState", "grants.clearState"]) {
    assert.equal(
      (await b.call(method, {})).error.code,
      "PERMISSION_REQUIRED",
      `${method} from a page`,
    );
    assert.equal(
      (
        await b.call(
          method,
          {},
          {
            url: "chrome-extension://test/popup.html",
          },
        )
      ).error.code,
      "PERMISSION_REQUIRED",
      `${method} from the popup`,
    );
    assert.equal(
      (
        await b.call(
          method,
          {},
          {
            url: "https://site.test/options.html",
            frameId: 0,
            tab: { id: 1, url: "https://site.test/options.html" },
          },
        )
      ).error.code,
      "PERMISSION_REQUIRED",
      `${method} from a page named like the options page`,
    );
  }
  assert.equal(
    b.providerState.records.size,
    3,
    "refused calls cleared nothing",
  );

  const key = b.store.installKey;
  const cleared = await b.ok("grants.clearState", {}, b.extension);
  assert.deepEqual(cleared.cleared, {
    entries: 3,
    bytes: report.bytes,
    threads: 0,
  });
  assert.equal(cleared.entries, 0);
  assert.equal(b.providerState.records.size, 0);
  assert.match(b.store.installKey, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(b.store.installKey, key, "the install key was rotated");
  // Grants and provider keys are untouched.
  assert.ok(b.store.grants["https://site.test"]);
  assert.ok(b.store.grants["https://other.test"]);
  assert.equal(b.store.opencode.apiKey, "zen-secret");

  // Every id minted before is refused, for every use, on every origin.
  const sent = b.requests.length;
  for (const [index, sender] of [b.sender(), otherSender].entries()) {
    for (const method of ["conversations.open", "conversations.release"])
      assert.equal(
        (await b.call(method, { id: ids[index] }, sender)).error.code,
        "INVALID_REQUEST",
        `${method} after clearing`,
      );
    assert.equal(
      (
        await b.call(
          "models.generate",
          {
            model: MODELS.anthropic,
            conversationId: ids[index],
            messages: continued(firsts[index]),
            tools,
          },
          sender,
        )
      ).error.code,
      "INVALID_REQUEST",
    );
  }
  assert.equal(b.requests.length, sent, "no provider request for an old id");
  // A new conversation works, and the one-off's next round has no state.
  const fresh = await conversation(b);
  assert.notEqual(fresh, ids[0]);
  assert.deepEqual(await b.ok("conversations.open", { id: fresh }), {
    id: fresh,
  });
  const second = await b.ok("models.generate", {
    model: MODELS.anthropic,
    messages: continued(oneOff),
    tools,
  });
  assert.equal(second.providerState, "none");
  // A restarted worker reads the new key, not the old one.
  await import(`../src/background.js?restart=${crypto.randomUUID()}`);
  assert.deepEqual(await b.ok("conversations.open", { id: fresh }), {
    id: fresh,
  });
});

test("a one-off completion uses the document as its conversation, which ends with the document", async (t) => {
  const b = await zen(t);
  anthropicTurn(b);
  const first = await b.ok("models.generate", {
    model: MODELS.anthropic,
    messages: [ask],
    tools,
  });
  assert.deepEqual(
    [...b.providerState.records.values()].map(
      (record) => record.conversationKey,
    ),
    ["document:session-1"],
  );
  b.hooks.fetch = async () =>
    Response.json({
      content: [
        THINKING,
        { type: "tool_use", id: "toolu_2", name: "get_weather", input: {} },
      ],
      stop_reason: "tool_use",
    });
  const second = await b.ok("models.generate", {
    model: MODELS.anthropic,
    messages: continued(first),
    tools,
  });
  assert.equal(second.providerState, "reused");
  assert.equal(b.providerState.records.size, 2);
  // pagehide sends session.end for this document.
  await b.ok("session.end", {});
  await settle();
  assert.equal(b.providerState.records.size, 0);

  // A navigation in the same tab ends the previous document too.
  anthropicTurn(b);
  await b.ok("models.generate", {
    model: MODELS.anthropic,
    messages: [ask],
    tools,
  });
  assert.equal(b.providerState.records.size, 1);
  b.sessions.set(1, { origin: "https://site.test", session: "session-9" });
  // Any bound request from the new document replaces the old scope.
  await b.ok("models.cancel", { request: "none" });
  await settle();
  assert.equal(b.providerState.records.size, 0);
});

test("one-off loops running side by side in a document keep each other's state", async (t) => {
  const b = await zen(t);
  anthropicTurn(b);
  const request = (messages) =>
    b.ok("models.generate", { model: MODELS.anthropic, messages, tools });
  const first = await request([ask]);
  // A second loop starts (a title, a summary) before the first one finishes.
  const other = await request([{ role: "user", content: "And in Pokhara?" }]);
  assert.equal(b.providerState.records.size, 2, "starting one kept the other");
  // The first loop's final round still finds its signed thinking, and ends
  // only its own entry.
  const done = await request(continued(first));
  assert.equal(done.providerState, "reused");
  assert.deepEqual(
    [...b.providerState.records.values()].map((record) => record.callIds),
    [other.message.toolCalls.map((call) => call.id)],
  );
  const otherDone = await request([
    { role: "user", content: "And in Pokhara?" },
    ...continued(other).slice(1),
  ]);
  assert.equal(otherDone.providerState, "reused");
  assert.equal(b.providerState.records.size, 0);
});

test("a document's state is still released after the worker restarted, when it generated", async (t) => {
  const b = await zen(t);
  anthropicTurn(b);
  await b.ok("models.generate", {
    model: MODELS.anthropic,
    messages: [ask],
    tools,
  });
  assert.equal(b.providerState.records.size, 1);
  // A fresh background on the same storage: the document scopes are gone.
  await import(`../src/background.js?restart=${crypto.randomUUID()}`);
  await b.ok("session.end", {});
  await settle();
  assert.equal(
    b.providerState.records.size,
    1,
    "an unflagged pagehide is left alone",
  );
  await b.ok("session.end", { generated: true });
  await settle();
  assert.equal(b.providerState.records.size, 0);
});

test("conversation ids are minted for the origin and verified on every use", async (t) => {
  const b = await zen(t);
  anthropicTurn(b);
  const id = await conversation(b);
  assert.match(id, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
  assert.notEqual(await conversation(b), id, "every create mints a new id");
  // One key per install, made on first use, kept in local storage only.
  const key = b.store.installKey;
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await b.ok("conversations.open", { id }), { id });
  assert.equal(b.store.installKey, key);

  b.sessions.set(2, { origin: "https://other.test", session: "session-2" });
  const otherSender = b.sender("https://other.test", 2);
  await b.approve(["models.generate"], {}, otherSender);
  const foreign = await conversation(b, otherSender);
  const [nonce, tag] = id.split(".");
  const flip = (text) => `${text[0] === "A" ? "B" : "A"}${text.slice(1)}`;
  const forged = [
    42,
    "",
    "conv-1",
    `${nonce}.${flip(tag)}`,
    `${flip(nonce)}.${tag}`,
    `${id}x`,
    foreign,
  ];
  for (const value of [undefined, ...forged])
    for (const method of ["conversations.open", "conversations.release"])
      assert.equal(
        (await b.call(method, { id: value })).error.code,
        "INVALID_REQUEST",
        `${method} ${value}`,
      );
  for (const value of forged)
    assert.equal(
      (
        await b.call("models.generate", {
          model: MODELS.anthropic,
          conversationId: value,
          messages: [ask],
        })
      ).error.code,
      "INVALID_REQUEST",
      String(value),
    );
  assert.equal(b.requests.length, 0, "no provider request for a forged id");
  // An id that has nothing stored, or no longer has, is still a conversation.
  await b.ok("conversations.release", { id });
  const after = await b.ok("models.generate", {
    model: MODELS.anthropic,
    conversationId: id,
    messages: [ask],
    tools,
  });
  assert.equal(after.providerState, "none");
  // A restarted worker reads the same key, so earlier ids still verify.
  await import(`../src/background.js?restart=${crypto.randomUUID()}`);
  assert.deepEqual(await b.ok("conversations.open", { id }), { id });
  assert.equal(b.store.installKey, key);
  assert.equal(JSON.stringify(after).includes(key), false);
});

test("providers without continuation state store nothing and report none", async (t) => {
  const b = await zen(t);
  const id = await conversation(b);
  b.hooks.fetch = async () =>
    Response.json({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: { name: "get_weather", arguments: "{}" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    });
  const result = await b.ok("models.generate", {
    conversationId: id,
    messages: [ask],
    tools,
  });
  assert.equal(result.model, "openai/allowed");
  assert.equal(result.providerState, "none");
  assert.equal(b.providerState.records.size, 0);
});

test("a round aborted by revocation stores nothing", async (t) => {
  const b = await zen(t);
  const id = await conversation(b);
  let release;
  b.hooks.fetch = async () => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return Response.json({
      content: [
        THINKING,
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
      ],
      stop_reason: "tool_use",
    });
  };
  const pending = b.call("models.generate", {
    model: MODELS.anthropic,
    conversationId: id,
    messages: [ask],
    tools,
  });
  while (!release) await settle();
  await b.ok("grant.revoke");
  release();
  assert.equal((await pending).error.code, "PERMISSION_REQUIRED");
  await settle();
  assert.equal(b.providerState.records.size, 0);
});

test("a round in flight when settings clear stored state ends and stores nothing", async (t) => {
  const b = await zen(t);
  const id = await conversation(b);
  let release;
  b.hooks.fetch = async () => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return Response.json({
      content: [
        THINKING,
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
      ],
      stop_reason: "tool_use",
    });
  };
  const pending = b.call("models.generate", {
    model: MODELS.anthropic,
    conversationId: id,
    messages: [ask],
    tools,
  });
  while (!release) await settle();
  await b.ok("grants.clearState", {}, b.extension);
  release();
  assert.equal((await pending).error.code, "PERMISSION_REQUIRED");
  await settle();
  assert.equal(b.providerState.records.size, 0);
  // The grant itself survives: a new conversation works at once.
  assert.match(await conversation(b), /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
});

test("a round that starts while settings clear stored state is refused, never stored", async (t) => {
  const b = await zen(t);
  const id = await conversation(b);
  anthropicTurn(b);
  // Hold the clear at its first storage read, so the page's round starts
  // while it is under way.
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const allEntries = b.providerState.allEntries;
  b.providerState.allEntries = async (...args) => {
    await gate;
    return allEntries(...args);
  };
  const clearing = b.ok("grants.clearState", {}, b.extension);
  await settle();
  const pending = b.call("models.generate", {
    model: MODELS.anthropic,
    conversationId: id,
    messages: [ask],
    tools,
  });
  await settle();
  open();
  const [late] = await Promise.all([pending, clearing]);
  assert.equal(
    late.error.code,
    "INVALID_REQUEST",
    "the old id stopped verifying",
  );
  await settle();
  assert.equal(b.providerState.records.size, 0);
});

test("the hosted loop replays the same state between its own rounds", async (t) => {
  const b = await zen(t);
  // Changing the site model cancels prepared turns, so it comes first.
  await b.ok(
    "site.update",
    { origin: "https://site.test", model: MODELS.anthropic },
    b.extension,
  );
  const params = await b.prepare({
    name: "Weather",
    tools: [{ name: "get_weather", inputSchema: tools[0].inputSchema }],
  });
  let round = 0;
  b.hooks.fetch = async () =>
    Response.json(
      ++round === 1
        ? {
            content: [
              THINKING,
              {
                type: "tool_use",
                id: "toolu_h",
                name: "site__get_weather",
                input: { city: "Kathmandu" },
              },
            ],
            stop_reason: "tool_use",
          }
        : { content: [{ type: "text", text: "21C" }], stop_reason: "end_turn" },
    );
  const result = await b.ok("chat.complete", params);
  assert.equal(result.message.content, "21C");
  assert.equal(b.invocations.length, 1);
  const assistant = b.requests
    .at(-1)
    .payload.messages.find((message) => message.role === "assistant");
  assert.deepEqual(assistant.content[0], THINKING);
  assert.equal(JSON.stringify(result).includes(SIGNATURE), false);
  // The hosted turn keeps its state in the turn, never in the store.
  assert.equal(b.providerState.records.size, 0);
});

function sse(events) {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
const streaming = { progress: { id: "p", onItem() {} } };
function zenConfig(protocol, model) {
  return {
    kind: "opencode",
    providerId: "opencode-api",
    baseUrl: ZEN,
    apiKey: "zen-key",
    model,
    protocol,
    capabilities: { tools: true, vision: false, reasoning: true },
  };
}

test("streamed Anthropic keeps thinking whole and its signature from signature_delta", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const long = "t".repeat(20_000);
  globalThis.fetch = async () =>
    sse([
      { type: "message_start", message: { id: "msg_s", usage: {} } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: long.slice(0, 15_000) },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: long.slice(15_000) },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: SIGNATURE },
      },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "redacted_thinking", data: REDACTED },
      },
      {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "tool_use",
          id: "toolu_s",
          name: "get_weather",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"city":"K"}' },
      },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ]);
  const result = await generate(
    zenConfig("anthropic", "claude-sonnet-4-6"),
    { messages: [ask], tools },
    undefined,
    false,
    streaming,
  );
  assert.equal(result.message.reasoning.length, 12_000);
  assert.deepEqual(result.rawMessage.state, {
    format: "anthropic",
    blocks: [
      { type: "thinking", thinking: long, signature: SIGNATURE },
      { type: "redacted_thinking", data: REDACTED },
    ],
  });
});

test("streamed Gemini keeps each function call's signature in call order", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (url) => {
    assert.match(url, /:streamGenerateContent\?alt=sse$/);
    return sse([
      {
        candidates: [
          { content: { parts: [{ text: "Considering.", thought: true }] } },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  thoughtSignature: "sig-first",
                  functionCall: { id: "g1", name: "get_weather", args: {} },
                },
                { functionCall: { id: "g2", name: "get_weather", args: {} } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
    ]);
  };
  const result = await generate(
    zenConfig("gemini", "gemini-3.1-pro"),
    { messages: [ask], tools },
    undefined,
    false,
    streaming,
  );
  assert.deepEqual(
    result.message.toolCalls.map((call) => call.id),
    ["g1", "g2"],
  );
  assert.deepEqual(result.rawMessage.state, {
    format: "gemini",
    signatures: ["sig-first", null],
  });
});

test("thinking without its signature is not kept, since it could not be replayed", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () =>
    Response.json({
      content: [
        { type: "thinking", thinking: "unsigned" },
        { type: "tool_use", id: "toolu_u", name: "get_weather", input: {} },
      ],
      stop_reason: "tool_use",
    });
  const result = await generate(
    zenConfig("anthropic", "claude-sonnet-4-6"),
    { messages: [ask], tools },
    undefined,
    false,
  );
  assert.equal(result.rawMessage.state, null);
});

test("streamed Responses keeps reasoning items, call item ids, and output order", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return sse([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_1", summary: [] },
      },
      { type: "response.output_item.done", output_index: 0, item: REASONING },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "message", id: "msg_1", content: [] },
      },
      { type: "response.output_text.delta", output_index: 1, delta: "On it." },
      {
        type: "response.output_item.added",
        output_index: 2,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "get_weather",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 2,
        delta: '{"city":"K"}',
      },
      {
        type: "response.output_item.done",
        output_index: 2,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"city":"K"}',
        },
      },
      {
        type: "response.completed",
        response: { id: "resp_s", status: "completed", usage: {} },
      },
    ]);
  };
  const config = zenConfig("responses", "gpt-5.6-luna");
  const result = await generate(
    config,
    { messages: [ask], tools },
    undefined,
    false,
    streaming,
  );
  assert.deepEqual(sent.include, ["reasoning.encrypted_content"]);
  assert.equal(result.message.content, "On it.");
  assert.deepEqual(result.rawMessage.state, {
    format: "responses",
    steps: [
      { kind: "reasoning", item: REASONING },
      { kind: "message" },
      { kind: "call", id: "fc_1" },
    ],
  });
  // Replayed in that order, around the page's own text and calls.
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return Response.json({ output: [], status: "completed" });
  };
  await generate(
    config,
    {
      messages: [
        ask,
        {
          role: "assistant",
          content: "On it.",
          toolCalls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"K"}' },
            },
          ],
        },
        { role: "tool", toolCallId: "call_1", content: "21" },
      ],
      tools,
    },
    undefined,
    false,
    { continuation: new Map([[1, result.rawMessage.state]]) },
  );
  assert.deepEqual(
    sent.input.map((item) => item.type ?? item.role),
    ["user", "reasoning", "assistant", "function_call", "function_call_output"],
  );
  assert.equal(sent.input[3].id, "fc_1");
  // Without tools there is no continuation, so nothing extra is asked for.
  await generate(config, { messages: [ask] }, undefined, false);
  assert.equal("include" in sent, false);
});

test("state of another wire format, or on a message without tool calls, is ignored", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = init.body;
    return Response.json({ content: [{ type: "text", text: "ok" }] });
  };
  const messages = [
    ask,
    { role: "assistant", content: "plain" },
    { role: "user", content: "again" },
  ];
  await generate(
    zenConfig("anthropic", "claude-sonnet-4-6"),
    { messages },
    undefined,
    false,
    {
      continuation: new Map([
        [1, { format: "anthropic", blocks: [THINKING] }],
        [2, { format: "gemini", signatures: ["x"] }],
      ]),
    },
  );
  assert.equal(sent.includes(SIGNATURE), false);
});

// The store itself, on the in-memory backend with a controlled clock.

function clock(start = 1_000_000) {
  const time = { now: start };
  time.fn = () => time.now;
  return time;
}
function entry(origin, conversationKey, callIds, size = 10) {
  return {
    origin,
    conversationKey,
    callIds,
    model: "opencode-api/claude-sonnet-4-6",
    providerId: "opencode-api",
    revision: "r1",
    state: { format: "anthropic", blocks: [{ data: "d".repeat(size) }] },
  };
}
const issuer = {
  model: "opencode-api/claude-sonnet-4-6",
  providerId: "opencode-api",
  revision: "r1",
};
const find = (store, origin, key, callIds) =>
  store.lookup(origin, key, [{ index: 1, callIds }], issuer);

test("entries expire after two idle days, and reuse refreshes the clock", async () => {
  const time = clock();
  const backend = memoryBackend();
  const store = createProviderStateStore({ backend, now: time.fn });
  assert.equal(PROVIDER_STATE.idleMs, 2 * 86_400_000);
  await store.store(entry("https://a.test", "c", ["1"]));
  await store.store(entry("https://a.test", "d", ["2"]));
  time.now += 1.5 * 86_400_000;
  assert.equal((await find(store, "https://a.test", "c", ["1"])).size, 1);
  time.now += 1.5 * 86_400_000;
  // "c" was used 1.5 days ago and survives; "d" has been idle for 3 days.
  assert.equal((await find(store, "https://a.test", "c", ["1"])).size, 1);
  assert.equal((await find(store, "https://a.test", "d", ["2"])).size, 0);
  assert.equal(backend.records.size, 1);
  // The startup sweep removes idle entries nobody asks about.
  time.now += 2 * 86_400_000 + 1;
  await store.sweep();
  assert.equal(backend.records.size, 0);
});

test("each origin is capped at 5 MB, evicting its least recently used entries", async () => {
  const time = clock();
  const backend = memoryBackend();
  const store = createProviderStateStore({ backend, now: time.fn });
  assert.equal(PROVIDER_STATE.originBytes, 5_000_000);
  const big = 1_900_000;
  await store.store(entry("https://a.test", "c1", ["1"], big));
  time.now += 1000;
  await store.store(entry("https://a.test", "c2", ["2"], big));
  time.now += 1000;
  // Reusing the oldest makes the second the least recently used.
  assert.equal((await find(store, "https://a.test", "c1", ["1"])).size, 1);
  time.now += 1000;
  await store.store(entry("https://b.test", "c", ["9"], big));
  await store.store(entry("https://a.test", "c3", ["3"], big));
  const left = [...backend.records.values()].map(
    (record) => `${record.origin} ${record.conversationKey}`,
  );
  assert.deepEqual(left.sort(), [
    "https://a.test c1",
    "https://a.test c3",
    "https://b.test c",
  ]);
  // A single entry over the per-entry bound is never stored.
  assert.equal(
    await store.store(entry("https://a.test", "huge", ["h"], 2_100_000)),
    false,
  );
});

test("the whole store is capped at 50 MB, evicting least recently used first", async () => {
  const time = clock();
  const backend = memoryBackend();
  const store = createProviderStateStore({ backend, now: time.fn });
  assert.equal(PROVIDER_STATE.totalBytes, 50_000_000);
  const big = 1_900_000;
  const keys = () =>
    new Set(
      [...backend.records.values()].map(
        (record) => `${record.origin} ${record.conversationKey}`,
      ),
    );
  // Two entries per origin keeps each origin under its own cap; 27 of them
  // (51.3 MB) are one past the total.
  for (let index = 0; index < 27; index++) {
    time.now += 1000;
    const site = Math.floor(index / 2);
    const id = String(index % 2);
    await store.store(entry(`https://s${site}.test`, `c${id}`, [id], big));
    // The very first entry is reused, so the second becomes the oldest.
    if (index === 1)
      assert.equal((await find(store, "https://s0.test", "c0", ["0"])).size, 1);
  }
  assert.equal(keys().has("https://s0.test c1"), false);
  assert.equal(keys().has("https://s0.test c0"), true);
  assert.equal(keys().size, 26);
  time.now += 1000;
  await store.store(entry("https://s13.test", "c1", ["1"], big));
  assert.equal(keys().has("https://s0.test c0"), false);
  assert.equal(keys().has("https://s13.test c1"), true);
  const total = [...backend.records.values()].reduce(
    (sum, record) => sum + record.bytes,
    0,
  );
  assert.ok(total <= PROVIDER_STATE.totalBytes, String(total));
});

test("a stored round lets go of the conversation's entries outside the request's turn", async () => {
  const backend = memoryBackend();
  const store = createProviderStateStore({ backend });
  await store.store(entry("https://a.test", "c", ["1"]));
  await store.store(entry("https://a.test", "c", ["2"]), { keep: [["1"]] });
  await store.store(entry("https://a.test", "other", ["9"]));
  assert.equal(backend.records.size, 3);
  await store.store(entry("https://a.test", "c", ["3"]), { keep: [["2"]] });
  assert.deepEqual(
    [...backend.records.values()]
      .filter((record) => record.conversationKey === "c")
      .map((record) => record.callIds)
      .sort(),
    [["2"], ["3"]],
  );
  // An aborted round stores nothing.
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(
    await store.store(entry("https://a.test", "c", ["4"]), {
      signal: aborted.signal,
    }),
    false,
  );
  await store.clearOrigin("https://a.test");
  assert.equal(backend.records.size, 0);
});

test("storage failures read as no state and never throw", async () => {
  const broken = new Proxy(
    {},
    {
      get: () => async () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    },
  );
  const store = createProviderStateStore({ backend: broken });
  assert.equal(
    (await find(store, "https://a.test", "c", ["1"])).size,
    0,
    "a failed lookup is an empty one",
  );
  assert.equal(await store.store(entry("https://a.test", "c", ["1"])), false);
  assert.equal(await store.release("https://a.test", "c"), false);
  assert.equal(await store.clearOrigin("https://a.test"), false);
  assert.equal(await store.clearAll(), false);
  // No IndexedDB at all is the same as an empty store.
  const none = createProviderStateStore({ backend: null });
  assert.equal((await find(none, "https://a.test", "c", ["1"])).size, 0);
  assert.equal(await none.store(entry("https://a.test", "c", ["1"])), false);
});

test("a conversation id verifies only for its origin and its install key", async () => {
  const key = await importInstallKey(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const other = await importInstallKey(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const id = await mintConversationId(key, "https://a.test");
  assert.match(id, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
  assert.equal(await verifyConversationId(key, "https://a.test", id), true);
  assert.equal(await verifyConversationId(key, "https://b.test", id), false);
  assert.equal(
    await verifyConversationId(key, "https://a.test:443", id),
    false,
  );
  assert.equal(await verifyConversationId(other, "https://a.test", id), false);
  for (const value of [null, 7, "", id.replace(".", "-"), `${id}=`])
    assert.equal(
      await verifyConversationId(key, "https://a.test", value),
      false,
    );
});

/**
 * The real page-api.js in a VM, with the test standing in for the content
 * script, so the handle's own wire messages are what is checked.
 */
function pageWorld(answers) {
  const nonce = "nonce-1";
  const win = new EventTarget();
  const posted = [];
  win.postMessage = (data) => {
    const copy = structuredClone(data);
    if (copy.direction !== "page-to-extension") {
      const event = new Event("message");
      event.source = win;
      event.data = copy;
      win.dispatchEvent(event);
      return;
    }
    posted.push(copy);
    if (copy.kind !== "request") return;
    const result = answers[copy.method]?.(copy.params);
    win.postMessage({
      channel: copy.channel,
      direction: "extension-to-page",
      nonce,
      kind: "response",
      id: copy.id,
      ...(result instanceof Error
        ? { ok: false, error: { code: "INVALID_REQUEST", message: "no" } }
        : { ok: true, result }),
    });
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
  return { api: win.ai.arjunah, posted };
}

test("page API: a conversation handle carries its id; a one-off completion carries none", async () => {
  const minted = "AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";
  const world = pageWorld({
    enable: () => ({ origin: "https://site.test" }),
    "conversations.create": () => ({ id: minted }),
    "conversations.open": (params) =>
      params.id === minted ? { id: minted } : new Error("foreign"),
    "conversations.release": () => true,
    "models.generate": () => ({ providerState: "none" }),
  });
  const session = await world.api.enable();
  const handle = await session.conversations.create();
  assert.equal(handle.id, minted);
  assert.equal(Object.isFrozen(handle), true);
  const sent = (method) =>
    world.posted.filter((message) => message.method === method).at(-1)?.params;
  await handle.generate({ messages: [ask], conversationId: "chosen" });
  assert.deepEqual(sent("models.generate"), {
    messages: [ask],
    conversationId: minted,
  });
  // A page's own `conversationId` on a one-off completion is not passed on.
  await session.models.generate({ messages: [ask], conversationId: minted });
  assert.deepEqual(sent("models.generate"), { messages: [ask] });
  const reopened = await session.conversations.open(minted);
  assert.equal(reopened.id, minted);
  assert.deepEqual(sent("conversations.open"), { id: minted });
  const refused = await session.conversations
    .open("not-minted")
    .catch((error) => error);
  assert.equal(refused.code, "INVALID_REQUEST");
  assert.equal(await reopened.release(), true);
  assert.deepEqual(sent("conversations.release"), { id: minted });
});
