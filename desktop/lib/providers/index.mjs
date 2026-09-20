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
  cache = { at: Date.now(), key, providers };
  return providers;
}

export function adapterFor(providerId) {
  return adapters.find((adapter) => adapter.id === providerId) ?? null;
}

export function invalidateProviderCache() {
  cache = { at: 0, key: "", providers: [] };
}
