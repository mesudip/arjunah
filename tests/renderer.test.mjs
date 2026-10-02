/**
 * Renderer helpers that need no DOM (SPEC 5.3, 7.3, 7.8, 8.2). The published widget
 * build is the file the extension loads, so testing it tests both modes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import ArjunahRenderer from "../packages/widget/dist/renderer.js";

const {
  flattenMentions,
  userInputMatches,
  userInputDeclaration,
  approvalPrompt,
  compactNumber,
} = ArjunahRenderer;

test("mentions reach a provider as their label and never as an id", () => {
  assert.deepEqual(
    flattenMentions([
      { type: "text", text: "Compare " },
      { type: "mention", id: "machine:12", label: "web-01" },
      { type: "text", text: " and " },
      { type: "mention", id: "machine:13", label: "web-02" },
    ]),
    [{ type: "text", text: "Compare @web-01 and @web-02" }],
  );
  const image = { type: "image", mediaType: "image/png", data: "AAA" };
  assert.deepEqual(
    flattenMentions([
      { type: "mention", id: "city:lis", label: "Lisbon" },
      image,
    ]),
    [{ type: "text", text: "@Lisbon" }, image],
  );
  // A string content stays a string, and nothing is mutated in place.
  assert.equal(flattenMentions("plain"), "plain");
  const parts = [
    { type: "text", text: "a" },
    { type: "mention", id: "x", label: "b" },
  ];
  flattenMentions(parts);
  assert.equal(parts[0].text, "a");
});

test("collected inputs are validated against their declared scalar schema", () => {
  assert.equal(
    userInputMatches("secret", { type: "string", minLength: 3 }),
    true,
  );
  assert.equal(userInputMatches("no", { type: "string", minLength: 3 }), false);
  assert.equal(userInputMatches(7, { type: "string" }), false);
  assert.equal(userInputMatches("x".repeat(4097), { type: "string" }), false);
  assert.equal(userInputMatches(true, { type: "boolean" }), true);
  assert.equal(userInputMatches(1, { type: "boolean" }), false);
  assert.equal(userInputMatches(4, { type: "integer", maximum: 4 }), true);
  assert.equal(userInputMatches(4.5, { type: "integer" }), false);
  assert.equal(userInputMatches(9, { type: "number", maximum: 4 }), false);
  assert.equal(userInputMatches("b", { type: "string", enum: ["a"] }), false);
  assert.equal(userInputMatches("a", { type: "string", const: "a" }), true);
});

test("the model picker labels context windows compactly", () => {
  assert.equal(compactNumber(272000), "272k");
  assert.equal(compactNumber(8000), "8.0k");
  assert.equal(compactNumber(128000), "128k");
  assert.equal(compactNumber(2_000_000), "2.0M");
  assert.equal(compactNumber(0), "0");
});

test("a streamed input declaration is checked like a site tool's (SPEC 7.3)", () => {
  const otp = {
    id: "otp",
    label: "One-time code",
    schema: { type: "string", minLength: 6, maxLength: 6 },
    secret: true,
  };
  assert.deepEqual(userInputDeclaration(otp), {
    id: "otp",
    label: "One-time code",
    description: "",
    schema: { type: "string", minLength: 6, maxLength: 6 },
    secret: true,
  });
  // An unbounded string gets the protocol's ceiling.
  assert.equal(
    userInputDeclaration({ id: "a", label: "A", schema: { type: "string" } })
      .schema.maxLength,
    4096,
  );
  for (const bad of [
    null,
    { ...otp, id: "Bad" },
    { ...otp, label: "" },
    { ...otp, label: "x".repeat(81) },
    { ...otp, description: "x".repeat(281) },
    { ...otp, schema: { type: "object" } },
    { ...otp, schema: { type: "string", pattern: "^a" } },
    { ...otp, schema: { type: "string", minLength: 7, maxLength: 6 } },
    { ...otp, schema: { type: "string", minLength: 5000 } },
    { ...otp, schema: { type: "boolean", minimum: 1 } },
    { ...otp, schema: { type: "integer", enum: [1, 1.5] } },
    { ...otp, schema: { type: "string", enum: ["a"] } },
    { id: "n", label: "N", schema: { type: "number" }, secret: true },
  ])
    assert.equal(userInputDeclaration(bad), null, JSON.stringify(bad));
  // The declaration is a copy: changing the original changes nothing.
  const declared = userInputDeclaration(otp);
  otp.schema.minLength = 1;
  assert.equal(declared.schema.minLength, 6);
});

test("an approval prompt keeps the SPEC 7.8 bounds and carries only text", () => {
  assert.deepEqual(
    approvalPrompt({
      title: "Deploy",
      summary: "Ship build 42.",
      danger: true,
    }),
    {
      title: "Deploy",
      summary: "Ship build 42.",
      target: "",
      detail: "",
      danger: true,
    },
  );
  // Bounds count code points, so an astral character is one, not two.
  assert.ok(approvalPrompt({ title: "🚀".repeat(80), summary: "s" }));
  for (const bad of [
    { title: "x".repeat(81), summary: "s" },
    { title: "t", summary: "x".repeat(281) },
    { title: "t", summary: "s", target: "x".repeat(81) },
    { title: "t", summary: "s", detail: "x".repeat(4001) },
    { title: "", summary: "s" },
    { title: "t" },
    { title: "t", summary: "s", danger: "yes" },
    { title: 1, summary: "s" },
    ["t", "s"],
  ])
    assert.equal(approvalPrompt(bad), null, JSON.stringify(bad));
  // Direction overrides cannot reorder what the visitor reads.
  assert.equal(
    approvalPrompt({ title: "Pay \u202emoc.live", summary: "s" }).title,
    "Pay moc.live",
  );
});
