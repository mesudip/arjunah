import * as claudeCode from "./claude-code.mjs";
import * as codex from "./codex.mjs";
import * as opencode from "./opencode.mjs";
import { guidance } from "./common.mjs";
import { access, constants } from "node:fs/promises";

const PATH_SETTINGS = {
  "claude-code": "claudePath",
  codex: "codexPath",
  opencode: "opencodePath",
};

// A custom binary path from the dashboard that does not point at an
// executable file gets a precise message instead of a downstream crash.
async function customPathProblem(adapter, settings) {
  const custom = settings[PATH_SETTINGS[adapter.id]];
  if (!custom) return null;
  try {
    await access(custom, constants.X_OK);
    return null;
  } catch {
    return {
      installed: false,
      available: false,
      reason: `The custom ${adapter.name} path ${custom} is not an executable file.`,
      guidance: guidance({
        state: "error",
        summary: `The custom path \`${custom}\` does not exist or cannot be run.`,
        steps: [
          `Check the path in a terminal with \`ls -l ${custom}\`.`,
          "Correct the path below and save, or clear the field and save to search the usual install locations again.",
        ],
      }),
    };
  }
}

export const adapters = [claudeCode, codex, opencode];
const CACHE_MS = 20_000;
let cache = { at: 0, key: "", providers: [] };
// Two callers arriving together (a chat turn and a popup opening) used to start
// two independent sweeps, because the cache is only written once a sweep ends.
// On a loaded machine that doubled the spawns at the worst possible moment.
let inFlight = null;
// Bumped by `invalidateProviderCache`. A sweep that was already running cannot
// be cancelled, so it checks this before writing: settings that changed while
// it was out must not be overwritten by an answer gathered under the old ones.
let generation = 0;

function gate(adapter, info, settings) {
  if (adapter.id === "codex" && info.installed && !settings.experimentalCodex)
    return {
      ...info,
      available: false,
      enabled: false,
      reason:
        "Codex is detected but disabled in the desktop app. Enable it on the desktop dashboard after reading the sandbox notice.",
      guidance: guidance({
        state: "disabled",
        summary: "Codex is installed and signed in, but switched off here.",
        steps: [
          "Read the notice: Codex keeps a read-only shell sandbox even for browser requests.",
          "Tick “Enable Codex” below. The change applies immediately to paired browsers.",
        ],
      }),
    };
  return { ...info, enabled: true };
}

export async function detectProviders(settings = {}, { force = false } = {}) {
  const key = JSON.stringify(settings);
  if (!force && Date.now() - cache.at < CACHE_MS && cache.key === key)
    return cache.providers;
  if (inFlight && inFlight.key === key) return inFlight.promise;
  const promise = fullSweep(settings, key).finally(() => {
    if (inFlight?.promise === promise) inFlight = null;
  });
  inFlight = { key, promise };
  return promise;
}

/**
 * The happy path: the CLIs are already known, so ask each one only for what
 * moves — its model list and its plan usage. An adapter that cannot answer, or
 * that was not available last time, is detected in full instead, which is how
 * an uninstalled or signed-out tool is still noticed. Never spawns `which`,
 * `--version`, or a sign-in check while the assumption holds.
 */
export async function refreshProviders(settings = {}) {
  const key = JSON.stringify(settings);
  if (cache.key !== key || !cache.providers.length)
    return detectProviders(settings, { force: true });
  const previous = new Map(cache.providers.map((item) => [item.id, item]));
  const providers = await Promise.all(
    adapters.map(async (adapter) => {
      const before = previous.get(adapter.id);
      // Nothing to re-ask of a tool that is not installed, not signed in, or
      // switched off here: it has no model list or quota that can have moved.
      // Only a provider that *was* working and now will not answer is news,
      // and that is what earns a full detection.
      if (!before) return null;
      if (!before.available || typeof adapter.refresh !== "function")
        return before;
      try {
        const next = await adapter.refresh(before, settings);
        // `gate()` is what turns Codex off when the dashboard switch is off.
        // Skipping it here let a light pass hand back an ungated provider and
        // quietly re-enable it until the next full sweep.
        return next
          ? {
              ...next,
              ...gate(adapter, next, settings),
              detectedAt: new Date().toISOString(),
            }
          : null;
      } catch {
        return null;
      }
    }),
  );
  // One adapter that could not confirm itself invalidates the light pass: the
  // full sweep's answer is then authoritative for every provider in it.
  if (providers.some((item) => item == null))
    return detectProviders(settings, { force: true });
  cache = { at: Date.now(), key, providers };
  return providers;
}

async function fullSweep(settings, key) {
  const startedAt = generation;
  const providers = await Promise.all(
    adapters.map(async (adapter) => {
      let info;
      try {
        info =
          (await customPathProblem(adapter, settings)) ??
          (await adapter.detect(settings));
      } catch (error) {
        info = {
          installed: false,
          available: false,
          reason: `Detection failed: ${error.message}`,
          guidance: guidance({
            state: "error",
            summary: `Checking ${adapter.name} failed: ${error.message}`,
            steps: [
              `Run \`${adapter.id === "claude-code" ? "claude" : adapter.id} --version\` in a terminal to confirm the tool starts.`,
              "If it lives somewhere unusual, paste the full path to the binary below and save, then click Re-check.",
            ],
          }),
        };
      }
      return {
        id: adapter.id,
        name: adapter.name,
        vendor: adapter.vendor,
        kind: "subscription",
        supportsTools: adapter.supportsTools,
        supportsThreads: adapter.supportsThreads === true,
        supportsReasoning: adapter.supportsReasoning === true,
        supportsVision: adapter.supportsVision === true,
        ...gate(adapter, info, settings),
        detectedAt: new Date().toISOString(),
      };
    }),
  );
  if (startedAt === generation) cache = { at: Date.now(), key, providers };
  return providers;
}

export function adapterFor(providerId) {
  return adapters.find((adapter) => adapter.id === providerId) ?? null;
}

export function invalidateProviderCache() {
  cache = { at: 0, key: "", providers: [] };
  inFlight = null;
  generation++;
}
