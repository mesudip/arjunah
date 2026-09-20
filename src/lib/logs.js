/**
 * The extension's own diagnostic log, shown in settings beside the desktop
 * companion's. It exists so a slow or stuck turn can be explained instead of
 * guessed at.
 *
 * Bounded and metadata-only by contract: prompts, model output, tool arguments,
 * page content, API keys, and pairing tokens MUST NOT be logged. Callers pass
 * counts, names, model ids, durations, and error codes. The buffer lives in the
 * service worker and is mirrored to session storage so a worker restart does not
 * lose the last minutes of context; it never syncs and never leaves the browser.
 */
export const LOG_LEVELS = ["debug", "info", "warn", "error"];
export const LOG_LIMIT = 400;
const MESSAGE_LIMIT = 300;
const SESSION_KEY = "log";

let entries = [];
let seq = 0;
let saveTimer = null;

function session() {
  // `storage.session` is MV3-only; a page or an older browser simply keeps the
  // in-memory copy.
  return globalThis.chrome?.storage?.session ?? null;
}

async function restore() {
  const area = session();
  if (!area) return;
  try {
    const saved = (await area.get(SESSION_KEY))?.[SESSION_KEY];
    if (!Array.isArray(saved) || !saved.length) return;
    // Anything logged while storage was loading is newer than the saved copy.
    // Give those entries fresh sequence numbers after the restored range so a
    // service-worker wake cannot create duplicate or out-of-order cursors.
    const previous = saved.slice(-LOG_LIMIT);
    let next = Math.max(0, ...previous.map((entry) => entry?.seq ?? 0));
    const current = entries.map((entry) => ({ ...entry, seq: ++next }));
    entries = [...previous, ...current].slice(-LOG_LIMIT);
    seq = next;
  } catch {
    /* session storage is optional */
  }
}

// Start loading immediately. In particular, do not let the first event after a
// service-worker wake overwrite the previous buffer before it has been read.
const restored = restore();

function persist() {
  const area = session();
  if (!area || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void restored.then(() => {
      try {
        void area
          .set({ [SESSION_KEY]: entries.slice(-LOG_LIMIT) })
          ?.catch?.(() => {});
      } catch {
        /* quota or a closing worker */
      }
    });
  }, 500);
}

export function logEvent(level, source, message) {
  const entry = {
    seq: ++seq,
    at: Date.now(),
    level: LOG_LEVELS.includes(level) ? level : "info",
    source: String(source ?? "extension").slice(0, 40),
    message: String(message ?? "").slice(0, MESSAGE_LIMIT),
  };
  entries.push(entry);
  if (entries.length > LOG_LIMIT) entries.splice(0, entries.length - LOG_LIMIT);
  persist();
  return entry;
}

export async function logEntries(limit = LOG_LIMIT) {
  await restored;
  return entries.slice(-Math.max(1, Math.min(limit, LOG_LIMIT)));
}

export async function clearLog() {
  await restored;
  entries = [];
  try {
    await session()?.remove(SESSION_KEY);
  } catch {
    /* nothing saved */
  }
}
