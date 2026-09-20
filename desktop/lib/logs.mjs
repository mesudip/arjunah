/**
 * The companion's own diagnostic log: a bounded ring buffer the dashboard and a
 * paired browser can read so a long wait is explainable instead of mysterious.
 *
 * Entries are metadata only. Prompts, model output, tool arguments, pairing
 * codes, and bearer tokens MUST NOT reach this buffer; callers pass short
 * descriptions such as "codex: launching the CLI" and nothing more.
 */
export const LOG_LEVELS = ["debug", "info", "warn", "error"];
const MESSAGE_LIMIT = 500;

export class LogBuffer {
  constructor({ limit = 600, sink = () => {} } = {}) {
    this.limit = limit;
    this.sink = sink;
    this.entries = [];
    this.seq = 0;
  }

  add(level, source, message) {
    const entry = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      level: LOG_LEVELS.includes(level) ? level : "info",
      source: String(source ?? "app").slice(0, 40),
      message: String(message ?? "").slice(0, MESSAGE_LIMIT),
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit)
      this.entries.splice(0, this.entries.length - this.limit);
    try {
      this.sink(entry);
    } catch {
      /* a failing console must never break a run */
    }
    return entry;
  }

  /** Entries newer than `after` (a seq), oldest first. */
  since(after = 0, limit = 200) {
    const from = Number.isFinite(after) ? after : 0;
    return this.entries
      .filter((entry) => entry.seq > from)
      .slice(-Math.max(1, Math.min(limit, this.limit)));
  }

  clear() {
    this.entries = [];
  }
}
