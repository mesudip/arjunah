import { randomInt, timingSafeEqual } from "node:crypto";

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;

export class Pairing {
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.listeners = new Set();
    this.failures = 0;
    this.lastAttempt = 0;
    this.rotate();
  }
  rotate() {
    this.code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.expires = Date.now() + CODE_TTL_MS;
    this.failures = 0;
    this.onChange(this.code);
    for (const listener of this.listeners) listener(this.code);
    return this.code;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  current() {
    if (Date.now() > this.expires) this.rotate();
    return { code: this.code, expiresAt: new Date(this.expires).toISOString() };
  }
  /** Returns true on success; rotates the code after success or too many failures. */
  attempt(candidate) {
    const now = Date.now();
    if (now - this.lastAttempt < 1000)
      return { ok: false, reason: "Too many pairing attempts. Wait a second." };
    this.lastAttempt = now;
    if (now > this.expires) {
      this.rotate();
      return {
        ok: false,
        reason:
          "The pairing code expired. Use the new code shown in the desktop app.",
      };
    }
    const value = String(candidate ?? "").replace(/\D/g, "");
    const expected = Buffer.from(this.code);
    const given = Buffer.from(value.padEnd(6, "x").slice(0, 6));
    const matches = value.length === 6 && timingSafeEqual(expected, given);
    if (!matches) {
      this.failures++;
      if (this.failures >= MAX_FAILURES) this.rotate();
      return { ok: false, reason: "Incorrect pairing code." };
    }
    this.rotate();
    return { ok: true };
  }
}
