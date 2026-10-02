/**
 * The options page address `window.ai.arjunah.openSettings()` opens when the
 * toolbar popup cannot be (SPEC 3): `options.html#grants:<encoded origin>`.
 * The origin is the sender's, taken by the background, never by the page, and
 * the address stays inside the extension, so nothing reaches the page.
 */
const PREFIX = "#grants:";

export function grantsHash(origin) {
  return `${PREFIX}${encodeURIComponent(origin)}`;
}

/**
 * The site a `#grants:` address names, or null for anything that is not one
 * exact http(s) origin. The options page only ever looks this up among its
 * own grants and shows it as text.
 */
export function originFromHash(hash) {
  if (typeof hash !== "string" || !hash.startsWith(PREFIX)) return null;
  let text;
  try {
    text = decodeURIComponent(hash.slice(PREFIX.length));
  } catch {
    return null;
  }
  try {
    const url = new URL(text);
    return ["http:", "https:"].includes(url.protocol) && url.origin === text
      ? text
      : null;
  } catch {
    return null;
  }
}
