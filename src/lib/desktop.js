import { BrokerError } from "./errors.js";
import { EFFORTS, LIMITS } from "./constants.js";
import { readJson, networkError } from "./network.js";
import { contentText } from "./validation.js";

export const DESKTOP_DEFAULT_URL = "http://127.0.0.1:48123";
const STATUS_CODES = {
  400: "INVALID_REQUEST",
  401: "NOT_CONFIGURED",
  403: "USER_DENIED",
  404: "NOT_SUPPORTED",
  413: "INVALID_REQUEST",
  502: "PROVIDER_ERROR",
  504: "TIMEOUT",
};

export function desktopOrigin(input) {
  let url;
  try {
    url = new URL(String(input ?? DESKTOP_DEFAULT_URL));
  } catch {
    throw new BrokerError("INVALID_REQUEST", "Desktop app address is invalid.");
  }
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new BrokerError(
      "INVALID_REQUEST",
      "The desktop app must be reached over loopback HTTP.",
    );
  return url.origin;
}

async function desktopFetch(link, path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (link.token) headers.Authorization = `Bearer ${link.token}`;
  if (init.body != null) headers["Content-Type"] = "application/json";
  const timeout = AbortSignal.timeout(init.timeoutMs ?? LIMITS.timeoutMs);
  let response;
  try {
    response = await fetch(`${desktopOrigin(link.baseUrl)}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body == null ? undefined : JSON.stringify(init.body),
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
  } catch (error) {
    if (["AbortError", "TimeoutError"].includes(error?.name))
      throw networkError(error, "TIMEOUT", "Desktop app");
    throw new BrokerError(
      "NOT_CONFIGURED",
      "The desktop app is not running. Start अर्जुनः Desktop and try again.",
    );
  }
  const body = await readJson(
    response,
    LIMITS.providerResponseBytes,
    "PROVIDER_ERROR",
  ).catch(() => null);
  if (!response.ok) {
    const message =
      response.status === 401
        ? "अर्जुनः Desktop no longer recognises this browser's pairing. Open extension settings and pair again."
        : typeof body?.error?.message === "string"
          ? body.error.message.slice(0, 300)
          : `The desktop app rejected the request (${response.status}).`;
    throw new BrokerError(
      STATUS_CODES[response.status] ?? "PROVIDER_ERROR",
      message,
    );
  }
  if (!body || typeof body !== "object")
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The desktop app returned invalid data.",
    );
  return body;
}

/** Never throws; reports whether the app is reachable and whether this token is accepted. */
export async function desktopStatus(link) {
  try {
    const status = await desktopFetch(link, "/api/status", { timeoutMs: 3000 });
    return {
      running: status.app === "arjunah-desktop",
      paired: status.paired === true,
      version: String(status.version ?? "").slice(0, 40),
      device: String(status.device ?? "").slice(0, 120),
      revision: Number(status.sync?.revision) || 0,
    };
  } catch {
    return {
      running: false,
      paired: false,
      version: "",
      device: "",
      revision: 0,
    };
  }
}

export function desktopPair(baseUrl, code, client) {
  return desktopFetch({ baseUrl }, "/api/pair", {
    method: "POST",
    body: {
      code: String(code ?? "")
        .replace(/\D/g, "")
        .slice(0, 6),
      client,
    },
    timeoutMs: 5000,
  });
}

export function desktopUnpair(link) {
  return desktopFetch(link, "/api/pair", { method: "DELETE", timeoutMs: 5000 });
}

const GUIDANCE_STATES = ["missing", "signed-out", "disabled", "error"];
// Troubleshooting text authored by the desktop app. Only plain strings and
// http(s) links survive; the UI renders them as text, never as markup.
function sanitizeConnection(input) {
  if (!input || typeof input !== "object") return null;
  const field = (key, max) =>
    input[key] == null ? null : String(input[key]).slice(0, max);
  return {
    account: field("account", 200),
    method: field("method", 120),
    plan: field("plan", 80),
    source: field("source", 200),
  };
}
/** Optional provider quota: numbers and short labels only. */
export function sanitizeQuota(input) {
  if (!input || typeof input !== "object") return null;
  const number = (value) =>
    Number.isFinite(value) && value >= 0 ? value : null;
  const used = number(input.used);
  const limit = number(input.limit);
  if (used == null && limit == null) return null;
  return {
    used,
    limit,
    unit: String(input.unit ?? "requests").slice(0, 40),
    resetsAt:
      typeof input.resetsAt === "string" ? input.resetsAt.slice(0, 40) : null,
    label: input.label == null ? null : String(input.label).slice(0, 160),
    windows: (Array.isArray(input.windows) ? input.windows : [])
      .slice(0, 8)
      .filter((item) => item && Number.isFinite(item.usedPercent))
      .map((item) => ({
        id: String(item.id ?? "").slice(0, 40),
        kind: ["session", "weekly", "monthly", "other"].includes(item.kind)
          ? item.kind
          : "other",
        label: String(item.label ?? item.id ?? "").slice(0, 60),
        usedPercent: Math.max(0, Math.min(100, Math.round(item.usedPercent))),
        resetsAt:
          typeof item.resetsAt === "string" ? item.resetsAt.slice(0, 40) : null,
      })),
  };
}
export function sanitizeGuidance(guide) {
  if (!guide || typeof guide !== "object") return null;
  const state = GUIDANCE_STATES.includes(guide.state) ? guide.state : "error";
  const links = (Array.isArray(guide.links) ? guide.links : [])
    .slice(0, 6)
    .filter((link) => {
      try {
        return ["http:", "https:"].includes(new URL(link?.url).protocol);
      } catch {
        return false;
      }
    })
    .map((link) => ({
      label: String(link.label ?? link.url).slice(0, 80),
      url: String(link.url).slice(0, 400),
    }));
  return {
    state,
    summary: String(guide.summary ?? "").slice(0, 400),
    steps: (Array.isArray(guide.steps) ? guide.steps : [])
      .slice(0, 8)
      .map((step) => String(step).slice(0, 400)),
    links,
    note: guide.note == null ? null : String(guide.note).slice(0, 400),
  };
}

export async function desktopProviders(link, refresh = false) {
  const body = await desktopFetch(
    link,
    `/api/providers${refresh ? "?refresh=1" : ""}`,
    {
      timeoutMs: 120_000,
    },
  );
  if (!Array.isArray(body.providers))
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The desktop app returned an invalid provider list.",
    );
  return body.providers.slice(0, 16).map((item) => ({
    id: String(item.id ?? "").slice(0, 64),
    name: String(item.name ?? item.id ?? "").slice(0, 80),
    vendor: String(item.vendor ?? "").slice(0, 80),
    installed: item.installed === true,
    available: item.available === true,
    enabled: item.enabled !== false,
    supportsTools: item.supportsTools === true,
    supportsVision: item.supportsVision === true,
    supportsReasoning: item.supportsReasoning === true,
    supportsThreads: item.supportsThreads === true,
    sandboxed: item.sandboxed === true,
    quota: sanitizeQuota(item.quota),
    account: item.account == null ? null : String(item.account).slice(0, 200),
    connection: sanitizeConnection(item.connection),
    reason: item.reason == null ? null : String(item.reason).slice(0, 400),
    notice: item.notice == null ? null : String(item.notice).slice(0, 400),
    guidance: sanitizeGuidance(item.guidance),
    version: item.version == null ? null : String(item.version).slice(0, 80),
    defaultModel:
      item.defaultModel == null
        ? null
        : String(item.defaultModel).slice(0, 200),
    models: (Array.isArray(item.models) ? item.models : [])
      .slice(0, 400)
      .map((model) => ({
        id: String(model.id ?? "").slice(0, 200),
        displayName: String(model.displayName ?? model.id ?? "").slice(0, 200),
        contextWindow:
          Number.isInteger(model.contextWindow) && model.contextWindow > 0
            ? model.contextWindow
            : null,
        reasoningLevels: (Array.isArray(model.reasoningLevels)
          ? model.reasoningLevels
          : []
        )
          .filter((level) => EFFORTS.includes(level))
          .slice(0, 8),
        defaultReasoning: EFFORTS.includes(model.defaultReasoning)
          ? model.defaultReasoning
          : null,
        capabilities:
          model.capabilities && typeof model.capabilities === "object"
            ? {
                tools: model.capabilities.tools !== false,
                vision: model.capabilities.vision === true,
                reasoning: model.capabilities.reasoning === true,
              }
            : null,
      })),
  }));
}

/** Ends the agent thread that backed one browser conversation. Never throws. */
export async function desktopEndThread(link, threadId) {
  if (!link?.token || !/^[A-Za-z0-9_-]{1,100}$/.test(String(threadId ?? "")))
    return false;
  try {
    const body = await desktopFetch(link, `/api/threads/${threadId}`, {
      method: "DELETE",
      timeoutMs: 5000,
    });
    return body.ended === true;
  } catch {
    return false;
  }
}

export function desktopSyncGet(link) {
  return desktopFetch(link, "/api/sync", { timeoutMs: 5000 });
}
export function desktopSyncPut(link, config) {
  return desktopFetch(link, "/api/sync", {
    method: "PUT",
    body: { config },
    timeoutMs: 5000,
  });
}

/** Polls live agent activity for one turn while the generate request is in flight. */
async function pollProgress(config, progress, signal, stopped) {
  let seen = 0;
  const step = async () => {
    const body = await desktopFetch(
      config,
      `/api/progress/${encodeURIComponent(progress.id)}?after=${seen}`,
      { timeoutMs: 5000, signal },
    ).catch(() => null);
    for (const item of body?.items ?? []) {
      seen++;
      try {
        progress.onItem(sanitizeProgress(item));
      } catch {
        /* UI callbacks never break generation */
      }
    }
  };
  while (!stopped.value && !signal?.aborted) {
    await step();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await step();
}
function sanitizeProgress(item) {
  if (item?.type === "output_delta")
    return {
      type: "output_delta",
      text: String(item.text ?? "").slice(0, 4000),
    };
  if (item?.type === "reasoning_delta")
    return {
      type: "reasoning_delta",
      text: String(item.text ?? "").slice(0, 4000),
    };
  if (item?.type === "reasoning")
    return { type: "reasoning", text: String(item.text ?? "").slice(0, 4000) };
  if (item?.type === "thinking")
    return {
      type: "thinking",
      tokens:
        Number.isInteger(item.tokens) && item.tokens >= 0 ? item.tokens : 0,
    };
  return {
    type: "command",
    phase: item?.phase === "start" ? "start" : "end",
    id: String(item?.id ?? "").slice(0, 80),
    command: String(item?.command ?? "").slice(0, 500),
    exitCode: Number.isInteger(item?.exitCode) ? item.exitCode : null,
    output: String(item?.output ?? "").slice(0, 2000),
  };
}

/** Runs one generation through the desktop app using an already validated request. */
export async function desktopGenerate(config, valid, signal, options = {}) {
  const progress = options.progress ?? null;
  const stopped = { value: false };
  const polling =
    progress?.id && progress.onItem
      ? pollProgress(config, progress, signal, stopped)
      : null;
  let body;
  try {
    body = await desktopFetch(config, "/api/generate", {
      method: "POST",
      body: {
        providerId: config.providerId,
        model: config.model,
        progressId: progress?.id ?? undefined,
        // One agent thread per browser conversation (SPEC 12.3).
        threadId:
          config.supportsThreads && options.thread ? options.thread : undefined,
        reasoning: valid.reasoning ?? undefined,
        // Desktop agents take text prompts; image parts were rejected earlier
        // unless the provider advertised vision, which none does yet.
        messages: valid.messages.map((message) =>
          Array.isArray(message.content)
            ? { ...message, content: contentText(message.content) }
            : message,
        ),
        tools: valid.tools,
        temperature: valid.temperature,
        maxTokens: valid.maxTokens,
      },
      signal,
      timeoutMs: LIMITS.desktopTimeoutMs,
    });
  } finally {
    stopped.value = true;
    if (polling) await polling.catch(() => {});
  }
  const message = body.message;
  if (
    !message ||
    typeof message !== "object" ||
    typeof (message.content ?? "") !== "string"
  )
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The desktop app returned an invalid message.",
    );
  const calls = Array.isArray(message.toolCalls)
    ? message.toolCalls.slice(0, LIMITS.toolCalls)
    : [];
  const toolCalls = calls.map((call) => {
    if (
      typeof call?.id !== "string" ||
      !call.id ||
      typeof call.name !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(call.name) ||
      typeof call.arguments !== "string"
    )
      throw new BrokerError(
        "PROVIDER_ERROR",
        "The desktop app returned invalid tool calls.",
      );
    return {
      id: call.id.slice(0, 128),
      name: call.name,
      arguments: call.arguments.slice(0, LIMITS.resultBytes),
    };
  });
  const content = String(message.content ?? "").slice(0, 120000);
  const count = (value) =>
    Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const agentSteps = (Array.isArray(body.steps) ? body.steps : [])
    .slice(0, 32)
    .filter((step) => step && typeof step === "object")
    .map((step) => ({
      type: "command",
      command: String(step.command ?? "").slice(0, 500),
      exitCode: Number.isInteger(step.exitCode) ? step.exitCode : null,
      output: String(step.output ?? "").slice(0, 2000),
    }));
  return {
    id:
      typeof body.id === "string" ? body.id.slice(0, 200) : crypto.randomUUID(),
    model: modelId(config),
    agentSteps,
    message: {
      role: "assistant",
      content,
      toolCalls,
      attachments: [],
      reasoning:
        typeof (message.reasoning ?? body.reasoning) === "string" &&
        (message.reasoning ?? body.reasoning).trim()
          ? (message.reasoning ?? body.reasoning).slice(
              0,
              LIMITS.reasoningChars,
            )
          : null,
    },
    finishReason:
      typeof body.finishReason === "string"
        ? body.finishReason.slice(0, 80)
        : "stop",
    usage: {
      promptTokens: count(body.usage?.promptTokens),
      completionTokens: count(body.usage?.completionTokens),
      totalTokens: count(body.usage?.totalTokens),
      cachedTokens: count(body.usage?.cachedTokens),
      reasoningTokens: count(body.usage?.reasoningTokens),
    },
    contextWindow: Number.isInteger(body.contextWindow)
      ? body.contextWindow
      : (config.contextWindow ?? null),
    thread: body.thread === true,
    quota: sanitizeQuota(body.quota),
    rawMessage: {
      role: "assistant",
      content,
      tool_calls: toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    },
  };
}

export function modelId(config) {
  return `${config?.providerId ?? "openai"}/${config?.model}`;
}
