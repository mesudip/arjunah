import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createDesktopApp } from "../desktop/lib/server.mjs";
import { Store } from "../desktop/lib/store.mjs";
import {
  buildPrompt,
  trailingToolResults,
} from "../desktop/lib/transcript.mjs";
import {
  ToolSession,
  SessionRegistry,
  SESSION_LIMITS,
} from "../desktop/lib/sessions.mjs";

const EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

function fakeAdapter(behavior) {
  return {
    id: "fake",
    name: "Fake",
    vendor: "Test",
    supportsTools: true,
    supportsThreads: true,
    async detect() {
      return {
        installed: true,
        available: true,
        binary: "/bin/fake",
        models: [{ id: "default", displayName: "Default" }],
        defaultModel: "default",
      };
    },
    start(options) {
      return behavior(options);
    },
  };
}

async function app(t, behavior) {
  const directory = mkdtempSync(join(tmpdir(), "arjunah-desktop-test-"));
  const store = new Store(directory);
  const adapter = fakeAdapter(
    behavior ??
      (() => ({
        child: null,
        output: Promise.resolve({
          content: "hello",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          model: "default",
        }),
      })),
  );
  const instance = createDesktopApp({
    store,
    adapters: (id) => (id === "fake" ? adapter : null),
    detect: async () => [
      { id: "fake", name: "Fake", vendor: "Test", ...(await adapter.detect()) },
    ],
  });
  const address = await instance.listen(0);
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await instance.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const call = async (path, { method = "GET", body, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: EXTENSION,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
      headers: response.headers,
    };
  };
  const pair = async () => {
    const result = await call("/api/pair", {
      method: "POST",
      body: {
        code: instance.pairing.current().code,
        client: { name: "Test browser", browser: "test" },
      },
    });
    assert.equal(result.status, 200);
    return { Authorization: `Bearer ${result.body.token}` };
  };
  return { instance, store, base, call, pair, adapter };
}

test("loopback guard rejects foreign hosts and web origins but allows extension origins with CORS", async (t) => {
  const { call, base } = await app(t);
  const foreignHost = await new Promise((resolve, reject) => {
    const request = httpRequest(
      `${base}/api/status`,
      { headers: { Host: "evil.test" } },
      (response) => resolve(response.statusCode),
    );
    request.on("error", reject);
    request.end();
  });
  assert.equal(foreignHost, 403);
  const web = await call("/api/status", {
    headers: { Origin: "https://site.test" },
  });
  assert.equal(web.status, 403);
  const ok = await call("/api/status");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.app, "arjunah-desktop");
  assert.equal(ok.body.paired, false);
  assert.equal(ok.headers.get("access-control-allow-origin"), EXTENSION);
  const preflight = await fetch(`${base}/api/generate`, {
    method: "OPTIONS",
    headers: { Origin: EXTENSION, "Access-Control-Request-Method": "POST" },
  });
  assert.equal(preflight.status, 204);
});

test("pairing requires the current code, issues a hashed token, and can be revoked", async (t) => {
  const { call, store, instance, pair } = await app(t);
  const wrong = await call("/api/pair", {
    method: "POST",
    body: { code: "000000" },
  });
  assert.equal(wrong.status, 403);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const headers = await pair();
  const token = headers.Authorization.slice(7);
  assert.equal(
    JSON.stringify(store.data).includes(token),
    false,
    "the raw token must not be stored",
  );
  assert.equal((statSync(store.path).mode & 0o777).toString(8), "600");
  assert.notEqual(instance.pairing.current().code, undefined);
  const providers = await call("/api/providers", { headers });
  assert.equal(providers.status, 200);
  assert.equal(providers.body.providers.length, 1);
  assert.equal("binary" in providers.body.providers[0], false);
  const status = await call("/api/status", { headers });
  assert.equal(status.body.paired, true);
  const unpair = await call("/api/pair", { method: "DELETE", headers });
  assert.equal(unpair.status, 200);
  assert.equal((await call("/api/providers", { headers })).status, 401);
});

test("authenticated websocket events carry revisions and invalidate changed desktop state", async (t) => {
  const { call, instance, base } = await app(t);
  const paired = await call("/api/pair", {
    method: "POST",
    body: {
      code: instance.pairing.current().code,
      client: { name: "Live browser", browser: "test" },
    },
  });
  assert.equal(paired.status, 200);
  const socket = new WebSocket(
    `${base.replace(/^http:/, "ws:")}/api/events`,
    `arjunah.v1.client.${paired.body.token}`,
  );
  t.after(() => socket.close());
  const messages = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else messages.push(message);
  });
  const nextMessage = () =>
    messages.length
      ? Promise.resolve(messages.shift())
      : new Promise((resolve) => waiters.push(resolve));
  const helloPromise = nextMessage();
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const hello = await helloPromise;
  assert.equal(hello.type, "hello");
  assert.ok(Number.isInteger(hello.revision));

  const changedPromise = (async () => {
    for (;;) {
      const message = await nextMessage();
      if (message.type === "state.changed" && message.topic === "sync")
        return message;
    }
  })();
  const synced = await call("/api/sync", {
    method: "PUT",
    headers: { Authorization: `Bearer ${paired.body.token}` },
    body: { config: { active: { type: "openai" } } },
  });
  assert.equal(synced.status, 200);
  const changed = await changedPromise;
  assert.ok(changed.revision > hello.revision);
});

test("sync stores browser configuration with increasing revisions and masks keys on the dashboard", async (t) => {
  const { call, pair, instance, base } = await app(t);
  const headers = await pair();
  const first = await call("/api/sync", {
    method: "PUT",
    headers,
    body: {
      config: {
        openai: { model: "gpt-5.6-sol", apiKey: "sk-secret-value-1234" },
        active: { type: "openai" },
      },
    },
  });
  assert.equal(first.body.revision, 1);
  const read = await call("/api/sync", { headers });
  assert.equal(read.body.config.openai.apiKey, "sk-secret-value-1234");
  const dashboard = await fetch(`${base}/api/dashboard/state`, {
    headers: { "X-Dashboard-Token": instance.dashboardToken },
  });
  const state = await dashboard.json();
  assert.equal(JSON.stringify(state).includes("sk-secret-value-1234"), false);
  assert.match(state.sync.config.openai.apiKey, /…/);
  const forbidden = await fetch(`${base}/api/dashboard/state`, {
    headers: { "X-Dashboard-Token": "nope" },
  });
  assert.equal(forbidden.status, 403);
});

test("generate runs the adapter with system prompt and prompt split from messages", async (t) => {
  let seen;
  const { call, pair } = await app(t, (options) => {
    seen = options;
    return {
      child: null,
      output: Promise.resolve({
        content: "answer",
        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
        model: "default",
      }),
    };
  });
  const headers = await pair();
  const result = await call("/api/generate", {
    method: "POST",
    headers,
    body: {
      providerId: "fake",
      model: "default",
      messages: [
        { role: "system", content: "Rules." },
        { role: "user", content: "Hi" },
      ],
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.message.content, "answer");
  assert.equal(result.body.finishReason, "stop");
  assert.equal(seen.systemPrompt, "Rules.");
  assert.equal(seen.prompt, "Hi");
  assert.equal(seen.mcp, null);
  const unknown = await call("/api/generate", {
    method: "POST",
    headers,
    body: { providerId: "nope", messages: [{ role: "user", content: "x" }] },
  });
  assert.equal(unknown.status, 400);
});

test("bridged tool calls pause the agent until the browser returns results through the next request", async (t) => {
  let mcpConfig;
  const { call, pair } = await app(t, (options) => {
    mcpConfig = options.mcp;
    const output = (async () => {
      const rpc = async (method, params, id = 1) => {
        const response = await fetch(options.mcp.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.mcp.token}`,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        });
        return response.status === 202 ? null : response.json();
      };
      const init = await rpc("initialize", { protocolVersion: "2025-03-26" });
      assert.equal(init.result.serverInfo.name, "arjunah-desktop");
      await rpc("notifications/initialized");
      const list = await rpc("tools/list", {});
      assert.deepEqual(
        list.result.tools.map((tool) => tool.name),
        ["site__echo"],
      );
      const unknown = await rpc("tools/call", { name: "other", arguments: {} });
      assert.equal(unknown.result.isError, true);
      const result = await rpc(
        "tools/call",
        { name: "site__echo", arguments: { value: "ping" } },
        2,
      );
      return {
        content: `tool said ${result.result.content[0].text}`,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "default",
      };
    })();
    return { child: null, output };
  });
  const headers = await pair();
  const tools = [
    {
      name: "site__echo",
      description: "Echo",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
      },
    },
  ];
  const messages = [{ role: "user", content: "Use the echo tool" }];
  const first = await call("/api/generate", {
    method: "POST",
    headers,
    body: { providerId: "fake", messages, tools },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.finishReason, "tool_calls");
  const [callItem] = first.body.message.toolCalls;
  assert.equal(callItem.name, "site__echo");
  assert.equal(callItem.arguments, '{"value":"ping"}');
  assert.match(mcpConfig.url, /\/mcp\//);
  const unauthorizedMcp = await fetch(mcpConfig.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
  });
  assert.equal(unauthorizedMcp.status, 401);
  const second = await call("/api/generate", {
    method: "POST",
    headers,
    body: {
      providerId: "fake",
      tools,
      messages: [
        ...messages,
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: callItem.id,
              type: "function",
              function: { name: callItem.name, arguments: callItem.arguments },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: callItem.id,
          content: '{"echoed":"ping"}',
        },
      ],
    },
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.message.content, 'tool said {"echoed":"ping"}');
});

test("agent failures surface as provider errors without internals", async (t) => {
  const { call, pair } = await app(t, () => ({
    child: null,
    output: Promise.resolve({ isError: true, errorMessage: "Not logged in" }),
  }));
  const headers = await pair();
  const result = await call("/api/generate", {
    method: "POST",
    headers,
    body: { providerId: "fake", messages: [{ role: "user", content: "x" }] },
  });
  assert.equal(result.status, 502);
  assert.equal(result.body.error.code, "PROVIDER_ERROR");
  assert.match(result.body.error.message, /Not logged in/);
});

test("transcript builder flattens history and detects trailing tool results", () => {
  const single = buildPrompt([
    { role: "system", content: "S" },
    { role: "user", content: "Only" },
  ]);
  assert.deepEqual(single, {
    systemPrompt: "S",
    prompt: "Only",
    transcript: false,
  });
  const messages = [
    { role: "system", content: "A" },
    { role: "system", content: "B" },
    { role: "user", content: "Q1" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "site__x", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: '{"ok":true}' },
  ];
  const multi = buildPrompt(messages);
  assert.equal(multi.systemPrompt, "A\n\nB");
  assert.match(multi.prompt, /user: Q1/);
  assert.match(multi.prompt, /requested tool "site__x"/);
  assert.match(multi.prompt, /tool \(c1\): \{"ok":true\}/);
  assert.deepEqual(trailingToolResults(messages), [
    { id: "c1", content: '{"ok":true}' },
  ]);
  assert.equal(trailingToolResults([{ role: "user", content: "x" }]), null);
  assert.equal(
    trailingToolResults([
      { role: "assistant", content: "", tool_calls: [{ id: "a" }] },
      { role: "tool", tool_call_id: "b", content: "" },
    ]),
    null,
  );
});

test("sessions batch concurrent tool calls and resolve pending calls with errors when abandoned", async () => {
  const session = new ToolSession({ tools: [], model: "m", providerId: "p" });
  const a = session.call("site__a", { n: 1 });
  const b = session.call("site__b", { n: 2 });
  const event = await session.nextEvent();
  assert.equal(event.type, "tool_calls");
  assert.deepEqual(
    event.calls.map((item) => item.name),
    ["site__a", "site__b"],
  );
  assert.equal(
    session.matches([{ id: event.calls[0].id }]),
    false,
    "partial results do not resume",
  );
  session.resume([
    { id: event.calls[0].id, content: "one" },
    { id: event.calls[1].id, content: "two" },
  ]);
  assert.equal((await a).content, "one");
  assert.equal((await b).content, "two");
  const other = new ToolSession({ tools: [], model: "m", providerId: "p" });
  const pending = other.call("site__c", {});
  other.end(true);
  assert.equal((await pending).isError, true);
  assert.ok(SESSION_LIMITS.resumeMs > 0);
});

test("partial tool results identify and retire their stale suspended session", async () => {
  const registry = new SessionRegistry();
  const session = registry.create({ tools: [], model: "m", providerId: "p" });
  const a = session.call("site__a", {});
  const b = session.call("site__b", {});
  const event = await session.nextEvent();
  const partial = [{ id: event.calls[0].id, content: "one" }];
  assert.equal(registry.findByResults(partial), null);
  assert.equal(registry.findByAnyResult(partial), session);
  session.end(true);
  assert.equal((await a).isError, true);
  assert.equal((await b).isError, true);
});

test("an agent that exits without draining stdin does not take the companion down", async () => {
  const { spawnAgent } = await import("../desktop/lib/providers/common.mjs");
  const { output } = spawnAgent({
    binary: "/bin/sh",
    args: ["-c", "exit 1"],
    // Larger than the pipe buffer, so the write cannot be absorbed and the
    // broken pipe surfaces as an EPIPE on the child's stdin stream.
    stdin: "x".repeat(2_000_000),
    parse: (stdout, stderr, code) => ({ stdout, stderr, code }),
  });
  assert.equal((await output).code, 1);
});

test("jwtPayload decodes an ID token payload and tolerates junk", async () => {
  const { jwtPayload } = await import("../desktop/lib/providers/common.mjs");
  const payload = Buffer.from(
    JSON.stringify({ email: "me@example.test", name: "Me" }),
  ).toString("base64url");
  assert.deepEqual(jwtPayload(`header.${payload}.sig`), {
    email: "me@example.test",
    name: "Me",
  });
  assert.equal(jwtPayload("not-a-token"), null);
  assert.equal(jwtPayload("a.!!!.c"), null);
  assert.equal(jwtPayload(null), null);
});

test("Codex output parsing keeps the commands the agent ran and the outer sandbox denies the home folder", async () => {
  const { parseCodexOutput, progressItem } = await import(
    "../desktop/lib/providers/codex.mjs"
  );
  const { outerSandbox } = await import("../desktop/lib/providers/common.mjs");
  const { mkdtempSync, readFileSync, readdirSync, rmSync } = await import(
    "node:fs"
  );
  const { tmpdir, homedir } = await import("node:os");
  const { join } = await import("node:path");
  const stdout = [
    JSON.stringify({ type: "thread.started" }),
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "command_execution",
        command: "ls -la /Users/me/Documents",
        aggregated_output:
          "sandbox-exec: sandbox_apply: Operation not permitted\n",
        exit_code: 71,
      },
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "I could not list that folder." },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 10, output_tokens: 4 },
    }),
  ].join("\n");
  const parsed = parseCodexOutput(stdout, "", 0, "default");
  assert.equal(parsed.content, "I could not list that folder.");
  assert.deepEqual(
    progressItem({
      type: "item.completed",
      item: { type: "agent_message", text: "I could not list that folder." },
    }),
    {
      type: "output_delta",
      text: "I could not list that folder.",
    },
  );
  assert.deepEqual(parsed.steps, [
    {
      type: "command",
      command: "ls -la /Users/me/Documents",
      exitCode: 71,
      output: "sandbox-exec: sandbox_apply: Operation not permitted\n",
    },
  ]);
  assert.equal(parsed.usage.totalTokens, 14);
  const scratch = mkdtempSync(join(tmpdir(), "arjunah-sandbox-test-"));
  try {
    const wrapped = outerSandbox({
      binary: "/opt/codex",
      args: ["exec", "--json"],
      scratch,
      allow: [join(homedir(), ".codex")],
    });
    if (process.platform !== "darwin") {
      assert.equal(wrapped, null);
      return;
    }
    assert.equal(wrapped.binary, "/usr/bin/sandbox-exec");
    assert.deepEqual(wrapped.args.slice(2), ["/opt/codex", "exec", "--json"]);
    const profile = readFileSync(wrapped.profilePath, "utf8");
    assert.match(
      profile,
      /\(deny file-read\* file-write\* \(subpath "[^"]+"\)\)/,
    );
    assert.ok(
      profile.includes(
        `(deny file-read-data (literal ${JSON.stringify(homedir())}))`,
      ),
    );
    assert.equal(
      profile.includes(
        `(subpath ${JSON.stringify(join(homedir(), ".codex"))})`,
      ),
      false,
      "the agent's own login data stays readable",
    );
    for (const entry of readdirSync(homedir())
      .filter((item) => item !== ".codex")
      .slice(0, 3))
      assert.ok(
        profile.includes(`(subpath ${JSON.stringify(join(homedir(), entry))})`),
      );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("live agent progress is recorded per turn and served to the paired browser", async (t) => {
  const { call, pair } = await app(t, ({ onProgress }) => {
    onProgress?.({ type: "command", phase: "start", id: "c1", command: "ls" });
    onProgress?.({
      type: "command",
      phase: "end",
      id: "c1",
      command: "ls",
      exitCode: 71,
      output: "denied",
    });
    onProgress?.({ type: "output_delta", text: "blo" });
    onProgress?.({ type: "output_delta", text: "cked" });
    return {
      child: null,
      output: Promise.resolve({
        content: "blocked",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "default",
        steps: [
          { type: "command", command: "ls", exitCode: 71, output: "denied" },
        ],
        reasoning: "I tried to list the folder.",
      }),
    };
  });
  const headers = await pair();
  const generated = await call("/api/generate", {
    method: "POST",
    headers,
    body: {
      providerId: "fake",
      model: "default",
      messages: [{ role: "user", content: "hi" }],
      progressId: "turn-1",
    },
  });
  assert.equal(generated.status, 200);
  assert.equal(generated.body.reasoning, "I tried to list the folder.");
  assert.equal(generated.body.steps[0].exitCode, 71);
  const progress = await call("/api/progress/turn-1?after=1", { headers });
  assert.equal(progress.body.total, 3);
  assert.equal(progress.body.done, true);
  assert.equal(progress.body.items[0].phase, "end");
  assert.deepEqual(progress.body.items[1], {
    type: "output_delta",
    text: "blocked",
  });
  const anonymous = await call("/api/progress/turn-1");
  assert.equal(anonymous.status, 401);
});

test("a browser conversation reuses one agent thread and sends only the new messages", async (t) => {
  const runs = [];
  const { call, pair, instance } = await app(t, (options) => {
    runs.push(options);
    options.onThread?.("agent-session-1");
    return {
      child: null,
      output: Promise.resolve({
        content: `reply ${runs.length}`,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "default",
        thread: "agent-session-1",
      }),
    };
  });
  const headers = await pair();
  const first = await call("/api/generate", {
    method: "POST",
    headers,
    body: {
      providerId: "fake",
      model: "default",
      threadId: "conv-1",
      reasoning: "high",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Remember ZEBRA." },
      ],
    },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.thread, true);
  assert.equal(
    runs[0].thread?.handle ?? null,
    null,
    "first run: no handle yet",
  );
  assert.equal(runs[0].reasoning, "high");
  assert.match(runs[0].prompt, /Remember ZEBRA/);
  const second = await call("/api/generate", {
    method: "POST",
    headers,
    body: {
      providerId: "fake",
      model: "default",
      threadId: "conv-1",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Remember ZEBRA." },
        { role: "assistant", content: "reply 1" },
        { role: "user", content: "What was the word?" },
      ],
    },
  });
  assert.equal(second.status, 200);
  assert.equal(runs[1].thread?.handle, "agent-session-1", "second run resumes");
  assert.equal(
    runs[1].prompt,
    "What was the word?",
    "only the new message is sent",
  );
  assert.equal(
    runs[1].scratch.directory,
    runs[0].scratch.directory,
    "same working directory",
  );
  // A different system prompt (e.g. widget options changed) starts a fresh thread.
  await call("/api/generate", {
    method: "POST",
    headers,
    body: {
      providerId: "fake",
      model: "default",
      threadId: "conv-1",
      messages: [
        { role: "system", content: "Be verbose." },
        { role: "user", content: "Hi" },
      ],
    },
  });
  assert.equal(runs[2].thread?.handle ?? null, null, "fresh thread");
  assert.notEqual(runs[2].scratch.directory, runs[0].scratch.directory);
  assert.match(runs[2].prompt, /Be verbose|Hi/);
  // Ending the conversation removes the thread; the next call starts over.
  const ended = await call("/api/threads/conv-1", {
    method: "DELETE",
    headers,
  });
  assert.equal(ended.body.ended, true);
  const again = await call("/api/threads/conv-1", {
    method: "DELETE",
    headers,
  });
  assert.equal(again.body.ended, false);
  assert.equal(
    (await call("/api/threads/conv-1", { method: "DELETE" })).status,
    401,
  );
});

test("Claude Code stream output yields text, thinking tokens, context window, and rate-limit quota", async () => {
  const { parseClaudeOutput, progressItem } = await import(
    "../desktop/lib/providers/claude-code.mjs"
  );
  const lines = [
    { type: "system", subtype: "init", session_id: "s-1" },
    { type: "system", subtype: "thinking_tokens", estimated_tokens: 102 },
    {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Count the primes." },
          { type: "text", text: "5" },
        ],
      },
    },
    {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: {
          five_hour: { utilization: 0.56, resetsAt: 1789249800 },
          seven_day: { utilization: 0.25 },
        },
      },
    },
    {
      type: "result",
      subtype: "success",
      result: "5",
      session_id: "s-1",
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 4341,
        cache_creation_input_tokens: 758,
        output_tokens: 83,
        output_tokens_details: { thinking_tokens: 80 },
      },
      modelUsage: { "claude-opus-5[1m]": { contextWindow: 1000000 } },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
  const parsed = parseClaudeOutput(lines, "", 0, "default");
  assert.equal(parsed.content, "5");
  assert.equal(parsed.usage.promptTokens, 5101);
  assert.equal(parsed.usage.cachedTokens, 4341);
  assert.equal(parsed.usage.reasoningTokens, 80);
  assert.equal(parsed.contextWindow, 1000000);
  assert.equal(parsed.reasoning, "Count the primes.");
  assert.equal(parsed.thread, "s-1");
  assert.deepEqual(parsed.quota, {
    used: 56,
    limit: 100,
    unit: "% of the 5-hour window",
    resetsAt: new Date(1789249800 * 1000).toISOString(),
    label: "7-day window 25% used",
  });
  assert.deepEqual(
    progressItem({
      type: "system",
      subtype: "thinking_tokens",
      estimated_tokens: 102,
    }),
    { type: "thinking", tokens: 102 },
  );
  assert.deepEqual(
    progressItem({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "partial" },
      },
    }),
    { type: "output_delta", text: "partial" },
  );
  assert.equal(parseClaudeOutput("", "boom", 1, "default").isError, true);
});

test("OpenCode verbose model listing yields limits and capabilities", async () => {
  const { parseModelList } = await import(
    "../desktop/lib/providers/opencode.mjs"
  );
  const stdout = `opencode/big-pickle\n{\n  "id": "big-pickle",\n  "name": "Big Pickle",\n  "limit": { "context": 200000, "output": 32000 },\n  "capabilities": { "reasoning": true, "toolcall": true, "input": { "text": true, "image": false } }\n}\nother/plain\n`;
  const models = parseModelList(stdout);
  assert.equal(models.length, 2);
  assert.equal(models[0].contextWindow, 200000);
  assert.deepEqual(models[0].capabilities, {
    tools: true,
    vision: false,
    reasoning: true,
  });
  assert.equal(models[0].displayName, "Big Pickle (opencode/big-pickle)");
  assert.equal(models[1].contextWindow, null);
  assert.equal(models[1].capabilities.reasoning, false);
  const { describeOpenCodeCredentials } = await import(
    "../desktop/lib/providers/opencode.mjs"
  );
  assert.deepEqual(
    describeOpenCodeCredentials({
      "opencode-go": { type: "api", key: "secret" },
      anthropic: { type: "oauth", access: "x" },
    }),
    [
      { id: "opencode-go", label: "OpenCode Go", type: "API key" },
      { id: "anthropic", label: "Anthropic", type: "sign-in" },
    ],
  );
  const retired = parseModelList(
    `x/old\n{ "id": "old", "status": "deprecated" }\nx/free-one\n{ "id": "free-one", "name": "Free One", "status": "active", "cost": { "input": 0, "output": 0 } }\n`,
  );
  assert.deepEqual(
    retired.map((model) => `${model.id}:${model.free}`),
    ["x/free-one:true"],
  );
});

test("Claude Code control-protocol probe yields account, model list, and plan windows", async () => {
  const { parseClaudeProbe, claudePlanLabel } = await import(
    "../desktop/lib/providers/claude-code.mjs"
  );
  const messages = [
    { type: "system", subtype: "init" },
    {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "init",
        response: {
          account: {
            email: "me@example.test",
            organization: "Acme",
            subscriptionType: "Claude Team",
            apiProvider: "firstParty",
          },
          models: [
            {
              value: "default",
              resolvedModel: "claude-opus-5[1m]",
              displayName: "Default (recommended)",
              description: "Opus 5 with 1M context",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
            },
            {
              value: "sonnet",
              resolvedModel: "claude-sonnet-5",
              displayName: "Sonnet",
              supportsEffort: true,
              supportedEffortLevels: ["low", "medium", "high", "ultrathink"],
            },
            {
              value: "haiku",
              resolvedModel: "claude-haiku-4-5",
              displayName: "Haiku",
              supportsEffort: false,
            },
          ],
        },
      },
    },
    {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "usage",
        response: {
          subscription_type: "team",
          rate_limits_available: true,
          rate_limits: {
            five_hour: {
              utilization: 18,
              resets_at: "2026-09-13T08:50:00.037064+00:00",
            },
            seven_day: {
              utilization: 31,
              resets_at: "2026-09-18T13:00:00+00:00",
            },
            nimbus_quill: { utilization: 0, resets_at: null },
            model_scoped: [
              {
                display_name: "Fable",
                utilization: 47,
                resets_at: "2026-09-18T13:00:00+00:00",
              },
            ],
          },
        },
      },
    },
  ];
  const probe = parseClaudeProbe(messages);
  assert.equal(probe.account.email, "me@example.test");
  assert.equal(probe.account.organization, "Acme");
  assert.equal(probe.models.length, 3);
  assert.equal(probe.models[0].contextWindow, 1_000_000);
  assert.equal(probe.models[1].contextWindow, 200_000);
  assert.equal(
    parseClaudeProbe([
      messages[0],
      {
        type: "control_response",
        response: {
          subtype: "success",
          request_id: "init",
          response: {
            account: {},
            models: [
              {
                value: "fable[1m]",
                resolvedModel: "claude-fable-5-1",
                displayName: "Fable",
              },
            ],
          },
        },
      },
    ]).models[0].contextWindow,
    1_000_000,
    "the [1m] marker may sit on the selectable value",
  );
  assert.deepEqual(probe.models[1].reasoningLevels, ["low", "medium", "high"]);
  assert.equal(probe.models[2].capabilities.reasoning, false);
  assert.equal(probe.quota.used, 18);
  assert.equal(probe.quota.resetsAt, "2026-09-13T08:50:00.037Z");
  assert.deepEqual(
    probe.quota.windows.map((w) => `${w.id}:${w.usedPercent}`),
    ["five_hour:18", "seven_day:31", "seven_day_fable:47"],
  );
  assert.equal(probe.quota.label, "Weekly 31% · Weekly · Fable 47%");
  assert.equal(claudePlanLabel("Claude Team"), "Claude Team");
  assert.equal(
    claudePlanLabel("claude_max_20x_subscription"),
    "Claude Max 20x",
  );
  assert.equal(claudePlanLabel("pro"), "Claude Pro");
  assert.equal(parseClaudeProbe([]), null);
});

test("Codex app-server probe yields account, rate-limit windows, spend, and models", async () => {
  const { parseCodexProbe } = await import(
    "../desktop/lib/providers/codex.mjs"
  );
  const messages = [
    { id: "init", result: { userAgent: "codex/0.153.4" } },
    { method: "remoteControl/status/changed", params: {} },
    {
      id: "account",
      result: {
        account: {
          type: "chatgpt",
          email: "me@example.test",
          planType: "team",
        },
        requiresOpenaiAuth: true,
      },
    },
    {
      id: "limits",
      result: {
        rateLimits: {
          limitId: "codex",
          planType: "team",
          primary: {
            usedPercent: 3,
            windowDurationMins: 300,
            resetsAt: 1789293465,
          },
          secondary: {
            usedPercent: 16,
            windowDurationMins: 10080,
            resetsAt: 1789833137,
          },
          individualLimit: {
            limit: "20",
            used: "9.100202322006226",
            remainingPercent: 54,
            resetsAt: 1790812801,
          },
        },
      },
    },
    {
      id: "models",
      result: {
        data: [
          {
            id: "gpt-6-astra",
            displayName: "GPT-6-Astra",
            isDefault: true,
            hidden: false,
            defaultReasoningEffort: "low",
            supportedReasoningEfforts: [
              { reasoningEffort: "low" },
              { reasoningEffort: "high" },
              { reasoningEffort: "ultra" },
            ],
            inputModalities: ["text", "image"],
          },
          {
            id: "secret",
            displayName: "Hidden",
            hidden: true,
            supportedReasoningEfforts: [],
          },
        ],
        nextCursor: null,
      },
    },
  ];
  const probe = parseCodexProbe(messages);
  assert.deepEqual(probe.account, {
    type: "chatgpt",
    email: "me@example.test",
    planType: "team",
  });
  assert.equal(probe.models.length, 1, "hidden models are dropped");
  assert.deepEqual(probe.models[0].reasoningLevels, ["low", "high"]);
  assert.equal(probe.models[0].defaultReasoning, "low");
  assert.equal(probe.models[0].acceptsImages, true);
  assert.equal(probe.quota.used, 3);
  assert.equal(probe.quota.windows[0].label, "Session (5h)");
  assert.equal(probe.quota.windows[1].label, "Weekly");
  assert.equal(
    probe.quota.windows[1].resetsAt,
    new Date(1789833137 * 1000).toISOString(),
  );
  assert.match(probe.quota.label, /Spend \$9\.10 of \$20 · Weekly 16%/);
  assert.equal(probe.quota.note, "Spend $9.10 of $20");
});
