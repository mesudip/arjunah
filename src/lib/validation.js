import { BrokerError } from "./errors.js";
import {
  CAPABILITIES,
  CONTEXT_FIELDS,
  EFFORTS,
  GENERATE_LIMITS,
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
  const constraint = validateRequire(input.require);
  if (
    constraint !== undefined &&
    !capabilities.includes("models.list") &&
    !capabilities.includes("models.generate")
  )
    invalid("require applies only to model access (level 1 or 2).", {
      field: "require",
    });
  // Who composes the site's level 1 or 2 rounds (SPEC 15.3). It changes only
  // what consent says, so it is checked rather than trusted to be meaningful.
  if (input.composer != null && !COMPOSERS.includes(input.composer))
    invalid('composer must be "webapp" or "server".', { field: "composer" });
  return {
    capabilities,
    context,
    reason: boundedString(input.reason, "reason", 280),
    ...(constraint !== undefined ? { require: constraint } : {}),
    ...(input.composer != null ? { composer: input.composer } : {}),
  };
}

/** The composers a page may name (SPEC 15.3); the extension is never one. */
export const COMPOSERS = Object.freeze(["webapp", "server"]);

const REQUIRE_KINDS = Object.freeze(["api-key", "subscription", "self-hosted"]);

/**
 * A site's constraint on which of the visitor's models may answer it (SPEC
 * 4): `{ kinds?, local?: true, builtinTools?: false }`. Returns the normalized
 * object (kinds sorted, absent members left out; `{}` means no constraint),
 * or `undefined` when the request carries none. Every member and value is
 * checked: a constraint the extension silently ignored would promise the site
 * something it does not enforce.
 */
export function validateRequire(input) {
  if (input === undefined || input === null) return undefined;
  const fail = (message) => invalid(message, { field: "require" });
  if (!plainObject(input)) fail("require must be an object.");
  const known = ["kinds", "local", "builtinTools"];
  if (Object.keys(input).some((key) => !known.includes(key)))
    fail("require has an unknown member.");
  const result = {};
  if (input.kinds !== undefined) {
    if (
      !Array.isArray(input.kinds) ||
      !input.kinds.length ||
      new Set(input.kinds).size !== input.kinds.length ||
      input.kinds.some((kind) => !REQUIRE_KINDS.includes(kind))
    )
      fail(
        `require.kinds must be a non-empty list of unique values from ${REQUIRE_KINDS.join(", ")}.`,
      );
    result.kinds = REQUIRE_KINDS.filter((kind) => input.kinds.includes(kind));
  }
  if (input.local !== undefined) {
    if (input.local !== true) fail("require.local can only be true.");
    result.local = true;
  }
  if (input.builtinTools !== undefined) {
    if (input.builtinTools !== false)
      fail("require.builtinTools can only be false.");
    result.builtinTools = false;
  }
  return result;
}

/** The stored form: `null` when nothing is required. */
export function requireOrNull(value) {
  return value && Object.keys(value).length ? value : null;
}

/**
 * User message content may be a string or bounded text/image parts. Parts are
 * kept in the public shape; provider adapters convert them to wire formats.
 * `maxChars` bounds each text part; `totalChars`, when given, bounds the text
 * parts together, which is how a message's text is one budget however it is
 * split (a desktop agent receives the parts joined into one string).
 */
function validateContent(content, name, maxChars, totalChars = Infinity) {
  if (content == null) return "";
  if (typeof content === "string")
    return boundedString(content, name, Math.min(maxChars, totalChars));
  if (
    !Array.isArray(content) ||
    !content.length ||
    content.length > LIMITS.contentParts
  )
    invalid(`${name} must be a string or 1 to ${LIMITS.contentParts} parts.`, {
      field: name,
    });
  let images = 0;
  let text = 0;
  return content.map((part, index) => {
    if (!plainObject(part)) invalid(`${name}[${index}] must be an object.`);
    if (part.type === "text") {
      const value =
        boundedString(part.text ?? "", `${name}[${index}].text`, maxChars) ??
        "";
      if ((text += value.length) > totalChars)
        invalid(
          `${name} text parts must total no more than ${totalChars} characters.`,
          { field: name },
        );
      return { type: "text", text: value };
    }
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

export function validateSiteToolResult(input, outputContent = [], cardIds) {
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
  // Card ids address cards for in-place updates, so a turn that reused one id
  // would swap the wrong card; the spec requires them to be unique (7.4).
  if (card?.id && cardIds) {
    if (cardIds.has(card.id)) invalid("Card ids must be unique within a turn.");
    cardIds.add(card.id);
  }
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

/**
 * One bound for every message, whoever wrote it: a page's own request and the
 * broker's hosted rounds are validated against the same model's `limits`.
 */
export function validateMessages(messages, limits = GENERATE_LIMITS) {
  if (
    !Array.isArray(messages) ||
    messages.length < 1 ||
    messages.length > limits.messages
  ) {
    invalid(`messages must contain 1 to ${limits.messages} items.`, {
      field: "messages",
    });
  }
  return messages.map((message, index) => {
    if (
      !plainObject(message) ||
      !["system", "user", "assistant", "tool"].includes(message.role)
    ) {
      invalid(`messages[${index}] has an invalid role.`);
    }
    const maxChars = limits.messageUnits;
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
      result.tool_calls = validateToolCalls(message.toolCalls, limits);
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

/**
 * `allowUserInputs` names who declares the tools: `true` for site tools
 * (collected inputs, output kinds, approvals), `"remote"` for a declared
 * remote tool (SPEC 7.7, 7.8: collected inputs and approvals, never output
 * kinds), and `false` for a page's own request, where neither exists.
 */
export function validateTools(
  tools,
  limit = LIMITS.tools,
  allowUserInputs = false,
  descriptionChars = LIMITS.toolDescriptionChars,
  schemaBytes = LIMITS.schemaBytes,
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
        schemaBytes,
      ),
    );
    if (!allowUserInputs && tool.userInputs != null)
      invalid(
        `tools[${index}].userInputs is supported only for registered site tools and declared remote tools.`,
      );
    const result = {
      name: tool.name,
      description:
        boundedString(
          tool.description ?? "",
          `tools[${index}].description`,
          descriptionChars,
        ) ?? "",
      inputSchema,
    };
    if (allowUserInputs === true)
      result.userInputs = validateToolUserInputs(
        tool.userInputs,
        inputSchema,
        index,
      );
    else if (allowUserInputs === "remote") {
      // Only present when declared, so contracts that declare none keep the
      // fingerprint they were approved under.
      const inputs = validateToolUserInputs(
        tool.userInputs,
        inputSchema,
        index,
      );
      if (inputs.length) result.userInputs = inputs;
    }
    // The visitor confirms the call before it runs (SPEC 7.8). Part of the
    // fingerprinted contract, so a site cannot drop it after consent.
    if (allowUserInputs) {
      if (
        tool.requiresApproval != null &&
        typeof tool.requiresApproval !== "boolean"
      )
        invalid(`tools[${index}].requiresApproval must be a boolean.`, {
          field: `tools[${index}].requiresApproval`,
        });
      // Recorded only when set, for the same reason as remote userInputs.
      if (tool.requiresApproval === true) result.requiresApproval = true;
    }
    if (allowUserInputs === true) {
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

/**
 * `toolChoice` (SPEC 5.3): `"auto"`, `"none"`, `"required"`, or `{ name }`
 * naming one of the request's own tools. It needs `tools`, because each wire
 * format expresses it as a constraint on the declared list.
 */
function validateToolChoice(input, tools) {
  const fail = (message) => invalid(message, { field: "toolChoice" });
  if (!tools.length) fail("toolChoice requires tools.");
  if (typeof input === "string") {
    if (!["auto", "none", "required"].includes(input))
      fail('toolChoice must be "auto", "none", "required", or { name }.');
    return input;
  }
  if (!plainObject(input) || typeof input.name !== "string")
    fail('toolChoice must be "auto", "none", "required", or { name }.');
  if (!tools.some((tool) => tool.name === input.name))
    fail("toolChoice.name must be one of the request's tools.");
  return { name: input.name };
}

/**
 * `limits` is the answering model's entry in `models.list()` (SPEC 5.2), so a
 * request is held to exactly the numbers the page was shown.
 */
export function validateGenerateRequest(input, limits = GENERATE_LIMITS) {
  if (!plainObject(input)) invalid("Generation request must be an object.");
  const output = {
    messages: validateMessages(input.messages, limits),
    tools: validateTools(
      input.tools,
      limits.tools,
      false,
      limits.toolDescriptionUnits,
      limits.schemaBytes,
    ),
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
      input.maxTokens > limits.maxTokens
    )
      invalid(`maxTokens must be an integer from 1 to ${limits.maxTokens}.`, {
        field: "maxTokens",
      });
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
  if (input.toolChoice != null)
    output.toolChoice = validateToolChoice(input.toolChoice, output.tools);
  cloneJson(output, "Generation request", limits.requestBytes);
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
    tools = validateTools(server.tools, LIMITS.declaredMcpTools, "remote");
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

/** A site's own model id (SPEC 15.2); never contains "/", unlike a catalog id. */
export const SITE_MODEL_ID = /^[A-Za-z0-9_.:-]{1,100}$/;

/**
 * `loop` (SPEC 15.1): the page function itself never crosses the bridge, so
 * the contract carries who composes, for consent, and the level to request.
 */
function validateLoop(input) {
  if (!plainObject(input))
    invalid("loop must be an object.", { field: "loop" });
  if (!COMPOSERS.includes(input.composer))
    invalid('loop.composer must be "server" or "webapp".', {
      field: "loop.composer",
    });
  const level = input.level ?? 1;
  if (level !== 1 && level !== 2)
    invalid("loop.level must be 1 or 2.", { field: "loop.level" });
  return { composer: input.composer, level };
}

/**
 * `models` (SPEC 15.2): 1 to 8 entries the site answers itself. Metadata is
 * the site's to give, so nothing absent is filled in except the two defaults
 * the specification names (tools on, vision off) and the display name.
 * `generate` is whether the page supplied an answering function: required
 * without a loop, refused with one, because a loop answers its own models.
 */
function validateSiteModels(input, loop, siteName) {
  const field = "models";
  if (!plainObject(input)) invalid("models must be an object.", { field });
  const list = input.list;
  if (!Array.isArray(list) || !list.length || list.length > LIMITS.siteModels)
    invalid(`models.list must contain 1 to ${LIMITS.siteModels} entries.`, {
      field: "models.list",
    });
  if (loop && input.generate)
    invalid(
      "models.generate must be absent with a loop: the loop answers its own models.",
      { field: "models.generate" },
    );
  if (!loop && input.generate !== true)
    invalid("models.generate must be a function without a loop.", {
      field: "models.generate",
    });
  const ids = new Set();
  return {
    list: list.map((raw, index) => {
      const name = `models.list[${index}]`;
      if (
        !plainObject(raw) ||
        typeof raw.id !== "string" ||
        !SITE_MODEL_ID.test(raw.id) ||
        ids.has(raw.id)
      )
        invalid(`${name}.id is invalid or duplicated.`, { field: name });
      ids.add(raw.id);
      const caps = raw.capabilities ?? {};
      if (!plainObject(caps))
        invalid(`${name}.capabilities must be an object.`, { field: name });
      for (const flag of ["tools", "vision", "reasoning"])
        if (caps[flag] != null && typeof caps[flag] !== "boolean")
          invalid(`${name}.capabilities.${flag} must be a boolean.`, {
            field: name,
          });
      const levels = raw.reasoningLevels ?? [];
      if (
        !Array.isArray(levels) ||
        new Set(levels).size !== levels.length ||
        levels.some((level) => !EFFORTS.includes(level))
      )
        invalid(
          `${name}.reasoningLevels must be unique values from ${EFFORTS.join(", ")}.`,
          { field: name },
        );
      if (
        raw.contextWindow != null &&
        (!Number.isSafeInteger(raw.contextWindow) || raw.contextWindow < 1)
      )
        invalid(`${name}.contextWindow must be a positive integer.`, {
          field: name,
        });
      return {
        id: raw.id,
        displayName:
          boundedString(raw.displayName, `${name}.displayName`, 80) || siteName,
        capabilities: {
          tools: caps.tools ?? true,
          vision: caps.vision ?? false,
          reasoning: caps.reasoning ?? levels.length > 0,
        },
        contextWindow: raw.contextWindow ?? null,
        reasoningLevels: EFFORTS.filter((level) => levels.includes(level)),
        kind: "site",
      };
    }),
    generate: !loop,
  };
}

export function validateSiteManifest(input) {
  if (!plainObject(input)) invalid("Site manifest must be an object.");
  const tools = validateTools(input.tools, LIMITS.siteTools, true);
  const loop = input.loop != null ? validateLoop(input.loop) : null;
  // With a loop the composer writes every prompt, so there is no extension
  // prompt to disclose, and it runs its own server tools (SPEC 15.1).
  if (loop && input.systemPrompt)
    invalid("loop and systemPrompt are mutually exclusive.", {
      field: "systemPrompt",
    });
  const servers = loop ? [] : (input.mcpServers ?? []);
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
  const name = boundedString(input.name, "name", 80, true);
  const models =
    input.models != null ? validateSiteModels(input.models, loop, name) : null;
  return {
    name,
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
    // Appended only when declared, so every earlier contract keeps the
    // fingerprint it was approved under.
    ...(loop ? { loop } : {}),
    ...(models ? { models } : {}),
  };
}

/**
 * What a site's own model returned for one round (SPEC 15.2), checked the way
 * a provider's answer is: the section 5.3 result shape and bounds, and tool
 * calls only to tools that round offered. Anything else fails the round as a
 * PROVIDER_ERROR. `usage` stays null when the site reported none, so the
 * panel shows no number the site did not give.
 */
export function validateSiteModelResult(input, offered = new Set()) {
  const fail = (what) => {
    throw new BrokerError(
      "PROVIDER_ERROR",
      `The site's model returned ${what}.`,
    );
  };
  if (!plainObject(input) || !plainObject(input.message)) fail("no message");
  const message = input.message;
  if (message.content != null && typeof message.content !== "string")
    fail("invalid message content");
  const content = message.content ?? "";
  if (content.length > LIMITS.answerChars) fail("an answer past its bound");
  const calls = message.toolCalls ?? [];
  if (!Array.isArray(calls) || calls.length > LIMITS.toolCalls)
    fail("an invalid list of tool calls");
  const ids = new Set();
  const toolCalls = calls.map((call) => {
    if (
      !plainObject(call) ||
      typeof call.id !== "string" ||
      !call.id ||
      call.id.length > 128 ||
      ids.has(call.id)
    )
      fail("a tool call with an invalid or repeated id");
    ids.add(call.id);
    if (typeof call.name !== "string" || !offered.has(call.name))
      fail("a call to a tool this round did not offer");
    const args = call.arguments ?? "{}";
    if (typeof args !== "string" || args.length > LIMITS.toolArgumentUnits)
      fail("tool arguments that are not a bounded JSON string");
    return { id: call.id, name: call.name, arguments: args || "{}" };
  });
  const images = message.attachments ?? [];
  if (!Array.isArray(images) || images.length > LIMITS.imagesPerMessage)
    fail("too many attachments");
  const attachments = images.map((image) => {
    if (
      !plainObject(image) ||
      (image.type != null && image.type !== "image") ||
      !IMAGE_TYPES.includes(image.mediaType) ||
      typeof image.data !== "string" ||
      !image.data ||
      image.data.length > LIMITS.imageChars ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
    )
      fail("an invalid image attachment");
    return { type: "image", mediaType: image.mediaType, data: image.data };
  });
  if (
    message.reasoning != null &&
    (typeof message.reasoning !== "string" ||
      message.reasoning.length > LIMITS.reasoningChars)
  )
    fail("an invalid reasoning summary");
  let usage = null;
  if (input.usage != null) {
    if (!plainObject(input.usage)) fail("invalid usage");
    usage = {};
    for (const key of [
      "promptTokens",
      "completionTokens",
      "totalTokens",
      "cachedTokens",
      "reasoningTokens",
    ]) {
      const value = input.usage[key] ?? 0;
      if (!Number.isSafeInteger(value) || value < 0) fail("invalid usage");
      usage[key] = value;
    }
  }
  return {
    id:
      typeof input.id === "string" && input.id && input.id.length <= 200
        ? input.id
        : crypto.randomUUID(),
    message: {
      role: "assistant",
      content,
      toolCalls,
      attachments,
      reasoning: message.reasoning || null,
    },
    finishReason:
      typeof input.finishReason === "string" && input.finishReason
        ? input.finishReason.slice(0, 80)
        : toolCalls.length
          ? "tool_calls"
          : "stop",
    usage,
  };
}

/**
 * One collected input value against its declared scalar schema (SPEC 7.3),
 * for a declared remote tool, whose value the extension forwards itself. The
 * error names the input, never the value.
 */
export function validateUserInputValue(definition, value) {
  const schema = definition?.schema ?? {};
  const fail = () => {
    throw new BrokerError(
      "TOOL_ERROR",
      `The value given for ${String(definition?.label ?? "an input").slice(0, 80)} does not match what the tool declared.`,
    );
  };
  if (schema.type === "string") {
    if (typeof value !== "string") fail();
    const length = [...value].length;
    if (
      length < (schema.minLength ?? 0) ||
      length > (schema.maxLength ?? LIMITS.toolUserInputChars)
    )
      fail();
  } else if (schema.type === "boolean") {
    if (typeof value !== "boolean") fail();
  } else if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) fail();
    if (schema.type === "integer" && !Number.isInteger(value)) fail();
    if (value < (schema.minimum ?? -Infinity)) fail();
    if (value > (schema.maximum ?? Infinity)) fail();
  } else fail();
  if (schema.enum && !schema.enum.some((item) => item === value)) fail();
  if (Object.hasOwn(schema, "const") && schema.const !== value) fail();
  return value;
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

export function validateToolCalls(calls, limits = GENERATE_LIMITS) {
  if (!Array.isArray(calls) || calls.length > limits.toolCallsPerMessage)
    invalid(
      `toolCalls must be an array of at most ${limits.toolCallsPerMessage} calls.`,
    );
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
          limits.toolArgumentUnits,
          true,
        ),
      },
      // Opaque provider state that must survive a tool round trip: Gemini 3
      // rejects a continuation whose function call lost its thought signature.
      // Bounded and charset-checked, then handed back only to the provider that
      // issued it; it is never interpreted here and never reaches a page.
      ...(typeof call.thoughtSignature === "string" && call.thoughtSignature
        ? {
            thoughtSignature: boundedString(
              call.thoughtSignature,
              "tool call signature",
              LIMITS.signatureChars,
              true,
            ),
          }
        : {}),
    };
  });
}

/**
 * Model-supplied tool calls, made safe to execute rather than rejected outright.
 *
 * `validateToolCalls` above is the strict gate for calls a *page* supplies:
 * malformed input there is the caller's bug and earns INVALID_REQUEST. Calls
 * that come back from a *model* are a different problem. A malformed one is the
 * model's own mistake, and the turn can only offer it the chance to correct
 * that mistake if the conversation stays well-formed — every tool call needs a
 * result, so a call that cannot be executed still needs an id to answer.
 *
 * So each call is repaired into something representable, and the ones that
 * cannot be executed carry the reason the model will be told:
 *
 * - Empty `arguments` becomes `"{}"`. Models calling a zero-argument tool over
 *   the Responses API routinely send `""`, which is not a rejection-worthy
 *   mistake, just a different spelling of "no arguments".
 * - An empty, over-long, or repeated id is replaced with a minted one. The
 *   broker echoes its own assistant message, so only the pairing between a call
 *   and its result has to hold; the provider never sees the original id again.
 * - A name outside the declared charset, arguments over the size bound, and
 *   anything that is not a function call object cannot be run. Those are
 *   reported, and the turn answers them as failed tool calls.
 *
 * Returns the repaired calls, a `rejected` map from call id to reason, and how
 * many trailing calls were dropped for exceeding the per-message bound.
 */
export function repairToolCalls(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const kept = list.slice(0, LIMITS.toolCalls);
  const rejected = new Map();
  const ids = new Set();
  const result = [];
  const mint = (index) => {
    let id = `call_${index}`;
    for (let n = 0; ids.has(id); n++) id = `call_${index}_${n}`;
    ids.add(id);
    return id;
  };
  for (const [index, call] of kept.entries()) {
    if (!plainObject(call) || !plainObject(call.function)) {
      const id = mint(index);
      result.push({
        id,
        type: "function",
        function: { name: "invalid_tool_call", arguments: "{}" },
      });
      rejected.set(
        id,
        "The provider returned something that was not a function call, so it could not be run. Issue the call again.",
      );
      continue;
    }
    let id =
      typeof call.id === "string" && call.id.length <= 128 ? call.id : "";
    if (!id || ids.has(id)) id = mint(index);
    else ids.add(id);

    const declared =
      typeof call.function.name === "string" ? call.function.name : "";
    let name = declared;
    if (!TOOL_NAME.test(declared)) {
      const cleaned = declared.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
      name = TOOL_NAME.test(cleaned) ? cleaned : "invalid_tool_call";
      rejected.set(
        id,
        declared
          ? `"${declared.slice(0, 120)}" is not a usable tool name: names may only contain letters, digits, underscores, and hyphens, and must be 1 to 64 characters long.`
          : "The provider returned a tool call with no name, so it could not be routed. Issue the call again with the name of a declared tool.",
      );
    }

    let args =
      typeof call.function.arguments === "string"
        ? call.function.arguments
        : "";
    // A zero-argument call arrives as "" from several providers; that is the
    // same intent as "{}" and is repaired rather than reported.
    if (!args) args = "{}";
    if (args.length > LIMITS.toolArgumentUnits) {
      rejected.set(
        id,
        `The arguments were ${args.length} characters long, over the ${LIMITS.toolArgumentUnits} character limit. Call the tool again with smaller arguments.`,
      );
      args = "{}";
    }

    result.push({
      id,
      type: "function",
      function: { name, arguments: args },
      ...(typeof call.thoughtSignature === "string" &&
      call.thoughtSignature &&
      call.thoughtSignature.length <= LIMITS.signatureChars
        ? { thoughtSignature: call.thoughtSignature }
        : {}),
    });
  }
  return { calls: result, rejected, dropped: list.length - kept.length };
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
