export const OPENCODE_PROVIDER_ID = "opencode";
export const OPENCODE_BASE_URL = "https://opencode.ai/zen/v1";
export const OPENCODE_DEFAULT_MODEL = "gpt-5.6-luna";

/**
 * Why a model in Zen's catalog cannot be offered here, or null when it can.
 *
 * Zen publishes one catalog for every surface it has, so the HTTP API lists
 * models an API key is not allowed to call. Both classes below were confirmed
 * against the live service rather than inferred from the docs.
 */
export function opencodeUnusableReason(model) {
  // The `-free` tier is refused over HTTP on every route with 403 FreeTierError,
  // "OpenCode's free tier can only be used from within OpenCode". No API key,
  // paid or not, can call these.
  if (/-free$/.test(model))
    return "OpenCode's free tier can only be used from inside the OpenCode app, not through an API key.";
  // System One is not a conversational API at all.
  if (/^jev-/.test(model))
    return "This OpenCode model does not provide a conversational API.";
  return null;
}

// Zen routes model families through different wire protocols, so each family
// must be sent the payload its own API documents. A model this key cannot call
// returns null and stays out of the catalog rather than being offered and then
// failing at the first turn.
export function opencodeProtocol(model) {
  if (opencodeUnusableReason(model)) return null;
  if (/^(?:gpt-|grok-|muse-spark-)/.test(model)) return "responses";
  if (/^(?:claude-|qwen)/.test(model)) return "anthropic";
  if (/^gemini-/.test(model)) return "gemini";
  return "chat-completions";
}

/**
 * The model to select when the user has not chosen one. Zen's catalog is a live
 * list, so the preferred id is a hint rather than a guarantee: it is used only
 * when the account actually offers it, and otherwise the first conversational
 * model of the account's own catalog wins.
 */
export function opencodePreferredModel(models) {
  const usable = (Array.isArray(models) ? models : []).filter(
    (model) => typeof model === "string" && opencodeProtocol(model),
  );
  return (
    usable.find((model) => model === OPENCODE_DEFAULT_MODEL) ??
    usable.find((model) => opencodeProtocol(model) === "responses") ??
    usable[0] ??
    null
  );
}

// How each vendor writes its own name, and whether the version hangs off it
// with a hyphen (GPT-5.6, GLM-5.3) or a space (Claude Sonnet 4.6, Grok 4.5).
const BRANDS = Object.freeze({
  gpt: ["GPT", "-"],
  glm: ["GLM", "-"],
  deepseek: ["DeepSeek", "-"],
  minimax: ["MiniMax", " "],
  mimo: ["MiMo", " "],
  kimi: ["Kimi", " "],
  qwen: ["Qwen", " "],
  grok: ["Grok", " "],
  jev: ["Jev", " "],
});

/**
 * "claude-sonnet-4-6" → "Claude Sonnet 4.6"; "gpt-5.6-luna" → "GPT-5.6 Luna".
 * Zen splits a version across segments (`-4-6`), so a bare number following a
 * number rejoins it as a decimal instead of reading as two separate words.
 */
export function opencodeDisplayName(model) {
  const parts = String(model).split("-").filter(Boolean);
  const words = [];
  for (const [index, part] of parts.entries()) {
    const brand = index === 0 ? BRANDS[part.toLowerCase()] : null;
    if (brand) {
      words.push(brand);
      continue;
    }
    const previous = words.at(-1);
    // A lone number after a number is the rest of one version, not a new word.
    if (/^\d+$/.test(part) && /\d$/.test(previous?.[0] ?? "")) {
      previous[0] += `.${part}`;
      continue;
    }
    words.push([
      /^v\d/i.test(part)
        ? `V${part.slice(1)}`
        : part.charAt(0).toUpperCase() + part.slice(1),
      " ",
    ]);
  }
  return words
    .map(([text, joiner], index) =>
      index === words.length - 1 ? text : text + joiner,
    )
    .join("");
}

export function opencodeCapabilities(model) {
  const protocol = opencodeProtocol(model);
  const vision =
    (["responses", "anthropic", "gemini"].includes(protocol) &&
      model !== "gpt-5.3-codex-spark") ||
    /(?:vision|vl)(?:-|$)/i.test(model) ||
    /^(?:deepseek-v4\.1-flash|glm-5\.3-flash|minimax-m3|kimi-(?:k2\.[5-7]|k3)|mimo-v2\.5)/i.test(
      model,
    );
  return {
    tools: true,
    vision,
    reasoning:
      protocol === "responses" ||
      /^(?:deepseek|glm|kimi|minimax|mimo)-/i.test(model),
  };
}

export function opencodeReasoningLevels(model) {
  if (!opencodeCapabilities(model).reasoning) return [];
  return opencodeProtocol(model) === "responses"
    ? ["none", "low", "medium", "high"]
    : ["low", "medium", "high"];
}
