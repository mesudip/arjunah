/**
 * Ranked model search (SPEC 8.2). The options page imports `lib/search.js`; the
 * renderer keeps its own copy because it ships as a standalone classic script,
 * so both are checked against the same expectations here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { searchFilter, searchScore } from "../src/lib/search.js";

const MODELS = [
  "claude-sonnet-4-5-thinking",
  "gpt-5-codex-mini",
  "claude-sonnet-4-5",
  "gpt-5",
  "gpt-5-codex",
  "o3-mini",
  "claude-opus-4-1",
  "gemini-2.5-pro",
  "gpt-4o-mini",
  "gpt-4o",
];
const rank = (query) => searchFilter(MODELS, query, (model) => [model]);

test("an exact name outranks the variants built on it", () => {
  assert.deepEqual(rank("gpt-5"), ["gpt-5", "gpt-5-codex", "gpt-5-codex-mini"]);
  assert.deepEqual(rank("gpt-4o"), ["gpt-4o", "gpt-4o-mini"]);
});

test("a match at a word boundary outranks one buried mid-word", () => {
  // "mini" starts a word in the first three and hides inside "gemini" in the last.
  assert.deepEqual(rank("mini"), [
    "o3-mini",
    "gpt-4o-mini",
    "gpt-5-codex-mini",
    "gemini-2.5-pro",
  ]);
});

test("every word must match, so typing more narrows", () => {
  assert.deepEqual(rank("gpt mini"), ["gpt-4o-mini", "gpt-5-codex-mini"]);
  assert.deepEqual(rank("gpt zzz"), []);
});

test("an empty query keeps the caller's own order", () => {
  assert.deepEqual(rank("   "), MODELS);
});

test("the display name outranks the raw id on an equal match", () => {
  const byName = searchScore(
    ["Sonnet 4.5", "anthropic/claude-sonnet"],
    "sonnet",
  );
  const byId = searchScore(["Claude", "sonnet"], "sonnet");
  assert.ok(byName > 0 && byId > 0);
  assert.ok(
    searchScore(["sonnet", "x"], "sonnet") >
      searchScore(["x", "sonnet"], "sonnet"),
  );
});

test("a search matching nothing scores zero rather than ranking last", () => {
  assert.equal(searchScore(["gpt-5", "gpt-5"], "claude"), 0);
});
