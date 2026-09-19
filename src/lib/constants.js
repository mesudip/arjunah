export const VERSION = "1.1.0";
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
export const LIMITS = Object.freeze({
  messages: 100,
  messageChars: 12_000,
  internalMessageChars: 180_000,
  internalMessages: 256,
  contentParts: 8,
  imagesPerMessage: 4,
  imageChars: 2_000_000,
  requestBytes: 12_000_000,
  providerResponseBytes: 2_000_000,
  mcpResponseBytes: 1_000_000,
  schemaBytes: 32_768,
  toolCalls: 32,
  timeoutMs: 30_000,
  desktopTimeoutMs: 180_000,
  preparedMs: 300_000,
  contextText: 20_000,
  selection: 4_000,
  systemPrompt: 12_000,
  tools: 64,
  siteTools: 32,
  toolUserInputs: 8,
  toolUserInputChars: 4_096,
  toolUserInputRequests: 4,
  toolUserInputTimeoutMs: 120_000,
  mcpServers: 8,
  resultBytes: 64 * 1024,
  toolRounds: 6,
  historyMessages: 40,
  widgetControls: 8,
  widgetSuggestions: 6,
  reasoningChars: 12_000,
});
