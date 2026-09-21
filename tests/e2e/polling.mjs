// End-to-end: what the extension asks the companion for while nobody is doing
// anything. A paired browser should be quiet when idle — the companion pushes
// invalidations over the event socket, so there is nothing to poll for. Any
// steady stream of /api/status or /api/providers is a refresh loop: something
// answers a state broadcast by writing state, which broadcasts again.
//
// Failures print the whole picture rather than a bare count: which paths were
// fetched, which broadcast reasons drove them, which storage keys were written,
// and — when a write really did change something — the exact fields that moved.
// That names the loop's driver instead of leaving it to be guessed at.
//
//   node tests/e2e/polling.mjs
//   ARJUNAH_E2E_IDLE_MS=30000 node tests/e2e/polling.mjs   # longer idle window
//   ARJUNAH_E2E_HEADFUL=1 node tests/e2e/polling.mjs       # watch it happen
import { mockProviderExtension } from "../helpers/browser-extension.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer";
import { createDesktopApp } from "../../desktop/lib/server.mjs";
import { Store } from "../../desktop/lib/store.mjs";

const IDLE_MS = Number(process.env.ARJUNAH_E2E_IDLE_MS) || 15000;
// An idle paired browser may legitimately react to the companion's own 30s
// provider monitor. Anything beyond a couple of round trips is a loop.
const BUDGET = Number(process.env.ARJUNAH_E2E_IDLE_BUDGET) || 6;
// ARJUNAH_E2E_TRACE=1 watches from before pairing and prints the first events in
// order, with the gap between them. That shows what seeds a refresh cycle and
// what paces it — a loop's cadence is its own round-trip time, not a timer.
const TRACE = Boolean(process.env.ARJUNAH_E2E_TRACE);
// Real provider detection shells out to CLIs and takes seconds. An instant fake
// would let duplicate probes finish before they can overlap, hiding exactly the
// cost a missing single-flight guard has in practice.
const PROBE_MS = Number(process.env.ARJUNAH_E2E_PROBE_MS ?? 500);

const fakeAdapter = {
  id: "claude-code",
  name: "Claude Code",
  vendor: "Anthropic",
  supportsTools: true,
  async detect() {
    return {
      installed: true,
      available: true,
      binary: "/fake/claude",
      version: "fake",
      account: "fake@example.test",
      models: [
        { id: "default", displayName: "Default" },
        { id: "sonnet", displayName: "Sonnet" },
      ],
      defaultModel: "default",
    };
  },
  start() {
    return { child: null, output: Promise.resolve({ content: "ok" }) };
  },
};

const storeDirectory = mkdtempSync(join(tmpdir(), "arjunah-polling-e2e-"));
const desktop = createDesktopApp({
  store: new Store(storeDirectory),
  log: () => {},
  adapters: (id) => (id === "claude-code" ? fakeAdapter : null),
  detect: async () => [
    ...(await new Promise((wait) => setTimeout(wait, PROBE_MS)).then(() => [])),
    {
      id: "claude-code",
      name: "Claude Code",
      vendor: "Anthropic",
      kind: "subscription",
      supportsTools: true,
      enabled: true,
      ...(await fakeAdapter.detect()),
    },
  ],
});

// Every request the extension makes, counted before the app sees it — and held
// open until its response finishes, so overlapping probes are visible. Two
// identical reads in flight at once is a missing single-flight guard, not a
// loop: it costs a full duplicate probe every time.
const hits = [];
const inFlight = new Map();
const peak = new Map();
desktop.server.prependListener("request", (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const label = `${request.method} ${url.pathname}${url.searchParams.get("refresh") === "1" ? "?refresh=1" : ""}`;
  hits.push({ at: Date.now(), label });
  const now = (inFlight.get(label) ?? 0) + 1;
  inFlight.set(label, now);
  peak.set(label, Math.max(peak.get(label) ?? 0, now));
  response.once("finish", () => inFlight.set(label, inFlight.get(label) - 1));
});
const upgrades = [];
desktop.server.prependListener("upgrade", () => upgrades.push(Date.now()));

const desktopAddress = await desktop.listen(0);
const desktopUrl = `http://127.0.0.1:${desktopAddress.port}`;

const profile = await mkdtemp(join(tmpdir(), "arjunah-polling-chrome-"));
const testExtension = await mockProviderExtension("http://127.0.0.1:9/v1");
let browser;

/** Watch the broker's own invalidation traffic from inside an extension page. */
async function installProbe(page) {
  await page.evaluate(() => {
    if (window.__probe) return;
    const probe = { states: [], storage: [] };
    window.__probe = probe;
    // A second listener on the same broadcast the options page already uses:
    // passive, and it records why the broker thinks state moved.
    const port = chrome.runtime.connect({ name: "arjunah-state" });
    port.onMessage.addListener((message) =>
      probe.states.push({
        at: Date.now(),
        reason: message.reason ?? "(initial)",
        revision: message.revision,
      }),
    );
    chrome.storage.onChanged.addListener((changes, area) => {
      for (const [key, change] of Object.entries(changes)) {
        const before = change.oldValue ?? null;
        const after = change.newValue ?? null;
        const entry = {
          at: Date.now(),
          area,
          key,
          changed: JSON.stringify(before) !== JSON.stringify(after),
          fields: [],
        };
        // A compact before/after shape for the key the loop writes, so the
        // sequence of writes can be read rather than inferred.
        if (key === "desktop")
          entry.shape = [before, after]
            .map((value) =>
              value
                ? `providers=${value.providers === undefined ? "MISSING" : value.providers.length} at=${value.providersAt ?? "-"} rev=${value.revision ?? "-"}`
                : "null",
            )
            .join("  ->  ");
        // Name the fields that actually moved, so a churning value is obvious.
        if (entry.changed && before && after && typeof after === "object")
          for (const field of new Set([
            ...Object.keys(before),
            ...Object.keys(after),
          ]))
            if (
              JSON.stringify(before[field]) !== JSON.stringify(after[field])
            ) {
              // `providers` is a large array: report the inner path, not 14 kB.
              if (field === "providers") {
                const olds = before[field] ?? [];
                const news = after[field] ?? [];
                if (olds.length !== news.length)
                  entry.fields.push(
                    `providers.length ${olds.length}->${news.length}`,
                  );
                for (let i = 0; i < Math.max(olds.length, news.length); i++)
                  for (const inner of new Set([
                    ...Object.keys(olds[i] ?? {}),
                    ...Object.keys(news[i] ?? {}),
                  ]))
                    if (
                      JSON.stringify(olds[i]?.[inner]) !==
                      JSON.stringify(news[i]?.[inner])
                    )
                      entry.fields.push(
                        `providers[${i}].${inner}: ${JSON.stringify(olds[i]?.[inner])?.slice(0, 80)} -> ${JSON.stringify(news[i]?.[inner])?.slice(0, 80)}`,
                      );
              } else entry.fields.push(field);
            }
        probe.storage.push(entry);
      }
    });
  });
}

const readProbe = (page) =>
  page.evaluate(() => window.__probe ?? { states: [], storage: [] });

function histogram(items, key) {
  const counts = new Map();
  for (const item of items)
    counts.set(item[key], (counts.get(item[key]) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

/** Go quiet, then report everything that happened anyway. */
async function idleWindow(label, page) {
  const from = Date.now();
  const before = hits.length;
  if (page) await page.evaluate(() => (window.__probe.mark = Date.now()));
  await new Promise((wait) => setTimeout(wait, IDLE_MS));
  const window_ = hits.slice(before);
  const probe = page ? await readProbe(page) : { states: [], storage: [] };
  const since = (list) => list.filter((item) => item.at >= from);
  const report = {
    label,
    seconds: Math.round((Date.now() - from) / 1000),
    requests: window_.length,
    paths: histogram(window_, "label"),
    broadcasts: histogram(since(probe.states), "reason"),
    writes: histogram(since(probe.storage), "key"),
    realChanges: since(probe.storage)
      .filter((item) => item.changed)
      .flatMap((item) => item.fields),
    timeline: since(probe.storage)
      .filter((item) => item.shape)
      .slice(0, 8)
      .map((item) => item.shape),
  };
  print(report);
  return report;
}

function print(report) {
  console.log(`\n--- idle: ${report.label} (${report.seconds}s) ---`);
  console.log(`  companion requests: ${report.requests}`);
  for (const [path, count] of report.paths)
    console.log(`    ${count}x ${path}`);
  if (report.broadcasts.length) {
    console.log("  state broadcasts, by reason:");
    for (const [reason, count] of report.broadcasts)
      console.log(`    ${count}x ${reason}`);
  }
  if (report.writes.length) {
    console.log("  storage writes, by key:");
    for (const [key, count] of report.writes)
      console.log(`    ${count}x ${key}`);
  }
  if (report.realChanges.length) {
    console.log("  fields that actually changed (the churn, if any):");
    for (const [field, count] of histogram(
      report.realChanges.map((field) => ({ field })),
      "field",
    ))
      console.log(`    ${count}x ${field}`);
  }
  if (report.timeline?.length) {
    console.log("  first writes to the `desktop` key, in order:");
    for (const line of report.timeline) console.log(`    ${line}`);
  }
}

/** The first events after pairing, interleaved and in order. */
async function trace(page, from) {
  const probe = await readProbe(page);
  const events = [
    ...hits.map((item) => ({ at: item.at, text: `-> ${item.label}` })),
    ...probe.states.map((item) => ({
      at: item.at,
      text: `broadcast #${item.revision} (${item.reason})`,
    })),
    ...probe.storage.map((item) => ({
      at: item.at,
      text: `write ${item.key}${item.changed ? ` [${item.fields.join(", ") || "changed"}]` : " [no-op]"}`,
    })),
  ]
    .filter((item) => item.at >= from)
    .sort((a, b) => a.at - b.at)
    .slice(0, 40);
  console.log("\n--- trace: pairing onwards ---");
  let previous = from;
  for (const event of events) {
    console.log(
      `  +${String(event.at - from).padStart(5)}ms  (+${String(event.at - previous).padStart(4)})  ${event.text}`,
    );
    previous = event.at;
  }
}

try {
  browser = await puppeteer.launch({
    headless: process.env.ARJUNAH_E2E_HEADFUL ? false : true,
    ...(process.env.CHROME_PATH
      ? { executablePath: process.env.CHROME_PATH }
      : {}),
    userDataDir: profile,
    protocolTimeout: 60000,
    args: [
      `--disable-extensions-except=${testExtension.directory}`,
      `--load-extension=${testExtension.directory}`,
    ],
  });
  const workerTarget = await browser.waitForTarget(
    (target) =>
      target.type() === "service_worker" &&
      target.url().startsWith("chrome-extension://"),
    { timeout: 15000 },
  );
  const extensionId = new URL(workerTarget.url()).host;

  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${extensionId}/options.html`);
  await settings.waitForFunction(() =>
    /Desktop app v|not detected/.test(
      document.querySelector("#desktop-state").textContent,
    ),
  );

  // Watch from before pairing when tracing, so the first cause is on record.
  if (TRACE) await installProbe(settings);
  const traceFrom = Date.now();

  // Pair, so the extension is in the state the bug needs: a live event socket
  // and a companion that answers /api/providers.
  await settings.$eval(
    "#desktop-url",
    (element, url) => (element.value = url),
    desktopUrl,
  );
  await settings.type("#desktop-code", desktop.pairing.current().code);
  await settings.click("#pair");
  await settings.waitForFunction(
    () =>
      /Connected to/.test(document.querySelector("#desktop-state").textContent),
    { timeout: 15000 },
  );
  assert.equal(desktop.store.listClients().length, 1, "paired");

  await installProbe(settings);
  // Let the pairing burst finish before measuring.
  await new Promise((wait) => setTimeout(wait, 3000));
  if (TRACE) await trace(settings, traceFrom);

  // Several callers wanting the companion's state at once — an options page
  // refresh racing the widget's, or two broadcasts a frame apart — should cost
  // one companion read between them, not one each.
  const shareFrom = hits.length;
  for (const label of peak.keys()) peak.set(label, 0);
  await settings.evaluate(
    (count) =>
      Promise.all(
        Array.from(
          { length: count },
          () =>
            new Promise((resolve) =>
              chrome.runtime.sendMessage(
                { kind: "arjunah", method: "desktop.status", params: {} },
                resolve,
              ),
            ),
        ),
      ),
    5,
  );
  const shared = hits.slice(shareFrom);
  console.log("\n--- five callers ask for the companion's state at once ---");
  for (const [label, count] of histogram(shared, "label"))
    console.log(`  ${count}x ${label}`);
  const sharedPeak = peak.get("GET /api/providers") ?? 0;
  console.log(`  peak concurrent GET /api/providers: ${sharedPeak}`);

  const open = await idleWindow("settings page open, untouched", settings);

  // Close the settings page: if the traffic continues, the service worker and
  // the event socket are driving it by themselves.
  await settings.close();
  const closedFrom = hits.length;
  await new Promise((wait) => setTimeout(wait, IDLE_MS));
  const closed = {
    label: "settings page closed",
    seconds: Math.round(IDLE_MS / 1000),
    requests: hits.length - closedFrom,
    paths: histogram(hits.slice(closedFrom), "label"),
    broadcasts: [],
    writes: [],
    realChanges: [],
  };
  print(closed);

  console.log(
    `\n  event-socket upgrades over the whole run: ${upgrades.length}`,
  );
  console.log("  peak overlapping requests, by path:");
  for (const [label, count] of [...peak].sort((a, b) => b[1] - a[1]))
    console.log(`    ${count} concurrent  ${label}`);
  const fail = [];
  // One companion read should serve every caller that wants it. Two of the same
  // probe in flight means callers are each starting their own.
  for (const [label, count] of peak)
    if (label.includes("/api/providers") && count > 1)
      fail.push(
        `${count} concurrent ${label}: a companion read is not shared between callers, so one state change costs several identical probes.`,
      );
  const probes = shared.filter((item) =>
    item.label.includes("/api/providers"),
  ).length;
  if (probes > 1)
    fail.push(
      `five simultaneous callers cost ${probes} provider probes; they should share one.`,
    );
  if (open.requests > BUDGET)
    fail.push(
      `settings page open: ${open.requests} companion requests in ${open.seconds}s (budget ${BUDGET}). The extension is polling, not listening.`,
    );
  if (closed.requests > BUDGET)
    fail.push(
      `settings page closed: ${closed.requests} companion requests in ${closed.seconds}s (budget ${BUDGET}). The service worker loops on its own.`,
    );
  // The shape of the churn says which kind of bug this is. A payload that never
  // moves while a bookkeeping field does means some cache guard keeps deciding
  // its cache is stale — the classic cause being an equality test that is
  // sensitive to key order, which storage does not preserve (see stableJson).
  if (fail.length && open.realChanges.length) {
    const fields = new Set(open.realChanges);
    if (fields.size === 1)
      fail.push(
        `Every write changed only \`${[...fields][0]}\` — the payload itself never moved, so a cache guard is rewriting an unchanged value.`,
      );
  }
  assert.equal(fail.join(" | "), "", fail.join("\n  "));

  console.log("\nAn idle paired browser stays quiet.");
} finally {
  if (browser) await browser.close();
  await desktop.close();
  await rm(profile, { recursive: true, force: true });
  await rm(storeDirectory, { recursive: true, force: true });
  await testExtension.cleanup();
}
