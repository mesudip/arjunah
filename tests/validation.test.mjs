import test from "node:test";
import assert from "node:assert/strict";
import {
  validateAccessRequest,
  validateGenerateRequest,
  validateMcpServer,
  validateSiteManifest,
  validateSiteToolResult,
  validateControlValues,
  providerOrigin,
} from "../src/lib/validation.js";

test("context fields are deduplicated and capability duplicates are rejected", () => {
  assert.throws(
    () =>
      validateAccessRequest({ capabilities: ["models.list", "models.list"] }),
    /unique/,
  );
  // A level bundle restating a capability the site also listed is the
  // expansion's duplicate, not the site's, so it is merged rather than refused.
  assert.deepEqual(
    validateAccessRequest({
      level: "completion",
      capabilities: ["models.generate"],
    }).capabilities,
    ["models.list", "models.generate"],
  );
  assert.throws(
    () =>
      validateAccessRequest({
        level: "completion",
        capabilities: ["models.list", "models.list"],
      }),
    /unique/,
  );
  assert.deepEqual(
    validateAccessRequest({
      capabilities: ["models.list", "context.read"],
      context: ["title", "title"],
    }),
    {
      capabilities: ["models.list", "context.read"],
      context: ["title"],
      reason: undefined,
    },
  );
});

test("unknown capability and context without capability are rejected", () => {
  assert.throws(
    () => validateAccessRequest({ capabilities: ["secrets.read"] }),
    /unknown capability/,
  );
  assert.throws(
    () =>
      validateAccessRequest({
        capabilities: ["models.list"],
        context: ["text"],
      }),
    /require context.read/,
  );
});

test("generation bounds and roles are enforced", () => {
  assert.equal(
    validateGenerateRequest({
      messages: [{ role: "user", content: "hi" }],
      temperature: 2,
    }).temperature,
    2,
  );
  assert.throws(
    () =>
      validateGenerateRequest({ messages: [{ role: "owner", content: "hi" }] }),
    /invalid role/,
  );
  assert.throws(
    () =>
      validateGenerateRequest({
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 0,
      }),
    /maxTokens/,
  );
});

test("MCP URLs and sensitive headers are constrained", () => {
  assert.equal(
    validateMcpServer({ id: "local", url: "http://127.0.0.1:3456/mcp" }).id,
    "local",
  );
  assert.throws(
    () => validateMcpServer({ id: "bad", url: "http://example.com/mcp" }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      validateMcpServer({
        id: "bad",
        url: "https://example.com/mcp",
        headers: { Authorization: "secret" },
      }),
    /forbidden header/,
  );
});

test("site contracts are bounded and normalized", () => {
  const manifest = validateSiteManifest({
    name: "Docs helper",
    tools: [{ name: "lookup", inputSchema: { type: "object" } }],
    widget: { autoShow: true },
  });
  assert.equal(manifest.tools[0].name, "lookup");
  assert.equal(manifest.widget.autoShow, true);
  assert.throws(
    () =>
      validateSiteManifest({
        name: "Docs",
        tools: [{ name: "same" }, { name: "same" }],
      }),
    /duplicate/,
  );
});

test("site tools may declare broker-collected scalar inputs", () => {
  const manifest = validateSiteManifest({
    name: "Secure helper",
    tools: [
      {
        name: "connect",
        inputSchema: {
          type: "object",
          properties: { host: { type: "string" } },
          required: ["host"],
          additionalProperties: false,
        },
        userInputs: [
          {
            id: "passphrase",
            label: "Passphrase",
            description: "Used only for this invocation.",
            schema: { type: "string", minLength: 1 },
            secret: true,
          },
        ],
      },
    ],
  });
  assert.deepEqual(manifest.tools[0].userInputs[0], {
    id: "passphrase",
    label: "Passphrase",
    description: "Used only for this invocation.",
    schema: { type: "string", minLength: 1, maxLength: 4096 },
    secret: true,
  });
  assert.throws(
    () =>
      validateGenerateRequest({
        messages: [{ role: "user", content: "connect" }],
        tools: [
          {
            name: "connect",
            userInputs: [
              {
                id: "secret",
                label: "Secret",
                schema: { type: "string" },
              },
            ],
          },
        ],
      }),
    /registered site tools/,
  );
  for (const userInputs of [
    [
      {
        id: "host",
        label: "Conflict",
        schema: { type: "string" },
      },
    ],
    [
      {
        id: "otp",
        label: "OTP",
        schema: { type: "object" },
      },
    ],
    [
      {
        id: "remember",
        label: "Remember",
        schema: { type: "boolean" },
        secret: true,
      },
    ],
  ])
    assert.throws(() =>
      validateSiteManifest({
        name: "Invalid secure helper",
        tools: [
          {
            name: "connect",
            inputSchema: {
              type: "object",
              properties: { host: { type: "string" } },
              additionalProperties: false,
            },
            userInputs,
          },
        ],
      }),
    );
});

test("site tool content results are declared, bounded, and retain a text fallback", () => {
  const image = {
    type: "image",
    mediaType: "image/webp",
    data: "UklGRg==",
  };
  assert.deepEqual(
    validateSiteToolResult(
      {
        kind: "content",
        content: [{ type: "text", text: "A small blue circle." }, image],
      },
      ["text", "image"],
    ).content[1],
    image,
  );
  assert.throws(
    () =>
      validateSiteToolResult({ kind: "content", content: [image] }, ["image"]),
    /text fallback/,
  );
  // A non-array `content` is a protocol error, not an internal TypeError.
  for (const malformed of ["hello", null, { type: "text" }])
    assert.throws(
      () =>
        validateSiteToolResult({ kind: "content", content: malformed }, [
          "text",
        ]),
      (error) =>
        error.code === "INVALID_REQUEST" &&
        /kind: "content"/.test(error.message),
    );
  assert.throws(
    () =>
      validateSiteToolResult(
        {
          kind: "content",
          content: [{ type: "text", text: "  " }, image],
        },
        ["text", "image"],
      ),
    /non-empty text fallback/,
  );
  assert.throws(
    () =>
      validateSiteToolResult(
        { kind: "content", content: [{ type: "text", text: "ok" }, image] },
        ["text"],
      ),
    /undeclared/,
  );
  assert.throws(
    () =>
      validateSiteToolResult(
        {
          kind: "content",
          content: [
            { type: "text", text: "fallback" },
            { type: "image", mediaType: "image/svg+xml", data: "PHN2Zz4=" },
          ],
        },
        ["text", "image"],
      ),
    /supported image type/,
  );
  assert.throws(
    () =>
      validateSiteToolResult(
        {
          kind: "content",
          content: Array.from({ length: 9 }, () => ({
            type: "text",
            text: "part",
          })),
        },
        ["text"],
      ),
    /1 to 8 parts/,
  );
  assert.throws(() => validateSiteToolResult("x".repeat(65_537)), /too large/);
  assert.equal(validateSiteToolResult({ legacy: true }).legacy, true);
});

test("tool output modes are normalized into the fingerprinted site contract", () => {
  const manifest = validateSiteManifest({
    name: "Canvas",
    tools: [
      {
        name: "look",
        outputContent: ["text", "image"],
        inputSchema: { type: "object", additionalProperties: false },
      },
    ],
  });
  assert.deepEqual(manifest.tools[0].outputContent, ["text", "image"]);
  assert.throws(
    () =>
      validateSiteManifest({
        name: "Canvas",
        tools: [{ name: "look", outputContent: ["image", "image"] }],
      }),
    /unique/,
  );
  assert.throws(
    () =>
      validateSiteManifest({
        name: "Canvas",
        tools: [{ name: "look", outputContent: ["image"] }],
      }),
    /text whenever image/,
  );
});

test("provider endpoints require TLS except loopback", () => {
  assert.equal(
    providerOrigin("https://api.example.com/v1"),
    "https://api.example.com",
  );
  assert.equal(
    providerOrigin("http://localhost:8080/v1"),
    "http://localhost:8080",
  );
  assert.throws(() => providerOrigin("http://api.example.com/v1"), /HTTPS/);
  assert.throws(
    () => providerOrigin("https://secret@example.com/v1?key=value"),
    /credentials/,
  );
});

test("malformed context and tool call envelopes produce INVALID_REQUEST", () => {
  for (const context of [42, {}, false])
    assert.throws(
      () => validateAccessRequest({ capabilities: ["context.read"], context }),
      (error) => error.code === "INVALID_REQUEST",
    );
  for (const toolCalls of [
    {},
    [null],
    [{ id: "x", type: "function", function: { name: "ok" } }],
  ])
    assert.throws(
      () =>
        validateGenerateRequest({
          messages: [{ role: "assistant", content: "", toolCalls }],
        }),
      (error) => error.code === "INVALID_REQUEST",
    );
  assert.throws(
    () =>
      validateGenerateRequest({
        messages: [{ role: "tool", content: "no id" }],
      }),
    /toolCallId/,
  );
});

test("tool schemas reject unsupported assertions and enforce supported nested arguments", async () => {
  const { validateArguments } = await import("../src/lib/schema.js");
  for (const inputSchema of [
    "not a schema",
    { $ref: "https://untrusted.test/schema" },
    { type: "object", properties: { x: { pattern: "unsafe" } } },
  ])
    assert.throws(
      () =>
        validateSiteManifest({
          name: "Schema",
          tools: [{ name: "echo", inputSchema }],
        }),
      (error) => error.code === "INVALID_REQUEST",
    );
  const schema = {
    type: "object",
    required: ["values"],
    additionalProperties: false,
    properties: {
      values: {
        type: "array",
        minItems: 1,
        items: { type: "integer", minimum: 1, maximum: 3 },
      },
    },
  };
  assert.deepEqual(validateArguments({ values: [1, 3] }, schema), {
    values: [1, 3],
  });
  for (const value of [
    {},
    { values: [] },
    { values: [4] },
    { values: [1], extra: true },
  ])
    assert.throws(
      () => validateArguments(value, schema),
      (error) => error.code === "TOOL_ERROR",
    );
});

test("JSON result limits count UTF-8 bytes", async () => {
  const { cloneJson } = await import("../src/lib/validation.js");
  assert.equal(cloneJson("x".repeat(65534), "result").length, 65534);
  assert.throws(() => cloneJson("界".repeat(30000), "result"), /too large/);
});

test("access levels expand to capability bundles and unknown levels are rejected", () => {
  assert.deepEqual(
    validateAccessRequest({ level: "completion" }).capabilities,
    ["models.list", "models.generate"],
  );
  assert.deepEqual(
    validateAccessRequest({}).capabilities,
    ["models.list", "models.generate"],
    "a bare request defaults to level 1",
  );
  assert.throws(() => validateAccessRequest({ capabilities: [] }), /non-empty/);
  assert.deepEqual(
    validateAccessRequest({
      level: "catalog",
      capabilities: ["context.read"],
      context: ["title"],
    }).capabilities,
    ["models.list", "models.generate", "models.catalog", "context.read"],
  );
  assert.throws(() => validateAccessRequest({ level: "root" }), /level must/);
});

test("user messages accept bounded text and image parts; other roles do not", () => {
  const image = { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" };
  const valid = validateGenerateRequest({
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "what is this" }, image],
      },
    ],
  });
  assert.deepEqual(valid.messages[0].content[1], image);
  assert.throws(
    () =>
      validateGenerateRequest({
        messages: [{ role: "assistant", content: [image] }],
      }),
    /only for user messages/,
  );
  assert.throws(
    () =>
      validateGenerateRequest({
        messages: [
          { role: "user", content: [{ ...image, mediaType: "image/svg+xml" }] },
        ],
      }),
    /supported image type/,
  );
  assert.throws(
    () =>
      validateGenerateRequest({
        messages: [
          { role: "user", content: [{ ...image, data: "not base64!" }] },
        ],
      }),
    /base64/,
  );
  assert.throws(
    () =>
      validateGenerateRequest({
        messages: [{ role: "user", content: Array(5).fill(image) }],
      }),
    /at most 4 images/,
  );
});

test("widget options are validated and defaulted", () => {
  const manifest = validateSiteManifest({
    name: "Widget",
    widget: {
      placeholder: "Ask…",
      toolCallView: "detailed",
      suggestions: ["One", "Two"],
      theme: { accent: "#ABCDEF", mode: "dark" },
      controls: [
        { id: "verbose", type: "toggle", label: "Verbose" },
        {
          id: "tone",
          type: "select",
          label: "Tone",
          options: [{ value: "a" }, { value: "b", label: "B" }],
          default: "zzz",
          model: false,
        },
        { id: "go", type: "button", label: "Go" },
      ],
    },
  });
  assert.equal(manifest.widget.theme.accent, "#abcdef");
  assert.equal(manifest.widget.toolCallView, "detailed");
  assert.deepEqual(manifest.widget.suggestions, ["One", "Two"]);
  assert.equal(manifest.widget.controls[0].default, false);
  assert.equal(manifest.widget.controls[1].default, "a");
  assert.equal(manifest.widget.controls[1].model, false);
  assert.deepEqual(
    validateControlValues(manifest.widget.controls, { verbose: true }),
    { verbose: true, tone: "a" },
  );
  assert.throws(
    () => validateControlValues(manifest.widget.controls, { tone: "nope" }),
    /unknown option/,
  );
  for (const controls of [
    [{ id: "Bad Id", type: "toggle", label: "x" }],
    [
      { id: "a", type: "toggle", label: "x" },
      { id: "a", type: "toggle", label: "y" },
    ],
    [{ id: "a", type: "slider", label: "x" }],
    [{ id: "a", type: "select", label: "x", options: [] }],
    Array.from({ length: 9 }, (_, i) => ({
      id: `c${i}`,
      type: "toggle",
      label: "x",
    })),
  ])
    assert.throws(() =>
      validateSiteManifest({ name: "Widget", widget: { controls } }),
    );
  assert.throws(
    () =>
      validateSiteManifest({ name: "W", widget: { theme: { accent: "red" } } }),
    /rrggbb/,
  );
  assert.equal(
    validateSiteManifest({ name: "W" }).widget.toolCallView,
    "compact",
  );
  assert.throws(
    () =>
      validateSiteManifest({
        name: "W",
        widget: { toolCallView: "hidden" },
      }),
    /compact or detailed/,
  );
});
