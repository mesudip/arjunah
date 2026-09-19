import { BrokerError } from "./errors.js";
import { LIMITS } from "./constants.js";
import {
  validateGenerateRequest,
  validateToolCalls,
  cloneJson,
  hasImages,
} from "./validation.js";
import { IMAGE_TYPES } from "./constants.js";
import {
  readJson,
  responseChunks,
  requestSignal,
  networkError,
} from "./network.js";
import { desktopGenerate, modelId } from "./desktop.js";

function endpoint(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}
function providerHeaders(config) {
  return { Authorization: `Bearer ${config.apiKey}` };
}

async function providerResponse(config, path, init, signal) {
  try {
    const response = await fetch(endpoint(config.baseUrl, path), {
      ...init,
      headers: { ...providerHeaders(config), ...init.headers },
      signal: requestSignal(signal),
      redirect: "error",
      credentials: "omit",
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new BrokerError(
        "PROVIDER_ERROR",
        `The provider rejected the request (${response.status}).`,
      );
    }
    return response;
  } catch (error) {
    throw networkError(error, "PROVIDER_ERROR", "Provider");
  }
}

async function providerRequest(config, path, init, signal) {
  try {
    return await readJson(
      await providerResponse(config, path, init, signal),
      LIMITS.providerResponseBytes,
      "PROVIDER_ERROR",
    );
  } catch (error) {
    throw networkError(error, "PROVIDER_ERROR", "Provider");
  }
}

/** Complete `data:` payloads from a bounded server-sent event stream. */
async function* providerEvents(response) {
  let buffer = "";
  let data = [];
  for await (const chunk of responseChunks(
    response,
    LIMITS.providerResponseBytes,
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
      } else if (line.startsWith("data:"))
        data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  // Some OpenAI-compatible local servers omit the final blank line.
  if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
  if (data.length) yield data.join("\n");
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
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
  let wireCalls;
  try {
    wireCalls = validateToolCalls(choice.message.tool_calls ?? []);
  } catch {
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider returned invalid tool calls.",
    );
  }
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
    if (chunk.error)
      throw new BrokerError(
        "PROVIDER_ERROR",
        "The provider reported an error while streaming.",
      );
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
        call.function.name += part.function.name;
      if (typeof part.function?.arguments === "string")
        call.function.arguments += part.function.arguments;
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
  ensureConfigured(config);
  const body = await providerRequest(config, "/models", {}, signal);
  if (!Array.isArray(body?.data))
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider returned an invalid model list.",
    );
  return body.data
    .filter((item) => typeof item?.id === "string" && item.id.length <= 200)
    .slice(0, 200)
    .map((item) => ({
      id: item.id,
      provider: "openai-compatible",
      displayName: item.id,
    }));
}

export async function generate(
  config,
  request,
  signal,
  internal = false,
  options = {},
) {
  ensureConfigured(config);
  // Validation owns the one conversion from public camelCase to provider wire fields.
  const valid = validateGenerateRequest(request, internal);
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
  // Desktop providers run the user's own subscription CLIs on this computer.
  if (config.kind === "desktop")
    return desktopGenerate(config, valid, signal, options);
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
        await providerResponse(config, "/chat/completions", init, signal),
        options.progress.onItem,
      );
    } catch (error) {
      throw networkError(error, "PROVIDER_ERROR", "Provider");
    }
  const body = await providerRequest(config, "/chat/completions", init, signal);
  return completionResult(config, body, body?.choices?.[0]);
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

export function ensureConfigured(config) {
  if (config?.kind === "desktop") {
    if (!config.baseUrl || !config.token || !config.providerId || !config.model)
      throw new BrokerError(
        "NOT_CONFIGURED",
        "The selected desktop provider is not available. Check the desktop app in extension options.",
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
  return `OpenAI API (${config.model})`;
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
