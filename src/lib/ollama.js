import { BrokerError } from "./errors.js";
import { EFFORTS } from "./constants.js";

// Two independent providers share one wire format: an Ollama server the user
// runs (any address they choose) and Ollama's hosted service. They keep
// separate credentials, catalogs, and public ids.
export const OLLAMA_PROVIDER_ID = "ollama";
export const OLLAMA_CLOUD_PROVIDER_ID = "ollama-cloud";
export const OLLAMA_DEFAULT_URL = "http://127.0.0.1:11434";
export const OLLAMA_CLOUD_URL = "https://ollama.com";
// The dynamic declarativeNetRequest rule that strips our Origin header on
// requests to the configured self-hosted server (see `ollamaOriginRule`).
export const OLLAMA_ORIGIN_RULE_ID = 4101;
// How long a discovered catalog is trusted before a catalog read refreshes it
// in the background. A local server changes whenever the user pulls a model.
export const OLLAMA_REFRESH_MS = Object.freeze({
  local: 60_000,
  cloud: 60 * 60_000,
});
const MODEL_LIMIT = 200;
export const OLLAMA_UNREACHABLE =
  "The Ollama server is not answering. Check that it is running and reachable.";
export const OLLAMA_CLOUD_UNREACHABLE =
  "Ollama Cloud is not answering. Try again in a moment.";
export const OLLAMA_ORIGIN_REFUSAL =
  "The Ollama server refused this browser extension (403). If it restricts origins, add chrome-extension://* and moz-extension://* to OLLAMA_ORIGINS and restart it.";
export const OLLAMA_PROXY_REFUSAL =
  "The server at this Ollama address refused the request (403). If a proxy in front of Ollama requires an API key, add one in extension settings; otherwise check its access rules.";
export const OLLAMA_KEY_REFUSAL =
  "The server at this Ollama address refused the request (403), which usually means it does not accept the API key. Check the key in extension settings, or the access rules of the proxy in front of Ollama.";

function ipv4(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every((part) => part <= 255) ? parts : null;
}

/**
 * Whether plain HTTP to this host stays on the user's own network. Ollama has
 * no TLS of its own, so a server on the LAN is normally reached over HTTP; a
 * host on the public internet is not, because prompts and page context would
 * cross it in the clear. Names cannot be resolved here, so only names that are
 * local by construction count.
 */
export function ollamaLocalHost(hostname) {
  const host = String(hostname).toLowerCase();
  const v4 = ipv4(host);
  if (v4) {
    const [a, b] = v4;
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      // Carrier-grade NAT space, which is also where Tailscale addresses live.
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.startsWith("[") && host.endsWith("]")) {
    const v6 = host.slice(1, -1);
    return (
      v6 === "::1" ||
      /^f[cd][0-9a-f]{0,2}:/.test(v6) ||
      /^fe[89ab][0-9a-f]?:/.test(v6)
    );
  }
  if (!host.includes(".")) return true;
  return /\.(?:local|lan|home\.arpa|internal|localhost|ts\.net)$/.test(host);
}

/**
 * The normalized base URL of a self-hosted server: an origin plus an optional
 * reverse-proxy path, without the `/api` or `/v1` a pasted endpoint may carry.
 */
export function ollamaBaseUrl(input) {
  const raw = String(input ?? "").trim() || OLLAMA_DEFAULT_URL;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw new BrokerError("INVALID_REQUEST", "The Ollama address is invalid.");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new BrokerError(
      "INVALID_REQUEST",
      "The Ollama address must use http or https.",
    );
  if (url.username || url.password || url.search || url.hash)
    throw new BrokerError(
      "INVALID_REQUEST",
      "The Ollama address must not contain credentials, a query, or a fragment.",
    );
  if (url.protocol === "http:" && !ollamaLocalHost(url.hostname))
    throw new BrokerError(
      "INVALID_REQUEST",
      "Plain http is allowed only for servers on this computer or your local network. Use https for a server on the internet.",
    );
  const path = url.pathname.replace(/\/+$/, "").replace(/\/(?:api|v1)$/, "");
  return `${url.origin}${path}`.slice(0, 500);
}

/**
 * "llama3.2:latest" → "llama3.2"; every other tag is part of the name. A model
 * the server forwards to ollama.com says so when its name does not.
 */
export function ollamaDisplayName(model, remote = false) {
  const name = String(model).replace(/:latest$/, "");
  return remote && !/cloud/i.test(name) ? `${name} (cloud)` : name;
}

/** Models a server lists but cannot run, with why: shown in settings, never offered. */
export function normalizeOllamaSkipped(list) {
  return (Array.isArray(list) ? list : [])
    .filter(
      (item) =>
        typeof item?.id === "string" &&
        item.id &&
        item.id.length <= 200 &&
        typeof item.reason === "string",
    )
    .slice(0, 50)
    .map((item) => ({
      id: item.id,
      reason: item.reason.slice(0, 200),
      ...cacheStamp(item),
    }));
}

/** Listed models that are not chat models (embeddings), remembered so they are not re-read. */
export function normalizeOllamaIgnored(list) {
  return (Array.isArray(list) ? list : [])
    .filter(
      (item) =>
        typeof item?.id === "string" && item.id && item.id.length <= 200,
    )
    .slice(0, 200)
    .map((item) => ({ id: item.id, ...cacheStamp(item) }));
}

/**
 * What a cached discovery result was checked against. Bump the schema when an
 * entry gains fields, so entries from older builds are read again. The server
 * version is part of it because the same file can stop loading after an
 * Ollama upgrade (or start loading after one): a digest alone cannot say.
 */
export const OLLAMA_CATALOG_SCHEMA = 2;
export function ollamaCheckKey(version) {
  return `${OLLAMA_CATALOG_SCHEMA}:${version ?? "unknown"}`.slice(0, 60);
}
function cacheStamp(item) {
  return {
    digest: typeof item?.digest === "string" ? item.digest.slice(0, 128) : null,
    checkedWith:
      typeof item?.checkedWith === "string"
        ? item.checkedWith.slice(0, 60)
        : null,
  };
}

/** Why discovery left a model out, from the refusal `/api/show` gave for it. */
/**
 * The server's own one-line error, cleaned for display in settings: unwrapped
 * from the JSON envelopes Ollama nests, stripped of control characters, and
 * capped. Only ever taken from `/api/show`, whose request carries nothing but
 * a model name, so it cannot quote a conversation back.
 */
export function ollamaServerText(text) {
  let value = String(text ?? "");
  for (let depth = 0; depth < 3; depth++) {
    try {
      const parsed = JSON.parse(value);
      const inner = parsed?.error?.message ?? parsed?.error ?? parsed?.message;
      if (typeof inner !== "string") break;
      value = inner;
    } catch {
      break;
    }
  }
  value = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value.length > 200 ? `${value.slice(0, 199)}…` : value;
}

/**
 * Why discovery left a model out. No cause is guessed: a model the server
 * cannot read may be a damaged download, a format this Ollama build does not
 * handle, or a regression in an update, and only the server's own words and
 * version tell those apart. A retirement is the one case Ollama names itself.
 */
export function ollamaSkipReason({ kind, status, text, version } = {}) {
  if (kind === "retired") return "Ollama has retired this model.";
  const said = ollamaServerText(text);
  const server = version ? `Ollama ${version} on the server` : "The server";
  return said
    ? `${server} could not read it: ${said}`
    : `${server} could not read it (HTTP ${status ?? "error"}).`;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function contextLength(show, tag) {
  const info = show?.model_info;
  if (info && typeof info === "object")
    for (const [key, value] of Object.entries(info))
      if (key.endsWith(".context_length") && safeCount(value)) return value;
  return safeCount(tag?.details?.context_length);
}

/**
 * Thinking controls a model accepts. `/api/show` lists them on servers that
 * know (`thinking.values`, such as `[false, "low", "high", "max"]`); older or
 * local servers report only the `thinking` capability, in which case gpt-oss is
 * known to take levels and everything else an on/off switch.
 */
function thinking(show, tag, capable) {
  if (!capable) return { think: null, levels: [], fallback: null };
  const values = Array.isArray(show?.thinking?.values)
    ? show.thinking.values
    : null;
  if (values) {
    const strings = values.filter(
      (value) => typeof value === "string" && EFFORTS.includes(value),
    );
    const off = values.includes(false);
    const levels = strings.length
      ? [...(off ? ["none"] : []), ...strings]
      : values.includes(true) && off
        ? ["none", "high"]
        : [];
    const fallback = show.thinking.default;
    return {
      think: strings.length ? "levels" : "boolean",
      levels,
      fallback:
        fallback === false && off
          ? "none"
          : fallback === true && levels.includes("high")
            ? "high"
            : typeof fallback === "string" && levels.includes(fallback)
              ? fallback
              : null,
    };
  }
  const family = `${show?.details?.family ?? tag?.details?.family ?? ""} ${tag?.name ?? ""}`;
  return /gpt-?oss/i.test(family)
    ? { think: "levels", levels: ["low", "medium", "high"], fallback: null }
    : { think: "boolean", levels: ["none", "high"], fallback: null };
}

/**
 * One catalog entry from a `/api/tags` item and its `/api/show` answer, or null
 * for a model that cannot hold a conversation (embedding models). Capabilities
 * come from the server's own metadata, never from the model's name: a model
 * without `vision` gets no images and one without `tools` gets no tools,
 * because Ollama fails those requests outright.
 */
/** "20914757184" (a raw count, as Ollama Cloud reports it) → "20.9B"; "2.1B" stays. */
function parameterSize(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (/^\d+$/.test(text)) {
    const count = Number(text);
    if (!count) return null;
    return count >= 1e9
      ? `${(count / 1e9).toFixed(1)}B`
      : `${Math.round(count / 1e6)}M`;
  }
  return /^[\d.]+[KMBT]$/i.test(text) && text.length <= 12
    ? text.toUpperCase()
    : null;
}

function quantization(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_.-]{1,24}$/.test(text) && !/^unknown$/i.test(text)
    ? text.toUpperCase()
    : null;
}

/**
 * Whether a model listed by a self-hosted server actually runs on ollama.com.
 * Ollama can host cloud models next to local ones (`ollama pull
 * gpt-oss:120b-cloud`); the server proxies them, so prompts leave the user's
 * network even though the address is local.
 */
function forwardsToCloud(tag, show, name) {
  return Boolean(
    tag?.remote_host ||
      tag?.remote_model ||
      show?.remote_host ||
      show?.remote_model ||
      /[:-]cloud$/i.test(name),
  );
}

/**
 * Where a loaded model sits, from `/api/ps` byte counts, labelled the way
 * `ollama ps` labels its PROCESSOR column so the widget and the terminal
 * agree: "100% GPU", "100% CPU", or "48%/52% CPU/GPU" for a split. Null when
 * the counts are missing or inconsistent. On Apple silicon unified memory
 * Ollama counts the Metal allocation as VRAM, so it reads as GPU too.
 */
export function ollamaProcessor(size, sizeVram) {
  if (!Number.isSafeInteger(size) || size <= 0) return null;
  const vram = Number.isSafeInteger(sizeVram) ? sizeVram : 0;
  if (vram < 0 || vram > size) return null;
  if (vram === 0) return { placement: "cpu", gpuPercent: 0, label: "100% CPU" };
  if (vram === size)
    return { placement: "gpu", gpuPercent: 100, label: "100% GPU" };
  const cpu = Math.round(((size - vram) / size) * 100);
  return {
    placement: "split",
    gpuPercent: 100 - cpu,
    label: `${cpu}%/${100 - cpu}% CPU/GPU`,
  };
}

/** Whether `version` ("0.32.15") is at least `required` ("0.30.0"). */
export function ollamaVersionAtLeast(version, required) {
  const parse = (value) =>
    String(value ?? "")
      .split(/[.-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10));
  const have = parse(version);
  const need = parse(required);
  if ([...have, ...need].some((part) => !Number.isFinite(part))) return true;
  for (let index = 0; index < 3; index++)
    if ((have[index] ?? 0) !== (need[index] ?? 0))
      return (have[index] ?? 0) > (need[index] ?? 0);
  return true;
}

export function ollamaModelInfo(tag, show, { cloud = false } = {}) {
  const name = typeof tag?.name === "string" ? tag.name : tag?.model;
  if (typeof name !== "string" || !name || name.length > 200) return null;
  const capabilities = Array.isArray(show?.capabilities)
    ? show.capabilities
    : Array.isArray(tag?.capabilities)
      ? tag.capabilities
      : null;
  if (capabilities && !capabilities.includes("completion")) return null;
  const has = (name_) => Boolean(capabilities?.includes(name_));
  const reasoning = has("thinking");
  const think = thinking(show, tag, reasoning);
  return {
    id: name,
    digest: typeof tag.digest === "string" ? tag.digest.slice(0, 128) : null,
    capabilities: { tools: has("tools"), vision: has("vision"), reasoning },
    contextWindow: contextLength(show, tag),
    reasoningLevels: think.levels,
    defaultReasoning: think.fallback,
    think: think.think,
    parameterSize: parameterSize(
      tag?.details?.parameter_size || show?.details?.parameter_size,
    ),
    quantization: quantization(
      show?.details?.quantization_level || tag?.details?.quantization_level,
    ),
    remote: !cloud && forwardsToCloud(tag, show, name),
  };
}

/** Stored or synced catalog entries, re-validated before use. */
export function normalizeOllamaModels(list) {
  const seen = new Set();
  const models = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (models.length >= MODEL_LIMIT) break;
    if (!item || typeof item !== "object") continue;
    const id = item.id;
    if (typeof id !== "string" || !id || id.length > 200 || seen.has(id))
      continue;
    seen.add(id);
    const levels = (
      Array.isArray(item.reasoningLevels) ? item.reasoningLevels : []
    ).filter((level) => EFFORTS.includes(level));
    const capabilities = item.capabilities ?? {};
    models.push({
      id,
      digest:
        typeof item.digest === "string" ? item.digest.slice(0, 128) : null,
      capabilities: {
        tools: capabilities.tools === true,
        vision: capabilities.vision === true,
        reasoning: capabilities.reasoning === true,
      },
      contextWindow: safeCount(item.contextWindow),
      reasoningLevels:
        capabilities.reasoning === true ? [...new Set(levels)] : [],
      defaultReasoning: levels.includes(item.defaultReasoning)
        ? item.defaultReasoning
        : null,
      think:
        capabilities.reasoning === true &&
        ["levels", "boolean"].includes(item.think)
          ? item.think
          : null,
      parameterSize: parameterSize(item.parameterSize),
      quantization: quantization(item.quantization),
      remote: item.remote === true,
      checkedWith: cacheStamp(item).checkedWith,
    });
  }
  return models.sort((a, b) =>
    ollamaDisplayName(a.id).localeCompare(ollamaDisplayName(b.id), "en", {
      numeric: true,
    }),
  );
}

/**
 * The default model when the user has not picked one: the previous choice,
 * else the first that runs on the server itself and can use site tools, since
 * most site assistants declare some.
 */
export function ollamaPreferredModel(models, previous) {
  if (models.some((model) => model.id === previous)) return previous;
  return (
    models.find((model) => model.capabilities?.tools && !model.remote)?.id ??
    models.find((model) => !model.remote)?.id ??
    models[0]?.id ??
    null
  );
}

const LEVEL_ORDER = ["low", "medium", "high", "xhigh", "max"];

/**
 * The `think` value for a requested effort, or undefined to leave the model's
 * own default alone. A model without the thinking capability never receives
 * the field: Ollama answers 400 "does not support thinking" when it does.
 */
export function ollamaThink(config, effort) {
  if (!effort || config?.capabilities?.reasoning !== true) return undefined;
  const levels = config.reasoningLevels ?? [];
  if (effort === "none") return levels.includes("none") ? false : undefined;
  if (config.think === "boolean") return true;
  if (levels.includes(effort)) return effort;
  // Clamp to the nearest level the model publishes (SPEC 5.3).
  const wanted = LEVEL_ORDER.indexOf(effort);
  const offered = levels.filter((level) => LEVEL_ORDER.includes(level));
  if (!offered.length) return undefined;
  // A tie goes to the higher level: the caller asked for more thought than
  // the lower neighbour gives.
  return offered.reduce((best, level) =>
    Math.abs(LEVEL_ORDER.indexOf(level) - wanted) <=
    Math.abs(LEVEL_ORDER.indexOf(best) - wanted)
      ? level
      : best,
  );
}

/**
 * One of our own errors for a refused request, classified to the SPEC 9
 * codes: `{ code, message, retryable, details?, kind?, generic? }`. Ollama's
 * error text is read only to choose the sentence and the code; it is never
 * shown, since a server's prose can quote the request back.
 *
 * `retryAfterMs` is what the response's `Retry-After` said, if anything.
 * `emptyBody` says the refusal came with no body at all, which is how
 * Ollama's own Origin and Host checks answer; anything else that answers 403
 * (an authenticating proxy, a firewall page) sends one.
 * `listing` marks a metadata read (`GET /api/tags`): a 404 there means the
 * address does not serve Ollama, not that a model is missing. `kind` tells
 * discovery and the catalog's self-correction which refusals are about the
 * model itself (`unloadable`, `retired`, `missing`).
 */
export function ollamaRefusal(
  status,
  text,
  config,
  { retryAfterMs = null, listing = false, emptyBody = false } = {},
) {
  const reason = String(text ?? "").slice(0, 500);
  const where = config?.cloud ? "Ollama Cloud" : "The Ollama server";
  const refuse = (code, message, extra = {}) => ({
    code,
    message,
    retryable: false,
    ...extra,
  });
  if (status === 401)
    return refuse(
      "NOT_CONFIGURED",
      config?.cloud
        ? "Ollama Cloud rejected the API key. Check it in extension settings."
        : "The Ollama server requires a valid API key. Check it in extension settings.",
    );
  if (status === 429)
    return {
      code: "RATE_LIMITED",
      message: `${where} reports a usage or rate limit. Try again later.`,
      retryable: true,
      ...(Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0
        ? { details: { retryAfterMs } }
        : {}),
    };
  if (status === 403 && !config?.cloud)
    return emptyBody
      ? refuse("PROVIDER_ERROR", OLLAMA_ORIGIN_REFUSAL)
      : config?.apiKey
        ? refuse("NOT_CONFIGURED", OLLAMA_KEY_REFUSAL)
        : refuse("PROVIDER_ERROR", OLLAMA_PROXY_REFUSAL);
  // Seen live with `truncate: false`: "request (3009 tokens) exceeds the
  // available context size (2048 tokens)", type exceed_context_size_error.
  // With truncation on (Ollama's default) an overflow is silent instead.
  if (
    /exceed(?:s|ed)?[^.]{0,40}context|exceed_context_size|context (?:size|length|window) (?:exceeded|is too)|prompt is too long|too many tokens/i.test(
      reason,
    )
  )
    return refuse(
      "CONTEXT_TOO_LONG",
      "The conversation is too long for the context this Ollama model was loaded with. Send fewer or shorter messages, or raise the server's context length.",
    );
  if (/does not support thinking/i.test(reason))
    return refuse(
      "NOT_SUPPORTED",
      "The selected Ollama model does not support thinking. Choose the default effort.",
    );
  if (/does not support tools/i.test(reason))
    return refuse(
      "NOT_SUPPORTED",
      "The selected Ollama model does not support tools.",
    );
  if (
    /image input is not supported|does not support (?:images|vision)|mmproj/i.test(
      reason,
    )
  )
    return refuse(
      "NOT_SUPPORTED",
      "The selected Ollama model does not accept images.",
    );
  if (
    /size overflow|unable to load|failed to load|error loading model|invalid file magic|unknown model architecture|unsupported model|not a valid model/i.test(
      reason,
    )
  )
    return refuse(
      "MODEL_UNAVAILABLE",
      "The Ollama server could not load this model. Refresh models in extension settings to see the server's reason.",
      { kind: "unloadable" },
    );
  if (/retired/i.test(reason))
    return refuse(
      "MODEL_UNAVAILABLE",
      "This Ollama Cloud model has been retired. Refresh the model list in extension settings.",
      { kind: "retired" },
    );
  if (/memory/i.test(reason))
    return refuse(
      "MODEL_UNAVAILABLE",
      "The Ollama server does not have enough memory to load this model.",
    );
  if (status === 404 && listing)
    return refuse(
      "PROVIDER_ERROR",
      `${where} did not answer as an Ollama API (404). Check the address in extension settings.`,
    );
  if (
    status === 404 ||
    /model .*not found|not found, try pulling/i.test(reason)
  )
    return refuse(
      "MODEL_UNAVAILABLE",
      `${where} does not have this model. Refresh the model list in extension settings.`,
      { kind: "missing" },
    );
  // Only a server error or an unexplained failure may succeed unchanged.
  return {
    code: "PROVIDER_ERROR",
    message: `${where} rejected the request (${status}).`,
    retryable: status >= 500 || status === 408,
    generic: true,
  };
}

/**
 * Ollama answers 403 to any request whose Origin it does not allow, and a
 * browser extension's own origin is never on its default list. Chrome sends
 * that header on every POST from the service worker, so every chat request
 * fails until the user edits the server's environment. Removing the header is
 * scoped twice: to this extension as the initiator, so a web page's requests
 * to the same server keep the Origin that Ollama's check exists to inspect,
 * and to the one server origin the user configured.
 */
export function ollamaOriginRule(baseUrl, extensionHost) {
  let origin;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    return null;
  }
  if (!extensionHost || origin === "null") return null;
  return {
    id: OLLAMA_ORIGIN_RULE_ID,
    priority: 1,
    condition: {
      urlFilter: `|${origin}/`,
      initiatorDomains: [extensionHost],
      resourceTypes: ["xmlhttprequest"],
    },
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "origin", operation: "remove" }],
    },
  };
}
