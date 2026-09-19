import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exchangePairingToken,
  t3Origin,
  T3Rpc,
  T3Error,
} from "../desktop/lib/t3/client.mjs";
import {
  mapT3Providers,
  enrichProviders,
  parseWindow,
  quotaFrom,
} from "../desktop/lib/t3/catalog.mjs";
import { createDesktopApp } from "../desktop/lib/server.mjs";
import { Store } from "../desktop/lib/store.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/t3-config.json", import.meta.url), "utf8"),
);

/** An in-process WebSocket stand-in that answers like a T3 server. */
class FakeSocket extends EventTarget {
  constructor(handler) {
    super();
    this.handler = handler;
    this.sent = [];
    this.closed = false;
  }
  send(text) {
    this.sent.push(JSON.parse(text));
    const reply = this.handler(JSON.parse(text));
    if (reply)
      queueMicrotask(() =>
        this.dispatchEvent(
          Object.assign(new Event("message"), { data: JSON.stringify(reply) }),
        ),
      );
  }
  close() {
    this.closed = true;
  }
}

test("T3 pairing exchanges the one-time token for a bearer and rejects junk", async (t) => {
  const seen = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push({ url: request.url, body: new URLSearchParams(body) });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        access_token: "bearer-1",
        scope: "orchestration:read orchestration:operate",
        expires_in: 3600,
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const paired = await exchangePairingToken(
    base,
    `${base}/pair#token=ABC123DEF`,
  );
  assert.equal(paired.accessToken, "bearer-1");
  assert.equal(paired.baseUrl, base);
  assert.equal(seen[0].url, "/oauth/token");
  assert.equal(seen[0].body.get("subject_token"), "ABC123DEF");
  assert.equal(
    seen[0].body.get("subject_token_type"),
    "urn:t3:params:oauth:token-type:environment-bootstrap",
  );
  await assert.rejects(
    () => exchangePairingToken(base, "!!"),
    (error) => error instanceof T3Error && error.code === "INVALID_REQUEST",
  );
  assert.throws(() => t3Origin("ftp://x"), /http\(s\)/);
  assert.equal(
    t3Origin("https://laptop.tailnet.ts.net/some/path"),
    "https://laptop.tailnet.ts.net",
  );
});

test("T3 RPC client frames requests as Effect RPC JSON and handles Chunk, Exit, Ping, and failures", async () => {
  const socket = new FakeSocket((message) => {
    if (message._tag === "Request" && message.tag === "server.getConfig")
      return [
        { _tag: "Ping" },
        {
          _tag: "Exit",
          requestId: message.id,
          exit: { _tag: "Success", value: { providers: [1, 2] } },
        },
      ];
    if (message._tag === "Request" && message.tag === "stream")
      return [
        { _tag: "Chunk", requestId: message.id, values: ["a", "b"] },
        { _tag: "Exit", requestId: message.id, exit: { _tag: "Success" } },
      ];
    if (message._tag === "Request")
      return {
        _tag: "Exit",
        requestId: message.id,
        exit: {
          _tag: "Failure",
          cause: [
            {
              _tag: "Fail",
              error: { _tag: "EnvironmentAuthorizationError", reason: "scope" },
            },
          ],
        },
      };
    return null;
  });
  const rpc = new T3Rpc(socket);
  const config = await rpc.call("server.getConfig", {});
  assert.deepEqual(config, { providers: [1, 2] });
  assert.deepEqual(socket.sent[0], {
    _tag: "Request",
    id: "1",
    tag: "server.getConfig",
    payload: {},
    headers: [],
  });
  assert.ok(
    socket.sent.some((item) => item._tag === "Pong"),
    "pings are answered",
  );
  const chunks = [];
  const streamed = await rpc.call(
    "stream",
    {},
    { onChunk: (value) => chunks.push(value) },
  );
  assert.deepEqual(streamed, ["a", "b"]);
  assert.deepEqual(chunks, ["a", "b"]);
  await assert.rejects(
    () => rpc.call("denied", {}),
    /EnvironmentAuthorizationError: scope/,
  );
  rpc.close();
  assert.equal(socket.closed, true);
});

test("T3 provider snapshots map to Arjunah providers with models, windows, reasoning, and quota", () => {
  const mapped = mapT3Providers(fixture.providers, {
    environmentLabel: "T3 Code (My laptop)",
  });
  const claude = mapped.enrich["claude-code"];
  assert.ok(claude, "claudeAgent maps to claude-code");
  assert.equal(claude.account, "sudip@sireto.io");
  assert.equal(claude.models.length, 10);
  const fable = claude.models.find((model) => model.id === "claude-fable-5-1");
  assert.equal(fable.displayName, "Claude Fable 5.1");
  assert.deepEqual(fable.reasoningLevels, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(fable.defaultReasoning, "medium");
  assert.equal(
    fable.contextWindow,
    1_000_000,
    "T3 marks the 1M window as default",
  );
  assert.equal(
    claude.models.filter((model) => !model.legacy).length,
    3,
    "current models come first",
  );
  assert.equal(claude.models[0].legacy, false);
  assert.equal(fable.isDefault, true);
  assert.equal(claude.quota.used, 74);
  assert.equal(claude.quota.unit, "% of session (5h)");
  assert.equal(claude.quota.resetsAt, "2026-09-12T21:50:00.154Z");
  assert.equal(claude.quota.label, "Weekly 28% · Weekly (Fable) 42%");
  assert.deepEqual(
    claude.quota.windows.map((w) => `${w.id}:${w.usedPercent}`),
    ["five_hour:74", "seven_day:28", "seven_day_fable:42"],
  );
  assert.equal(claude.defaultModel, "claude-fable-5-1");
  const grok = mapped.external.find((item) => item.id === "t3-grok");
  assert.ok(grok, "drivers Arjunah cannot run are listed as external");
  assert.equal(grok.available, false);
  assert.match(grok.reason, /no runner/);
  assert.equal(grok.models[0].id, "grok-build");
  assert.equal(parseWindow("1m"), 1_000_000);
  assert.equal(parseWindow("200k"), 200_000);
  assert.equal(parseWindow("weird"), null);
  assert.equal(quotaFrom(null), null);
  const merged = enrichProviders(
    [
      {
        id: "claude-code",
        name: "Claude Code",
        available: true,
        models: [
          { id: "default", displayName: "Claude (account default)" },
          { id: "claude-fable-5-1", displayName: "typed" },
        ],
        defaultModel: "default",
        quota: null,
        account: null,
        connection: null,
      },
    ],
    mapped,
  );
  assert.equal(merged[0].models[0].id, "claude-fable-5-1", "T3 models lead");
  assert.equal(merged[0].models[0].displayName, "Claude Fable 5.1");
  assert.ok(
    merged[0].models.some((model) => model.id === "default"),
    "Arjunah models kept",
  );
  assert.equal(
    merged[0].models.filter((model) => model.id === "claude-fable-5-1").length,
    1,
  );
  assert.equal(merged[0].quota.used, 74);
  assert.equal(
    merged[0].defaultModel,
    "default",
    "Arjunah default wins when set",
  );
  assert.equal(merged[0].catalogSource, "T3 Code (My laptop)");
  assert.ok(merged.some((provider) => provider.id === "t3-grok"));
});

test("the companion merges a paired T3 catalog into /api/providers and never returns the bearer", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "arjunah-t3-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  const calls = [];
  const app = createDesktopApp({
    store,
    detect: async () => [
      {
        id: "claude-code",
        name: "Claude Code",
        vendor: "Anthropic",
        kind: "subscription",
        installed: true,
        available: true,
        supportsTools: true,
        models: [{ id: "default", displayName: "Claude (account default)" }],
        defaultModel: "default",
      },
    ],
    t3Fetch: async (url, token, options) => {
      calls.push({ url, token, options });
      return { environment: fixture.environment, providers: fixture.providers };
    },
  });
  const address = await app.listen(0);
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (path, init = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        ...(init.headers ?? {}),
      },
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  };
  const pair = await call("/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: app.pairing.current().code,
      client: { name: "t" },
    }),
  });
  const auth = { Authorization: `Bearer ${pair.body.token}` };
  // Before T3 is configured, Arjunah reports its own detection only.
  const plain = await call("/api/providers", { headers: auth });
  assert.equal(plain.body.providers.length, 1);
  assert.equal(plain.body.t3.configured, false);
  assert.equal(calls.length, 0);
  store.updateSettings({
    t3Url: "http://127.0.0.1:3777",
    t3Token: "secret-bearer",
  });
  const enriched = await call("/api/providers", { headers: auth });
  assert.equal(calls[0].token, "secret-bearer");
  const claude = enriched.body.providers.find(
    (item) => item.id === "claude-code",
  );
  assert.equal(claude.models.length, 11);
  assert.equal(claude.models[0].displayName, "Claude Fable 5.1");
  assert.equal(claude.quota.used, 74);
  assert.equal(claude.account, "sudip@sireto.io");
  assert.ok(enriched.body.providers.some((item) => item.id === "t3-grok"));
  assert.equal(enriched.body.t3.configured, true);
  assert.equal(JSON.stringify(enriched.body).includes("secret-bearer"), false);
  // The dashboard sees a masked token and can disconnect.
  const dashboardToken = app.dashboardToken;
  const state = await fetch(`${base}/api/dashboard/state`, {
    headers: { "x-dashboard-token": dashboardToken },
  }).then((r) => r.json());
  assert.equal(state.settings.t3Token, "•••••");
  assert.equal(state.t3.configured, true);
  const removed = await fetch(`${base}/api/dashboard/t3`, {
    method: "DELETE",
    headers: { "x-dashboard-token": dashboardToken },
  }).then((r) => r.json());
  assert.equal(removed.t3.configured, false);
  assert.equal(store.settings.t3Token, undefined);
});
