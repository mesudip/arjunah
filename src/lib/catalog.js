import { OPENAI_BASE_URL, OPENAI_MODELS, openaiDisplayName } from "./openai.js";
import {
  OPENCODE_BASE_URL,
  OPENCODE_DEFAULT_MODEL,
  OPENCODE_PROVIDER_ID,
  opencodeCapabilities,
  opencodeDisplayName,
  opencodeProtocol,
  opencodeReasoningLevels,
} from "./opencode.js";

export const OPENAI_PROVIDER_ID = "openai";
export const OPENCODE_CLI_PROVIDER_ID = "opencode-cli";
export { OPENCODE_PROVIDER_ID };
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
export function activeModelId(active, openai, opencode) {
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
  return null;
}

/**
 * Every provider the broker knows about, available or not, with the models each
 * exposes. Account details stay in this broker-internal shape; `publicProvider`
 * and `publicModel` strip them before anything reaches a page.
 */
export function buildCatalog({
  openai,
  opencode,
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
    vendor: "OpenAI",
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
    vendor: "OpenCode",
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
      vendor: provider.vendor,
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
    defaultModel: activeModelId(active, openai, opencode),
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

/** The provider configuration that `generate()` needs for one model. */
export function configForModel(catalog, id, { openai, opencode, desktop }) {
  const found = findModel(catalog, id);
  if (!found || !found.provider.available) return null;
  const { provider, model } = found;
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

/** Page-visible model entry (SPEC 5.2). */
export function publicModelEntry(provider, model, isDefault) {
  return {
    id: model.id,
    provider: provider.id,
    displayName: model.displayName,
    default: isDefault,
    capabilities: { ...model.capabilities },
    contextWindow: model.contextWindow ?? null,
    reasoningLevels: [...(model.reasoningLevels ?? [])],
  };
}
