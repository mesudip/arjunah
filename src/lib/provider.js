import { BrokerError } from "./errors.js";
import { LIMITS } from "./constants.js";
import {
  validateGenerateRequest,
  validateToolCalls,
  repairToolCalls,
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
import { opencodeProtocol, opencodeUnusableReason } from "./opencode.js";

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
  if (config?.kind === "opencode" && config.protocol === "anthropic")
    return { "x-api-key": config.apiKey };
  if (config?.kind === "opencode" && config.protocol === "gemini")
    return { "x-goog-api-key": config.apiKey };
  return { Authorization: `Bearer ${config.apiKey}` };
}

// A provider's own prose may quote the request back, so nothing from the body
// is ever shown. Only the short machine-readable error type is read, and only
// to select one of our own sentences.
const REFUSALS = Object.freeze({
  FreeTierError:
    "OpenCode's free tier can only be used from inside the OpenCode app, not through an API key. Choose a model without the free suffix.",
});

/** The provider's `error.type`, when it is a short identifier we recognize. */
async function refusalKind(response) {
  try {
    const body = await readJson(
      response,
      LIMITS.providerResponseBytes,
      "PROVIDER_ERROR",
    );
    const type = body?.error?.type;
    return typeof type === "string" && /^[A-Za-z_]{1,64}$/.test(type)
      ? type
      : null;
  } catch {
    return null;
  }
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
      const kind = await refusalKind(response);
      throw new BrokerError(
        "PROVIDER_ERROR",
        REFUSALS[kind] ??
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
  for (const part of body.content) {
    if (part?.type === "text" && typeof part.text === "string")
      content += part.text;
    if (part?.type === "thinking" && typeof part.thinking === "string")
      reasoning += part.thinking;
    // Malformed parts are passed through rather than skipped: a call the
    // parser drops silently leaves the model waiting on a result that never
    // comes, where a repaired one is answered with the reason it failed.
    if (part?.type === "tool_use")
      wireCalls.push({
        id: part.id,
        type: "function",
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input ?? {}),
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
    rawMessage: { role: "assistant", content, tool_calls: validated },
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
    if (event?.type === "error")
      throw new BrokerError(
        "PROVIDER_ERROR",
        "The provider reported an error while streaming.",
      );
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
        block.thinking = `${block.thinking ?? ""}${event.delta.thinking}`.slice(
          0,
          LIMITS.reasoningChars,
        );
        if (event.delta.thinking)
          notify({ type: "reasoning_delta", text: event.delta.thinking });
      } else if (event.delta?.type === "input_json_delta") {
        if (typeof event.delta.partial_json !== "string")
          throw new BrokerError(
            "PROVIDER_ERROR",
            "The provider returned invalid streamed tool calls.",
          );
        block._json = `${block._json ?? ""}${event.delta.partial_json}`;
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
      let input = block.input ?? {};
      if (block._json)
        try {
          input = JSON.parse(block._json);
        } catch {
          input = null;
        }
      return { ...block, input };
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
  if (payload.stream)
    return streamedAnthropic(
      config,
      await providerResponse(config, "/messages", init, signal),
      options.progress.onItem,
    );
  return anthropicResult(
    config,
    await providerRequest(config, "/messages", init, signal),
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
      for (const call of message.tool_calls ?? [])
        parts.push({
          ...(call.thoughtSignature
            ? { thoughtSignature: call.thoughtSignature }
            : {}),
          functionCall: {
            id: call.id,
            name: call.function.name,
            args: JSON.parse(call.function.arguments),
          },
        });
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
    rawMessage: { role: "assistant", content, tool_calls: validated },
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
  const parts = [];
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
    if (event?.error)
      throw new BrokerError(
        "PROVIDER_ERROR",
        "The provider reported an error while streaming.",
      );
    const candidate = event?.candidates?.[0];
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    sawPayload = true;
    if (typeof candidate?.finishReason === "string")
      finishReason = candidate.finishReason;
    if (event.usageMetadata) usageMetadata = event.usageMetadata;
    for (const part of candidate?.content?.parts ?? []) {
      parts.push(part);
      if (typeof part.text === "string" && part.text) {
        try {
          onItem({
            type: part.thought === true ? "reasoning_delta" : "output_delta",
            text: part.text,
          });
        } catch {
          /* UI callbacks never break provider generation. */
        }
      }
    }
  }
  if (!sawPayload)
    throw new BrokerError(
      "PROVIDER_ERROR",
      "The provider stream ended without a response.",
    );
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
    return streamedGemini(
      config,
      await providerResponse(config, path, init, signal),
      options.progress.onItem,
    );
  return geminiResult(
    config,
    await providerRequest(config, path, init, signal),
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
    if (content.some((part) => part.text || part.image_url))
      input.push({ role, content });
    for (const call of message.tool_calls ?? [])
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
  }
  return input;
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
  for (const item of Array.isArray(body.output) ? body.output : []) {
    if (item?.type === "message")
      for (const part of Array.isArray(item.content) ? item.content : [])
        if (part?.type === "output_text" && typeof part.text === "string")
          content += part.text;
    if (item?.type === "function_call")
      wireCalls.push({
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: item.arguments },
      });
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
    rawMessage: { role: "assistant", content, tool_calls: validated },
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
    if (event.type === "error" || event.type === "response.failed")
      throw new BrokerError(
        "PROVIDER_ERROR",
        "The provider reported an error while streaming.",
      );
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
        type: "function",
        function: {
          name: String(event.item.name ?? ""),
          arguments: String(event.item.arguments ?? ""),
        },
      });
    if (event.type === "response.function_call_arguments.delta") {
      const call = calls.get(event.output_index);
      if (!call || typeof event.delta !== "string")
        throw new BrokerError(
          "PROVIDER_ERROR",
          "The provider returned invalid streamed tool calls.",
        );
      call.function.arguments += event.delta;
    }
    if (
      event.type === "response.output_item.done" &&
      event.item?.type === "function_call"
    )
      calls.set(event.output_index, {
        id: String(event.item.call_id ?? ""),
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
  const output = [];
  if (content)
    output.push({
      type: "message",
      content: [{ type: "output_text", text: content }],
    });
  output.push(
    ...[...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
  );
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
    return streamedResponses(
      config,
      await providerResponse(config, "/responses", init, signal),
      options.progress.onItem,
    );
  return responsesResult(
    config,
    await providerRequest(config, "/responses", init, signal),
  );
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
