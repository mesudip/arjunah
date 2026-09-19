import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeGuidance } from "../src/lib/desktop.js";

test("provider guidance from the desktop app is reduced to plain text and http links", () => {
  const guide = sanitizeGuidance({
    state: "signed-out",
    summary: "<b>not signed in</b>",
    steps: ["Run `claude`", 42, ...Array(10).fill("x")],
    links: [
      { label: "docs", url: "https://example.com/docs" },
      { label: "bad", url: "javascript:alert(1)" },
      { url: "http://example.com" },
    ],
    note: null,
    extra: "dropped",
  });
  assert.equal(guide.state, "signed-out");
  assert.equal(guide.summary, "<b>not signed in</b>");
  assert.equal(guide.steps.length, 8);
  assert.deepEqual(guide.steps.slice(0, 2), ["Run `claude`", "42"]);
  assert.deepEqual(guide.links, [
    { label: "docs", url: "https://example.com/docs" },
    { label: "http://example.com", url: "http://example.com" },
  ]);
  assert.equal(guide.note, null);
  assert.equal("extra" in guide, false);
});

test("unknown guidance states and shapes fall back safely", () => {
  assert.equal(sanitizeGuidance(null), null);
  assert.equal(sanitizeGuidance("text"), null);
  const guide = sanitizeGuidance({ state: "weird" });
  assert.equal(guide.state, "error");
  assert.deepEqual(guide.steps, []);
  assert.deepEqual(guide.links, []);
});
