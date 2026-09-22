// The two detection tiers and the process deadline that both rely on. Nothing
// else exercises these: the desktop suites inject their own `detect`, which
// leaves `refresh` unused, and `run()`'s kill escalation has no other cover.
import test from "node:test";
import assert from "node:assert/strict";
import { run } from "../desktop/lib/providers/common.mjs";
import * as opencode from "../desktop/lib/providers/opencode.mjs";
import * as claudeCode from "../desktop/lib/providers/claude-code.mjs";

test("run() enforces its deadline on a child that ignores SIGTERM", async () => {
  // execFile's own `timeout` sends one SIGTERM and gives up; a CLI with a
  // cleanup handler then outlives its deadline and reports nothing useful.
  const script =
    "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 10000);";
  const startedAt = Date.now();
  const result = await run(process.execPath, ["-e", script], {
    timeoutMs: 300,
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(result.timedOut, true, "the deadline is reported to the caller");
  assert.ok(
    elapsed < 6000,
    `SIGKILL must follow SIGTERM; took ${elapsed}ms of a possible 10000`,
  );
});

test("run() reports a clean finish without the timeout flag", async () => {
  const result = await run(
    process.execPath,
    ["-e", "process.stdout.write('hi')"],
    {
      timeoutMs: 10_000,
    },
  );
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, "hi");
});

test("a light refresh declines rather than caching a truncated model listing", async () => {
  // A killed `opencode models` leaves partial stdout, and the parser will
  // happily return the models it managed to read — including one whose JSON
  // block was cut off. Caching that as the catalog can even move defaultModel.
  const previous = {
    binary: "/fake/opencode",
    available: true,
    models: [{ id: "a/one" }, { id: "a/two" }],
  };
  const full = "a/one\n{}\na/two\n{}\n";
  assert.equal(opencode.parseModelList(full).length, 2);
  const cut = 'a/one\n{"name":"One"}\na/two\n{"name":"T';
  assert.equal(
    opencode.parseModelList(cut).length,
    2,
    "the parser itself keeps the truncated entry, which is why refresh must not trust it",
  );
  // `refresh` against a binary that does not exist fails rather than caching.
  assert.equal(await opencode.refresh(previous), null);
});

test("a light refresh is skipped for a provider that is not usable", async () => {
  assert.equal(await opencode.refresh(null), null);
  assert.equal(
    await opencode.refresh({ binary: "/x", available: false }),
    null,
  );
  assert.equal(await claudeCode.refresh({ available: true }), null);
  assert.equal(
    await claudeCode.refresh({ binary: "/x", available: false }),
    null,
  );
});

test("the light pass asks only working providers, and one failure escalates to a full sweep", async () => {
  // The real registry imports three fixed adapter modules, so the tiering is
  // exercised through a stand-in with the same contract.
  const calls = [];
  const make = (id, { available = true, refreshes = true } = {}) => ({
    id,
    name: id,
    vendor: "Test",
    supportsTools: false,
    async detect() {
      calls.push(`${id}:detect`);
      return { installed: true, available, binary: `/fake/${id}`, models: [] };
    },
    async refresh(previous) {
      calls.push(`${id}:refresh`);
      return refreshes ? { ...previous, models: [{ id: "fresh" }] } : null;
    },
  });
  const {
    detectProviders,
    refreshProviders,
    invalidateProviderCache,
    adapters,
  } = await import("../desktop/lib/providers/index.mjs");
  const original = adapters.splice(0, adapters.length);
  adapters.push(make("good"), make("down", { available: false }));
  try {
    invalidateProviderCache();
    await detectProviders({}, { force: true });
    assert.deepEqual(calls.sort(), ["down:detect", "good:detect"]);

    // Happy path: only the working provider is asked, and never for its
    // install or sign-in state.
    calls.length = 0;
    const light = await refreshProviders({});
    assert.deepEqual(calls, ["good:refresh"]);
    assert.deepEqual(light.find((item) => item.id === "good").models, [
      { id: "fresh" },
    ]);
    assert.equal(light.find((item) => item.id === "down").available, false);

    // A provider that was working and now will not answer is news, and the
    // full sweep's answer is authoritative for everything in it.
    calls.length = 0;
    adapters.splice(0, adapters.length);
    adapters.push(
      make("good", { refreshes: false }),
      make("down", { available: false }),
    );
    await refreshProviders({});
    assert.deepEqual(calls.sort(), [
      "down:detect",
      "good:detect",
      "good:refresh",
    ]);
  } finally {
    adapters.splice(0, adapters.length, ...original);
    invalidateProviderCache();
  }
});
