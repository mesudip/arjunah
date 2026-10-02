/**
 * Conversation ids (SPEC 5.4). The background mints one per conversation for
 * one origin, and checks it on every request that carries it, without keeping
 * a list of the ids it handed out:
 *
 *   id  = base64url(nonce) "." base64url(tag)
 *   tag = HMAC-SHA-256(installKey, origin "\n" base64url(nonce)), first 16 bytes
 *
 * `nonce` is 16 random bytes and `installKey` a random key made once per
 * install, kept in `chrome.storage.local`, never synced and never shown to a
 * page. A page therefore cannot choose an id, and an id minted for one origin
 * does not verify for another.
 */
export const INSTALL_KEY_BYTES = 32;
const ID = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/;

export function base64url(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The raw bytes of a base64url string, or null when it is not one. */
export function fromBase64url(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export function importInstallKey(raw) {
  return crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function tag(key, origin, nonce) {
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${origin}\n${nonce}`),
  );
  return base64url(new Uint8Array(mac).slice(0, 16));
}

export async function mintConversationId(key, origin) {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  return `${nonce}.${await tag(key, origin, nonce)}`;
}

/** True only for an id this install minted for exactly this origin. */
export async function verifyConversationId(key, origin, id) {
  const match = typeof id === "string" ? ID.exec(id) : null;
  if (!match) return false;
  const expected = await tag(key, origin, match[1]);
  // Both are 22 characters; compared in full, whatever differs first.
  let difference = 0;
  for (let index = 0; index < expected.length; index++)
    difference |= expected.charCodeAt(index) ^ match[2].charCodeAt(index);
  return difference === 0;
}

/**
 * The desktop companion thread id for one page conversation (SPEC 12.3.1):
 * `base64url(HMAC-SHA-256(installKey, "desktop\n" origin "\n" conversation))`,
 * first 24 bytes, so it fits the companion's `^[A-Za-z0-9_-]{1,100}$`.
 * Companion thread ids are not origin-scoped; deriving one per origin and
 * conversation means a page can neither choose nor guess another's.
 */
export async function desktopThreadId(key, origin, conversation) {
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`desktop\n${origin}\n${conversation}`),
  );
  return base64url(new Uint8Array(mac).slice(0, 24));
}
