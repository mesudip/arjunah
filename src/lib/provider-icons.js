// One provider-artwork table for every surface that draws a provider: the
// popup's wallet cards and site chips, and the hosted widget's model picker,
// which receives the resolved icon with its model list because a content
// script cannot import this module. The options page draws text-only pickers
// and does not use it yet. The files are bundled (see
// icons/providers/README.md); nothing here is ever fetched from a remote origin.
const PROVIDER_ICONS = Object.freeze({
  openai: "icons/providers/openai.svg",
  "claude-code": "icons/providers/claude.svg",
  codex: "icons/providers/codex.png",
  "opencode-api": "icons/providers/opencode.svg",
  "opencode-cli": "icons/providers/opencode.svg",
});

// The two OpenCode surfaces share one official mark, so the badge is what
// tells the hosted Zen API apart from the CLI on this computer.
const PROVIDER_BADGES = Object.freeze({ "opencode-api": "API" });

/** `{ src, badge? }` for a provider id, or null when we ship no artwork. */
export function providerIcon(providerId, { badges = true } = {}) {
  const path = PROVIDER_ICONS[providerId];
  if (!path) return null;
  const badge = badges ? PROVIDER_BADGES[providerId] : null;
  return {
    src: chrome.runtime.getURL(path),
    ...(badge ? { badge } : {}),
  };
}

/**
 * An `<span class="provider-mark">` holding the provider's artwork, or null.
 * Extension pages share `theme.css`, so the same class styles it everywhere.
 */
export function providerMark(providerId, options) {
  const icon = providerIcon(providerId, options);
  if (!icon) return null;
  const mark = document.createElement("span");
  mark.className = "provider-mark";
  mark.setAttribute("aria-hidden", "true");
  const image = document.createElement("img");
  image.src = icon.src;
  image.alt = "";
  mark.append(image);
  if (icon.badge) {
    const badge = document.createElement("span");
    badge.className = "provider-mark-badge";
    badge.textContent = icon.badge;
    mark.append(badge);
  }
  return mark;
}
