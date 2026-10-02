import { BrokerError } from "./errors.js";
import { LIMITS, generateLimits } from "./constants.js";
import {
  validateGenerateRequest,
  validateToolCalls,
  repairToolCalls,
  cloneJson,
  hasImages,
} from "./validation.js";
import { IMAGE_TYPES } from "./constants.js";
import { providerSchema } from "./schema.js";
import {
  readJson,
  responseChunks,
  requestSignal,
  networkError,
} from "./network.js";
import { desktopGenerate, modelId } from "./desktop.js";
import { opencodeProtocol, opencodeUnusableReason } from "./opencode.js";
import {
  OLLAMA_CLOUD_UNREACHABLE,
  OLLAMA_ORIGIN_REFUSAL,
  OLLAMA_UNREACHABLE,
  ollamaDisplayName,
  ollamaCheckKey,
  ollamaModelInfo,
  ollamaProcessor,
  ollamaSkipReason,
  ollamaVersionAtLeast,
  ollamaRefusal,
  ollamaThink,
} from "./ollama.js";

function endpoint(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}
/**
 * Zen proxies each family to its upstream vendor and expects that vendor's own
 * credential header, not one scheme for the whole gateway. Verified against the
 * live service on 2026-09-20: `Authorization: Bearer` answers 401 AuthError
 * ("Missing API key") on the Anthropic and Gemini routes.
 */
function providerHeaders(config) {
  // A self-hosted Ollama usually has no key at all; one behind an
  // authenticating proxy, and Ollama Cloud, take a bearer token.
  if (config?.kind === "ollama")
    return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
  if (config?.kind === "opencode" && config.protocol === "anthropic")
    return { "x-api-key": config.apiKey };
  if (config?.kind === "opencode" && config.protocol === "gemini")
    return { "x-goog-api-key": config.apiKey };
  return { Authorization: `Bearer ${config.apiKey}` };
}

// A provider's own prose may quote the request back, so nothing from the body
// is ever shown. Its short machine-readable fields are read, and its message
// is matched against fixed patterns, only to select one of our own sentences.
const REFUSALS = Object.freeze({
  FreeTierError:
    "OpenCode's free tier can only be used from inside the OpenCode app, not through an API key. Choose a model without the free suffix.",
});
// OpenAI and every Chat Completions or Responses server modelled on it send
// `context_length_exceeded`; llama.cpp's server has its own type for it.
const CONTEXT_CODES = new Set([
  "context_length_exceeded",
  "exceed_context_size_error",
  "context_window_exceeded",
]);
const MODEL_CODES = new Set(["model_not_found", "model_not_available"]);
const FAILURE_TEXT = Object.freeze({
  // OpenAI and vLLM "maximum context length is", Anthropic "prompt is too
  // long" and "exceed context limit", Gemini "The input token count (…)
  // exceeds the maximum", LM Studio "greater than the context length".
  context:
    /context[_ ](?:length|window|size|limit)|maximum context|prompt is too long|input is too long|input token count[^.]*exceeds|too many (?:input |prompt )?tokens|reduce the length of the messages/i,
  // OpenAI "The model `x` does not exist", Anthropic "model: x", Gemini
  // "models/x is not found for API version", and the generic spellings.
  model:
    /\bmodel\b[^.\n]{0,160}?\b(?:not found|does not exist|is not available|not available|unavailable|not supported|decommissioned|deprecated|retired)\b|\b(?:unknown|invalid|unsupported) model\b|\bmodels\/\S+ is not found|^model:/i,
  load: /(?:failed|unable) to load (?:the )?model|error loading model/i,
  transient: /overloaded|server_error|api_error|internal|unavailable/i,
});
const DAY_MS = 86_400_000;

/** The parts of a provider error object worth reading, bounded and typed. */
function failureFields(error) {
  const word = (value) =>
    typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
      ? value
      : null;
  if (typeof error === "string") return { message: error.slice(0, 2_000) };
  if (!error || typeof error !== "object") return {};
  const delay = (Array.isArray(error.details) ? error.details : []).find(
    (item) => typeof item?.retryDelay === "string",
  )?.retryDelay;
  // Gemini's RetryInfo is a protobuf Duration: "30s", "1.5s".
  const seconds = /^(\d{1,6}(?:\.\d{1,9})?)s$/.exec(delay ?? "")?.[1];
  return {
    type: word(error.type),
    code: word(error.code),
    statusName: word(error.status),
    message:
      typeof error.message === "string" ? error.message.slice(0, 2_000) : "",
    retryAfterMs:
      seconds == null ? null : Math.min(Number(seconds) * 1000, DAY_MS),
  };
}

/** `Retry-After` (seconds or a date) or OpenAI-style `retry-after-ms`. */
function retryAfterHeader(response) {
  const clamp = (ms) => Math.min(Math.max(0, Math.round(ms)), DAY_MS);
  const ms = response.headers.get("retry-after-ms");
  if (ms != null && ms !== "" && Number.isFinite(Number(ms)))
    return clamp(Number(ms));
  const value = response.headers.get("retry-after");
  if (value == null || value === "") return null;
  if (Number.isFinite(Number(value))) return clamp(Number(value) * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? clamp(date - Date.now()) : null;
}

/**
 * One of our own errors for a provider failure (SPEC 9). `status` is the HTTP
 * status, or 0 for an error reported inside a stream. Context and model
 * failures are only read into a generation request: a model listing that 404s
 * is a wrong address, not a missing model.
 */
function classifiedFailure(
  { type, code, statusName, message = "", retryAfterMs = null },
  { status = 0, generation = true, retryAfter = null } = {},
) {
  if (REFUSALS[type])
    return new BrokerError("PROVIDER_ERROR", REFUSALS[type], undefined, {
      retryable: false,
    });
  const client = status === 0 || (status >= 400 && status < 500);
  // "The model is currently unavailable" from an overloaded service is a
  // wait, not a missing model.
  const transient = [type, code, statusName].some(
    (value) => value && FAILURE_TEXT.transient.test(value),
  );
  if (
    status === 429 ||
    type === "rate_limit_error" ||
    code === "rate_limit_exceeded" ||
    statusName === "RESOURCE_EXHAUSTED"
  ) {
    // OpenAI answers 429 for an exhausted balance too; waiting will not help.
    if (code === "insufficient_quota")
      return new BrokerError(
        "PROVIDER_ERROR",
        "The provider account has no quota left for this request.",
        undefined,
        { retryable: false },
      );
    const wait = retryAfter ?? retryAfterMs;
    return new BrokerError(
      "RATE_LIMITED",
      "The provider is limiting how often requests can be made. Try again later.",
      wait == null ? undefined : { retryAfterMs: wait },
    );
  }
  if (
    generation &&
    (CONTEXT_CODES.has(code) ||
      CONTEXT_CODES.has(type) ||
      status === 413 ||
      (client && FAILURE_TEXT.context.test(message)))
  )
    return new BrokerError(
      "CONTEXT_TOO_LONG",
      "The conversation is too long for the selected model's context window. Send fewer or shorter messages.",
    );
  if (
    generation &&
    (MODEL_CODES.has(code) ||
      FAILURE_TEXT.load.test(message) ||
      ((client || statusName === "NOT_FOUND") &&
        !transient &&
        FAILURE_TEXT.model.test(message)))
  )
    return new BrokerError(
      "MODEL_UNAVAILABLE",
      "The selected model is not available from its provider. Choose another model in the extension.",
    );
  if (status === 0)
    return new BrokerError(
      "PROVIDER_ERROR",
      "The provider reported an error while streaming.",
      undefined,
      { retryable: transient },
    );
  return new BrokerError(
    "PROVIDER_ERROR",
    `The provider rejected the request (${status}).`,
    undefined,
    { retryable: status >= 500 || status === 408 },
  );
}

/** Classifies a failed provider response from its status, headers, and body. */
async function responseFailure(response, generation) {
  let fields = {};
  try {
    const body = await readJson(
      response,
      LIMITS.providerResponseBytes,
      "PROVIDER_ERROR",
    );
    // Gemini's streaming route can wrap its error in a one-element array, and
    // FastAPI-style servers answer `{ detail }` or `{ message }`.
    const source = Array.isArray(body) ? body[0] : body;
    fields = failureFields(
      source?.error ?? source?.detail ?? source?.message ?? null,
    );
  } catch {
    /* an unreadable body still has a status */
  }
  return classifiedFailure(fields, {
    status: response.status,
    generation,
    retryAfter: retryAfterHeader(response),
  });
}

/** An error a provider reported inside an otherwise successful stream. */
function streamFailure(error) {
  return classifiedFailure(failureFields(error));
}

/** Ollama's `{ "error": "..." }` text, read only to choose our own sentence. */
async function errorText(response) {
  try {
    const body = await readJson(response, 64_000, "PROVIDER_ERROR");
    return typeof body?.error === "string" ? body.error.slice(0, 500) : "";
  } catch {
    return "";
  }
}

/**
 * `deadline` is the whole-exchange timeout. Metadata calls keep the default;
 * a generation round passes null so a slow model is waited on rather than cut
 * off, and the visitor is told about the wait instead (SPEC 10).
 */
async function providerResponse(
  config,
  path,
  init,
  signal,
  deadline = LIMITS.timeoutMs,
) {
  try {
    const response = await fetch(endpoint(config.baseUrl, path), {
      ...init,
      headers: { ...providerHeaders(config), ...init.headers },
      signal: requestSignal(signal, deadline),
      redirect: "error",
      credentials: "omit",
    });
    if (!response.ok) {
      if (config?.kind === "ollama") {
        const text = await errorText(response);
        const refusal = ollamaRefusal(response.status, text, config, {
          retryAfterMs: retryAfterHeader(response),
          listing: (init.method ?? "GET") === "GET",
        });
        // Discovery needs to tell a model the server refused from a request
        // that never arrived, and settings show the server's own reason for
        // it. Kept off `details`, which pages can read.
        throw Object.assign(
          new BrokerError(refusal.code, refusal.message, refusal.details, {
            retryable: refusal.retryable,
          }),
          {
            ollama: {
              status: response.status,
              kind: refusal.kind ?? null,
              text,
            },
          },
        );
      }
      throw await responseFailure(response, init.method === "POST");
    }
    return response;
  } catch (error) {
    // A server that never answered is the most common Ollama failure (it is
    // stopped, asleep, or on another network), and says so in its own words.
    if (
      config?.kind === "ollama" &&
      !(error instanceof BrokerError) &&
      !["AbortError", "TimeoutError"].includes(error?.name)
    )
      throw new BrokerError(
        "PROVIDER_ERROR",
        config.cloud ? OLLAMA_CLOUD_UNREACHABLE : OLLAMA_UNREACHABLE,
        undefined,
        { retryable: true },
      );
    throw networkError(error, "PROVIDER_ERROR", "Provider");
  }
}

async function providerRequest(
  config,
  path,
  init,
  signal,
  deadline = LIMITS.timeoutMs,
) {
  try {
    return await readJson(
      await providerResponse(config, path, init, signal, deadline),
      LIMITS.providerResponseBytes,
      "PROVIDER_ERROR",
    );
  } catch (error) {
    throw networkError(error, "PROVIDER_ERROR", "Provider");
  }
}

/**
 * Complete `data:` payloads from a server-sent event stream. The stream has no
 * size cap: its wire size runs far ahead of its text, since every token delta
 * carries its own JSON envelope, and a round already ends at the visitor's
 * stop button. What is held is bounded instead: one event at a time, each at
 * most `providerEventBytes`, and the parsers keep only the text they need.
 */
async function* providerEvents(response) {
  const tooLarge = () =>
    new BrokerError("PROVIDER_ERROR", "A provider stream event was too large.");
  let buffer = "";
  let data = [];
  let held = 0;
  for await (const chunk of responseChunks(
    response,
    Infinity,
    "PROVIDER_ERROR",
  )) {
    buffer += chunk;
    while (true) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (!match || (match[0] === "\r" && match.index === buffer.length - 1))
        break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (line === "") {
        if (data.length) yield data.join("\n");
        data = [];
        held = 0;
      } else if (line.startsWith("data:")) {
        held += line.length;
        if (held > LIMITS.providerEventBytes) throw tooLarge();
        data.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (held + buffer.length > LIMITS.providerEventBytes) throw tooLarge();
  }
  // Some OpenAI-compatible local servers omit the final blank line.
  if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
  if (data.length) yield data.join("\n");
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Streamed tool arguments past `toolArgumentUnits` are only ever rejected by
 * `repairToolCalls`, so nothing beyond one character over the limit is kept:
 * that is enough for the repair to report the call as oversized.
 */
function appendCapped(current, delta, limit = LIMITS.toolArgumentUnits + 1) {
  return current.length >= limit
    ? current
    : `${current}${delta}`.slice(0, limit);
}

function completionResult(config, body, choice) {
  if (
    !choice?.message ||
    typeof choice.message !== "object" ||
    Array.isArray(choice.message)
  )
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider response did not contain a message.",
    );
  const {
    calls: wireCalls,
    rejected,
    dropped,
  } = repairToolCalls(choice.message.tool_calls ?? []);
  if (
    choice.message.content != null &&
    typeof choice.message.content !== "string"
  )
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider returned invalid message content.",
    );
  const content = (choice.message.content ?? "").slice(0, 120000);
  const toolCalls = wireCalls.map((call) => ({
    id: call.id,
    name: call.function.name,
    arguments: call.function.arguments,
  }));
  const usage = body.usage ?? {};
  return {
    id:
      typeof body.id === "string" ? body.id.slice(0, 200) : crypto.randomUUID(),
    model: modelId(config),
    message: {
      role: "assistant",
      content,
      toolCalls,
      attachments: responseImages(choice.message),
      reasoning: responseReasoning(choice.message),
    },
    finishReason:
      typeof choice.finish_reason === "string"
        ? choice.finish_reason.slice(0, 80)
        : "stop",
    usage: {
      promptTokens: count(usage.prompt_tokens),
      completionTokens: count(usage.completion_tokens),
      totalTokens: count(usage.total_tokens),
      cachedTokens: count(usage.prompt_tokens_details?.cached_tokens),
      reasoningTokens: count(usage.completion_tokens_details?.reasoning_tokens),
    },
    contextWindow: config.contextWindow ?? null,
    thread: false,
    rawMessage: { role: "assistant", content, tool_calls: wireCalls },
    rejectedToolCalls: rejected,
    droppedToolCalls: dropped,
  };
}

/** Aggregate SSE while forwarding bounded deltas only to broker-owned UI. */
async function streamedCompletion(config, response, onItem) {
  // A few compatible servers ignore `stream: true` and return ordinary JSON.
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const body = await readJson(
      response,
      LIMITS.providerResponseBytes,
      "PROVIDER_ERROR",
    );
    return completionResult(config, body, body?.choices?.[0]);
  }
  let id = null;
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let usage = {};
  let sawPayload = false;
  let sawChoice = false;
  const calls = new Map();
  const notify = (item) => {
    try {
      onItem(item);
    } catch {
      /* UI callbacks never break provider generation. */
    }
  };
  for await (const data of providerEvents(response)) {
    if (data === "[DONE]") break;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new BrokerError(
        "PROVIDER_ERROR",
        "The provider returned an invalid event stream.",
      );
    }
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk))
      throw new BrokerError(
        "PROVIDER_ERROR",
        "The provider returned an invalid event stream.",
      );
    if (chunk.error) throw streamFailure(chunk.error);
    sawPayload = true;
    if (typeof chunk.id === "string") id = chunk.id.slice(0, 200);
    if (chunk.usage && typeof chunk.usage === "object") usage = chunk.usage;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
    if (!choice) continue;
    sawChoice = true;
    if (typeof choice.finish_reason === "string")
      finishReason = choice.finish_reason.slice(0, 80);
    const delta = choice.delta ?? choice.message;
    if (!delta || typeof delta !== "object" || Array.isArray(delta)) continue;
    if (delta.content != null && typeof delta.content !== "string")
      throw new BrokerError(
        "PROVIDER_ERROR",
        "The provider returned invalid streamed content.",
      );
    if (delta.content) {
      const text = delta.content.slice(0, Math.max(0, 120000 - content.length));
      content += text;
      if (text) notify({ type: "output_delta", text });
    }
    const thought = delta.reasoning_content ?? delta.reasoning;
    if (thought != null && typeof thought !== "string")
      throw new BrokerError(
        "PROVIDER_ERROR",
        "The provider returned invalid streamed reasoning.",
      );
    if (thought) {
      const text = thought.slice(
        0,
        Math.max(0, LIMITS.reasoningChars - reasoning.length),
      );
      reasoning += text;
      if (text) notify({ type: "reasoning_delta", text });
    }
    for (const part of Array.isArray(delta.tool_calls)
      ? delta.tool_calls
      : []) {
      const index = Number.isInteger(part?.index) ? part.index : calls.size;
      if (index < 0 || index >= LIMITS.toolCalls)
        throw new BrokerError(
          "PROVIDER_ERROR",
          "The provider returned invalid streamed tool calls.",
        );
      const call = calls.get(index) ?? {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      };
      if (part.id != null && typeof part.id !== "string")
        throw new BrokerError(
          "PROVIDER_ERROR",
          "The provider returned invalid streamed tool calls.",
        );
      if (part.type != null && typeof part.type !== "string")
        throw new BrokerError(
          "PROVIDER_ERROR",
          "The provider returned invalid streamed tool calls.",
        );
      if (part.function?.name != null && typeof part.function.name !== "string")
        throw new BrokerError(
          "PROVIDER_ERROR",
          "The provider returned invalid streamed tool calls.",
        );
      if (
        part.function?.arguments != null &&
        typeof part.function.arguments !== "string"
      )
        throw new BrokerError(
          "PROVIDER_ERROR",
          "The provider returned invalid streamed tool calls.",
        );
      if (typeof part.id === "string") call.id = part.id;
      if (typeof part.type === "string") call.type = part.type;
      if (typeof part.function?.name === "string")
        call.function.name = appendCapped(
          call.function.name,
          part.function.name,
          256,
        );
      if (typeof part.function?.arguments === "string")
        call.function.arguments = appendCapped(
          call.function.arguments,
          part.function.arguments,
        );
      calls.set(index, call);
    }
  }
  if (!sawPayload || !sawChoice)
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider stream ended without a response.",
    );
  const body = { id, usage };
  const choice = {
    finish_reason: finishReason,
    message: {
      role: "assistant",
      content,
      tool_calls: [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => call),
      ...(reasoning ? { reasoning_content: reasoning } : {}),
    },
  };
  return completionResult(config, body, choice);
}

export async function listProviderModels(config, signal) {
  ensureCredentialed(config);
  const body = await providerRequest(config, "/models", {}, signal);
  if (!Array.isArray(body?.data))
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider returned an invalid model list.",
    );
  return body.data
    .filter((item) => typeof item?.id === "string" && item.id.length <= 200)
    .filter((item) => config.kind !== "opencode" || opencodeProtocol(item.id))
    .slice(0, 200)
    .map((item) => ({
      id: item.id,
      provider: "openai-compatible",
      displayName: item.id,
    }));
}

/**
 * The wire format whose replies carry state a tool continuation has to send
 * back (SPEC 5.4): Anthropic's signed thinking, Gemini's thought signatures,
 * the Responses API's encrypted reasoning. Chat Completions, Ollama's native
 * API, and the desktop companion carry none, so they return null.
 */
export function continuationFormat(config) {
  return config?.kind === "opencode" &&
    ["anthropic", "gemini", "responses"].includes(config.protocol)
    ? config.protocol
    : null;
}

/**
 * The state one reply leaves for its continuation, or null. Only a reply that
 * ends in tool calls has a continuation, and state that is too large to keep
 * whole is not kept at all, because a cut copy cannot be replayed.
 */
function continuationState(format, value, calls) {
  if (!value || !calls.length) return null;
  const state = { format, ...value };
  return new TextEncoder().encode(JSON.stringify(state)).byteLength <=
    LIMITS.providerStateBytes
    ? state
    : null;
}

/**
 * `_internal` marked the broker's own hosted rounds, which once had larger
 * message bounds than a page. Both now answer to the model's one set of
 * `limits`; the position stays so existing callers keep their meaning.
 *
 * `options.continuation` maps a message index to the provider state the
 * extension kept for that assistant message (SPEC 5.4). It joins the message
 * only after validation, and only for the wire format that issued it, so it
 * is never something a request could carry in.
 */
export async function generate(
  config,
  request,
  signal,
  _internal = false,
  options = {},
) {
  ensureConfigured(config);
  // Validation owns the one conversion from public camelCase to provider wire
  // fields, against the same bounds `models.list()` reports for this model.
  const valid = validateGenerateRequest(
    request,
    generateLimits(config.kind === "desktop"),
  );
  // The section 7.1 hints (`format`, `readOnly`, ...) are accepted from sites
  // and MCP servers but sent to no provider: some validate function schemas
  // against a fixed field list, and no configuration names one known endpoint.
  // Stripping here covers every wire format below, the desktop's included.
  valid.tools = valid.tools.map((tool) => ({
    ...tool,
    inputSchema: providerSchema(tool.inputSchema),
  }));
  if (
    valid.model != null &&
    valid.model !== "default" &&
    valid.model !== modelId(config)
  )
    throw new BrokerError(
      "INVALID_REQUEST",
      "The requested model is not exposed by this broker.",
    );
  const capabilities = config.capabilities ?? { tools: true, vision: false };
  if (hasImages(valid.messages) && !capabilities.vision)
    throw new BrokerError(
      "NOT_SUPPORTED",
      "The selected model does not accept images.",
    );
  if (valid.tools.length && !capabilities.tools)
    throw new BrokerError(
      "NOT_SUPPORTED",
      "The selected model does not accept tools.",
    );
  // Ollama's native API and the agent CLIs behind the companion have no
  // control over tool use, so only their default, "auto", can be honoured;
  // dropping the tools to fake "none" would change what the model was told.
  if (
    valid.toolChoice &&
    valid.toolChoice !== "auto" &&
    ["desktop", "ollama"].includes(config.kind)
  )
    throw new BrokerError(
      "NOT_SUPPORTED",
      `${config.providerName ?? "This provider"} cannot be told how to use tools. Send toolChoice "auto" or leave it out.`,
    );
  const format = continuationFormat(config);
  for (const [index, state] of options.continuation ?? [])
    if (
      format &&
      state?.format === format &&
      valid.messages[index]?.role === "assistant" &&
      valid.messages[index].tool_calls?.length
    )
      valid.messages[index].state = state;
  // Desktop providers run the user's own subscription CLIs on this computer.
  if (config.kind === "desktop")
    return desktopGenerate(config, valid, signal, options);
  if (config.kind === "ollama")
    return ollamaGenerate(config, valid, signal, options);
  if (config.kind === "opencode" && config.protocol === "responses")
    return responsesGenerate(config, valid, signal, options);
  if (config.kind === "opencode" && config.protocol === "anthropic")
    return anthropicGenerate(config, valid, signal, options);
  if (config.kind === "opencode" && config.protocol === "gemini")
    return geminiGenerate(config, valid, signal, options);
  // Anything else under `opencode` has no conversational route of its own, so
  // it must be refused rather than guessed at with the Chat Completions shape.
  if (config.kind === "opencode" && config.protocol !== "chat-completions")
    throw new BrokerError(
      "NOT_SUPPORTED",
      opencodeUnusableReason(config.model) ??
        "This OpenCode model has no conversational API.",
    );
  const payload = {
    model: config.model,
    messages: valid.messages.map(openaiMessage),
    stream: Boolean(options.progress?.onItem),
  };
  // `stream_options` is an OpenAI extension. Other compatible providers get
  // only the portable `stream: true` field and may still report usage.
  if (
    payload.stream &&
    (() => {
      try {
        return new URL(config.baseUrl).hostname === "api.openai.com";
      } catch {
        return false;
      }
    })()
  )
    payload.stream_options = { include_usage: true };
  if (valid.temperature != null) payload.temperature = valid.temperature;
  // OpenAI's current reasoning models reject the legacy max_tokens field.
  if (valid.maxTokens != null) payload.max_completion_tokens = valid.maxTokens;
  // GPT-5.6 Chat Completions supports functions only with reasoning disabled.
  // Include tool-result continuations even if the caller omits the tool list.
  // Reasoning with tools requires a future Responses API adapter.
  if (
    /^gpt-5\.6(?:-|$)/.test(config.model) &&
    (valid.tools.length ||
      valid.messages.some(
        (message) => message.role === "tool" || message.tool_calls?.length,
      ))
  )
    payload.reasoning_effort = "none";
  else if (valid.reasoning && capabilities.reasoning)
    payload.reasoning_effort = ["xhigh", "max"].includes(valid.reasoning)
      ? "high"
      : valid.reasoning;
  if (valid.tools.length)
    payload.tools = valid.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  if (valid.toolChoice)
    payload.tool_choice = wireToolChoice("chat-completions", valid.toolChoice);
  cloneJson(payload, "Provider request", LIMITS.requestBytes);
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(payload.stream ? { Accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify(payload),
  };
  if (payload.stream)
    try {
      return await streamedCompletion(
        config,
        await providerResponse(config, "/chat/completions", init, signal, null),
        options.progress.onItem,
      );
    } catch (error) {
      throw networkError(error, "PROVIDER_ERROR", "Provider");
    }
  const body = await providerRequest(
    config,
    "/chat/completions",
    init,
    signal,
    null,
  );
  return completionResult(config, body, body?.choices?.[0]);
}

/**
 * SPEC 5.3 `toolChoice` in one wire format's own terms. Only called with a
 * validated choice, which always comes with tools.
 */
export function wireToolChoice(format, choice) {
  const name = typeof choice === "object" ? choice.name : null;
  if (format === "anthropic")
    return name
      ? { type: "tool", name }
      : { type: { auto: "auto", none: "none", required: "any" }[choice] };
  if (format === "gemini")
    return {
      functionCallingConfig: name
        ? { mode: "ANY", allowedFunctionNames: [name] }
        : { mode: { auto: "AUTO", none: "NONE", required: "ANY" }[choice] },
    };
  if (format === "responses") return name ? { type: "function", name } : choice;
  return name ? { type: "function", function: { name } } : choice;
}

function appendRoleMessage(messages, role, content) {
  const previous = messages.at(-1);
  if (previous?.role === role) previous.content.push(...content);
  else messages.push({ role, content });
}

function anthropicInput(messages) {
  const system = [];
  const result = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) system.push({ type: "text", text: message.content });
      continue;
    }
    if (message.role === "tool") {
      appendRoleMessage(result, "user", [
        {
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: message.content,
        },
      ]);
      continue;
    }
    const content = Array.isArray(message.content)
      ? message.content.map((part) =>
          part.type === "text"
            ? { type: "text", text: part.text }
            : {
                type: "image",
                source: {
                  type: "base64",
                  media_type: part.mediaType,
                  data: part.data,
                },
              },
        )
      : message.content
        ? [{ type: "text", text: message.content }]
        : [];
    for (const call of message.tool_calls ?? [])
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: JSON.parse(call.function.arguments),
      });
    // With thinking on, Anthropic refuses a tool continuation whose assistant
    // message does not start with the signed thinking it issued, unmodified.
    if (message.state?.format === "anthropic")
      content.unshift(...message.state.blocks);
    appendRoleMessage(
      result,
      message.role === "assistant" ? "assistant" : "user",
      content,
    );
  }
  return { system, messages: result };
}

function anthropicUsage(usage = {}) {
  const promptTokens = count(usage.input_tokens);
  const completionTokens = count(usage.output_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cachedTokens:
      count(usage.cache_read_input_tokens) +
      count(usage.cache_creation_input_tokens),
    reasoningTokens: 0,
  };
}

function anthropicResult(config, body) {
  if (!Array.isArray(body?.content))
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider response did not contain a message.",
    );
  let content = "";
  let reasoning = "";
  const wireCalls = [];
  // Thinking blocks are kept whole for the continuation, all or none: one
  // that lost its signature, or was cut at the state bound, cannot go back.
  const thinking = [];
  let replayable = true;
  for (const part of body.content) {
    if (part?.type === "text" && typeof part.text === "string")
      content += part.text;
    if (part?.type === "thinking" && typeof part.thinking === "string")
      reasoning += part.thinking;
    if (part?.type === "thinking")
      if (
        typeof part.thinking === "string" &&
        part.thinking.length <= LIMITS.providerStateBytes &&
        typeof part.signature === "string" &&
        part.signature
      )
        thinking.push({
          type: "thinking",
          thinking: part.thinking,
          signature: part.signature,
        });
      else replayable = false;
    if (part?.type === "redacted_thinking")
      if (typeof part.data === "string" && part.data)
        thinking.push({ type: "redacted_thinking", data: part.data });
      else replayable = false;
    // Malformed parts are passed through rather than skipped: a call the
    // parser drops silently leaves the model waiting on a result that never
    // comes, where a repaired one is answered with the reason it failed.
    if (part?.type === "tool_use")
      wireCalls.push({
        id: part.id,
        type: "function",
        function: {
          name: part.name,
          arguments:
            typeof part.arguments === "string"
              ? part.arguments
              : JSON.stringify(part.input ?? {}),
        },
      });
  }
  const { calls: validated, rejected, dropped } = repairToolCalls(wireCalls);
  content = content.slice(0, 120000);
  reasoning = reasoning.slice(0, LIMITS.reasoningChars);
  return {
    id:
      typeof body.id === "string" ? body.id.slice(0, 200) : crypto.randomUUID(),
    model: modelId(config),
    message: {
      role: "assistant",
      content,
      toolCalls: validated.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      attachments: [],
      reasoning: reasoning || null,
    },
    finishReason:
      typeof body.stop_reason === "string"
        ? body.stop_reason.slice(0, 80)
        : wireCalls.length
          ? "tool_use"
          : "end_turn",
    usage: anthropicUsage(body.usage),
    contextWindow: config.contextWindow ?? null,
    thread: false,
    rawMessage: {
      role: "assistant",
      content,
      tool_calls: validated,
      state: continuationState(
        "anthropic",
        replayable && thinking.length ? { blocks: thinking } : null,
        validated,
      ),
    },
    rejectedToolCalls: rejected,
    droppedToolCalls: dropped,
  };
}

async function streamedAnthropic(config, response, onItem) {
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    return anthropicResult(
      config,
      await readJson(response, LIMITS.providerResponseBytes, "PROVIDER_ERROR"),
    );
  let id = null;
  let stopReason = null;
  let usage = {};
  let sawPayload = false;
  const blocks = new Map();
  const notify = (item) => {
    try {
      onItem(item);
    } catch {
      /* UI callbacks never break provider generation. */
    }
  };
  for await (const data of providerEvents(response)) {
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new BrokerError(
        "PROVIDER_ERROR",
        "The provider returned an invalid event stream.",
      );
    }
    if (event?.type === "error") throw streamFailure(event.error);
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    sawPayload = true;
    if (event.type === "message_start") {
      if (typeof event.message?.id === "string") id = event.message.id;
      if (event.message?.usage) usage = event.message.usage;
    }
    if (event.type === "content_block_start" && event.content_block)
      blocks.set(event.index, { ...event.content_block });
    if (event.type === "content_block_delta") {
      const block = blocks.get(event.index) ?? { type: "text", text: "" };
      if (event.delta?.type === "text_delta") {
        if (typeof event.delta.text !== "string")
          throw new BrokerError(
            "PROVIDER_ERROR",
            "The provider returned invalid streamed content.",
          );
        block.text = `${block.text ?? ""}${event.delta.text}`.slice(0, 120000);
        if (event.delta.text)
          notify({ type: "output_delta", text: event.delta.text });
      } else if (event.delta?.type === "thinking_delta") {
        if (typeof event.delta.thinking !== "string")
          throw new BrokerError(
            "PROVIDER_ERROR",
            "The provider returned invalid streamed reasoning.",
          );
        // Kept whole up to the state bound rather than cut at the summary
        // bound: the block goes back to Anthropic byte-for-byte or not at all,
        // and `anthropicResult` shortens the summary the page sees.
        block.thinking = appendCapped(
          block.thinking ?? "",
          event.delta.thinking,
          LIMITS.providerStateBytes + 1,
        );
        if (event.delta.thinking)
          notify({ type: "reasoning_delta", text: event.delta.thinking });
      } else if (event.delta?.type === "signature_delta") {
        if (typeof event.delta.signature !== "string")
          throw new BrokerError(
            "PROVIDER_ERROR",
            "The provider returned invalid streamed reasoning.",
          );
        block.signature = appendCapped(
          block.signature ?? "",
          event.delta.signature,
          LIMITS.providerStateBytes + 1,
        );
      } else if (event.delta?.type === "input_json_delta") {
        if (typeof event.delta.partial_json !== "string")
          throw new BrokerError(
            "PROVIDER_ERROR",
            "The provider returned invalid streamed tool calls.",
          );
        block._json = appendCapped(block._json ?? "", event.delta.partial_json);
      }
      blocks.set(event.index, block);
    }
    if (event.type === "message_delta") {
      if (typeof event.delta?.stop_reason === "string")
        stopReason = event.delta.stop_reason;
      if (event.usage) usage = { ...usage, ...event.usage };
    }
  }
  if (!sawPayload)
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider stream ended without a response.",
    );
  const content = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => {
      if (block.type !== "tool_use") return block;
      const { _json: json, ...rest } = block;
      if (!json) return { ...rest, input: rest.input ?? {} };
      // Arguments that do not parse, including ones cut at the size cap, go
      // on as the text that arrived. Parsing them to `{}` would run the tool
      // with no arguments instead of telling the model what went wrong.
      try {
        return { ...rest, input: JSON.parse(json) };
      } catch {
        return { ...rest, input: undefined, arguments: json };
      }
    });
  return anthropicResult(config, {
    id,
    content,
    stop_reason: stopReason,
    usage,
  });
}

async function anthropicGenerate(config, valid, signal, options) {
  const converted = anthropicInput(valid.messages);
  const payload = {
    model: config.model,
    messages: converted.messages,
    max_tokens: valid.maxTokens ?? 8192,
    stream: Boolean(options.progress?.onItem),
  };
  if (converted.system.length) payload.system = converted.system;
  if (valid.temperature != null) payload.temperature = valid.temperature;
  if (valid.reasoning && config.capabilities?.reasoning) {
    payload.thinking = { type: "adaptive" };
    payload.output_config = {
      effort: valid.reasoning === "none" ? "low" : valid.reasoning,
    };
  }
  if (valid.tools.length)
    payload.tools = valid.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  if (valid.toolChoice) {
    payload.tool_choice = wireToolChoice("anthropic", valid.toolChoice);
    // Anthropic refuses extended thinking with a forced tool. The effort is
    // clamped to what the request allows (SPEC 5.3), the tool choice is not.
    if (["any", "tool"].includes(payload.tool_choice.type))
      delete payload.thinking;
  }
  cloneJson(payload, "Provider request", LIMITS.requestBytes);
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      ...(payload.stream ? { Accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify(payload),
  };
  // The catch is not decoration: `providerResponse` returns once the headers
  // are in, so anything the body read throws — an abort while the stream is
  // open above all — lands here rather than inside its own wrapper, and would
  // otherwise reach the page as a bare INTERNAL_ERROR.
  if (payload.stream)
    try {
      return await streamedAnthropic(
        config,
        await providerResponse(config, "/messages", init, signal, null),
        options.progress.onItem,
      );
    } catch (error) {
      throw networkError(error, "PROVIDER_ERROR", "Provider");
    }
  return anthropicResult(
    config,
    await providerRequest(config, "/messages", init, signal, null),
  );
}

function geminiInput(messages) {
  const system = [];
  const contents = [];
  const callNames = new Map();
  for (const message of messages)
    for (const call of message.tool_calls ?? [])
      callNames.set(call.id, call.function.name);
  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) system.push({ text: message.content });
      continue;
    }
    let role = message.role === "assistant" ? "model" : "user";
    let parts;
    if (message.role === "tool")
      parts = [
        {
          functionResponse: {
            name: callNames.get(message.tool_call_id) ?? "tool",
            response: { result: message.content },
          },
        },
      ];
    else {
      parts = Array.isArray(message.content)
        ? message.content.map((part) =>
            part.type === "text"
              ? { text: part.text }
              : {
                  inlineData: { mimeType: part.mediaType, data: part.data },
                },
          )
        : message.content
          ? [{ text: message.content }]
          : [];
      // Gemini 3 validates the signature of every function call since the
      // last user turn. The one the extension kept wins over a caller's own.
      const kept =
        message.state?.format === "gemini" ? message.state.signatures : [];
      for (const [index, call] of (message.tool_calls ?? []).entries()) {
        const signature = kept[index] ?? call.thoughtSignature;
        parts.push({
          ...(signature ? { thoughtSignature: signature } : {}),
          functionCall: {
            id: call.id,
            name: call.function.name,
            args: JSON.parse(call.function.arguments),
          },
        });
      }
    }
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return { system, contents };
}

function geminiUsage(usage = {}) {
  return {
    promptTokens: count(usage.promptTokenCount),
    completionTokens: count(usage.candidatesTokenCount),
    totalTokens: count(usage.totalTokenCount),
    cachedTokens: count(usage.cachedContentTokenCount),
    reasoningTokens: count(usage.thoughtsTokenCount),
  };
}

function geminiResult(config, body) {
  const candidate = Array.isArray(body?.candidates) ? body.candidates[0] : null;
  if (!Array.isArray(candidate?.content?.parts))
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider response did not contain a message.",
    );
  let content = "";
  let reasoning = "";
  const wireCalls = [];
  candidate.content.parts.forEach((part, index) => {
    if (typeof part?.text === "string") {
      if (part.thought === true) reasoning += part.text;
      else content += part.text;
    }
    if (part?.functionCall)
      wireCalls.push({
        id: (typeof part.functionCall.id === "string" && part.functionCall.id
          ? part.functionCall.id
          : `gemini-${index}-${part.functionCall.name}`
        ).slice(0, 128),
        type: "function",
        function: {
          name: part.functionCall.name,
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
        // Gemini 3 refuses a continuation whose function call came back without
        // the signature it issued, so it is carried rather than dropped.
        ...(typeof part.thoughtSignature === "string"
          ? { thoughtSignature: part.thoughtSignature }
          : {}),
      });
  });
  const { calls: validated, rejected, dropped } = repairToolCalls(wireCalls);
  content = content.slice(0, 120000);
  reasoning = reasoning.slice(0, LIMITS.reasoningChars);
  return {
    id: crypto.randomUUID(),
    model: modelId(config),
    message: {
      role: "assistant",
      content,
      toolCalls: validated.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      attachments: [],
      reasoning: reasoning || null,
    },
    finishReason:
      typeof candidate.finishReason === "string"
        ? candidate.finishReason.slice(0, 80)
        : wireCalls.length
          ? "tool_calls"
          : "STOP",
    usage: geminiUsage(body.usageMetadata),
    contextWindow: config.contextWindow ?? null,
    thread: false,
    rawMessage: {
      role: "assistant",
      content,
      tool_calls: validated,
      // Per call, in order, as issued: only the first of parallel calls
      // carries one, and a long one survives that `signatureChars` would drop.
      state: continuationState(
        "gemini",
        wireCalls.some((call) => call.thoughtSignature)
          ? {
              signatures: validated.map(
                (_call, index) => wireCalls[index]?.thoughtSignature || null,
              ),
            }
          : null,
        validated,
      ),
    },
    rejectedToolCalls: rejected,
    droppedToolCalls: dropped,
  };
}

async function streamedGemini(config, response, onItem) {
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    return geminiResult(
      config,
      await readJson(response, LIMITS.providerResponseBytes, "PROVIDER_ERROR"),
    );
  // Text is folded as it arrives; only function-call parts are kept whole,
  // since their args and thought signatures go back to Gemini unchanged.
  let content = "";
  let reasoning = "";
  const calls = [];
  let finishReason = null;
  let usageMetadata = {};
  let sawPayload = false;
  for await (const data of providerEvents(response)) {
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new BrokerError(
        "PROVIDER_ERROR",
        "The provider returned an invalid event stream.",
      );
    }
    if (event?.error) throw streamFailure(event.error);
    const candidate = event?.candidates?.[0];
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    sawPayload = true;
    if (typeof candidate?.finishReason === "string")
      finishReason = candidate.finishReason;
    if (event.usageMetadata) usageMetadata = event.usageMetadata;
    for (const part of candidate?.content?.parts ?? []) {
      if (part?.functionCall) {
        if (calls.length <= LIMITS.toolCalls) calls.push(part);
        continue;
      }
      if (typeof part?.text !== "string" || !part.text) continue;
      const thought = part.thought === true;
      const room = thought
        ? LIMITS.reasoningChars - reasoning.length
        : 120000 - content.length;
      const text = part.text.slice(0, Math.max(0, room));
      if (!text) continue;
      if (thought) reasoning += text;
      else content += text;
      try {
        onItem({ type: thought ? "reasoning_delta" : "output_delta", text });
      } catch {
        /* UI callbacks never break provider generation. */
      }
    }
  }
  if (!sawPayload)
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider stream ended without a response.",
    );
  const parts = [
    ...(reasoning ? [{ text: reasoning, thought: true }] : []),
    ...(content ? [{ text: content }] : []),
    ...calls,
  ];
  return geminiResult(config, {
    candidates: [
      { content: { role: "model", parts }, finishReason: finishReason },
    ],
    usageMetadata,
  });
}

async function geminiGenerate(config, valid, signal, options) {
  const converted = geminiInput(valid.messages);
  const payload = { contents: converted.contents };
  if (converted.system.length)
    payload.systemInstruction = { parts: converted.system };
  const generationConfig = {};
  if (valid.maxTokens != null)
    generationConfig.maxOutputTokens = valid.maxTokens;
  if (valid.temperature != null)
    generationConfig.temperature = valid.temperature;
  if (valid.reasoning && config.capabilities?.reasoning)
    generationConfig.thinkingConfig = {
      thinkingLevel:
        { minimal: "LOW", low: "LOW", medium: "MEDIUM" }[valid.reasoning] ??
        "HIGH",
      includeThoughts: true,
    };
  if (Object.keys(generationConfig).length)
    payload.generationConfig = generationConfig;
  if (valid.tools.length)
    payload.tools = [
      {
        functionDeclarations: valid.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      },
    ];
  if (valid.toolChoice)
    payload.toolConfig = wireToolChoice("gemini", valid.toolChoice);
  cloneJson(payload, "Provider request", LIMITS.requestBytes);
  const stream = Boolean(options.progress?.onItem);
  const path = `/models/${encodeURIComponent(config.model)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(stream ? { Accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify(payload),
  };
  if (stream)
    try {
      return await streamedGemini(
        config,
        await providerResponse(config, path, init, signal, null),
        options.progress.onItem,
      );
    } catch (error) {
      throw networkError(error, "PROVIDER_ERROR", "Provider");
    }
  return geminiResult(
    config,
    await providerRequest(config, path, init, signal, null),
  );
}

/** Public messages → Responses API input items, preserving tool continuations. */
function responsesInput(messages) {
  const input = [];
  for (const message of messages) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content,
      });
      continue;
    }
    const role = message.role === "system" ? "developer" : message.role;
    const content = Array.isArray(message.content)
      ? message.content.map((part) =>
          part.type === "text"
            ? {
                type: role === "assistant" ? "output_text" : "input_text",
                text: part.text,
              }
            : {
                type: "input_image",
                image_url: `data:${part.mediaType};base64,${part.data}`,
              },
        )
      : [
          {
            type: role === "assistant" ? "output_text" : "input_text",
            text: message.content,
          },
        ];
    const text = content.some((part) => part.text || part.image_url)
      ? { role, content }
      : null;
    const calls = (message.tool_calls ?? []).map((call) => ({
      type: "function_call",
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    }));
    if (message.state?.format === "responses")
      input.push(...replayedResponse(message.state.steps, text, calls));
    else input.push(...(text ? [text] : []), ...calls);
  }
  return input;
}

/**
 * One assistant message as the round that produced it was issued (SPEC 5.4):
 * its encrypted reasoning items verbatim and in place, since with `store:
 * false` the provider kept none of them, then the message's own text and
 * calls where the original message and calls sat, each call under the item
 * id it was issued with. Text the original had no message for goes before
 * the first call, and anything left over follows.
 */
function replayedResponse(steps, text, calls) {
  const items = [];
  let next = 0;
  let textSent = !text;
  for (const step of steps) {
    if (step.kind === "reasoning") items.push(step.item);
    if (step.kind === "message" && !textSent) {
      items.push(text);
      textSent = true;
    }
    if (step.kind === "call" && next < calls.length) {
      if (!textSent) {
        items.push(text);
        textSent = true;
      }
      items.push({ ...(step.id ? { id: step.id } : {}), ...calls[next++] });
    }
  }
  if (!textSent) items.push(text);
  items.push(...calls.slice(next));
  return items;
}

function responsesUsage(usage = {}) {
  const promptTokens = count(usage.input_tokens);
  const completionTokens = count(usage.output_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: count(usage.total_tokens) || promptTokens + completionTokens,
    cachedTokens: count(usage.input_tokens_details?.cached_tokens),
    reasoningTokens: count(usage.output_tokens_details?.reasoning_tokens),
  };
}

function responsesResult(config, body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider response did not contain a message.",
    );
  let content = "";
  const wireCalls = [];
  // What a continuation replays, in output order: reasoning that came back
  // encrypted (without it, `store: false` leaves nothing to refer to), and
  // where the message and each call sat.
  const steps = [];
  for (const item of Array.isArray(body.output) ? body.output : []) {
    if (item?.type === "message") {
      steps.push({ kind: "message" });
      for (const part of Array.isArray(item.content) ? item.content : [])
        if (part?.type === "output_text" && typeof part.text === "string")
          content += part.text;
    }
    if (item?.type === "function_call") {
      steps.push({
        kind: "call",
        ...(typeof item.id === "string" && item.id && item.id.length <= 200
          ? { id: item.id }
          : {}),
      });
      wireCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      });
    }
    if (
      item?.type === "reasoning" &&
      typeof item.encrypted_content === "string" &&
      item.encrypted_content
    )
      steps.push({ kind: "reasoning", item });
  }
  content = content.slice(0, 120000);
  const { calls: validated, rejected, dropped } = repairToolCalls(wireCalls);
  return {
    id:
      typeof body.id === "string" ? body.id.slice(0, 200) : crypto.randomUUID(),
    model: modelId(config),
    message: {
      role: "assistant",
      content,
      toolCalls: validated.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      attachments: [],
      reasoning: null,
    },
    finishReason:
      wireCalls.length > 0
        ? "tool_calls"
        : typeof body.status === "string"
          ? body.status.slice(0, 80)
          : "stop",
    usage: responsesUsage(body.usage),
    contextWindow: config.contextWindow ?? null,
    thread: false,
    rawMessage: {
      role: "assistant",
      content,
      tool_calls: validated,
      state: continuationState(
        "responses",
        steps.some((step) => step.kind === "reasoning") ? { steps } : null,
        validated,
      ),
    },
    rejectedToolCalls: rejected,
    droppedToolCalls: dropped,
  };
}

async function streamedResponses(config, response, onItem) {
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    return responsesResult(
      config,
      await readJson(response, LIMITS.providerResponseBytes, "PROVIDER_ERROR"),
    );
  let id = null;
  let content = "";
  let reasoning = "";
  let usage = {};
  let status = "completed";
  let sawPayload = false;
  const calls = new Map();
  const reasoningItems = new Map();
  let reasoningBytes = 0;
  let messageIndex = null;
  const notify = (item) => {
    try {
      onItem(item);
    } catch {
      /* UI callbacks never break provider generation. */
    }
  };
  for await (const data of providerEvents(response)) {
    if (data === "[DONE]") break;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      throw new BrokerError(
        "PROVIDER_ERROR",
        "The provider returned an invalid event stream.",
      );
    }
    if (!event || typeof event !== "object" || Array.isArray(event))
      throw new BrokerError(
        "PROVIDER_ERROR",
        "The provider returned an invalid event stream.",
      );
    // A Responses `error` event carries its code and message at the top
    // level; `response.failed` carries them in the response object.
    if (event.type === "error") throw streamFailure(event.error ?? event);
    if (event.type === "response.failed")
      throw streamFailure(event.response?.error);
    sawPayload = true;
    const response_ = event.response;
    if (typeof response_?.id === "string") id = response_.id.slice(0, 200);
    if (response_?.usage && typeof response_.usage === "object")
      usage = response_.usage;
    if (typeof response_?.status === "string") status = response_.status;
    if (event.type === "response.output_text.delta") {
      if (typeof event.delta !== "string")
        throw new BrokerError(
          "PROVIDER_ERROR",
          "The provider returned invalid streamed content.",
        );
      const text = event.delta.slice(0, Math.max(0, 120000 - content.length));
      content += text;
      if (text) notify({ type: "output_delta", text });
    }
    if (event.type === "response.reasoning_summary_text.delta") {
      if (typeof event.delta !== "string")
        throw new BrokerError(
          "PROVIDER_ERROR",
          "The provider returned invalid streamed reasoning.",
        );
      const text = event.delta.slice(
        0,
        Math.max(0, LIMITS.reasoningChars - reasoning.length),
      );
      reasoning += text;
      if (text) notify({ type: "reasoning_delta", text });
    }
    if (
      event.type === "response.output_item.added" &&
      event.item?.type === "function_call"
    )
      calls.set(event.output_index, {
        id: String(event.item.call_id ?? ""),
        itemId: event.item.id,
        type: "function",
        function: {
          name: String(event.item.name ?? ""),
          arguments: String(event.item.arguments ?? ""),
        },
      });
    if (
      event.type === "response.output_item.added" &&
      event.item?.type === "message" &&
      messageIndex == null
    )
      messageIndex = event.output_index;
    // A finished reasoning item arrives whole, encrypted content included
    // when it was asked for; kept up to the state bound for the continuation.
    if (
      event.type === "response.output_item.done" &&
      event.item?.type === "reasoning" &&
      Number.isInteger(event.output_index)
    ) {
      reasoningBytes += data.length;
      if (reasoningBytes <= LIMITS.providerStateBytes)
        reasoningItems.set(event.output_index, event.item);
    }
    if (event.type === "response.function_call_arguments.delta") {
      const call = calls.get(event.output_index);
      if (!call || typeof event.delta !== "string")
        throw new BrokerError(
          "PROVIDER_ERROR",
          "The provider returned invalid streamed tool calls.",
        );
      call.function.arguments = appendCapped(
        call.function.arguments,
        event.delta,
      );
    }
    if (
      event.type === "response.output_item.done" &&
      event.item?.type === "function_call"
    )
      calls.set(event.output_index, {
        id: String(event.item.call_id ?? ""),
        itemId: event.item.id,
        type: "function",
        function: {
          name: String(event.item.name ?? ""),
          arguments: String(event.item.arguments ?? ""),
        },
      });
  }
  if (!sawPayload)
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider stream ended without a response.",
    );
  // Rebuilt in output order, so a continuation can replay it in that order.
  // The text was folded into one message as it arrived and sits where the
  // first message item did, or first when the stream announced none.
  const positioned = new Map(reasoningItems);
  for (const [index, call] of calls)
    positioned.set(index, {
      type: "function_call",
      ...(typeof call.itemId === "string" ? { id: call.itemId } : {}),
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  const output = [...positioned.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, item]) => item);
  if (content) {
    const message = {
      type: "message",
      content: [{ type: "output_text", text: content }],
    };
    const at =
      messageIndex == null
        ? 0
        : [...positioned.keys()].filter((index) => index < messageIndex).length;
    output.splice(at, 0, message);
  }
  const result = responsesResult(config, { id, output, usage, status });
  if (reasoning) result.message.reasoning = reasoning;
  return result;
}

async function responsesGenerate(config, valid, signal, options) {
  const payload = {
    model: config.model,
    input: responsesInput(valid.messages),
    stream: Boolean(options.progress?.onItem),
    store: false,
  };
  if (valid.maxTokens != null) payload.max_output_tokens = valid.maxTokens;
  // Every model Zen routes through Responses is a reasoning model, and those
  // reject `temperature` outright. Dropping it keeps the request valid, which
  // section 5.3 prefers over failing a turn a site cannot know to avoid.
  if (valid.reasoning && config.capabilities?.reasoning)
    payload.reasoning = {
      effort: ["xhigh", "max"].includes(valid.reasoning)
        ? "high"
        : valid.reasoning,
      summary: "auto",
    };
  if (valid.tools.length)
    payload.tools = valid.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: false,
    }));
  if (valid.toolChoice)
    payload.tool_choice = wireToolChoice("responses", valid.toolChoice);
  // With `store: false` the provider keeps none of the reasoning a model did
  // before calling a tool, so it is asked for encrypted, to be sent back with
  // the continuation (SPEC 5.4). Only a round with tools can have one.
  if (valid.tools.length && config.capabilities?.reasoning)
    payload.include = ["reasoning.encrypted_content"];
  cloneJson(payload, "Provider request", LIMITS.requestBytes);
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(payload.stream ? { Accept: "text/event-stream" } : {}),
    },
    body: JSON.stringify(payload),
  };
  if (payload.stream)
    try {
      return await streamedResponses(
        config,
        await providerResponse(config, "/responses", init, signal, null),
        options.progress.onItem,
      );
    } catch (error) {
      throw networkError(error, "PROVIDER_ERROR", "Provider");
    }
  return responsesResult(
    config,
    await providerRequest(config, "/responses", init, signal, null),
  );
}

/**
 * Complete lines of a newline-delimited JSON stream (Ollama's native
 * `application/x-ndjson`). Like `providerEvents`, the stream has no total cap
 * and only one line, at most `providerEventBytes`, is held at a time.
 */
async function* providerLines(response) {
  let buffer = "";
  for await (const chunk of responseChunks(
    response,
    Infinity,
    "PROVIDER_ERROR",
  )) {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) yield line;
    }
    if (buffer.length > LIMITS.providerEventBytes)
      throw new BrokerError(
        "PROVIDER_ERROR",
        "A provider stream event was too large.",
      );
  }
  if (buffer.trim()) yield buffer.trim();
}

function toolArguments(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

/**
 * Public messages → Ollama `/api/chat` messages. Images travel beside the text
 * as bare base64 (a `data:` prefix is refused), tool arguments as objects, and
 * a tool result names the function it answers as well as the call id.
 */
function ollamaMessages(messages) {
  const names = new Map();
  for (const message of messages)
    for (const call of message.tool_calls ?? [])
      names.set(call.id, call.function.name);
  return messages.map((message) => {
    if (message.role === "tool")
      return {
        role: "tool",
        content: message.content,
        tool_call_id: message.tool_call_id,
        ...(names.has(message.tool_call_id)
          ? { tool_name: names.get(message.tool_call_id) }
          : {}),
      };
    if (Array.isArray(message.content)) {
      const images = message.content
        .filter((part) => part.type === "image")
        .map((part) => part.data);
      return {
        role: message.role,
        content: message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
        ...(images.length ? { images } : {}),
      };
    }
    const wire = { role: message.role, content: message.content ?? "" };
    if (message.tool_calls?.length)
      wire.tool_calls = message.tool_calls.map((call, index) => ({
        id: call.id,
        function: {
          index,
          name: call.function.name,
          arguments: toolArguments(call.function.arguments),
        },
      }));
    return wire;
  });
}

/** Ollama tool calls carry argument objects; the broker's wire form is a string. */
function ollamaWireCall(call) {
  if (!call || typeof call !== "object" || Array.isArray(call)) return call;
  const fn = call.function;
  if (!fn || typeof fn !== "object" || Array.isArray(fn)) return call;
  const args = fn.arguments;
  return {
    id: typeof call.id === "string" ? call.id : "",
    type: "function",
    function: {
      name: fn.name,
      arguments:
        typeof args === "string"
          ? args.slice(0, LIMITS.toolArgumentUnits + 1)
          : JSON.stringify(args ?? {}).slice(0, LIMITS.toolArgumentUnits + 1),
    },
  };
}

function ollamaResult(config, body) {
  const message = body?.message;
  if (!message || typeof message !== "object" || Array.isArray(message))
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider response did not contain a message.",
    );
  if (message.content != null && typeof message.content !== "string")
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider returned invalid message content.",
    );
  if (message.thinking != null && typeof message.thinking !== "string")
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider returned invalid reasoning.",
    );
  const wireCalls = (
    Array.isArray(message.tool_calls) ? message.tool_calls : []
  ).map(ollamaWireCall);
  const { calls, rejected, dropped } = repairToolCalls(wireCalls);
  const content = (message.content ?? "").slice(0, 120000);
  const reasoning = (message.thinking ?? "").slice(0, LIMITS.reasoningChars);
  const promptTokens = count(body.prompt_eval_count);
  const completionTokens = count(body.eval_count);
  return {
    id: crypto.randomUUID(),
    model: modelId(config),
    message: {
      role: "assistant",
      content,
      toolCalls: calls.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
      attachments: [],
      reasoning: reasoning.trim() ? reasoning : null,
    },
    // Ollama reports `stop` even when the round ended in tool calls.
    finishReason: wireCalls.length
      ? "tool_calls"
      : typeof body.done_reason === "string" && body.done_reason
        ? body.done_reason.slice(0, 80)
        : "stop",
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cachedTokens: 0,
      reasoningTokens: 0,
    },
    contextWindow: config.contextWindow ?? null,
    thread: false,
    rawMessage: { role: "assistant", content, tool_calls: calls },
    rejectedToolCalls: rejected,
    droppedToolCalls: dropped,
  };
}

async function streamedOllama(config, response, onItem) {
  const type = response.headers.get("content-type") ?? "";
  // A proxy that buffers the stream may hand back one ordinary JSON body.
  if (type.includes("application/json") && !type.includes("ndjson"))
    return ollamaResult(
      config,
      await readJson(response, LIMITS.providerResponseBytes, "PROVIDER_ERROR"),
    );
  let content = "";
  let reasoning = "";
  const calls = [];
  let final = null;
  const notify = (item) => {
    try {
      onItem(item);
    } catch {
      /* UI callbacks never break provider generation. */
    }
  };
  for await (const line of providerLines(response)) {
    let chunk;
    try {
      chunk = JSON.parse(line);
    } catch {
      throw new BrokerError(
        "PROVIDER_ERROR",
        "The provider returned an invalid event stream.",
      );
    }
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk))
      throw new BrokerError(
        "PROVIDER_ERROR",
        "The provider returned an invalid event stream.",
      );
    // A failure after the headers (out of memory while loading, a dropped
    // runner) arrives as its own line.
    if (chunk.error != null) {
      const refusal = ollamaRefusal(500, chunk.error, config);
      throw new BrokerError(
        refusal.code,
        refusal.generic
          ? "The provider reported an error while streaming."
          : refusal.message,
        refusal.details,
        { retryable: refusal.retryable },
      );
    }
    const delta = chunk.message;
    if (delta && typeof delta === "object" && !Array.isArray(delta)) {
      if (delta.content != null && typeof delta.content !== "string")
        throw new BrokerError(
          "PROVIDER_ERROR",
          "The provider returned invalid streamed content.",
        );
      if (delta.thinking != null && typeof delta.thinking !== "string")
        throw new BrokerError(
          "PROVIDER_ERROR",
          "The provider returned invalid streamed reasoning.",
        );
      if (delta.content) {
        const text = delta.content.slice(
          0,
          Math.max(0, 120000 - content.length),
        );
        content += text;
        if (text) notify({ type: "output_delta", text });
      }
      if (delta.thinking) {
        const text = delta.thinking.slice(
          0,
          Math.max(0, LIMITS.reasoningChars - reasoning.length),
        );
        reasoning += text;
        if (text) notify({ type: "reasoning_delta", text });
      }
      // Ollama emits each tool call whole, never as argument fragments. One
      // past the limit is kept so the repair can report the overflow.
      for (const call of Array.isArray(delta.tool_calls)
        ? delta.tool_calls
        : [])
        if (calls.length <= LIMITS.toolCalls) calls.push(call);
    }
    if (chunk.done === true) {
      final = chunk;
      break;
    }
  }
  // Every Ollama stream ends with a `done` line carrying the usage. A stream
  // that stops before it was cut off, and its partial answer is not one.
  if (!final)
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider stream ended without a response.",
    );
  return ollamaResult(config, {
    ...final,
    message: {
      role: "assistant",
      content,
      thinking: reasoning,
      tool_calls: calls,
    },
  });
}

// How a self-hosted server actually loaded a model: the context it gave it
// (`num_ctx` is the server's choice, OLLAMA_CONTEXT_LENGTH or its memory-based
// default, usually far below the trained maximum `/api/show` reports, and
// Ollama silently drops the start of a prompt that overflows it) and whether
// it sits in GPU memory, system memory, or both. Cached briefly: one round of
// a tool loop should not cost a second request.
const runtimeStates = new Map();
async function ollamaRuntime(config, signal) {
  if (config.cloud) return null;
  const key = `${config.baseUrl}\n${config.model}`;
  const cached = runtimeStates.get(key);
  if (cached && Date.now() - cached.at < 30_000) return cached.value;
  // Only the request may fail quietly: an unreachable `/api/ps` costs the
  // display, never the answer. Anything thrown past it is a bug to surface.
  const body = await providerRequest(
    config,
    "/api/ps",
    {},
    signal,
    3_000,
  ).catch(() => null);
  const loaded = (Array.isArray(body?.models) ? body.models : []).find(
    (item) => item?.name === config.model || item?.model === config.model,
  );
  const value = loaded
    ? {
        contextLength:
          Number.isSafeInteger(loaded.context_length) &&
          loaded.context_length > 0
            ? loaded.context_length
            : null,
        processor: ollamaProcessor(loaded.size, loaded.size_vram),
        // When Ollama will unload it (keep_alive), so the widget can stop
        // showing a placement that is no longer true without polling for it.
        until: Number.isFinite(Date.parse(loaded.expires_at))
          ? new Date(Date.parse(loaded.expires_at)).toISOString()
          : null,
      }
    : null;
  runtimeStates.set(key, { at: Date.now(), value });
  if (runtimeStates.size > 64)
    runtimeStates.delete(runtimeStates.keys().next().value);
  return value;
}

/**
 * How a self-hosted model is loaded right now, or null when it is not (or
 * the configuration is not a self-hosted Ollama). Broker UI only.
 */
export async function ollamaLoadedState(config, signal) {
  if (config?.kind !== "ollama" || config.cloud) return null;
  return ollamaRuntime(config, signal);
}

async function ollamaGenerate(config, valid, signal, options) {
  const payload = {
    model: config.model,
    messages: ollamaMessages(valid.messages),
    stream: Boolean(options.progress?.onItem),
  };
  const think = ollamaThink(config, valid.reasoning);
  if (think !== undefined) payload.think = think;
  const modelOptions = {};
  if (valid.temperature != null) modelOptions.temperature = valid.temperature;
  if (valid.maxTokens != null) modelOptions.num_predict = valid.maxTokens;
  if (Object.keys(modelOptions).length) payload.options = modelOptions;
  if (valid.tools.length)
    payload.tools = valid.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  cloneJson(payload, "Provider request", LIMITS.requestBytes);
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: payload.stream ? "application/x-ndjson" : "application/json",
    },
    body: JSON.stringify(payload),
  };
  let result;
  if (payload.stream)
    try {
      result = await streamedOllama(
        config,
        await providerResponse(config, "/api/chat", init, signal, null),
        options.progress.onItem,
      );
    } catch (error) {
      throw networkError(error, "PROVIDER_ERROR", "Provider");
    }
  else
    result = ollamaResult(
      config,
      await providerRequest(config, "/api/chat", init, signal, null),
    );
  const runtime = await ollamaRuntime(config, signal);
  if (runtime?.contextLength) result.contextWindow = runtime.contextLength;
  // Broker-private: where the model runs is a fact about the visitor's
  // machine, so `stripRaw` keeps it from every page-bound result.
  if (runtime?.processor)
    result.processor = { ...runtime.processor, until: runtime.until };
  return result;
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index], index);
      }
    }),
  );
  return results;
}

/**
 * The conversational models an Ollama server offers, with the capabilities it
 * reports for each, the models it lists but cannot run (`skipped`), and the
 * ones that are not chat models at all (`ignored`, such as embeddings).
 *
 * `/api/tags` lists names; `/api/show` is the authority on capabilities (a
 * tags entry can under-report vision or tools). A model the server refuses to
 * describe is one it cannot load either (a file this build cannot read answers
 * both with the same error), and one whose `requires` is newer than the server
 * cannot run: both are reported in `skipped` instead of being offered to fail
 * every turn. A model whose description simply did not arrive keeps its last
 * entry, or what the tags entry says, which may be nothing: such a model is
 * offered without tools or images rather than sent a request it would refuse.
 *
 * Every outcome is remembered against the model's digest and the server's
 * version (`ollamaCheckKey`), so a background refresh costs two small GETs
 * once nothing has changed. `force` re-reads everything, which is what an
 * explicit refresh from settings asks for.
 */
export async function listOllamaModels(
  config,
  previous = {},
  { signal, force = false } = {},
) {
  ensureCredentialed(config);
  const tags = await providerRequest(config, "/api/tags", {}, signal);
  if (!Array.isArray(tags?.models))
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider returned an invalid model list.",
    );
  const version = config.cloud
    ? null
    : await providerRequest(config, "/api/version", {}, signal).then(
        (body) =>
          typeof body?.version === "string" ? body.version.slice(0, 40) : null,
        () => null,
      );
  const checkedWith = ollamaCheckKey(config.cloud ? "cloud" : version);
  const earlier = Array.isArray(previous) ? { models: previous } : previous;
  const known = new Map();
  for (const [kind, list] of [
    ["model", earlier?.models],
    ["skipped", earlier?.skipped],
    ["ignored", earlier?.ignored],
  ])
    for (const item of Array.isArray(list) ? list : [])
      if (typeof item?.id === "string") known.set(item.id, { kind, item });
  const entries = tags.models
    .filter(
      (item) =>
        typeof item?.name === "string" && item.name && item.name.length <= 200,
    )
    .slice(0, 200);
  const results = await mapLimit(entries, 4, async (tag) => {
    const stamp = { digest: tag.digest ?? null, checkedWith };
    const cached = known.get(tag.name);
    if (
      !force &&
      cached?.item.digest &&
      cached.item.digest === tag.digest &&
      cached.item.checkedWith === checkedWith
    )
      return { [cached.kind]: cached.item };
    // A description that does not arrive falls back to the last usable entry.
    const fallback =
      cached?.kind === "model"
        ? cached.item
        : { ...ollamaModelInfo(tag, null, config), checkedWith: null };
    let show = null;
    try {
      show = await providerRequest(
        config,
        "/api/show",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: tag.name }),
        },
        signal,
      );
    } catch (error) {
      // A refused credential or Origin fails every model the same way, and
      // is the first sign of it: report it rather than offer a crippled list.
      if (
        signal?.aborted ||
        error?.code === "NOT_CONFIGURED" ||
        error?.message === OLLAMA_ORIGIN_REFUSAL
      )
        throw error;
      if (error?.ollama?.status)
        return {
          skipped: {
            id: tag.name,
            reason: ollamaSkipReason({ ...error.ollama, version }),
            ...stamp,
          },
        };
      // Not stamped: the next refresh asks again.
      return { model: fallback.id ? fallback : null };
    }
    if (typeof show?.error === "string")
      return {
        skipped: {
          id: tag.name,
          reason: ollamaSkipReason({
            kind: /retired/i.test(show.error) ? "retired" : null,
            status: 200,
            text: show.error,
            version,
          }),
          ...stamp,
        },
      };
    if (
      version &&
      typeof show?.requires === "string" &&
      !ollamaVersionAtLeast(version, show.requires)
    )
      return {
        skipped: {
          id: tag.name,
          reason: `It needs Ollama ${show.requires.slice(0, 20)} or newer; this server runs ${version}.`,
          ...stamp,
        },
      };
    const model = ollamaModelInfo(tag, show, config);
    return model
      ? { model: { ...model, checkedWith } }
      : { ignored: { id: tag.name, ...stamp } };
  });
  const byName = (a, b) =>
    ollamaDisplayName(a.id).localeCompare(ollamaDisplayName(b.id), "en", {
      numeric: true,
    });
  const pick = (kind) =>
    results
      .map((item) => item[kind])
      .filter(Boolean)
      .sort(byName);
  return {
    models: pick("model"),
    skipped: pick("skipped"),
    ignored: pick("ignored"),
    version,
  };
}

/** Public message → OpenAI Chat Completions wire message. */
function openaiMessage(message) {
  if (!Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map((part) =>
      part.type === "text"
        ? { type: "text", text: part.text }
        : {
            type: "image_url",
            image_url: { url: `data:${part.mediaType};base64,${part.data}` },
          },
    ),
  };
}

/**
 * OpenAI-compatible endpoints that generate images return them as
 * `message.images[].image_url.url` data URLs. Only validated image types pass.
 */
export function responseImages(message) {
  const list = Array.isArray(message?.images) ? message.images.slice(0, 4) : [];
  const attachments = [];
  for (const item of list) {
    const url = item?.image_url?.url ?? item?.url;
    const match =
      typeof url === "string" &&
      /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        url,
      );
    if (!match || !IMAGE_TYPES.includes(match[1])) continue;
    if (match[2].length > LIMITS.imageChars) continue;
    attachments.push({ type: "image", mediaType: match[1], data: match[2] });
  }
  return attachments;
}

/** Reasoning summaries some OpenAI-compatible providers attach to the message. */
export function responseReasoning(message) {
  const value = message?.reasoning_content ?? message?.reasoning;
  return typeof value === "string" && value.trim()
    ? value.slice(0, LIMITS.reasoningChars)
    : null;
}

/**
 * Listing a catalog needs only the credential: a model cannot be required to
 * discover which models exist. Generation still needs `ensureConfigured`.
 */
export function ensureCredentialed(config) {
  // A self-hosted Ollama is reached by address alone; a key is optional there.
  if (config?.kind === "ollama" && !config.cloud) {
    if (!config.baseUrl)
      throw new BrokerError(
        "NOT_CONFIGURED",
        "Enter the Ollama server address before loading the model catalog.",
      );
    return;
  }
  if (!config?.baseUrl || !config?.apiKey)
    throw new BrokerError(
      "NOT_CONFIGURED",
      "Enter an API key before loading the model catalog.",
    );
}

export function ensureConfigured(config) {
  if (config?.kind === "desktop") {
    if (!config.baseUrl || !config.token || !config.providerId || !config.model)
      throw new BrokerError(
        "NOT_CONFIGURED",
        "The selected desktop provider is not available. Check the desktop app in extension options.",
      );
    return;
  }
  if (config?.kind === "ollama") {
    ensureCredentialed(config);
    if (!config.model)
      throw new BrokerError(
        "NOT_CONFIGURED",
        "Choose an Ollama model in the extension options first.",
      );
    return;
  }
  if (!config?.baseUrl || !config?.model || !config?.apiKey)
    throw new BrokerError(
      "NOT_CONFIGURED",
      "Configure a provider in the extension options first.",
    );
}

export function providerLabel(config) {
  if (!config) return "No provider configured";
  if (config.kind === "desktop")
    return `${config.providerName ?? config.providerId} on this computer (${config.model})`;
  return `${config.providerName ?? "OpenAI API"} (${config.model})`;
}

export function publicModel(config, isDefault = true) {
  return {
    id: modelId(config),
    provider: config.providerId ?? "openai",
    displayName: config.displayName ?? config.model,
    default: isDefault,
    capabilities: {
      ...(config.capabilities ?? { tools: true, vision: false }),
    },
  };
}
