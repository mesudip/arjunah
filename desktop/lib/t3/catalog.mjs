/**
 * Maps T3 Code provider snapshots (`ServerProvider` in T3's contracts) onto the
 * shapes Arjunah Desktop already reports. T3 drivers that Arjunah can run map to
 * Arjunah provider ids; the rest are listed so the wallet shows every model T3
 * knows about, marked as not runnable here.
 */
const DRIVER_TO_ARJUNAH = Object.freeze({
  claudeAgent: "claude-code",
  codex: "codex",
  opencode: "opencode",
});
const DRIVER_NAMES = Object.freeze({
  cursor: ["Cursor", "Cursor"],
  grok: ["Grok Build", "xAI"],
  antigravity: ["Antigravity", "Google"],
});
const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];

function contextWindowFrom(descriptors) {
  const option = descriptors.find((item) => item.id === "contextWindow");
  if (!option || option.type !== "select") return null;
  const chosen =
    option.options.find((item) => item.id === option.currentValue) ??
    option.options.find((item) => item.isDefault) ??
    option.options[0];
  return parseWindow(chosen?.id ?? chosen?.label);
}

export function parseWindow(value) {
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/i.exec(String(value ?? "").trim());
  if (!match) return null;
  const number = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  return Math.round(
    number * (unit === "m" ? 1_000_000 : unit === "k" ? 1000 : 1),
  );
}

function reasoningFrom(descriptors) {
  const option = descriptors.find((item) => item.id === "effort");
  if (!option || option.type !== "select")
    return { levels: [], defaultLevel: null };
  const levels = option.options
    .map((item) => item.id)
    .filter((id) => EFFORTS.includes(id));
  const chosen = option.options.find((item) => item.isDefault)?.id ?? null;
  return { levels, defaultLevel: EFFORTS.includes(chosen) ? chosen : null };
}

export function mapModel(model) {
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const { levels, defaultLevel } = reasoningFrom(descriptors);
  return {
    id: String(model.slug),
    displayName: String(model.name ?? model.slug),
    contextWindow: contextWindowFrom(descriptors),
    reasoningLevels: levels,
    defaultReasoning: defaultLevel,
    capabilities: { tools: true, vision: false, reasoning: levels.length > 0 },
    isDefault: model.isDefault === true,
    legacy: model.isLegacy === true,
  };
}

/** T3's rolling usage windows as the Arjunah quota shape (percent of the primary window). */
export function quotaFrom(usageLimits) {
  const windows = usageLimits?.windows ?? [];
  if (!windows.length) return null;
  const primary = windows.find((item) => item.kind === "session") ?? windows[0];
  const others = windows
    .filter((item) => item !== primary)
    .map((item) => `${item.label} ${Math.round(item.usedPercent)}%`)
    .join(" · ");
  return {
    used: Math.round(primary.usedPercent),
    limit: 100,
    unit: `% of ${primary.label.toLowerCase()}`,
    resetsAt: primary.resetsAt ?? null,
    label: others || null,
    windows: windows.map((item) => ({
      id: String(item.id),
      kind: item.kind ?? "other",
      label: String(item.label),
      usedPercent: Math.round(item.usedPercent),
      resetsAt: item.resetsAt ?? null,
    })),
  };
}

/**
 * Returns `{ enrich: { [arjunahProviderId]: { models, quota, account, defaultModel } },
 * external: [providerEntry] }` for a T3 provider list.
 */
export function mapT3Providers(
  providers,
  { environmentLabel = "T3 Code" } = {},
) {
  const enrich = {};
  const external = [];
  for (const provider of Array.isArray(providers) ? providers : []) {
    if (!provider || typeof provider !== "object") continue;
    const driver = String(provider.driver ?? "");
    // Legacy models stay selectable; current ones are listed first.
    const models = (Array.isArray(provider.models) ? provider.models : [])
      .filter((model) => typeof model?.slug === "string")
      .slice(0, 100)
      .map(mapModel)
      .sort((a, b) => Number(a.legacy) - Number(b.legacy));
    const quota = quotaFrom(provider.usageLimits);
    const account =
      typeof provider.auth?.email === "string" ? provider.auth.email : null;
    const defaultModel =
      models.find((model) => model.isDefault)?.id ?? models[0]?.id ?? null;
    const arjunahId = DRIVER_TO_ARJUNAH[driver];
    if (arjunahId) {
      // Several T3 instances can share a driver (work/personal accounts); the
      // first authenticated one wins for the Arjunah provider of that kind.
      const authenticated = provider.auth?.status === "authenticated";
      if (
        !enrich[arjunahId] ||
        (authenticated && !enrich[arjunahId].authenticated)
      )
        enrich[arjunahId] = {
          models,
          quota,
          account,
          defaultModel,
          authenticated,
          instanceId: String(provider.instanceId ?? driver),
          source: environmentLabel,
        };
      continue;
    }
    const [name, vendor] = DRIVER_NAMES[driver] ?? [
      String(provider.displayName ?? driver),
      "",
    ];
    external.push({
      id: `t3-${String(provider.instanceId ?? driver)
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")}`,
      name: String(provider.displayName ?? name),
      vendor,
      kind: "subscription",
      installed: provider.installed === true,
      available: false,
      enabled: provider.enabled === true,
      supportsTools: true,
      supportsVision: false,
      supportsReasoning: models.some(
        (model) => model.reasoningLevels.length > 0,
      ),
      supportsThreads: false,
      account,
      connection: account
        ? {
            account,
            method: `${name} sign-in via ${environmentLabel}`,
            plan: null,
            source: environmentLabel,
          }
        : null,
      reason: `${name} is known to ${environmentLabel} but अर्जुनः has no runner for it yet.`,
      notice: null,
      guidance: null,
      quota,
      version: typeof provider.version === "string" ? provider.version : null,
      models,
      defaultModel,
    });
  }
  return { enrich, external };
}

/**
 * Merges T3 enrichment into Arjunah's own provider list: T3 models come first
 * (they carry names, context windows, and reasoning levels), Arjunah models not
 * known to T3 follow; quota and account fill gaps only.
 */
export function enrichProviders(arjunahProviders, mapped) {
  const merged = arjunahProviders.map((provider) => {
    const extra = mapped.enrich[provider.id];
    if (!extra) return provider;
    const seen = new Set(extra.models.map((model) => model.id));
    const models = [
      ...extra.models.map(({ isDefault: _d, legacy: _l, ...model }) => model),
      ...(provider.models ?? []).filter((model) => !seen.has(model.id)),
    ];
    return {
      ...provider,
      models,
      defaultModel: provider.defaultModel ?? extra.defaultModel,
      quota: provider.quota ?? extra.quota,
      account: provider.account ?? extra.account,
      connection:
        provider.connection ??
        (extra.account
          ? {
              account: extra.account,
              method: `sign-in reported by ${extra.source}`,
              plan: null,
              source: extra.source,
            }
          : null),
      catalogSource: extra.source,
    };
  });
  return [...merged, ...mapped.external];
}
