// SPDX-License-Identifier: MIT
export const VERSION = "1.0.0";
export const CAPABILITIES = Object.freeze([
  "models.list",
  "models.generate",
  "models.catalog",
  "context.read",
  "chat.hosted",
  "tools.site",
  "tools.mcp",
]);
// Access levels are named capability bundles (SPEC section 4).
export const LEVELS = Object.freeze({
  completion: Object.freeze(["models.list", "models.generate"]),
  catalog: Object.freeze(["models.list", "models.generate", "models.catalog"]),
});
export const CONTEXT_FIELDS = Object.freeze([
  "title",
  "url",
  "selection",
  "text",
]);
export const EFFORTS = Object.freeze([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export const IMAGE_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
/**
 * The bounds of one `models.generate` request (SPEC 5.3), the one table both
 * validation and `models.list()` read: what a page is told is what it is held
 * to. Names carry their unit: `Units` are UTF-16 code units, `Bytes` UTF-8
 * bytes, and `messageUnits` covers a message's text as a whole, whether it is
 * one string or several text parts.
 */
export const GENERATE_LIMITS = Object.freeze({
  messages: 400,
  messageUnits: 180_000,
  tools: 128,
  toolDescriptionUnits: 2_000,
  toolCallsPerMessage: 32,
  toolArgumentUnits: 65_536,
  schemaBytes: 32_768,
  schemaDepth: 16,
  requestBytes: 12_000_000,
  maxTokens: 32_768,
  timeoutMs: 180_000,
});
/**
 * The desktop companion refuses more than 300 messages and keeps only the
 * first 64 tools and 500 characters of each description (`validateGenerate`
 * in desktop/lib/server.mjs). Its models report that, so a page sized to them
 * is refused here, with a reason, rather than cut short there in silence.
 */
const DESKTOP_GENERATE_LIMITS = Object.freeze({
  ...GENERATE_LIMITS,
  messages: 300,
  tools: 64,
  toolDescriptionUnits: 500,
});
/** The generate bounds for one model; `desktop` for a companion-run agent. */
export function generateLimits(desktop = false) {
  return desktop ? DESKTOP_GENERATE_LIMITS : GENERATE_LIMITS;
}
export const LIMITS = Object.freeze({
  // Hosted-chat history and site tool result text keep their own, smaller
  // per-message bound; a page's own requests are sized by GENERATE_LIMITS.
  messageChars: 12_000,
  contentParts: 8,
  imagesPerMessage: 4,
  imageChars: 2_000_000,
  requestBytes: GENERATE_LIMITS.requestBytes,
  providerResponseBytes: 2_000_000,
  // A streamed response has no total cap, since every token carries its own
  // JSON envelope. Each event is parsed and dropped, so only one event is ever
  // held at a time, and this bounds that one (a finished image can be large).
  providerEventBytes: 8_000_000,
  // Thinking arrives a token at a time. The background merges it for this long
  // before one message crosses to the widget, instead of one per token.
  reasoningBatchMs: 250,
  reasoningBatchChars: 4_000,
  mcpResponseBytes: 1_000_000,
  schemaBytes: GENERATE_LIMITS.schemaBytes,
  toolCalls: GENERATE_LIMITS.toolCallsPerMessage,
  toolArgumentUnits: GENERATE_LIMITS.toolArgumentUnits,
  timeoutMs: 30_000,
  // A model that is still thinking is not a failed request, so a generation
  // round has no deadline of its own. After this much silence the visitor is
  // told about the wait and keeps the stop button; nothing is cancelled for
  // them. Reasoning models routinely spend longer than this before the first
  // token, and longer still once an image is in the prompt.
  stallNoticeMs: 20_000,
  // The page bridge rejects a direct `models.generate` at this point
  // (src/page-api.js), so past it nobody is waiting for the answer. A hosted
  // chat is different: it has a visitor, a stall notice, and a stop button, so
  // it stays unbounded. This bounds only the direct call whose caller is gone.
  directGenerateMs: GENERATE_LIMITS.timeoutMs,
  desktopTimeoutMs: 180_000,
  preparedMs: 300_000,
  contextText: 20_000,
  selection: 4_000,
  systemPrompt: 12_000,
  // A hosted assistant's whole tool set (site, declared, and discovered MCP
  // tools together), and the description bound its contract applies.
  tools: 64,
  toolDescriptionChars: 500,
  siteTools: 32,
  toolUserInputs: 8,
  toolUserInputChars: 4_096,
  toolUserInputRequests: 4,
  toolUserInputTimeoutMs: 120_000,
  mcpServers: 8,
  resultBytes: 64 * 1024,
  // Gemini thought signatures run ~900 chars; leave generous headroom.
  signatureChars: 8_000,
  // The provider state one assistant message may carry into a later round
  // (SPEC 5.4), serialized: signed thinking, thought signatures, encrypted
  // reasoning. Larger state is not kept, since a cut copy cannot be replayed.
  providerStateBytes: 2_000_000,
  toolRounds: 100,
  historyMessages: 40,
  widgetControls: 8,
  widgetSuggestions: 6,
  reasoningChars: 12_000,
  // A result's answer text. A page's round stream (SPEC 5.3) is held to this
  // and to `reasoningChars`, so its deltas never carry more than the result.
  answerChars: 120_000,
  // Transcript cards (SPEC 7.4).
  cardNodes: 200,
  cardDepth: 6,
  cardText: 2_000,
  cardLabel: 80,
  cardButtons: 16,
  cardFields: 16,
  cardListItems: 50,
  cardSelectOptions: 20,
  cardActionPayloadBytes: 4_096,
  // Tool progress (SPEC 7.5).
  progressChars: 200,
  progressReports: 50,
  // Site-owned threads (SPEC 7.6).
  threads: 100,
  threadEntries: 200,
  threadTitle: 120,
  threadCallbackTimeoutMs: 30_000,
  stepPreview: 2_000,
  // Declared remote tools (SPEC 7.7).
  declaredMcpTools: 64,
  // The site's own models (SPEC 15.2).
  siteModels: 8,
  // How long the visitor has to answer an approval prompt (SPEC 7.8).
  approvalTimeoutMs: 120_000,
});
