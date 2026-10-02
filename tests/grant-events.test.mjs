import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { broker } from "./helpers/broker.mjs";
import { grantsHash, originFromHash } from "../src/lib/settings-link.js";

const OTHER = "https://other.test";

/**
 * Every grant mutation path changes the revision the content script compares
 * (SPEC 3, `arjunah:grantchange`), and none of them changes another origin's.
 */
test("grant.state moves on every mutation path of this origin and only this origin", async (t) => {
  const b = await broker(t);
  b.store.opencode = {
    baseUrl: "https://opencode.ai/zen/v1",
    model: "muse-spark-1.3",
    models: ["muse-spark-1.3"],
    apiKey: "zen-secret",
  };
  b.sessions.set(2, { origin: OTHER, session: "session-2" });
  const other = b.sender(OTHER, 2);
  const mine = () => b.ok("grant.state");
  const theirs = () => b.ok("grant.state", {}, other);

  const none = await mine();
  assert.deepEqual(none, {
    level: null,
    model: null,
    revoked: true,
    revision: "",
  });
  const seen = [none.revision];
  const theirsBefore = await theirs();
  const step = async (label, operation) => {
    await operation();
    const state = await mine();
    assert.notEqual(state.revision, seen.at(-1), `${label} changes it`);
    seen.push(state.revision);
    assert.deepEqual(
      await theirs(),
      theirsBefore,
      `${label} leaves another origin alone`,
    );
    // Nothing but these four reach the content script.
    assert.deepEqual(Object.keys(state).sort(), [
      "level",
      "model",
      "revision",
      "revoked",
    ]);
    return state;
  };

  const consent = await step("consent", () =>
    b.approve(["models.list", "models.generate"]),
  );
  assert.deepEqual(
    [consent.level, consent.model, consent.revoked],
    ["completion", "openai/allowed", false],
  );
  const popup = await step("popup site model", () =>
    b.ok(
      "site.update",
      { origin: "https://site.test", model: "opencode-api/muse-spark-1.3" },
      b.extension,
    ),
  );
  assert.equal(popup.model, "opencode-api/muse-spark-1.3");
  await step("catalog level", () =>
    b.approve(["models.list", "models.generate", "models.catalog"]),
  );
  await step("exposed providers", () =>
    b.ok(
      "site.update",
      { origin: "https://site.test", providers: ["openai"] },
      b.extension,
    ),
  );
  await b.approve(["chat.hosted"]);
  seen.push((await mine()).revision);
  const header = await step("hosted header", () =>
    b.ok("hosted.model", { model: "openai/allowed" }),
  );
  assert.equal(header.model, "openai/allowed");
  // The global default moves the site model of a site that follows it.
  await b.ok(
    "site.update",
    { origin: "https://site.test", model: null },
    b.extension,
  );
  seen.push((await mine()).revision);
  await step("global default", () =>
    b.ok(
      "catalog.default",
      { model: "opencode-api/muse-spark-1.3" },
      b.extension,
    ),
  );
  const revoked = await step("disable()", () => b.ok("grant.revoke"));
  assert.deepEqual(
    [revoked.level, revoked.model, revoked.revoked],
    [null, null, true],
  );
  seen.length = 0;
  await b.approve(["models.list", "models.generate"]);
  await step("settings revoke", () =>
    b.ok("grants.revoke", { origin: "https://site.test" }, b.extension),
  );
  await b.approve(["models.list", "models.generate"]);
  // Revoking all sites is the one path that changes every origin.
  await b.approve(["models.list", "models.generate"], {}, other);
  await b.ok("grants.clear", {}, b.extension);
  assert.equal((await mine()).revoked, true);
  assert.equal((await theirs()).revoked, true);
});

/** The real page-api.js against a window the test plays the other side of. */
function pageWorld() {
  const nonce = "nonce-1";
  const win = new EventTarget();
  const posted = [];
  win.postMessage = (data) => {
    const copy = structuredClone(data);
    if (copy.direction === "page-to-extension") {
      posted.push(copy);
      return;
    }
    const event = new Event("message");
    event.source = win;
    event.data = copy;
    win.dispatchEvent(event);
  };
  const context = vm.createContext({
    window: win,
    document: { currentScript: { dataset: { arjunahNonce: nonce } } },
    crypto,
    CustomEvent,
    TextEncoder,
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(readFileSync("src/page-api.js", "utf8"), context);
  return { win, api: win.ai.arjunah, posted, nonce };
}

test("page API: arjunah:grantchange carries exactly level, model, and revoked", () => {
  const world = pageWorld();
  const events = [];
  world.win.addEventListener("arjunah:grantchange", (event) =>
    events.push(event.detail),
  );
  const send = (payload, nonce = world.nonce) =>
    world.win.postMessage({
      channel: "arjunah-v0.1",
      direction: "extension-to-page",
      nonce,
      kind: "grantchange",
      ...payload,
    });
  send({
    detail: {
      level: "catalog",
      model: "openai/gpt-5.6-sol",
      revoked: false,
      providers: ["openai"],
      origin: OTHER,
    },
  });
  send({ detail: { level: null, model: null, revoked: true } });
  send({ detail: { level: "root", model: 7, revoked: "yes" } });
  // A message without the bridge nonce is not the extension's.
  send({ detail: { level: "completion" } }, "forged");
  // The detail objects belong to the page's realm; compare their content.
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [
    { level: "catalog", model: "openai/gpt-5.6-sol", revoked: false },
    { level: null, model: null, revoked: true },
    { level: null, model: null, revoked: false },
  ]);
  assert.ok(Object.isFrozen(events[0]));
});

test("page API: openSettings() asks the extension and is a root member", async () => {
  const world = pageWorld();
  const pending = world.api.openSettings();
  const request = world.posted.at(-1);
  assert.equal(request.kind, "request");
  assert.equal(request.method, "settings.open");
  world.win.postMessage({
    channel: request.channel,
    direction: "extension-to-page",
    nonce: world.nonce,
    kind: "response",
    id: request.id,
    ok: true,
    result: true,
  });
  assert.equal(await pending, true);
  assert.deepEqual(Object.keys(world.api).sort(), [
    "chat",
    "disable",
    "enable",
    "isEnabled",
    "openSettings",
    "site",
    "version",
  ]);
});

test("openSettings opens the popup where allowed, else the options page, at most once a second per tab", async (t) => {
  const b = await broker(t);
  const opened = [];
  chrome.tabs.create = async (options) => {
    opened.push(["tab", options]);
    return { id: 9 };
  };
  const sender = { ...b.sender(), tab: { ...b.sender().tab, windowId: 3 } };
  assert.equal(await b.ok("ui.openSettings", {}, sender), true);
  // The options page lands on the asking site's row; the origin is the
  // sender's, and the page only ever learns `true`.
  assert.deepEqual(opened, [
    [
      "tab",
      {
        url: "chrome-extension://test/options.html#grants:https%3A%2F%2Fsite.test",
        windowId: 3,
      },
    ],
  ]);
  assert.equal(
    originFromHash(new URL(opened[0][1].url).hash),
    "https://site.test",
  );
  // A second click within the second opens nothing more.
  assert.equal(await b.ok("ui.openSettings", {}, sender), true);
  assert.equal(opened.length, 1);

  chrome.action = {
    async openPopup(options) {
      opened.push(["popup", options]);
    },
  };
  const later = { ...sender, tab: { ...sender.tab, id: 2 } };
  b.sessions.set(2, { origin: "https://site.test", session: "session-2" });
  assert.equal(await b.ok("ui.openSettings", {}, later), true);
  assert.deepEqual(opened.at(-1), ["popup", { windowId: 3 }]);

  // A browser that refuses the popup here still gets the options page.
  chrome.action.openPopup = async () => {
    throw new Error("Not allowed");
  };
  // A page asking for another site's row cannot: params are ignored.
  const third = { ...sender, tab: { ...sender.tab, id: 4 } };
  assert.equal(
    await b.ok("ui.openSettings", { origin: "https://evil.test" }, third),
    true,
  );
  assert.deepEqual(opened.at(-1), [
    "tab",
    {
      url: "chrome-extension://test/options.html#grants:https%3A%2F%2Fsite.test",
      windowId: 3,
    },
  ]);
  // Settings pages and frames are not pages that may ask.
  assert.equal(
    (await b.call("ui.openSettings", {}, { ...sender, frameId: 1 })).error.code,
    "NOT_SUPPORTED",
  );
});

test("the content script refuses openSettings without a user gesture before reaching the extension", () => {
  // content.js needs a browser to run; this pins the gate it applies. The
  // browser suites exercise both sides of it.
  const source = readFileSync("src/content.js", "utf8");
  const gate = source.indexOf('method === "settings.open"');
  assert.ok(gate > 0);
  const block = source.slice(gate, source.indexOf("}", gate + 400));
  assert.match(block, /navigator\.userActivation\?\.isActive !== true/);
  assert.match(block, /PERMISSION_REQUIRED/);
  assert.ok(
    block.indexOf("PERMISSION_REQUIRED") <
      block.indexOf('runtime("ui.openSettings")'),
  );
});

test("the options page reads only one exact http(s) origin from a #grants: address", () => {
  for (const origin of [
    "https://site.test",
    "http://127.0.0.1:8080",
    "https://xn--80ak6aa92e.com",
  ])
    assert.equal(originFromHash(grantsHash(origin)), origin);
  for (const hash of [
    "",
    "#grants",
    "#grants:",
    "#grants:https%3A%2F%2Fsite.test%2Fpath",
    "#grants:javascript%3Aalert(1)",
    "#grants:moz-extension%3A%2F%2Fabc",
    "#grants:%E0%A4%A",
    "#grants:https%3A%2F%2FSITE.test",
    "#other:https%3A%2F%2Fsite.test",
    null,
  ])
    assert.equal(originFromHash(hash), null, String(hash));
});
