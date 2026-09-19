export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_MODELS = Object.freeze([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
]);
export const OPENAI_DEFAULT_MODEL = OPENAI_MODELS[0];

/** "gpt-5.6-sol" → "GPT-5.6 Sol"; unknown ids are shown as typed. */
export function openaiDisplayName(model) {
  const match = /^(gpt|o)(-?[0-9][0-9.]*)(?:-(.+))?$/i.exec(model);
  if (!match) return model;
  const family = match[1].toUpperCase();
  const suffix = (match[3] ?? "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return `${family}${match[2]}${suffix ? ` ${suffix}` : ""}`;
}
