import { BrokerError } from "./errors.js";
import {
  CAPABILITIES,
  CONTEXT_FIELDS,
  EFFORTS,
  IMAGE_TYPES,
  LEVELS,
  LIMITS,
} from "./constants.js";
import { validateSchema } from "./schema.js";
import { validateCard } from "./cards.js";

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_USER_INPUT_ID = /^[a-z][a-z0-9_-]{0,31}$/;

function invalid(message, details) {
  throw new BrokerError("INVALID_REQUEST", message, details);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, name, max, required = false) {
  if (value == null && !required) return undefined;
  if (
    typeof value !== "string" ||
    (required && value.length === 0) ||
    value.length > max
  ) {
    invalid(
      `${name} must be ${required ? "a non-empty" : "a"} string no longer than ${max} characters.`,
      { field: name },
    );
  }
  return value;
}

function cloneJson(value, name, maxBytes = LIMITS.resultBytes) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    invalid(`${name} must be JSON-serializable.`);
  }
  if (
    encoded === undefined ||
    new TextEncoder().encode(encoded).byteLength > maxBytes
  )
    invalid(`${name} is too large or not JSON-serializable.`);
  return JSON.parse(encoded);
}

export function levelOf(capabilities = []) {
  if (capabilities.includes("models.catalog")) return "catalog";
  if (capabilities.includes("models.generate")) return "completion";
  return "assistant";
}

export function validateAccessRequest(input) {
  if (!plainObject(input)) invalid("Access request must be an object.");
  let requested = input.capabilities;
  // Like a wallet connect, a bare request asks for level 1.
  const level =
    input.level ?? (input.capabilities == null ? "completion" : null);
  if (level != null) {
    if (!Object.hasOwn(LEVELS, level))
      invalid('level must be "completion" or "catalog".', {
        field: "level",
      });
    requested = [
      ...LEVELS[level],
      ...(Array.isArray(input.capabilities) ? input.capabilities : []),
    ];
    if (input.capabilities != null && !Array.isArray(input.capabilities))
      invalid("capabilities must be an array.");
  } else if (!Array.isArray(requested) || requested.length === 0) {
    invalid("capabilities must be a non-empty array.");
  }
  // Uniqueness is the caller's contract, so it is checked against what the site
  // actually passed. A level bundle restating one of them is not the site's
  // mistake, so merging the two may legitimately drop a duplicate.
  const own = Array.isArray(input.capabilities) ? input.capabilities : [];
  if (new Set(own).size !== own.length) invalid("capabilities must be unique.");
  const capabilities = [...new Set(requested)];
  if (
    capabilities.some(
      (item) => typeof item !== "string" || !CAPABILITIES.includes(item),
    )
  ) {
    invalid("The request contains an unknown capability.");
  }
  if (!Array.isArray(input.context ?? [])) invalid("context must be an array.");
  const context = [...new Set(input.context ?? [])];
  if (context.some((item) => !CONTEXT_FIELDS.includes(item))) {
    invalid("context contains an unknown field.");
  }
  if (context.length && !capabilities.includes("context.read"))
    invalid("context fields require context.read.");
  return {
    capabilities,
    context,
    reason: boundedString(input.reason, "reason", 280),
  };
}

/**
 * User message content may be a string or bounded text/image parts. Parts are
 * kept in the public shape; provider adapters convert them to wire formats.
 */
function validateContent(content, name, maxChars) {
  if (content == null) return "";
  if (typeof content === "string")
    return boundedString(content, name, maxChars);
  if (
    !Array.isArray(content) ||
    !content.length ||
    content.length > LIMITS.contentParts
  )
    invalid(`${name} must be a string or 1 to ${LIMITS.contentParts} parts.`, {
      field: name,
    });
  let images = 0;
  return content.map((part, index) => {
    if (!plainObject(part)) invalid(`${name}[${index}] must be an object.`);
    if (part.type === "text")
      return {
        type: "text",
        text:
          boundedString(part.text ?? "", `${name}[${index}].text`, maxChars) ??
          "",
      };
    if (part.type === "image") {
      if (++images > LIMITS.imagesPerMessage)
        invalid(
          `${name} may contain at most ${LIMITS.imagesPerMessage} images.`,
        );
      if (!IMAGE_TYPES.includes(part.mediaType))
        invalid(`${name}[${index}].mediaType is not a supported image type.`);
      const data = boundedString(
        part.data,
        `${name}[${index}].data`,
        LIMITS.imageChars,
        true,
      );
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data))
        invalid(`${name}[${index}].data must be base64.`);
      return { type: "image", mediaType: part.mediaType, data };
    }
    invalid(`${name}[${index}].type must be "text" or "image".`);
  });
}

export function validateSiteToolResult(input, outputContent = []) {
  if (!outputContent.length) return cloneJson(input, "tool result");
  if (
    !plainObject(input) ||
    input.kind !== "content" ||
    !Array.isArray(input.content)
  )
    invalid(
      'Content tool results must be { kind: "content", content: [...] }.',
    );
  // Cards (SPEC 7.4) are drawn, never sent to the model, so they are pulled out
  // and checked by their own bounded validator before the rest is validated.
  const cards = input.content.filter(
    (part) => plainObject(part) && part.type === "card",
  );
  if (cards.length > 1) invalid("A tool result may contain one card.");
  if (cards.length && !outputContent.includes("card"))
    invalid("The tool returned an undeclared content type.");
  const rest = input.content.filter(
    (part) => !(plainObject(part) && part.type === "card"),
  );
  if (cards.length && !rest.length)
    invalid("Image and card tool results require a non-empty text fallback.");
  const content = validateContent(
    rest,
    "tool result content",
    LIMITS.messageChars,
  );
  const kinds = new Set(content.map((part) => part.type));
  if ([...kinds].some((kind) => !outputContent.includes(kind)))
    invalid("The tool returned an undeclared content type.");
  if (
    (kinds.has("image") || cards.length) &&
    !content.some((part) => part.type === "text" && part.text.trim().length > 0)
  )
    invalid("Image and card tool results require a non-empty text fallback.");
  const card = cards.length
    ? validateCard(cards[0].card, "tool result card")
    : null;
  return {
    kind: "content",
    content: card ? [...content, { type: "card", card }] : content,
  };
}

export function hasImages(messages) {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => part.type === "image"),
  );
}

export function contentText(content) {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((part) => part.type !== "card")
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("\n");
}

export function validateMessages(messages, internal = false) {
  if (
    !Array.isArray(messages) ||
    messages.length < 1 ||
    messages.length > (internal ? LIMITS.internalMessages : LIMITS.messages)
  ) {
    invalid(`messages must contain 1 to ${LIMITS.messages} items.`);
  }
  return messages.map((message, index) => {
    if (
      !plainObject(message) ||
      !["system", "user", "assistant", "tool"].includes(message.role)
    ) {
      invalid(`messages[${index}] has an invalid role.`);
    }
    const maxChars = internal
      ? LIMITS.internalMessageChars
      : LIMITS.messageChars;
    if (message.role !== "user" && Array.isArray(message.content))
      invalid(
        `messages[${index}] may use content parts only for user messages.`,
      );
    const result = {
      role: message.role,
      content: validateContent(
        message.content,
        `messages[${index}].content`,
        maxChars,
      ),
    };
    if (message.name != null)
      result.name = boundedString(
        message.name,
        `messages[${index}].name`,
        64,
        true,
      );
    if (message.toolCallId != null)
      result.tool_call_id = boundedString(
        message.toolCallId,
        `messages[${index}].toolCallId`,
        128,
        true,
      );
    if (message.toolCalls != null)
      result.tool_calls = validateToolCalls(message.toolCalls);
    if (message.role === "tool" && !result.tool_call_id)
      invalid("Tool messages require toolCallId.");
    if (message.toolCalls != null && message.role !== "assistant")
      invalid("Only assistant messages can contain toolCalls.");
    return result;
  });
}

function validateToolUserInputs(inputs, inputSchema, toolIndex) {
  if (inputs == null) return [];
  if (!Array.isArray(inputs) || inputs.length > LIMITS.toolUserInputs)
    invalid(
      `tools[${toolIndex}].userInputs must contain no more than ${LIMITS.toolUserInputs} items.`,
    );
  if (inputs.length && inputSchema.additionalProperties !== false)
    invalid(
      `tools[${toolIndex}].inputSchema must set additionalProperties to false when userInputs are declared.`,
    );
  const ids = new Set();
  return inputs.map((input, inputIndex) => {
    const field = `tools[${toolIndex}].userInputs[${inputIndex}]`;
    if (
      !plainObject(input) ||
      typeof input.id !== "string" ||
      !TOOL_USER_INPUT_ID.test(input.id) ||
      ids.has(input.id)
    )
      invalid(`${field} has an invalid or duplicate id.`);
    if (Object.hasOwn(inputSchema.properties ?? {}, input.id))
      invalid(`${field}.id must not also be a model-supplied property.`);
    ids.add(input.id);
    const rawSchema = cloneJson(input.schema, `${field}.schema`, 4_096);
    if (
      !plainObject(rawSchema) ||
      !["string", "number", "integer", "boolean"].includes(rawSchema.type)
    )
      invalid(`${field}.schema must declare one scalar type.`);
    const scalarKeywords = new Set([
      "type",
      "enum",
      "const",
      "minimum",
      "maximum",
      "minLength",
      "maxLength",
      "title",
      "description",
      "$comment",
    ]);
    if (Object.keys(rawSchema).some((key) => !scalarKeywords.has(key)))
      invalid(
        `${field}.schema contains a keyword not supported for user input.`,
      );
    const numeric = ["number", "integer"].includes(rawSchema.type);
    if (
      (!numeric && (rawSchema.minimum != null || rawSchema.maximum != null)) ||
      (rawSchema.type !== "string" &&
        (rawSchema.minLength != null || rawSchema.maxLength != null)) ||
      (rawSchema.minimum != null &&
        rawSchema.maximum != null &&
        rawSchema.minimum > rawSchema.maximum) ||
      (rawSchema.minLength != null &&
        rawSchema.maxLength != null &&
        rawSchema.minLength > rawSchema.maxLength)
    )
      invalid(`${field}.schema has assertions incompatible with its type.`);
    const hasScalarType = (value) =>
      rawSchema.type === "string"
        ? typeof value === "string"
        : rawSchema.type === "boolean"
          ? typeof value === "boolean"
          : typeof value === "number" &&
            Number.isFinite(value) &&
            (rawSchema.type !== "integer" || Number.isInteger(value));
    if (
      (rawSchema.enum &&
        rawSchema.enum.some((value) => !hasScalarType(value))) ||
      (Object.hasOwn(rawSchema, "const") && !hasScalarType(rawSchema.const))
    )
      invalid(`${field}.schema enum and const values must match its type.`);
    if (
      rawSchema.type === "string" &&
      (rawSchema.maxLength == null ||
        rawSchema.maxLength > LIMITS.toolUserInputChars)
    )
      rawSchema.maxLength = LIMITS.toolUserInputChars;
    // Reuse the protocol's bounded schema validator by placing the scalar under
    // an object property; root tool schemas themselves must be objects.
    validateSchema({
      type: "object",
      properties: { value: rawSchema },
      required: ["value"],
      additionalProperties: false,
    });
    const secret = input.secret === true;
    if (secret && rawSchema.type !== "string")
      invalid(`${field}.secret is supported only for string inputs.`);
    if (secret && (rawSchema.enum || Object.hasOwn(rawSchema, "const")))
      invalid(`${field}.secret cannot be combined with enum or const.`);
    return {
      id: input.id,
      label: boundedString(input.label, `${field}.label`, 80, true),
      description:
        boundedString(input.description ?? "", `${field}.description`, 280) ??
        "",
      schema: rawSchema,
      secret,
    };
  });
}

export function validateTools(
  tools,
  limit = LIMITS.tools,
  allowUserInputs = false,
) {
  if (tools == null) return [];
  if (!Array.isArray(tools) || tools.length > limit)
    invalid(`tools must contain no more than ${limit} items.`);
  const names = new Set();
  return tools.map((tool, index) => {
    if (
      !plainObject(tool) ||
      typeof tool.name !== "string" ||
      !TOOL_NAME.test(tool.name) ||
      names.has(tool.name)
    )
      invalid(`tools[${index}] has an invalid or duplicate name.`);
    names.add(tool.name);
    const inputSchema = validateSchema(
      cloneJson(
        tool.inputSchema ?? { type: "object" },
        `tools[${index}].inputSchema`,
        LIMITS.schemaBytes,
      ),
    );
    if (!allowUserInputs && tool.userInputs != null)
      invalid(
        `tools[${index}].userInputs is supported only for registered site tools.`,
      );
    const result = {
      name: tool.name,
      description:
        boundedString(
          tool.description ?? "",
          `tools[${index}].description`,
          500,
        ) ?? "",
      inputSchema,
    };
    if (allowUserInputs)
      result.userInputs = validateToolUserInputs(
        tool.userInputs,
        inputSchema,
        index,
      );
    if (allowUserInputs) {
      const outputContent = tool.outputContent ?? [];
      if (
        !Array.isArray(outputContent) ||
        outputContent.length > 3 ||
        new Set(outputContent).size !== outputContent.length ||
        outputContent.some(
          (kind) => !["text", "image", "card"].includes(kind),
        ) ||
        ((outputContent.includes("image") || outputContent.includes("card")) &&
          !outputContent.includes("text"))
      )
        invalid(
          `tools[${index}].outputContent must contain unique text/image/card values, with text whenever image or card is declared.`,
        );
      result.outputContent = outputContent;
    }
    return result;
  });
}

export function validateGenerateRequest(input, internal = false) {
  if (!plainObject(input)) invalid("Generation request must be an object.");
  const output = {
    messages: validateMessages(input.messages, internal),
    tools: validateTools(input.tools),
  };
  if (input.model != null)
    output.model = boundedString(input.model, "model", 200, true);
  if (input.temperature != null) {
    if (
      !Number.isFinite(input.temperature) ||
      input.temperature < 0 ||
      input.temperature > 2
    )
      invalid("temperature must be between 0 and 2.");
    output.temperature = input.temperature;
  }
  if (input.maxTokens != null) {
    if (
      !Number.isInteger(input.maxTokens) ||
      input.maxTokens < 1 ||
      input.maxTokens > 32768
    )
      invalid("maxTokens must be an integer from 1 to 32768.");
    output.maxTokens = input.maxTokens;
  }
  if (input.reasoning != null) {
    const effort = plainObject(input.reasoning)
      ? input.reasoning.effort
      : input.reasoning;
    if (!EFFORTS.includes(effort))
      invalid(`reasoning.effort must be one of ${EFFORTS.join(", ")}.`, {
        field: "reasoning",
      });
    output.reasoning = effort;
  }
  cloneJson(output, "Generation request", LIMITS.requestBytes);
  return output;
}

export function validateMcpServer(server, index = 0) {
  if (!plainObject(server)) invalid(`mcpServers[${index}] must be an object.`);
  const id = boundedString(server.id, `mcpServers[${index}].id`, 64, true);
  if (!TOOL_NAME.test(id)) invalid(`mcpServers[${index}].id is invalid.`);
  const name = boundedString(
    server.name ?? id,
    `mcpServers[${index}].name`,
    80,
    true,
  );
  let url;
  try {
    url = new URL(server.url);
  } catch {
    invalid(`mcpServers[${index}].url is invalid.`);
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
  ) {
    invalid(
      `mcpServers[${index}].url must use HTTPS (loopback HTTP is allowed) and contain no credentials or fragment.`,
    );
  }
  const headers = {};
  if (server.headers != null) {
    if (Object.keys(server.headers).length > 32)
      invalid("Too many MCP headers.");
    if (!plainObject(server.headers))
      invalid(`mcpServers[${index}].headers must be an object.`);
    for (const [key, value] of Object.entries(server.headers)) {
      const lower = key.toLowerCase();
      if (
        !["authorization", "cookie", "proxy-authorization"].includes(lower) &&
        !lower.startsWith("sec-") &&
        !lower.startsWith("chrome-") &&
        /^[A-Za-z0-9-]{1,64}$/.test(key)
      ) {
        if (typeof value !== "string" || /[\r\n]/.test(value))
          invalid("MCP header value is invalid.");
        headers[key] = boundedString(
          value,
          `mcpServers[${index}].headers.${key}`,
          1000,
        );
      } else invalid(`mcpServers[${index}] contains a forbidden header.`);
    }
  }
  // Declared tools (SPEC 7.7) make the server's tool set part of the
  // fingerprinted contract, so the extension never calls tools/list for it and
  // consent shows the same definitions the model will be offered.
  let tools;
  if (server.tools != null) {
    if (!Array.isArray(server.tools) || !server.tools.length)
      invalid(`mcpServers[${index}].tools must be a non-empty array.`);
    tools = validateTools(server.tools, LIMITS.declaredMcpTools);
  }
  return {
    id,
    name,
    url: url.toString(),
    headers,
    ...(tools ? { tools } : {}),
  };
}

const CONTROL_ID = /^[a-z][a-z0-9_-]{0,31}$/;
function validateControls(input) {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > LIMITS.widgetControls)
    invalid(
      `widget.controls must contain no more than ${LIMITS.widgetControls} items.`,
    );
  const ids = new Set();
  return input.map((control, index) => {
    const name = `widget.controls[${index}]`;
    if (!plainObject(control)) invalid(`${name} must be an object.`);
    const id = boundedString(control.id, `${name}.id`, 32, true);
    if (!CONTROL_ID.test(id) || ids.has(id))
      invalid(`${name}.id is invalid or duplicated.`);
    ids.add(id);
    if (!["toggle", "select", "button"].includes(control.type))
      invalid(`${name}.type must be toggle, select, or button.`);
    const result = {
      id,
      type: control.type,
      label: boundedString(control.label, `${name}.label`, 40, true),
      description:
        boundedString(control.description ?? "", `${name}.description`, 120) ??
        "",
      model: control.model !== false,
    };
    if (control.type === "select") {
      if (
        !Array.isArray(control.options) ||
        !control.options.length ||
        control.options.length > 8
      )
        invalid(`${name}.options must contain 1 to 8 items.`);
      result.options = control.options.map((option, i) => {
        if (!plainObject(option)) invalid(`${name}.options[${i}] is invalid.`);
        return {
          value: boundedString(
            option.value,
            `${name}.options[${i}].value`,
            40,
            true,
          ),
          label: boundedString(
            option.label ?? option.value,
            `${name}.options[${i}].label`,
            40,
            true,
          ),
        };
      });
      if (
        new Set(result.options.map((o) => o.value)).size !==
        result.options.length
      )
        invalid(`${name}.options values must be unique.`);
      result.default = result.options.some((o) => o.value === control.default)
        ? control.default
        : result.options[0].value;
    } else if (control.type === "toggle") {
      result.default = control.default === true;
    }
    return result;
  });
}

/** Validates page- or user-set control values against the declared controls. */
export function validateControlValues(controls, values) {
  if (values == null) return {};
  if (!plainObject(values)) invalid("Control values must be an object.");
  const output = {};
  for (const control of controls) {
    if (control.type === "button") continue;
    const value = Object.hasOwn(values, control.id)
      ? values[control.id]
      : control.default;
    if (control.type === "toggle") {
      if (typeof value !== "boolean")
        invalid(`Control ${control.id} expects a boolean.`);
    } else if (!control.options.some((option) => option.value === value))
      invalid(`Control ${control.id} received an unknown option.`);
    output[control.id] = value;
  }
  return output;
}

export function validateWidget(input) {
  if (input != null && !plainObject(input))
    invalid("widget must be an object.");
  const widget = input ?? {};
  if (
    widget.toolCallView != null &&
    !["compact", "detailed"].includes(widget.toolCallView)
  )
    invalid("widget.toolCallView must be compact or detailed.");
  const suggestions = widget.suggestions ?? [];
  if (
    !Array.isArray(suggestions) ||
    suggestions.length > LIMITS.widgetSuggestions
  )
    invalid(
      `widget.suggestions must contain no more than ${LIMITS.widgetSuggestions} items.`,
    );
  let theme = null;
  if (widget.theme != null) {
    if (!plainObject(widget.theme)) invalid("widget.theme must be an object.");
    theme = {};
    if (widget.theme.accent != null) {
      if (!/^#[0-9a-fA-F]{6}$/.test(widget.theme.accent))
        invalid("widget.theme.accent must be a #rrggbb colour.");
      theme.accent = widget.theme.accent.toLowerCase();
    }
    if (widget.theme.mode != null) {
      if (!["light", "dark", "auto"].includes(widget.theme.mode))
        invalid("widget.theme.mode must be light, dark, or auto.");
      theme.mode = widget.theme.mode;
    }
  }
  return {
    autoShow: widget.autoShow === true,
    toolCallView: widget.toolCallView ?? "compact",
    greeting:
      boundedString(widget.greeting ?? "", "widget.greeting", 500) ?? "",
    placeholder:
      boundedString(widget.placeholder ?? "", "widget.placeholder", 80) ?? "",
    suggestions: suggestions.map((item, index) =>
      boundedString(item, `widget.suggestions[${index}]`, 120, true),
    ),
    theme,
    controls: validateControls(widget.controls),
  };
}

export function validateSiteManifest(input) {
  if (!plainObject(input)) invalid("Site manifest must be an object.");
  const tools = validateTools(input.tools, LIMITS.siteTools, true);
  const servers = input.mcpServers ?? [];
  if (!Array.isArray(servers) || servers.length > LIMITS.mcpServers)
    invalid(`mcpServers must contain no more than ${LIMITS.mcpServers} items.`);
  const serverIds = new Set();
  const mcpServers = servers.map((item, index) => {
    const server = validateMcpServer(item, index);
    if (serverIds.has(server.id)) invalid("MCP server ids must be unique.");
    serverIds.add(server.id);
    return server;
  });
  const widget = validateWidget(input.widget);
  // The page cannot ship its callbacks, so the contract carries only the fact
  // that this site stores the conversation, which consent must disclose.
  let threads = null;
  if (input.threads != null) {
    if (!plainObject(input.threads)) invalid("threads must be an object.");
    threads = { rename: input.threads.rename === true };
  }
  return {
    name: boundedString(input.name, "name", 80, true),
    description:
      boundedString(input.description ?? "", "description", 280) ?? "",
    systemPrompt:
      boundedString(
        input.systemPrompt ?? "",
        "systemPrompt",
        LIMITS.systemPrompt,
      ) ?? "",
    widget,
    tools,
    mcpServers,
    threads,
  };
}

export function validateContextFields(input, granted = []) {
  const fields = input?.fields;
  if (
    !Array.isArray(fields) ||
    fields.length === 0 ||
    fields.some((field) => !CONTEXT_FIELDS.includes(field))
  )
    invalid("fields must be a non-empty context field array.");
  const unique = [...new Set(fields)];
  if (unique.some((field) => !granted.includes(field)))
    throw new BrokerError(
      "PERMISSION_REQUIRED",
      "One or more context fields have not been granted.",
    );
  return unique;
}

export function providerOrigin(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    invalid("Provider base URL is invalid.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    invalid(
      "Provider must use HTTPS, except for loopback development endpoints.",
    );
  if (url.username || url.password || url.hash || url.search)
    invalid(
      "Provider base URL must not contain credentials, a query, or a fragment.",
    );
  return url.origin;
}

export { plainObject, cloneJson };

export function validateToolCalls(calls) {
  if (!Array.isArray(calls) || calls.length > LIMITS.toolCalls)
    invalid("toolCalls must be a bounded array.");
  const ids = new Set();
  return calls.map((call) => {
    if (
      !plainObject(call) ||
      call.type !== "function" ||
      !plainObject(call.function)
    )
      invalid("Invalid tool call.");
    const id = boundedString(call.id, "tool call id", 128, true);
    if (ids.has(id)) invalid("Duplicate tool call id.");
    ids.add(id);
    if (
      typeof call.function.name !== "string" ||
      !TOOL_NAME.test(call.function.name)
    )
      invalid("Invalid tool call name.");
    return {
      id,
      type: "function",
      function: {
        name: call.function.name,
        arguments: boundedString(
          call.function.arguments,
          "tool arguments",
          LIMITS.resultBytes,
          true,
        ),
      },
    };
  });
}

export function validateContext(input) {
  if (!plainObject(input)) invalid("Page context must be an object.");
  const output = {};
  for (const [key, limit] of [
    ["title", 500],
    ["url", 4000],
    ["selection", LIMITS.selection],
    ["text", LIMITS.contextText],
  ]) {
    if (input[key] != null)
      output[key] = boundedString(input[key], `context.${key}`, limit);
  }
  return output;
}
