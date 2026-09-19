import test from "node:test";
import assert from "node:assert/strict";
import { validateCard, validateCardValues } from "../src/lib/cards.js";
import {
  validateSiteToolResult,
  validateSiteManifest,
  validateMcpServer,
  contentText,
} from "../src/lib/validation.js";
import { LIMITS } from "../src/lib/constants.js";

const textNode = (text = "hello") => ({ type: "text", text });
const card = (...children) => ({ type: "card", children });

test("cards accept the declared node set and reject everything else", () => {
  const validated = validateCard(
    card(
      { type: "text", text: "Pick a seat", style: "heading" },
      {
        type: "list",
        items: [{ title: "12A", action: { type: "local", name: "pick" } }],
      },
      {
        type: "form",
        id: "booking",
        action: { type: "message", text: "Book it" },
        fields: [
          { type: "input", id: "name", label: "Name", required: true },
          {
            type: "select",
            id: "meal",
            label: "Meal",
            options: [{ value: "veg" }, { value: "none", label: "None" }],
          },
          { type: "checkbox", id: "window", label: "Window", default: true },
        ],
      },
      {
        type: "button",
        label: "Cancel",
        action: { type: "local", name: "cancel" },
        style: "danger",
      },
    ),
  );
  assert.equal(validated.children.length, 4);
  assert.equal(validated.children[2].fields[1].default, "veg");
  assert.equal(validated.children[2].fields[2].default, true);
  for (const bad of [
    {
      type: "card",
      children: [{ type: "image", url: "https://x.test/a.png" }],
    },
    { type: "card", children: [{ type: "link", href: "https://x.test" }] },
    { type: "card", children: [{ type: "html", html: "<b>x</b>" }] },
    { type: "card", children: [] },
    { type: "card", children: [{ type: "button", label: "Go" }] },
    {
      type: "card",
      children: [
        { type: "button", label: "Go", action: { type: "tool", name: "x" } },
      ],
    },
    {
      type: "card",
      children: [
        {
          type: "form",
          id: "A",
          action: { type: "local", name: "x" },
          fields: [],
        },
      ],
    },
    { children: [textNode()] },
  ])
    assert.throws(
      () => validateCard(bad),
      /INVALID_REQUEST|card/i,
      JSON.stringify(bad),
    );
});

test("card bounds are enforced on nodes, buttons, fields, and payloads", () => {
  const many = (count, node) => card(...Array.from({ length: count }, node));
  assert.throws(
    () => validateCard(many(LIMITS.cardNodes + 1, () => textNode())),
    /at most 200 nodes/,
  );
  assert.throws(
    () =>
      validateCard(
        many(LIMITS.cardButtons + 1, (_, i) => ({
          type: "button",
          label: `b${i}`,
          action: { type: "local", name: "x" },
        })),
      ),
    /at most 16 buttons/,
  );
  assert.throws(
    () =>
      validateCard(
        card({
          type: "form",
          id: "f",
          action: { type: "local", name: "x" },
          fields: Array.from({ length: LIMITS.cardFields + 1 }, (_, i) => ({
            type: "input",
            id: `f${i}`,
            label: "x",
          })),
        }),
      ),
    /at most 16 form fields/,
  );
  assert.throws(
    () => validateCard(card(textNode("x".repeat(LIMITS.cardText + 1)))),
    /at most 2000 characters/,
  );
  assert.throws(
    () =>
      validateCard(
        card({
          type: "button",
          label: "go",
          action: {
            type: "local",
            name: "x",
            payload: { blob: "x".repeat(LIMITS.cardActionPayloadBytes) },
          },
        }),
      ),
    /too large/,
  );
});

test("card form values are checked against the declared fields", () => {
  const fields = [
    { type: "input", id: "name", label: "Name", required: true, default: "" },
    {
      type: "select",
      id: "meal",
      label: "Meal",
      options: [{ value: "veg", label: "veg" }],
      default: "veg",
    },
    { type: "checkbox", id: "window", label: "Window", default: false },
  ];
  assert.deepEqual(
    validateCardValues(fields, { name: "Ada", meal: "veg", window: true }),
    { name: "Ada", meal: "veg", window: true },
  );
  assert.throws(
    () => validateCardValues(fields, { name: "", meal: "veg", window: true }),
    /required/,
  );
  assert.throws(
    () =>
      validateCardValues(fields, { name: "Ada", meal: "steak", window: true }),
    /unknown option/,
  );
  assert.throws(
    () =>
      validateCardValues(fields, { name: "Ada", meal: "veg", window: "yes" }),
    /boolean/,
  );
});

test("card tool results need a declaration and a text fallback, and the model sees only text", () => {
  const declared = ["text", "card"];
  const result = validateSiteToolResult(
    {
      kind: "content",
      content: [
        { type: "text", text: "Seat map for flight 42." },
        { type: "card", card: card(textNode("12A")) },
      ],
    },
    declared,
  );
  assert.equal(result.content.at(-1).type, "card");
  // The tool message the model receives never contains the card.
  assert.equal(contentText(result.content), "Seat map for flight 42.");
  assert.throws(
    () =>
      validateSiteToolResult(
        {
          kind: "content",
          content: [
            { type: "text", text: "x" },
            { type: "card", card: card(textNode()) },
          ],
        },
        ["text"],
      ),
    /undeclared content type/,
  );
  assert.throws(
    () =>
      validateSiteToolResult(
        {
          kind: "content",
          content: [{ type: "card", card: card(textNode()) }],
        },
        declared,
      ),
    /text fallback/,
  );
  assert.throws(
    () =>
      validateSiteToolResult(
        {
          kind: "content",
          content: [
            { type: "text", text: "x" },
            { type: "card", card: card(textNode()) },
            { type: "card", card: card(textNode()) },
          ],
        },
        declared,
      ),
    /one card/,
  );
});

test("outputContent accepts card only alongside text", () => {
  const manifest = (outputContent) => ({
    name: "Site",
    tools: [{ name: "t", inputSchema: { type: "object" }, outputContent }],
  });
  assert.deepEqual(
    validateSiteManifest(manifest(["text", "card"])).tools[0].outputContent,
    ["text", "card"],
  );
  for (const bad of [["card"], ["card", "card"], ["text", "widget"]])
    assert.throws(() => validateSiteManifest(manifest(bad)), /outputContent/);
});

test("declared remote tools join the contract and keep the schema subset", () => {
  const server = validateMcpServer({
    id: "backend",
    url: "https://api.example.test/mcp",
    tools: [
      {
        name: "charge",
        description: "Charge the saved card",
        inputSchema: {
          type: "object",
          properties: { amount: { type: "integer", minimum: 1 } },
          required: ["amount"],
          additionalProperties: false,
        },
      },
    ],
  });
  assert.equal(server.tools.length, 1);
  assert.equal(server.tools[0].description, "Charge the saved card");
  assert.throws(
    () => validateMcpServer({ id: "b", url: "https://a.test/mcp", tools: [] }),
    /non-empty array/,
  );
  assert.throws(
    () =>
      validateMcpServer({
        id: "b",
        url: "https://a.test/mcp",
        tools: [
          {
            name: "x",
            inputSchema: {
              type: "object",
              properties: { a: { pattern: "^x$" } },
            },
          },
        ],
      }),
    /INVALID_REQUEST|pattern|unsupported/i,
  );
});

test("a site that stores conversations says so in the contract", () => {
  const stored = validateSiteManifest({
    name: "Site",
    threads: { rename: true },
  });
  assert.deepEqual(stored.threads, { rename: true });
  assert.equal(validateSiteManifest({ name: "Site" }).threads, null);
  assert.throws(
    () => validateSiteManifest({ name: "Site", threads: [] }),
    /threads must be an object/,
  );
  // Declaring storage changes the contract, so it changes the fingerprint too.
  assert.notDeepEqual(
    validateSiteManifest({ name: "Site" }),
    validateSiteManifest({ name: "Site", threads: {} }),
  );
});
