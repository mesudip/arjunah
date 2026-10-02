import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createDesktopApp } from "../desktop/lib/server.mjs";
import { Store } from "../desktop/lib/store.mjs";

// Turns on one conversation (one `threadId`) must never overlap: two runs would
// otherwise share one CLI session, or one would end the thread and delete the
// scratch directory under the other's live process.

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

async function app(t, behavior) {
  const directory = mkdtempSync(join(tmpdir(), "arjunah-desktop-test-"));
  const store = new Store(directory);
  const adapter = {
    id: "fake",
    name: "Fake",
    vendor: "Test",
    supportsTools: true,
    supportsThreads: true,
    supportsVision: false,
    start: (options) => behavior(options),
  };
  const instance = createDesktopApp({
    store,
    adapters: (id) => (id === "fake" ? adapter : null),
    detect: async () => [
      {
        id: "fake",
        name: "Fake",
        vendor: "Test",
        installed: true,
        available: true,
        binary: "/bin/fake",
        models: [{ id: "default", displayName: "Default" }],
        defaultModel: "default",
      },
    ],
  });
  const address = await instance.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await instance.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const pairing = await fetch(`${base}/api/pair`, {
    method: "POST",
    headers: { Origin: EXTENSION, "Content-Type": "application/json" },
    body: JSON.stringify({
      code: instance.pairing.current().code,
      client: { name: "Test browser", browser: "test" },
    }),
  }).then((response) => response.json());
  const headers = {
    Origin: EXTENSION,
    Authorization: `Bearer ${pairing.token}`,
  };
  const call = async (path, { method = "GET", body, signal } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      signal,
      headers: {
        ...headers,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const generate = (threadId, messages, extra = {}) =>
    call("/api/generate", {
      method: "POST",
      body: {
        providerId: "fake",
        model: "default",
        threadId,
        messages,
        ...extra.body,
      },
      signal: extra.signal,
    });
  return { instance, call, generate };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  return { promise, resolve };
}

async function until(check, label, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Waits until the request behind `progressId` reports that it is queued. */
function queued(call, progressId) {
  return until(async () => {
    const progress = await call(`/api/progress/${progressId}`);
    return progress.body.items.some(
      (item) =>
        item.type === "phase" &&
        /Waiting for the previous turn/.test(item.text),
    );
  }, `${progressId} to queue`);
}

function exitedChild(child) {
  return child.exitCode != null || child.signalCode != null;
}

test("concurrent turns on one conversation run one after another, each after the last agent exited", async (t) => {
  const runs = [];
  const gate = deferred();
  let active = 0;
  let overlap = false;
  const { call, generate } = await app(t, (options) => {
    const index = runs.length;
    const run = { options, child: null, firstExited: null };
    runs.push(run);
    if (active > 0) overlap = true;
    active += 1;
    if (index === 0) {
      // Like Codex's app server: the answer arrives before the process exits.
      run.child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 400)"], {
        stdio: "ignore",
      });
      return {
        child: run.child,
        output: gate.promise.then(() => {
          active -= 1;
          return {
            content: "reply 1",
            usage: USAGE,
            model: "default",
            thread: "s1",
          };
        }),
      };
    }
    run.firstExited = exitedChild(runs[0].child);
    run.firstScratch = existsSync(runs[0].options.scratch.directory);
    active -= 1;
    return {
      child: null,
      output: Promise.resolve({
        content: "reply 2",
        usage: USAGE,
        model: "default",
        thread: "s1",
      }),
    };
  });
  const first = generate("conv-q", [
    { role: "user", content: "Remember ZEBRA." },
  ]);
  await until(() => runs.length === 1, "the first run");
  // The second turn already carries the first answer, as a second tab sharing
  // the conversation would after reading it elsewhere.
  const second = generate(
    "conv-q",
    [
      { role: "user", content: "Remember ZEBRA." },
      { role: "assistant", content: "reply 1" },
      { role: "user", content: "What was the word?" },
    ],
    { body: { progressId: "second" } },
  );
  await queued(call, "second");
  assert.equal(runs.length, 1, "the second turn has not started");
  assert.ok(
    existsSync(runs[0].options.scratch.directory),
    "scratch directory intact",
  );
  gate.resolve();
  assert.equal((await first).status, 200);
  const answered = await second;
  assert.equal(answered.status, 200);
  assert.equal(answered.body.message.content, "reply 2");
  assert.equal(runs.length, 2);
  assert.equal(overlap, false, "the two runs never overlapped");
  assert.equal(runs[1].firstExited, true, "the first agent had exited");
  assert.equal(runs[1].firstScratch, true);
  // Serialised, the second turn sees the thread the first one finished.
  assert.equal(
    runs[1].options.thread?.handle,
    "s1",
    "resumed the first session",
  );
  assert.equal(runs[1].options.prompt, "What was the word?");
  assert.equal(
    runs[1].options.scratch.directory,
    runs[0].options.scratch.directory,
  );
});

test("a turn cancelled while queued never starts and frees its place in the queue", async (t) => {
  const runs = [];
  const gate = deferred();
  const { instance, call, generate } = await app(t, (options) => {
    runs.push(options);
    return {
      child: null,
      output: (runs.length === 1 ? gate.promise : Promise.resolve()).then(
        () => ({
          content: `reply ${runs.length}`,
          usage: USAGE,
          model: "default",
        }),
      ),
    };
  });
  const first = generate("conv-c", [{ role: "user", content: "one" }]);
  await until(() => runs.length === 1, "the first run");
  const controller = new AbortController();
  const cancelled = generate("conv-c", [{ role: "user", content: "two" }], {
    body: { progressId: "cancelled" },
    signal: controller.signal,
  }).catch((error) => error);
  await queued(call, "cancelled");
  controller.abort();
  assert.equal((await cancelled).name, "AbortError");
  assert.equal((await call("/api/progress/cancelled")).body.done, true);
  gate.resolve();
  assert.equal((await first).status, 200);
  assert.equal(runs.length, 1, "the cancelled turn never reached the agent");
  // The lane is free again: a later turn runs at once.
  const third = await generate("conv-c", [{ role: "user", content: "three" }]);
  assert.equal(third.status, 200);
  assert.equal(runs.length, 2);
  assert.match(runs[1].prompt, /three/);
  assert.equal(instance.sessions.sessions.size, 0);
});

test("a first turn that fails does not wedge the turns queued behind it", async (t) => {
  const runs = [];
  const gate = deferred();
  const { call, generate } = await app(t, (options) => {
    runs.push(options);
    if (runs.length === 1)
      return {
        child: null,
        output: gate.promise.then(() => ({
          isError: true,
          errorMessage: "boom",
        })),
      };
    if (runs.length === 2) throw new Error("spawn failed");
    return {
      child: null,
      output: Promise.resolve({
        content: "fine",
        usage: USAGE,
        model: "default",
      }),
    };
  });
  const first = generate("conv-f", [{ role: "user", content: "one" }]);
  await until(() => runs.length === 1, "the first run");
  const second = generate("conv-f", [{ role: "user", content: "two" }], {
    body: { progressId: "f2" },
  });
  await queued(call, "f2");
  const third = generate("conv-f", [{ role: "user", content: "three" }], {
    body: { progressId: "f3" },
  });
  await queued(call, "f3");
  gate.resolve();
  const failed = await first;
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, "PROVIDER_ERROR");
  // The second could not even start its agent; the third still runs.
  assert.equal((await second).status, 502);
  const answered = await third;
  assert.equal(answered.status, 200);
  assert.equal(answered.body.message.content, "fine");
  assert.equal(runs.length, 3);
  // The failed runs ended their threads; the third began a fresh one.
  assert.equal(runs[2].thread?.handle ?? null, null);
  assert.ok(existsSync(runs[2].scratch.directory));
  assert.ok(!existsSync(runs[0].scratch.directory));
});

test("ending a conversation mid-run stops the agent, refuses queued turns, and deletes only after exit", async (t) => {
  const runs = [];
  const { call, generate } = await app(t, (options) => {
    // A CLI that takes a moment to shut down once asked to.
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 300)); setInterval(() => {}, 1000)",
      ],
      { stdio: "ignore" },
    );
    runs.push({ options, child });
    return {
      child,
      output: new Promise((resolve) =>
        child.on("exit", () =>
          resolve({ isError: true, errorMessage: "terminated" }),
        ),
      ),
    };
  });
  const first = generate("conv-e", [{ role: "user", content: "one" }]);
  await until(() => runs.length === 1, "the first run");
  // Give the child time to install its SIGTERM handler.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = generate("conv-e", [{ role: "user", content: "two" }], {
    body: { progressId: "e2" },
  });
  await queued(call, "e2");
  const { directory } = runs[0].options.scratch;
  const ended = await call("/api/threads/conv-e", { method: "DELETE" });
  assert.equal(ended.body.ended, true);
  const stopped = await first;
  assert.equal(stopped.status, 499);
  assert.equal(stopped.body.error.code, "ABORTED");
  const refused = await second;
  assert.equal(refused.status, 499);
  assert.equal(refused.body.error.message, "The conversation was ended.");
  assert.equal(runs.length, 1, "the queued turn never started");
  assert.equal(
    exitedChild(runs[0].child),
    false,
    "the agent is still shutting down",
  );
  assert.ok(existsSync(directory), "nothing is deleted under a live process");
  await until(() => exitedChild(runs[0].child), "the agent to exit");
  await until(() => !existsSync(directory), "the scratch directory to go");
  // The conversation can start over afterwards.
  const again = generate("conv-e", [{ role: "user", content: "again" }]);
  await until(() => runs.length === 2, "a fresh run");
  assert.notEqual(runs[1].options.scratch.directory, directory);
  runs[1].child.kill("SIGKILL");
  assert.equal((await again).status, 502);
});

/** A fake agent's call of one bridged tool through its session's MCP endpoint. */
async function callTool(options, name, id = 1) {
  const response = await fetch(options.mcp.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${options.mcp.token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: {} },
    }),
  });
  return (await response.json()).result.content[0].text;
}

const TOOLS = [
  { name: "site__echo", inputSchema: { type: "object", properties: {} } },
];

/** The browser's side of one tool round: the call and its result appended. */
function answered(messages, response, content) {
  const item = response.body.message.toolCalls[0];
  return [
    ...messages,
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: item.id,
          type: "function",
          function: { name: item.name, arguments: item.arguments },
        },
      ],
    },
    { role: "tool", tool_call_id: item.id, content },
  ];
}

test("a thread's next turn sends only what follows the last turn's tool rounds", async (t) => {
  const runs = [];
  const { generate } = await app(t, (options) => {
    runs.push(options);
    if (runs.length === 1)
      return {
        child: null,
        output: callTool(options, "site__echo").then((text) => ({
          content: `echo said ${text}`,
          usage: USAGE,
          model: "default",
          thread: "s1",
        })),
      };
    return {
      child: null,
      output: Promise.resolve({
        content: "second answer",
        usage: USAGE,
        model: "default",
        thread: "s1",
      }),
    };
  });
  let messages = [{ role: "user", content: "Echo something." }];
  const round = await generate("conv-tools", messages, {
    body: { tools: TOOLS },
  });
  assert.equal(round.body.finishReason, "tool_calls");
  messages = answered(messages, round, "pong");
  const final = await generate("conv-tools", messages, {
    body: { tools: TOOLS },
  });
  assert.equal(final.body.message.content, "echo said pong");
  messages = [
    ...messages,
    { role: "assistant", content: "echo said pong" },
    { role: "user", content: "Thanks. And now?" },
  ];
  const next = await generate("conv-tools", messages, {
    body: { tools: TOOLS },
  });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(runs[1].thread?.handle, "s1", "the session was resumed");
  // Only the new message: not the tool result or the answer it already gave.
  assert.equal(runs[1].prompt, "Thanks. And now?");
});

test("with every agent run working, one more is refused at once and nothing is killed", async (t) => {
  const stops = [];
  let started = 0;
  const { generate } = await app(t, () => {
    started += 1;
    return { child: null, output: new Promise(() => {}) };
  });
  t.after(() => {
    for (const stop of stops) stop.abort();
  });
  const working = [];
  for (let index = 0; index < 6; index++) {
    const stop = new AbortController();
    stops.push(stop);
    working.push(
      generate(null, [{ role: "user", content: `run ${index}` }], {
        signal: stop.signal,
      }).catch(() => null),
    );
  }
  await until(() => started === 6, "six working runs");
  const at = Date.now();
  const refused = await generate(null, [{ role: "user", content: "one more" }]);
  assert.ok(Date.now() - at < 2000, "answered at once, not after a timeout");
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error.code, "RATE_LIMITED");
  assert.equal(refused.body.error.reason, "busy");
  assert.equal(refused.body.error.retryAfterMs, 5000);
  assert.equal(started, 6, "no working run was evicted to make room");
});

test("at the limit the run paused on the browser longest makes room, and its results start afresh", async (t) => {
  const stops = [];
  const runs = [];
  const { generate } = await app(t, (options) => {
    runs.push(options);
    const index = runs.length;
    // Runs 1 to 5 keep working; run 6, the newest, pauses on a tool call, so
    // evicting the oldest run instead would kill one that is working.
    if (index <= 5) return { child: null, output: new Promise(() => {}) };
    if (index === 6)
      return {
        child: null,
        output: callTool(options, "site__echo").then(() => ({
          content: "never delivered",
          usage: USAGE,
          model: "default",
        })),
      };
    return {
      child: null,
      output: Promise.resolve({
        content: `run ${index}`,
        usage: USAGE,
        model: "default",
      }),
    };
  });
  const busy = [];
  t.after(() => {
    for (const stop of stops) stop.abort();
  });
  for (let index = 0; index < 5; index++) {
    const stop = new AbortController();
    stops.push(stop);
    busy.push(
      generate(null, [{ role: "user", content: `busy ${index}` }], {
        signal: stop.signal,
      }).then(
        (response) => response.status,
        () => "aborted",
      ),
    );
  }
  await until(() => runs.length === 5, "five working runs");
  const pausedAsk = [{ role: "user", content: "Use the tool." }];
  const paused = await generate(null, pausedAsk, { body: { tools: TOOLS } });
  assert.equal(paused.body.finishReason, "tool_calls");
  const seventh = await generate(null, [{ role: "user", content: "seventh" }]);
  assert.equal(seventh.status, 200, JSON.stringify(seventh.body));
  assert.equal(seventh.body.message.content, "run 7");
  // Every working run is still waiting: none was killed to make room.
  const still = await Promise.race([
    Promise.any(busy),
    new Promise((resolve) => setTimeout(() => resolve("waiting"), 200)),
  ]);
  assert.equal(still, "waiting");
  // The evicted run's tool result arrives later: a fresh run from the
  // transcript answers it instead of a hang.
  const late = await generate(null, answered(pausedAsk, paused, "pong"), {
    body: { tools: TOOLS },
  });
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal(late.body.message.content, "run 8");
});
