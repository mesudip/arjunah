/**
 * Ranked substring search for the model pickers.
 *
 * Model names are long, repetitive, and share prefixes ("claude-sonnet-4-5",
 * "claude-sonnet-4-5-thinking"), so plain `includes` filtering buries the entry
 * the user meant under its own variants. Ranking fixes the order: an exact name
 * first, then a match at the start, then one at a word boundary, then one
 * anywhere, and among equals the entry the query covers more of.
 *
 * `src/renderer/core.js` carries a copy of this, because the renderer ships as a
 * standalone classic script and cannot import. Change both together.
 */

/** Anything that is not a letter or a digit starts a new word in a model id. */
const SEPARATOR = /[^a-z0-9]/;

export function searchWords(query) {
  return String(query ?? "")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
}

function wordScore(text, word) {
  const haystack = String(text ?? "").toLowerCase();
  if (!haystack) return 0;
  const at = haystack.indexOf(word);
  if (at < 0) return 0;
  const rank =
    haystack === word
      ? 800
      : at === 0
        ? 600
        : SEPARATOR.test(haystack[at - 1])
          ? 400
          : 200;
  // Ties break towards the entry the query covers more of, then towards the
  // earlier match: for "sonnet", "claude-sonnet-4-5" beats the -thinking variant.
  return (
    rank +
    Math.round((word.length / haystack.length) * 100) -
    Math.min(at, 80) / 10
  );
}

/**
 * How well one entry answers the query, or 0 when it does not. Fields are given
 * best-first (display name before raw id); every word must match some field, so
 * typing more always narrows.
 */
export function searchScore(fields, query) {
  const words = searchWords(query);
  if (!words.length) return 0;
  let total = 0;
  for (const word of words) {
    let best = 0;
    fields.forEach((field, index) => {
      const score = wordScore(field, word);
      if (score) best = Math.max(best, score - index * 25);
    });
    if (!best) return 0;
    total += best;
  }
  return total / words.length;
}

/**
 * The entries that match, best first. An empty query keeps the caller's own
 * order, which is the grouping the picker already arranged.
 */
export function searchFilter(items, query, fieldsOf) {
  if (!searchWords(query).length) return items.slice();
  return items
    .map((item, order) => ({
      item,
      order,
      score: searchScore(fieldsOf(item), query),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((row) => row.item);
}
