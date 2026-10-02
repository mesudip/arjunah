import { randomBytes, randomUUID } from "node:crypto";

export const SESSION_LIMITS = Object.freeze({
  // Agent runs (CLI processes) alive at once. At the limit only a run paused
  // on the browser is evicted for a new one; see SessionRegistry.makeRoom.
  maxSessions: 6,
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
    this.events = [];
    this.waiter = null;
    this.resumeTimer = null;
    this.child = null;
    this.ended = false;
    this.createdAt = Date.now();
    // When the run last handed tool calls to the browser and stopped.
    this.pausedAt = 0;
  }

  /**
   * Paused on the browser: the agent is blocked on tool calls the browser has
   * not answered, and no request is waiting on the run. Evicting such a run
   * loses nothing that cannot be redone, because tool results for a session
   * that is gone start a fresh run from the transcript (SPEC 12.3.1).
   */
  waitingOnBrowser() {
    return !this.ended && !this.waiter && this.pending.size > 0;
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
    if (this.waiter) {
      const { resolve, timer } = this.waiter;
      this.waiter = null;
      clearTimeout(timer);
      resolve(event);
    } else this.events.push(event);
    // Delivered first: ending the session answers any waiter with an error.
    if (event.type === "final" || event.type === "error") this.end(false);
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
      // MCP supplies no end-of-batch marker. Surface each request immediately
      // instead of guessing with a debounce; sibling calls remain pending and
      // may be resumed independently as the browser returns their results.
      this.emit({
        type: "tool_calls",
        calls: [{ id, name, arguments: JSON.stringify(args ?? {}) }],
      });
      this.pausedAt = Date.now();
      this.armResumeTimer();
    });
  }

  armResumeTimer() {
    clearTimeout(this.resumeTimer);
    this.resumeTimer = this.pending.size
      ? setTimeout(() => {
          if (this.pending.size)
            this.end(
              true,
              "The browser did not return the agent's tool results in time.",
            );
        }, SESSION_LIMITS.resumeMs)
      : null;
  }

  matches(results) {
    return (
      !this.ended &&
      results.length > 0 &&
      results.every((item) => this.pending.has(item.id))
    );
  }

  resume(results) {
    for (const item of results) {
      const entry = this.pending.get(item.id);
      this.pending.delete(item.id);
      entry?.resolve({
        content: String(item.content).slice(0, SESSION_LIMITS.toolResultBytes),
        images: Array.isArray(item.images) ? item.images.slice(0, 8) : [],
      });
    }
    this.armResumeTimer();
  }

  /**
   * The browser closed the request that was waiting on this run (a page
   * aborted its call, or the visitor pressed stop). Nobody can receive the
   * answer, so the agent process is killed rather than left to finish on the
   * user's subscription, and the waiting request is released at once.
   */
  cancel() {
    const waiter = this.waiter;
    this.waiter = null;
    this.end(true);
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve({ type: "cancelled" });
    }
  }

  /**
   * Ends the run, killing its process when `kill` is set. A request still
   * waiting on it is answered at once with `reason`, so nothing is left to sit
   * out the event timeout on a run that is already gone.
   */
  end(kill, reason = "The agent session ended before answering.") {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.resumeTimer);
    if (this.waiter) {
      const { resolve, timer } = this.waiter;
      this.waiter = null;
      clearTimeout(timer);
      resolve({ type: "error", message: reason });
    }
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

/** Every place is taken by a run that is still working. */
export class SessionLimitError extends Error {
  constructor() {
    super(
      `The desktop app is already running ${SESSION_LIMITS.maxSessions} agent sessions.`,
    );
    this.name = "SessionLimitError";
  }
}

export class SessionRegistry {
  constructor() {
    this.sessions = new Map();
  }
  /**
   * Frees a place for one more run, or says there is none. At the limit the
   * run paused on the browser the longest is evicted; a run that is working,
   * or that a request is waiting on, is never killed to make room, so the
   * newcomer is refused instead and can try again shortly.
   */
  makeRoom() {
    if (this.sessions.size < SESSION_LIMITS.maxSessions) return true;
    const paused = [...this.sessions.values()]
      .filter((session) => session.waitingOnBrowser())
      .sort((a, b) => a.pausedAt - b.pausedAt)[0];
    if (!paused) return false;
    paused.end(true, "The desktop app needed room for another agent run.");
    return this.sessions.size < SESSION_LIMITS.maxSessions;
  }

  create(options) {
    if (!this.makeRoom()) throw new SessionLimitError();
    const session = new ToolSession({
      ...options,
      onEnd: (item) => {
        this.sessions.delete(item.id);
        options.onEnd?.(item);
      },
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
