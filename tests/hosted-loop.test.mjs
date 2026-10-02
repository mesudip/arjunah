import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { broker, toolReply } from "./helpers/broker.mjs";
import {
  validateAccessRequest,
  validateSiteManifest,
  validateSiteModelResult,
  validateUserInputValue,
} from "../src/lib/validation.js";

/**
 * SPEC section 15 on the extension side: the manifest's `loop` (15.1) and
 * `models` (15.2), the `composer` of an access request (15.3), and mode 1
 * approvals and remote collected inputs (7.8).
 */

const Hosted = vm.runInNewContext(
  `${readFileSync("src/hosted.js", "utf8")}\nArjunahHosted`,
  {},
);

const loopManifest = (extra = {}) => ({
  name: "Loop desk",
  loop: { composer: "server" },
  ...extra,
});

test("loop: composer and level are validated, and it excludes systemPrompt and mcpServers", () => {
  const manifest = validateSiteManifest(
    loopManifest({
      mcpServers: [{ id: "x", url: "https://api.site.test/mcp" }],
    }),
  );
  assert.deepEqual(manifest.loop, { composer: "server", level: 1 });
  assert.deepEqual(manifest.mcpServers, [], "mcpServers are ignored");
  assert.deepEqual(
    validateSiteManifest(
      loopManifest({ loop: { composer: "webapp", level: 2 } }),
    ).loop,
    { composer: "webapp", level: 2 },
  );
  for (const loop of [
    {},
    { composer: "arjunah" },
    { composer: "server", level: 3 },
    { composer: "server", level: "completion" },
    [],
  ])
    assert.throws(
      () => validateSiteManifest(loopManifest({ loop })),
      /loop/,
      JSON.stringify(loop),
    );
  assert.throws(
    () => validateSiteManifest(loopManifest({ systemPrompt: "Be helpful." })),
    /mutually exclusive/,
  );
});

test("a contract without the new fields keeps its shape, so its fingerprint holds", () => {
  const manifest = validateSiteManifest({
    name: "Plain",
    tools: [{ name: "a", inputSchema: { type: "object" } }],
    mcpServers: [
      {
        id: "srv",
        url: "https://api.site.test/mcp",
        tools: [{ name: "b", inputSchema: { type: "object" } }],
      },
    ],
  });
  assert.deepEqual(Object.keys(manifest), [
    "name",
    "description",
    "systemPrompt",
    "widget",
    "tools",
    "mcpServers",
    "threads",
  ]);
  assert.equal("requiresApproval" in manifest.tools[0], false);
  assert.deepEqual(Object.keys(manifest.mcpServers[0].tools[0]), [
    "name",
    "description",
    "inputSchema",
  ]);
});

test("models: 1 to 8 entries, id syntax, optional metadata, and generate per mode", () => {
  const manifest = validateSiteManifest({
    name: "Shop",
    models: {
      generate: true,
      list: [
        { id: "shop-small" },
        {
          id: "shop:large.v2",
          displayName: "Large",
          contextWindow: 32000,
          reasoningLevels: ["high", "low"],
          capabilities: { vision: true, tools: false },
        },
      ],
    },
  });
  assert.deepEqual(manifest.models.list[0], {
    id: "shop-small",
    displayName: "Shop",
    capabilities: { tools: true, vision: false, reasoning: false },
    contextWindow: null,
    reasoningLevels: [],
    kind: "site",
  });
  assert.deepEqual(manifest.models.list[1].capabilities, {
    tools: false,
    vision: true,
    reasoning: true,
  });
  assert.deepEqual(manifest.models.list[1].reasoningLevels, ["low", "high"]);
  assert.equal(manifest.models.generate, true);
  const bad = [
    { list: [], generate: true },
    {
      list: Array.from({ length: 9 }, (_, i) => ({ id: `m${i}` })),
      generate: true,
    },
    { list: [{ id: "a/b" }], generate: true },
    { list: [{ id: "x".repeat(101) }], generate: true },
    { list: [{ id: "a" }, { id: "a" }], generate: true },
    { list: [{ id: "a", contextWindow: 0 }], generate: true },
    { list: [{ id: "a", reasoningLevels: ["turbo"] }], generate: true },
    { list: [{ id: "a", capabilities: { tools: "yes" } }], generate: true },
    { list: [{ id: "a" }] },
  ];
  for (const models of bad)
    assert.throws(
      () => validateSiteManifest({ name: "Shop", models }),
      /models/,
      JSON.stringify(models).slice(0, 80),
    );
  // A loop answers its own models: generate must be absent there.
  assert.equal(
    validateSiteManifest(loopManifest({ models: { list: [{ id: "a" }] } }))
      .models.generate,
    false,
  );
  assert.throws(
    () =>
      validateSiteManifest(
        loopManifest({ models: { list: [{ id: "a" }], generate: true } }),
      ),
    /absent with a loop/,
  );
});

test("requiresApproval and remote userInputs are validated and part of the contract", () => {
  const manifest = validateSiteManifest({
    name: "Cart",
    tools: [
      {
        name: "delete_item",
        inputSchema: { type: "object", additionalProperties: false },
        requiresApproval: true,
      },
    ],
    mcpServers: [
      {
        id: "backend",
        url: "https://api.site.test/mcp",
        tools: [
          {
            name: "pay",
            inputSchema: {
              type: "object",
              properties: { amount: { type: "number" } },
              additionalProperties: false,
            },
            requiresApproval: true,
            userInputs: [
              {
                id: "pin",
                label: "Card PIN",
                schema: { type: "string", minLength: 4 },
                secret: true,
              },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(manifest.tools[0].requiresApproval, true);
  const pay = manifest.mcpServers[0].tools[0];
  assert.equal(pay.requiresApproval, true);
  assert.equal(pay.userInputs[0].id, "pin");
  assert.equal(pay.userInputs[0].secret, true);
  assert.equal(
    "outputContent" in pay,
    false,
    "remote tools take no output kinds",
  );
  assert.throws(
    () =>
      validateSiteManifest({
        name: "Cart",
        tools: [{ name: "x", requiresApproval: "yes" }],
      }),
    /requiresApproval must be a boolean/,
  );
  // A remote tool with inputs must close its argument object, and an input
  // may not shadow a model-supplied property.
  assert.throws(
    () =>
      validateSiteManifest({
        name: "Cart",
        mcpServers: [
          {
            id: "b",
            url: "https://api.site.test/mcp",
            tools: [
              {
                name: "pay",
                inputSchema: { type: "object" },
                userInputs: [
                  { id: "pin", label: "PIN", schema: { type: "string" } },
                ],
              },
            ],
          },
        ],
      }),
    /additionalProperties/,
  );
});

test("composer is validated on an access request and defaults to none", () => {
  assert.equal(
    validateAccessRequest({ level: "completion", composer: "server" }).composer,
    "server",
  );
  assert.equal(
    validateAccessRequest({ level: "catalog", composer: "webapp" }).composer,
    "webapp",
  );
  assert.equal("composer" in validateAccessRequest({}), false);
  for (const composer of ["arjunah", "", 1, true])
    assert.throws(
      () => validateAccessRequest({ composer }),
      (error) =>
        error.code === "INVALID_REQUEST" && error.details.field === "composer",
    );
});

test("consent text per mode", () => {
  const site = { id: "shop-small", displayName: "Shop model" };
  // A page's own enable(): webapp keeps today's wording, server adds the
  // fixed line of SPEC 15.3.
  assert.deepEqual(
    [...Hosted.consentLines({ mode: "page", composer: "webapp" })],
    [],
  );
  assert.deepEqual(
    [...Hosted.consentLines({ mode: "page", composer: "server" })],
    [
      "This site's server writes the prompts and sends them, including the results of tools it runs, to the model you choose. अर्जुनः cannot show these prompts.",
    ],
  );
  // Mode 1 with the visitor's model adds nothing; with the site's own model
  // it says the visitor's AI is not used.
  assert.deepEqual([...Hosted.consentLines({ mode: "hosted" })], []);
  const hostedSite = Hosted.consentLines({ mode: "hosted", siteModel: site });
  assert.match(hostedSite[0], /This site's own model \(Shop model\) answers/);
  assert.match(hostedSite[0], /Your AI is not used/);
  // Modes 2 and 3 name the composer and say no context is shared.
  const server = Hosted.consentLines({ mode: "loop", composer: "server" });
  assert.equal(server[0], Hosted.SERVER_LINE);
  assert.match(server[1], /This site's server sees everything you type/);
  assert.match(server[1], /Page context is not shared/);
  const webapp = Hosted.consentLines({ mode: "loop", composer: "webapp" });
  assert.equal(webapp[0], Hosted.PAGE_LINE);
  assert.match(webapp[0], /^This site's page writes the prompts/);
  const loopSite = Hosted.consentLines({
    mode: "loop",
    composer: "webapp",
    siteModel: site,
  });
  assert.match(
    loopSite[0],
    /This site's page runs the conversation and answers it with its own model \(Shop model\)\. Your AI is not used/,
  );
  // Tools that ask first are listed in every mode.
  assert.match(
    Hosted.consentLines({ mode: "hosted", approvals: ["delete_item"] }).at(-1),
    /This tool asks you before it runs: delete_item\./,
  );
  assert.match(
    Hosted.consentLines({ mode: "loop", approvals: ["a", "b"] }).at(-1),
    /These tools ask you before they run: a, b\./,
  );
  // The persistent panel line names the composer.
  assert.match(Hosted.panelLine("server"), /run by this site's server/);
  assert.match(
    Hosted.panelLine("webapp", true),
    /run and answered by this site's page/,
  );
});

test("the picker starts on the site's model only when the visitor has none", () => {
  const siteModels = Hosted.siteModelEntries({
    name: "Shop",
    models: {
      list: [
        {
          id: "shop-small",
          displayName: "Shop model",
          capabilities: { tools: true, vision: false, reasoning: false },
          contextWindow: null,
          reasoningLevels: [],
        },
      ],
    },
  });
  assert.equal(siteModels[0].providerName, "Shop");
  assert.equal(siteModels[0].providerId, "site");
  const visitorModels = [{ id: "openai/gpt" }];
  const pick = (extra) =>
    Hosted.pickerSelection({ siteModels, visitorModels, ...extra });
  assert.equal(pick({ visitorModel: null }), "shop-small", "no visitor model");
  assert.equal(pick({ visitorModel: "openai/gpt" }), "openai/gpt");
  assert.equal(
    pick({ visitorModel: "openai/gpt", siteChoice: "shop-small" }),
    "shop-small",
    "a stored choice of a site model wins",
  );
  assert.equal(
    pick({ visitorModel: "openai/gpt", siteChoice: "gone" }),
    "openai/gpt",
    "a stored choice the contract no longer declares is ignored",
  );
  assert.equal(
    pick({ visitorModel: "openai/gpt", pending: "shop-small" }),
    "shop-small",
  );
  assert.equal(Hosted.pickerSelection({}), null);
  assert.deepEqual(Hosted.bridgeEntry(siteModels[0]).kind, "site");
});

test("a site model's result is validated like a provider's", () => {
  const offered = new Set(["site__lookup"]);
  const ok = validateSiteModelResult(
    {
      message: {
        content: "hi",
        toolCalls: [{ id: "c1", name: "site__lookup", arguments: "{}" }],
      },
      usage: { promptTokens: 3, completionTokens: 1 },
    },
    offered,
  );
  assert.equal(ok.message.toolCalls[0].name, "site__lookup");
  assert.equal(ok.finishReason, "tool_calls");
  assert.deepEqual(ok.usage, {
    promptTokens: 3,
    completionTokens: 1,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
  });
  assert.equal(
    validateSiteModelResult({ message: { content: "x" } }).usage,
    null,
    "no usage is invented",
  );
  const bad = [
    null,
    {},
    { message: { content: 3 } },
    { message: { content: "x".repeat(120001) } },
    {
      message: {
        toolCalls: [{ id: "c1", name: "site__other", arguments: "{}" }],
      },
    },
    {
      message: {
        toolCalls: [
          { id: "c1", name: "site__lookup", arguments: "{}" },
          { id: "c1", name: "site__lookup", arguments: "{}" },
        ],
      },
    },
    {
      message: {
        toolCalls: [{ id: "c1", name: "site__lookup", arguments: {} }],
      },
    },
    {
      message: {
        attachments: [{ type: "image", mediaType: "image/svg", data: "AA==" }],
      },
    },
    { message: { reasoning: 5 } },
    { message: {}, usage: { promptTokens: -1 } },
  ];
  for (const value of bad)
    assert.throws(
      () => validateSiteModelResult(value, offered),
      (error) => error.code === "PROVIDER_ERROR",
      JSON.stringify(value)?.slice(0, 80),
    );
});

test("a remote input value is checked against its scalar schema without echoing it", () => {
  const definition = {
    id: "pin",
    label: "Card PIN",
    schema: { type: "string", minLength: 4, maxLength: 4096 },
  };
  assert.equal(validateUserInputValue(definition, "1234"), "1234");
  assert.throws(
    () => validateUserInputValue(definition, "12"),
    (error) =>
      error.code === "TOOL_ERROR" &&
      /Card PIN/.test(error.message) &&
      !error.message.includes("12"),
  );
  assert.throws(() =>
    validateUserInputValue({ label: "n", schema: { type: "integer" } }, 1.5),
  );
});

// ------------------------------------------------------------ the broker

const siteManifest = {
  name: "Shop",
  systemPrompt: "Help with the shop.",
  tools: [
    {
      name: "lookup",
      inputSchema: { type: "object", additionalProperties: false },
    },
  ],
  models: {
    generate: true,
    list: [{ id: "shop-small", displayName: "Shop model" }],
  },
};

test("a mode 1 turn on a site model runs through the page, offers the site's tools, and records no usage", async (t) => {
  const b = await broker(t);
  const turn = await b.prepare(siteManifest);
  const rounds = [];
  b.hooks.message = (message) => {
    if (message.kind !== "arjunah-site-generate") return undefined;
    rounds.push(message.request);
    const tool = message.request.messages.find((item) => item.role === "tool");
    return {
      ok: true,
      result: tool
        ? { message: { content: `stock: ${tool.content}` } }
        : {
            message: {
              content: "",
              toolCalls: [{ id: "s1", name: "site__lookup", arguments: "{}" }],
            },
          },
    };
  };
  b.hooks.tool = () => ({ stock: 7 });
  const result = await b.ok("chat.complete", {
    ...turn,
    turnId: "turn-1",
    siteModel: "shop-small",
  });
  assert.equal(result.message.content, 'stock: {"stock":7}');
  assert.equal(result.usage, null, "the site reported no usage");
  assert.equal(b.requests.length, 0, "no provider was contacted");
  assert.equal(b.store.usage, undefined, "nothing reached the usage ledger");
  assert.equal(rounds.length, 2);
  assert.deepEqual(
    rounds[0].tools.map((tool) => tool.name),
    ["site__lookup"],
  );
  assert.equal(rounds[0].messages[1].content, "Help with the shop.");
  assert.equal(b.invocations.length, 1);
  const start = b.events.find((event) => event.type === "model.start");
  assert.equal(start.model, "shop-small");
});

test("a site model calling a tool it was not offered fails the round as PROVIDER_ERROR", async (t) => {
  const b = await broker(t);
  const turn = await b.prepare(siteManifest);
  b.hooks.message = (message) =>
    message.kind === "arjunah-site-generate"
      ? {
          ok: true,
          result: {
            message: {
              toolCalls: [{ id: "x", name: "site__drop_db", arguments: "{}" }],
            },
          },
        }
      : undefined;
  const response = await b.call("chat.complete", {
    ...turn,
    siteModel: "shop-small",
  });
  assert.equal(response.error.code, "PROVIDER_ERROR");
  assert.equal(b.invocations.length, 0);
  const unknown = await b.call("chat.complete", {
    ...(await b.prepare(siteManifest)),
    siteModel: "not-declared",
  });
  assert.equal(unknown.error.code, "INVALID_REQUEST");
});

test("a page failure in the site's generate is a PROVIDER_ERROR, and its timeout a TIMEOUT", async (t) => {
  const b = await broker(t);
  for (const [code, expected] of [
    ["PROVIDER_ERROR", "PROVIDER_ERROR"],
    ["TIMEOUT", "TIMEOUT"],
  ]) {
    const turn = await b.prepare(siteManifest);
    b.hooks.message = (message) =>
      message.kind === "arjunah-site-generate"
        ? { ok: false, error: { code, message: "backend down" } }
        : undefined;
    const response = await b.call("chat.complete", {
      ...turn,
      siteModel: "shop-small",
    });
    assert.equal(response.error.code, expected);
    assert.match(
      response.error.message,
      /The site's model failed: backend down/,
    );
  }
});

const approvalManifest = {
  name: "Cart",
  tools: [
    {
      name: "delete_item",
      inputSchema: {
        type: "object",
        properties: { sku: { type: "string" } },
        additionalProperties: false,
      },
      requiresApproval: true,
    },
  ],
};

test("a requiresApproval tool runs only on Approve; anything else is a tool error the model receives", async (t) => {
  for (const answer of [
    { ok: true, approved: false },
    { ok: false },
    { ok: true, approved: "yes" },
    { ok: true, approved: true },
  ]) {
    const b = await broker(t);
    const turn = await b.prepare(approvalManifest);
    const asked = [];
    b.hooks.message = (message) => {
      if (message.kind !== "arjunah-approval") return undefined;
      asked.push(message);
      return answer;
    };
    b.hooks.tool = () => ({ removed: true });
    b.hooks.fetch = async () =>
      b.requests.length === 1
        ? toolReply("site__delete_item", '{"sku":"A-1"}')
        : Response.json({ choices: [{ message: { content: "done" } }] });
    await b.ok("chat.complete", turn);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].approval.title, "delete_item");
    assert.match(asked[0].approval.detail, /"sku": "A-1"/);
    assert.equal(asked[0].toolId, "call-1");
    const toolMessage = b.requests[1].payload.messages.find(
      (item) => item.role === "tool",
    );
    if (answer.approved === true) {
      assert.equal(b.invocations.length, 1);
      assert.match(toolMessage.content, /removed/);
    } else {
      assert.equal(b.invocations.length, 0, JSON.stringify(answer));
      assert.match(toolMessage.content, /did not approve/);
    }
  }
});

test("a declared remote tool's collected inputs reach the server only in _meta.arjunah.inputs", async (t) => {
  const b = await broker(t);
  const manifest = {
    name: "Pay",
    mcpServers: [
      {
        id: "backend",
        url: "https://api.site.test/mcp",
        tools: [
          {
            name: "pay",
            inputSchema: {
              type: "object",
              properties: { amount: { type: "number" } },
              additionalProperties: false,
            },
            userInputs: [
              {
                id: "pin",
                label: "Card PIN",
                schema: { type: "string", minLength: 4 },
                secret: true,
              },
            ],
          },
        ],
      },
    ],
  };
  const turn = await b.prepare(manifest);
  const asked = [];
  b.hooks.message = (message) => {
    if (message.kind !== "arjunah-tool-input") return undefined;
    asked.push(message);
    return { ok: true, value: "4321" };
  };
  const calls = [];
  b.hooks.fetch = async (_url, _init, request) => {
    if (!request.method)
      return b.requests.filter((item) => !item.payload.method).length === 1
        ? toolReply("mcp_backend__pay", '{"amount":12}')
        : Response.json({ choices: [{ message: { content: "paid" } }] });
    if (request.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    calls.push(request);
    return Response.json({
      jsonrpc: "2.0",
      id: request.id,
      result:
        request.method === "initialize"
          ? { protocolVersion: "2025-03-26" }
          : { content: [{ type: "text", text: "ok" }] },
    });
  };
  await b.ok("chat.complete", { ...turn, conversationId: "conv-9" });
  assert.equal(asked.length, 1);
  assert.equal(asked[0].definition.id, "pin");
  assert.equal(asked[0].recipient, "https://api.site.test");
  const call = calls.find((item) => item.method === "tools/call");
  assert.deepEqual(call.params.arguments, { amount: 12 });
  assert.deepEqual(call.params._meta, {
    arjunah: { conversationId: "conv-9", inputs: { pin: "4321" } },
  });
  const providerTraffic = JSON.stringify(
    b.requests.filter((item) => !item.payload.method),
  );
  assert.equal(providerTraffic.includes("4321"), false, "never model input");
  assert.equal(
    JSON.stringify(b.events).includes("4321"),
    false,
    "never in the activity feed",
  );
});

test("a cancelled remote input means the tool is not called", async (t) => {
  const b = await broker(t);
  const manifest = {
    name: "Pay",
    mcpServers: [
      {
        id: "backend",
        url: "https://api.site.test/mcp",
        tools: [
          {
            name: "pay",
            inputSchema: { type: "object", additionalProperties: false },
            userInputs: [
              { id: "pin", label: "Card PIN", schema: { type: "string" } },
            ],
          },
        ],
      },
    ],
  };
  const turn = await b.prepare(manifest);
  b.hooks.message = (message) =>
    message.kind === "arjunah-tool-input" ? { ok: false } : undefined;
  const calls = [];
  b.hooks.fetch = async (_url, _init, request) => {
    if (!request.method)
      return b.requests.filter((item) => !item.payload.method).length === 1
        ? toolReply("mcp_backend__pay")
        : Response.json({ choices: [{ message: { content: "ok" } }] });
    calls.push(request);
    return Response.json({ jsonrpc: "2.0", id: request.id, result: {} });
  };
  await b.ok("chat.complete", turn);
  assert.equal(
    calls.some((item) => item.method === "tools/call"),
    false,
  );
  const toolMessage = b.requests
    .filter((item) => !item.payload.method)[1]
    .payload.messages.find((item) => item.role === "tool");
  assert.match(toolMessage.content, /did not provide Card PIN/);
});

test("the grant records the composer and the visitor's choice of a site model", async (t) => {
  const b = await broker(t);
  await b.approve(["models.list", "models.generate"], { composer: "server" });
  assert.equal(b.store.grants["https://site.test"].composer, "server");
  // A hosted-chat request does not overwrite it.
  await b.approve(["chat.hosted"], { siteModel: "shop-small" });
  const grant = b.store.grants["https://site.test"];
  assert.equal(grant.composer, "server");
  assert.equal(grant.siteModel, "shop-small");
  assert.equal("composer" in (await b.ok("grant.query")), false);
  assert.equal((await b.ok("hosted.settings")).siteModel, "shop-small");
  await b.ok("hosted.model", { model: "openai/allowed", siteModel: null });
  assert.equal(b.store.grants["https://site.test"].siteModel, null);
  await b.ok("hosted.model", { siteModel: "shop-small" });
  assert.equal(b.store.grants["https://site.test"].siteModel, "shop-small");
  assert.equal(
    (await b.call("hosted.model", { siteModel: "a/b" })).error.code,
    "INVALID_REQUEST",
  );
});

test("a loop contract never runs the extension's own loop, and loop.tool needs its approval", async (t) => {
  const b = await broker(t);
  const manifest = {
    name: "Loop desk",
    loop: { composer: "server" },
    tools: [
      {
        name: "page_info",
        inputSchema: {
          type: "object",
          properties: { field: { type: "string" } },
          additionalProperties: false,
        },
        requiresApproval: true,
      },
    ],
  };
  const reg = await b.register(manifest);
  const prepare = await b.call("chat.prepare", {
    manifest,
    registrationId: reg.id,
  });
  assert.equal(prepare.error.code, "NOT_SUPPORTED");
  const params = {
    manifest,
    registrationId: reg.id,
    fingerprint: reg.fingerprint,
    name: "page_info",
    arguments: { field: "title" },
    invocationId: "c1",
  };
  assert.equal(
    (await b.call("loop.tool", params)).error.code,
    "PERMISSION_REQUIRED",
    "the contract was not approved yet",
  );
  await b.approve(["models.list", "models.generate"], {
    composer: "server",
    registrationId: reg.id,
    _resources: { contractFingerprint: reg.fingerprint, mcpOrigins: [] },
  });
  let approve = false;
  b.hooks.message = (message) =>
    message.kind === "arjunah-approval"
      ? { ok: true, approved: approve }
      : undefined;
  b.hooks.tool = (message) => ({ value: message.args.field });
  const denied = await b.call("loop.tool", params);
  assert.equal(denied.error.code, "TOOL_ERROR");
  assert.match(denied.error.message, /did not approve/);
  assert.equal(b.invocations.length, 0);
  approve = true;
  assert.deepEqual(await b.ok("loop.tool", params), { value: "title" });
  const invalid = await b.call("loop.tool", {
    ...params,
    arguments: { field: 3 },
  });
  assert.equal(
    invalid.error.code,
    "TOOL_ERROR",
    "schema failures never run it",
  );
  const unknown = await b.call("loop.tool", { ...params, name: "nope" });
  assert.equal(unknown.error.code, "TOOL_ERROR");
  // A contract the visitor did not approve is refused even with a grant.
  const changed = await b.call("loop.tool", {
    ...params,
    manifest: { ...manifest, name: "Other desk" },
  });
  assert.equal(changed.error.code, "PERMISSION_REQUIRED");
  // The panel's picker and card validation work for an approved loop.
  assert.ok(
    await b.ok("cards.validate", {
      card: { type: "card", children: [{ type: "text", text: "hi" }] },
      fingerprint: reg.fingerprint,
    }),
  );
  assert.equal(
    (
      await b.call("cards.validate", {
        card: { type: "card", children: [] },
      })
    ).error.code,
    "PERMISSION_REQUIRED",
  );
});
