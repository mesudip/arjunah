/**
 * Renderer helpers that need no DOM (SPEC 5.3, 7.3, 8.2). The published widget
 * build is the file the extension loads, so testing it tests both modes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import ArjunahRenderer from "../packages/widget/dist/renderer.js";

const { flattenMentions, userInputMatches, compactNumber } = ArjunahRenderer;

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
