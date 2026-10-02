import { OPENAI_BASE_URL, OPENAI_MODELS, openaiDisplayName } from "./openai.js";
import { generateLimits } from "./constants.js";
import {
  OPENCODE_BASE_URL,
  OPENCODE_DEFAULT_MODEL,
  OPENCODE_PROVIDER_ID,
  opencodeCapabilities,
  opencodeDisplayName,
  opencodeProtocol,
  opencodeReasoningLevels,
} from "./opencode.js";
import {
  OLLAMA_CLOUD_PROVIDER_ID,
  OLLAMA_CLOUD_URL,
  OLLAMA_PROVIDER_ID,
  ollamaDisplayName,
  ollamaLocalHost,
} from "./ollama.js";

export const OPENAI_PROVIDER_ID = "openai";
export const OPENCODE_CLI_PROVIDER_ID = "opencode-cli";
export { OPENCODE_PROVIDER_ID, OLLAMA_PROVIDER_ID, OLLAMA_CLOUD_PROVIDER_ID };
export const DESKTOP_DOWN =
  "अर्जुनः Desktop is not running. Start it (npm run desktop) and try again.";
export const DESKTOP_UNPAIRED =
  "अर्जुनः Desktop no longer recognises this browser's pairing. Open extension settings and pair again.";
// Context windows as published in OpenAI's model catalog (the same slugs Codex lists).
const OPENAI_CONTEXT = Object.freeze({
  "gpt-5.6-sol": 272_000,
  "gpt-5.6-terra": 272_000,
  "gpt-5.6-luna": 272_000,
  "gpt-5.5": 272_000,
  "gpt-6-astra": 272_000,
});
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;

/** `<provider-id>/<model>` → { providerId, model } or null. */
export function parseModelId(id) {
  if (typeof id !== "string" || id.length > 264) return null;
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return null;
  const providerId = id.slice(0, slash);
  if (!PROVIDER_ID.test(providerId)) return null;
  return { providerId, model: id.slice(slash + 1) };
}

export function modelIdFor(providerId, model) {
  return `${providerId}/${model}`;
}

/** The global default selection (`active` storage) expressed as a model id. */
export function activeModelId(active, openai, opencode, ollama, ollamaCloud) {
  if (active?.type === "desktop" && active.providerId && active.model)
    return modelIdFor(
      active.providerId === "opencode"
        ? OPENCODE_CLI_PROVIDER_ID
        : active.providerId,
      active.model,
    );
  if (active?.type === "openai" && openai?.model)
    return modelIdFor(OPENAI_PROVIDER_ID, openai.model);
  if (active?.type === "opencode" && opencode?.model)
    return modelIdFor(OPENCODE_PROVIDER_ID, opencode.model);
  if (active?.type === OLLAMA_PROVIDER_ID && ollama?.model)
    return modelIdFor(OLLAMA_PROVIDER_ID, ollama.model);
  if (active?.type === OLLAMA_CLOUD_PROVIDER_ID && ollamaCloud?.model)
    return modelIdFor(OLLAMA_CLOUD_PROVIDER_ID, ollamaCloud.model);
  return null;
}

/**
 * Whether an address is an IP literal on this computer or the user's own
 * network, or a loopback name. Unlike the plain-http rule in ollama.js, names
 * that are only local by convention (`gpu-box`, `nas.lan`, `*.ts.net`) do not
 * count: a page is told `local: true` only when the extension can be sure, and
 * it cannot resolve a name to find out where it points.
 */
function privateAddress(baseUrl) {
  let host;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const literal =
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
    (host.startsWith("[") && host.endsWith("]"));
  return literal && ollamaLocalHost(host);
}

/** The provider's vendor only where the configured address settles it. */
function hostIs(baseUrl, expected) {
  try {
    return new URL(baseUrl).hostname === new URL(expected).hostname;
  } catch {
    return false;
  }
}

// Desktop agents whose vendor is fixed by the CLI itself. OpenCode forwards to
// whichever upstream the user configured, so it has none the extension knows.
const DESKTOP_VENDORS = Object.freeze({
  "claude-code": "Anthropic",
  codex: "OpenAI",
});
// Desktop agents that run tools of their own beside the ones a page offers:
// Codex keeps a read-only shell sandbox the companion cannot disable (SPEC
// 12.3). Claude Code and OpenCode run with every built-in tool disabled.
const BUILTIN_TOOL_AGENTS = new Set(["codex"]);

function serverLabel(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return "the configured address";
  }
}

/**
 * Ollama, self-hosted or hosted. Its catalog is what the server reported at
 * the last discovery, capabilities included, so a model is offered images or
 * tools only when the server said it accepts them.
 */
function ollamaProvider(id, settings, usage, cloud) {
  const models = Array.isArray(settings?.models) ? settings.models : [];
  const configured = Boolean(
    settings?.baseUrl && (cloud ? settings.apiKey : true),
  );
  return {
    id,
    name: cloud ? "Ollama Cloud" : "Ollama (self-hosted)",
    // A server the user runs can be anything that speaks Ollama's API.
    vendor: cloud ? "Ollama" : null,
    kind: cloud ? "api-key" : "self-hosted",
    // Broker-internal: the server sits on this computer or the user's own
    // network, so a model it runs itself keeps prompts there (`local`).
    privateAddress: !cloud && privateAddress(settings?.baseUrl),
    installed: true,
    available: Boolean(configured && settings?.model && models.length),
    reason: !configured
      ? cloud
        ? "No API key saved in this browser."
        : "No Ollama server configured."
      : !models.length
        ? "The server reported no chat models. Pull one, then refresh."
        : null,
    account: !configured
      ? null
      : cloud
        ? "API key stored in this browser"
        : `Server at ${serverLabel(settings.baseUrl)}${settings.apiKey ? " · key stored in this browser" : ""}`,
    plan: null,
    quota: null,
    // A failed background refresh keeps the last catalog and says why.
    notice: settings?.lastError ?? null,
    supportsTools: models.some((model) => model.capabilities?.tools),
    supportsVision: models.some((model) => model.capabilities?.vision),
    supportsReasoning: models.some((model) => model.capabilities?.reasoning),
    supportsThreads: false,
    usage: usage[id] ?? null,
    defaultModel: settings?.model ? modelIdFor(id, settings.model) : null,
    models: models.map((model) => ({
      id: modelIdFor(id, model.id),
      model: model.id,
      displayName: ollamaDisplayName(model.id, model.remote),
      capabilities: { ...model.capabilities },
      parameterSize: model.parameterSize ?? null,
      quantization: model.quantization ?? null,
      remote: model.remote === true,
      contextWindow: model.contextWindow ?? null,
      reasoningLevels: [...(model.reasoningLevels ?? [])],
      defaultReasoning: model.defaultReasoning ?? null,
      think: model.think ?? null,
    })),
  };
}

/**
 * Every provider the broker knows about, available or not, with the models each
 * exposes. Account details stay in this broker-internal shape; `publicProvider`
 * and `publicModel` strip them before anything reaches a page.
 */
export function buildCatalog({
  openai,
  opencode,
  ollama,
  ollamaCloud,
  desktop,
  active,
  usage = {},
  desktopRunning = true,
  desktopAccepted = true,
}) {
  const providers = [];
  const openaiModels = [
    ...new Set([...(openai?.model ? [openai.model] : []), ...OPENAI_MODELS]),
  ];
  providers.push({
    id: OPENAI_PROVIDER_ID,
    name: "OpenAI API",
    // A custom base URL may point at any OpenAI-compatible server.
    vendor: hostIs(openai?.baseUrl ?? OPENAI_BASE_URL, OPENAI_BASE_URL)
      ? "OpenAI"
      : null,
    kind: "api-key",
    installed: true,
    available: Boolean(openai?.apiKey && openai?.model),
    reason: openai?.apiKey ? null : "No API key saved in this browser.",
    account: openai?.apiKey ? "API key stored in this browser" : null,
    plan: null,
    quota: null,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsThreads: false,
    usage: usage[OPENAI_PROVIDER_ID] ?? null,
    defaultModel: openai?.model
      ? modelIdFor(OPENAI_PROVIDER_ID, openai.model)
      : null,
    models: openaiModels.map((model) => ({
      id: modelIdFor(OPENAI_PROVIDER_ID, model),
      model,
      displayName: openaiDisplayName(model),
      capabilities: {
        tools: true,
        vision: /^gpt-/.test(model),
        reasoning: /^(gpt-5|gpt-6|o[1-9])/.test(model),
      },
      contextWindow: OPENAI_CONTEXT[model] ?? null,
      reasoningLevels: /^(gpt-5|gpt-6|o[1-9])/.test(model)
        ? ["none", "low", "medium", "high"]
        : [],
      defaultReasoning: null,
    })),
  });
  // Zen's catalog is discovered from the account's own key. Fall back to the
  // preferred id only before a discovery has happened, so the picker never
  // advertises a model this account may not actually be able to call.
  const discovered = Array.isArray(opencode?.models) ? opencode.models : [];
  const opencodeModels = [
    ...new Set([
      ...(opencode?.model ? [opencode.model] : []),
      ...discovered,
      ...(discovered.length ? [] : [OPENCODE_DEFAULT_MODEL]),
    ]),
  ].filter((model) => typeof model === "string" && opencodeProtocol(model));
  providers.push({
    id: OPENCODE_PROVIDER_ID,
    name: "OpenCode Zen API",
    vendor: hostIs(opencode?.baseUrl ?? OPENCODE_BASE_URL, OPENCODE_BASE_URL)
      ? "OpenCode"
      : null,
    kind: "api-key",
    installed: true,
    available: Boolean(opencode?.apiKey && opencode?.model),
    reason: opencode?.apiKey ? null : "No API key saved in this browser.",
    // Zen reports no tier of its own, so this says only what a completed
    // request proved. Untested keys say so rather than claiming a tier.
    account: opencode?.apiKey
      ? opencode.tier === "paid"
        ? "Paid (Go) key · stored in this browser"
        : "API key stored in this browser · not yet tested"
      : null,
    plan: null,
    quota: null,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsThreads: false,
    usage: usage[OPENCODE_PROVIDER_ID] ?? usage.opencode ?? null,
    defaultModel: opencode?.model
      ? modelIdFor(OPENCODE_PROVIDER_ID, opencode.model)
      : null,
    // Zen returns its catalog in no useful order and it is long, so the picker
    // groups it the way a reader scans it: by vendor, then by name.
    models: opencodeModels
      .map((model) => {
        const capabilities = opencodeCapabilities(model);
        return {
          id: modelIdFor(OPENCODE_PROVIDER_ID, model),
          model,
          displayName: opencodeDisplayName(model),
          capabilities,
          contextWindow: null,
          reasoningLevels: opencodeReasoningLevels(model),
          defaultReasoning: null,
        };
      })
      .sort((a, b) =>
        a.displayName.localeCompare(b.displayName, "en", { numeric: true }),
      ),
  });
  providers.push(ollamaProvider(OLLAMA_PROVIDER_ID, ollama, usage, false));
  providers.push(
    ollamaProvider(OLLAMA_CLOUD_PROVIDER_ID, ollamaCloud, usage, true),
  );
  for (const provider of desktop?.providers ?? []) {
    if (!PROVIDER_ID.test(provider.id)) continue;
    const publicId =
      provider.id === "opencode" ? OPENCODE_CLI_PROVIDER_ID : provider.id;
    const models = (
      provider.models?.length
        ? provider.models
        : [{ id: "default", displayName: "Default model" }]
    ).map((model) => ({
      id: modelIdFor(publicId, model.id),
      model: model.id,
      displayName: model.displayName || model.id,
      capabilities: {
        tools: model.capabilities?.tools ?? provider.supportsTools === true,
        vision: model.capabilities?.vision ?? provider.supportsVision === true,
        reasoning:
          model.capabilities?.reasoning ?? provider.supportsReasoning === true,
      },
      contextWindow: model.contextWindow ?? null,
      reasoningLevels: model.reasoningLevels ?? [],
      defaultReasoning: model.defaultReasoning ?? null,
    }));
    providers.push({
      id: publicId,
      runtimeId: provider.id,
      name: provider.name,
      vendor: DESKTOP_VENDORS[provider.id] ?? null,
      kind: "subscription",
      installed: provider.installed,
      available: Boolean(
        desktop?.token &&
          desktopRunning &&
          desktopAccepted &&
          provider.available,
      ),
      reason: !desktop?.token
        ? "Pair the desktop app to use this provider."
        : !desktopRunning
          ? DESKTOP_DOWN
          : !desktopAccepted
            ? DESKTOP_UNPAIRED
            : provider.reason,
      account:
        provider.connection?.account ??
        provider.account ??
        (provider.available ? "signed in" : null),
      method: provider.connection?.method ?? null,
      plan: provider.connection?.plan ?? null,
      quota: provider.quota ?? null,
      version: provider.version ?? null,
      guidance: provider.guidance ?? null,
      notice: provider.notice ?? null,
      supportsTools: provider.supportsTools === true,
      supportsVision: provider.supportsVision === true,
      supportsReasoning: provider.supportsReasoning === true,
      supportsThreads: provider.supportsThreads === true,
      sandboxed: provider.sandboxed === true,
      usage: usage[publicId] ?? usage[provider.id] ?? null,
      defaultModel: modelIdFor(
        publicId,
        provider.defaultModel ?? models[0]?.model ?? "default",
      ),
      models,
    });
  }
  return {
    providers,
    defaultModel: activeModelId(active, openai, opencode, ollama, ollamaCloud),
    desktop: {
      paired: Boolean(desktop?.token),
      running: Boolean(desktop?.token && desktopRunning),
      accepted: Boolean(desktop?.token && desktopRunning && desktopAccepted),
    },
  };
}

export function findModel(catalog, id) {
  const parsed = parseModelId(id);
  if (!parsed) return null;
  const provider = catalog.providers.find(
    (item) => item.id === parsed.providerId,
  );
  if (!provider) return null;
  const model =
    provider.models.find((item) => item.id === id) ??
    // Desktop providers answer with the account default when the exact model
    // is not in their advertised list (the user may have typed one).
    (provider.kind === "subscription" && provider.available
      ? {
          id,
          model: parsed.model,
          displayName: parsed.model,
          capabilities: {
            tools: provider.supportsTools,
            vision: provider.supportsVision,
            reasoning: provider.supportsReasoning === true,
          },
          contextWindow: null,
          reasoningLevels: [],
          defaultReasoning: null,
        }
      : null);
  return model ? { provider, model } : null;
}

/**
 * Resolve a model stored before the Zen API and desktop OpenCode CLI received
 * distinct public provider ids.
 */
export function findStoredModel(catalog, id) {
  const exact = findModel(catalog, id);
  if (exact || typeof id !== "string" || !id.startsWith("opencode/"))
    return exact;
  const model = id.slice(9);
  const cli = catalog.providers.find(
    (provider) => provider.id === OPENCODE_CLI_PROVIDER_ID,
  );
  // Prefer a real CLI catalog entry. This distinguishes old desktop ids such
  // as `opencode/opencode/muse-...` from old Zen ids without guessing.
  if (cli?.models.some((item) => item.model === model))
    return findModel(catalog, `${OPENCODE_CLI_PROVIDER_ID}/${model}`);
  return findModel(catalog, `${OPENCODE_PROVIDER_ID}/${model}`);
}

/** The `active` storage document that selects `id` as the global default. */
export function activeForModel(id) {
  const parsed = parseModelId(id);
  if (!parsed) return null;
  if (
    parsed.providerId === OLLAMA_PROVIDER_ID ||
    parsed.providerId === OLLAMA_CLOUD_PROVIDER_ID
  )
    return { type: parsed.providerId, model: parsed.model };
  return parsed.providerId === OPENAI_PROVIDER_ID
    ? { type: "openai", model: parsed.model }
    : parsed.providerId === OPENCODE_PROVIDER_ID
      ? { type: "opencode", model: parsed.model }
      : {
          type: "desktop",
          providerId:
            parsed.providerId === OPENCODE_CLI_PROVIDER_ID
              ? "opencode"
              : parsed.providerId,
          model: parsed.model,
        };
}

/**
 * The provider configuration that `generate()` needs for one model, with the
 * page-visible `traits` of SPEC 5.2 that a page-bound result repeats.
 */
export function configForModel(catalog, id, settings) {
  const found = findModel(catalog, id);
  if (!found || !found.provider.available) return null;
  const config = providerConfig(found, settings);
  return { ...config, traits: modelTraits(found.provider, found.model) };
}

function providerConfig(
  { provider, model },
  { openai, opencode, ollama, ollamaCloud, desktop },
) {
  if (provider.id === OPENAI_PROVIDER_ID)
    return {
      kind: "openai",
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: openai.baseUrl ?? OPENAI_BASE_URL,
      apiKey: openai.apiKey,
      model: model.model,
      displayName: model.displayName,
      capabilities: model.capabilities,
      contextWindow: model.contextWindow,
      reasoningLevels: model.reasoningLevels,
    };
  if (provider.id === OPENCODE_PROVIDER_ID)
    return {
      kind: "opencode",
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: opencode.baseUrl ?? OPENCODE_BASE_URL,
      apiKey: opencode.apiKey,
      model: model.model,
      protocol: opencodeProtocol(model.model),
      displayName: model.displayName,
      capabilities: model.capabilities,
      contextWindow: model.contextWindow,
      reasoningLevels: model.reasoningLevels,
    };
  if (
    provider.id === OLLAMA_PROVIDER_ID ||
    provider.id === OLLAMA_CLOUD_PROVIDER_ID
  ) {
    const cloud = provider.id === OLLAMA_CLOUD_PROVIDER_ID;
    const settings = cloud ? ollamaCloud : ollama;
    return {
      kind: "ollama",
      cloud,
      providerId: provider.id,
      providerName: provider.name,
      baseUrl: cloud ? OLLAMA_CLOUD_URL : settings.baseUrl,
      apiKey: settings.apiKey ?? null,
      model: model.model,
      displayName: model.displayName,
      capabilities: model.capabilities,
      contextWindow: model.contextWindow,
      reasoningLevels: model.reasoningLevels,
      think: model.think ?? null,
    };
  }
  return {
    kind: "desktop",
    providerId: provider.runtimeId ?? provider.id,
    catalogProviderId: provider.id,
    providerName: provider.name,
    baseUrl: desktop.baseUrl,
    token: desktop.token,
    model: model.model,
    displayName: model.displayName,
    capabilities: model.capabilities,
    contextWindow: model.contextWindow,
    reasoningLevels: model.reasoningLevels,
    supportsThreads: provider.supportsThreads === true,
    account: provider.account,
  };
}

/**
 * What a page may know about where a model runs (SPEC 5.2): the provider's
 * kind, whether prompts stay on the user's computer or network (`local`), and
 * whether the answering agent runs tools of its own (`builtinTools`). `local`
 * is conservative: only a self-hosted Ollama server at a loopback or private
 * address running the model itself, never one it forwards to ollama.com.
 */
export function modelTraits(provider, model) {
  return {
    kind: provider.kind,
    local:
      provider.id === OLLAMA_PROVIDER_ID &&
      provider.privateAddress === true &&
      model?.remote !== true,
    builtinTools:
      provider.kind === "subscription" &&
      BUILTIN_TOOL_AGENTS.has(provider.runtimeId ?? provider.id),
  };
}

/** Whether a model's traits satisfy a grant's `require` (SPEC 4). */
export function traitsMatch(constraint, traits) {
  if (!constraint) return true;
  if (constraint.kinds && !constraint.kinds.includes(traits.kind)) return false;
  if (constraint.local === true && traits.local !== true) return false;
  if (constraint.builtinTools === false && traits.builtinTools !== false)
    return false;
  return true;
}

export function modelMatches(constraint, provider, model) {
  return traitsMatch(constraint, modelTraits(provider, model));
}

/** Page-visible provider entry (SPEC 5.2): identifiers and model ids only. */
export function publicProvider(provider) {
  return {
    id: provider.id,
    name: provider.name,
    vendor: provider.vendor,
    kind: provider.kind,
    models: provider.models.map((model) => model.id),
  };
}

/**
 * Page-visible model entry (SPEC 5.2). `limits` comes from the table that
 * `generate` validates against, keyed the same way: every subscription
 * provider runs through the desktop companion and takes its bounds.
 */
export function publicModelEntry(provider, model, isDefault) {
  return {
    id: model.id,
    provider: provider.id,
    displayName: model.displayName,
    default: isDefault,
    capabilities: { ...model.capabilities },
    contextWindow: model.contextWindow ?? null,
    reasoningLevels: [...(model.reasoningLevels ?? [])],
    limits: { ...generateLimits(provider.kind === "subscription") },
    ...modelTraits(provider, model),
  };
}
