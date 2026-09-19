import { randomBytes, randomUUID } from "node:crypto";

export const SESSION_LIMITS = Object.freeze({
  maxSessions: 6,
  batchMs: 250,
  // How long a session waits for the browser to return tool results.
  resumeMs: 120_000,
  // How long one /api/generate call waits for the next model event.
  eventMs: 170_000,
  toolResultBytes: 64 * 1024,
});

/**
 * One CLI agent run that may pause on tool calls. The CLI reaches back into the
 * desktop app through a per-session MCP endpoint; each tools/call blocks until
 * the browser broker executes the tool and posts the result with the next
 * generate request. Events flow to whoever awaits nextEvent().
 */
export class ToolSession {
  constructor({ tools, model, providerId, onEnd }) {
    this.id = randomUUID();
    this.token = randomBytes(24).toString("base64url");
    this.tools = tools;
    this.model = model;
    this.providerId = providerId;
    this.onEnd = onEnd;
    this.pending = new Map(); // callId -> { name, resolve }
    this.collected = [];
    this.events = [];
    this.waiter = null;
    this.batchTimer = null;
    this.resumeTimer = null;
    this.child = null;
    this.ended = false;
    this.createdAt = Date.now();
  }

  attach(run) {
    this.child = run.child;
    run.output.then(
      (result) =>
        this.emit(
          result.isError
            ? { type: "error", message: result.errorMessage }
            : { type: "final", ...result },
        ),
      (error) =>
        this.emit({
          type: "error",
          message: error?.message ?? "The CLI agent failed.",
        }),
    );
  }

  emit(event) {
    if (this.ended) return;
    if (event.type === "final" || event.type === "error") this.end(false);
    if (this.waiter) {
      const { resolve, timer } = this.waiter;
      this.waiter = null;
      clearTimeout(timer);
      resolve(event);
    } else this.events.push(event);
  }

  nextEvent(timeoutMs = SESSION_LIMITS.eventMs) {
    if (this.events.length) return Promise.resolve(this.events.shift());
    if (this.ended)
      return Promise.resolve({
        type: "error",
        message: "The agent session ended before answering.",
      });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve({ type: "timeout" });
        this.end(true);
      }, timeoutMs);
      this.waiter = { resolve, timer };
    });
  }

  /** Called by the MCP bridge; resolves when the browser returns the result. */
  call(name, args) {
    if (this.ended) return Promise.reject(new Error("Session ended."));
    const id = `call_${randomBytes(12).toString("hex")}`;
    return new Promise((resolve) => {
      this.pending.set(id, { name, resolve });
      this.collected.push({ id, name, arguments: JSON.stringify(args ?? {}) });
      clearTimeout(this.batchTimer);
      this.batchTimer = setTimeout(() => this.flush(), SESSION_LIMITS.batchMs);
    });
  }

  flush() {
    if (!this.collected.length) return;
    const calls = this.collected;
    this.collected = [];
    this.emit({ type: "tool_calls", calls });
    clearTimeout(this.resumeTimer);
    this.resumeTimer = setTimeout(() => {
      if (this.pending.size) this.end(true);
    }, SESSION_LIMITS.resumeMs);
  }

  matches(results) {
    return (
      !this.ended &&
      results.length > 0 &&
      results.every((item) => this.pending.has(item.id)) &&
      results.length === this.pending.size
    );
  }

  resume(results) {
    clearTimeout(this.resumeTimer);
    for (const item of results) {
      const entry = this.pending.get(item.id);
      this.pending.delete(item.id);
      entry?.resolve({
        content: String(item.content).slice(0, SESSION_LIMITS.toolResultBytes),
      });
    }
  }

  end(kill) {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.batchTimer);
    clearTimeout(this.resumeTimer);
    for (const entry of this.pending.values())
      entry.resolve({
        content: JSON.stringify({
          isError: true,
          message: "The browser did not return a tool result.",
        }),
        isError: true,
      });
    this.pending.clear();
    if (kill && this.child && this.child.exitCode == null) {
      try {
        this.child.kill("SIGTERM");
        setTimeout(() => {
          if (this.child.exitCode == null) this.child.kill("SIGKILL");
        }, 3000).unref();
      } catch {
        /* already gone */
      }
    }
    this.onEnd?.(this);
  }
}

export class SessionRegistry {
  constructor() {
    this.sessions = new Map();
  }
  create(options) {
    if (this.sessions.size >= SESSION_LIMITS.maxSessions) {
      const oldest = [...this.sessions.values()].sort(
        (a, b) => a.createdAt - b.createdAt,
      )[0];
      oldest?.end(true);
    }
    const session = new ToolSession({
      ...options,
      onEnd: (item) => this.sessions.delete(item.id),
    });
    this.sessions.set(session.id, session);
    return session;
  }
  get(id) {
    return this.sessions.get(id) ?? null;
  }
  findByResults(results) {
    for (const session of this.sessions.values())
      if (session.matches(results)) return session;
    return null;
  }
  findByAnyResult(results) {
    for (const session of this.sessions.values())
      if (results.some((item) => session.pending.has(item.id))) return session;
    return null;
  }
  endAll() {
    for (const session of [...this.sessions.values()]) session.end(true);
  }
}
