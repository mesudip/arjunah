import { BrokerError } from "./errors.js";
import { LIMITS } from "./constants.js";

/**
 * Transcript cards (SPEC 7.4): a bounded, site-authored JSON tree the renderer
 * turns into DOM. There is no HTML, no Markdown, no link and no image here on
 * purpose: a card is site UI drawn inside extension UI, so the node set stays
 * small enough to audit and every string arrives as a text node.
 *
 * This module validates. Drawing lives in the renderer, which only ever
 * receives a tree that passed through here.
 */
const ID = /^[a-z][a-z0-9_-]{0,31}$/;
const TEXT_STYLES = ["body", "muted", "heading"];
const BUTTON_STYLES = ["primary", "secondary", "danger"];
const FIELD_TYPES = ["input", "select", "checkbox"];

function invalid(message) {
  throw new BrokerError("INVALID_REQUEST", message);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, name, max, required = false) {
  if (value == null && !required) return undefined;
  if (typeof value !== "string" || (required && !value.length))
    invalid(`${name} must be a non-empty string.`);
  if ([...value].length > max)
    invalid(`${name} must be at most ${max} characters.`);
  return value;
}

function validateAction(input, name, state) {
  if (!plainObject(input)) invalid(`${name} must be an object.`);
  if (input.type === "message")
    return {
      type: "message",
      text: text(input.text, `${name}.text`, LIMITS.cardText, true),
    };
  if (input.type === "local") {
    const action = {
      type: "local",
      name: text(input.name, `${name}.name`, 64, true),
    };
    if (input.payload !== undefined) {
      let encoded;
      try {
        encoded = JSON.stringify(input.payload);
      } catch {
        invalid(`${name}.payload must be JSON-serializable.`);
      }
      if (
        encoded === undefined ||
        new TextEncoder().encode(encoded).byteLength >
          LIMITS.cardActionPayloadBytes
      )
        invalid(`${name}.payload is too large or not JSON-serializable.`);
      action.payload = JSON.parse(encoded);
    }
    state.hasLocal = true;
    return action;
  }
  invalid(`${name}.type must be "message" or "local".`);
}

function validateField(input, index, name, ids, state) {
  if (!plainObject(input)) invalid(`${name} must be an object.`);
  if (!FIELD_TYPES.includes(input.type))
    invalid(`${name}.type must be input, select, or checkbox.`);
  const id = text(input.id, `${name}.id`, 32, true);
  if (!ID.test(id) || ids.has(id))
    invalid(`${name}.id is invalid or duplicated.`);
  ids.add(id);
  if (++state.fields > LIMITS.cardFields)
    invalid(`A card may contain at most ${LIMITS.cardFields} form fields.`);
  const field = {
    type: input.type,
    id,
    label: text(input.label, `${name}.label`, LIMITS.cardLabel, true),
  };
  const placeholder = text(
    input.placeholder,
    `${name}.placeholder`,
    LIMITS.cardLabel,
  );
  if (placeholder !== undefined) field.placeholder = placeholder;
  if (input.required === true) field.required = true;
  if (input.type === "select") {
    if (
      !Array.isArray(input.options) ||
      !input.options.length ||
      input.options.length > LIMITS.cardSelectOptions
    )
      invalid(
        `${name}.options must contain 1 to ${LIMITS.cardSelectOptions} items.`,
      );
    field.options = input.options.map((option, i) => {
      if (!plainObject(option)) invalid(`${name}.options[${i}] is invalid.`);
      const value = text(
        option.value,
        `${name}.options[${i}].value`,
        LIMITS.cardLabel,
        true,
      );
      return {
        value,
        label:
          text(
            option.label ?? value,
            `${name}.options[${i}].label`,
            LIMITS.cardLabel,
            true,
          ) ?? value,
      };
    });
    if (
      new Set(field.options.map((o) => o.value)).size !== field.options.length
    )
      invalid(`${name}.options values must be unique.`);
    field.default = field.options.some((o) => o.value === input.default)
      ? input.default
      : field.options[0].value;
  } else if (input.type === "checkbox") field.default = input.default === true;
  else {
    const value = text(input.default, `${name}.default`, LIMITS.cardText);
    field.default = value ?? "";
  }
  void index;
  return field;
}

function validateNode(input, name, depth, state) {
  if (depth > LIMITS.cardDepth)
    invalid(`A card may nest at most ${LIMITS.cardDepth} levels.`);
  if (!plainObject(input)) invalid(`${name} must be an object.`);
  if (++state.nodes > LIMITS.cardNodes)
    invalid(`A card may contain at most ${LIMITS.cardNodes} nodes.`);
  if (input.type === "text") {
    const node = {
      type: "text",
      text: text(input.text ?? "", `${name}.text`, LIMITS.cardText) ?? "",
    };
    if (input.style != null) {
      if (!TEXT_STYLES.includes(input.style))
        invalid(`${name}.style must be body, muted, or heading.`);
      node.style = input.style;
    }
    return node;
  }
  if (input.type === "button") {
    if (++state.buttons > LIMITS.cardButtons)
      invalid(`A card may contain at most ${LIMITS.cardButtons} buttons.`);
    const node = {
      type: "button",
      label: text(input.label, `${name}.label`, LIMITS.cardLabel, true),
      action: validateAction(input.action, `${name}.action`, state),
    };
    if (input.style != null) {
      if (!BUTTON_STYLES.includes(input.style))
        invalid(`${name}.style must be primary, secondary, or danger.`);
      node.style = input.style;
    }
    return node;
  }
  if (input.type === "list") {
    if (
      !Array.isArray(input.items) ||
      input.items.length > LIMITS.cardListItems
    )
      invalid(
        `${name}.items must contain no more than ${LIMITS.cardListItems} items.`,
      );
    return {
      type: "list",
      items: input.items.map((item, index) => {
        const field = `${name}.items[${index}]`;
        if (!plainObject(item)) invalid(`${field} must be an object.`);
        if (++state.nodes > LIMITS.cardNodes)
          invalid(`A card may contain at most ${LIMITS.cardNodes} nodes.`);
        const entry = {
          title: text(item.title, `${field}.title`, LIMITS.cardLabel, true),
        };
        const description = text(
          item.description,
          `${field}.description`,
          LIMITS.cardText,
        );
        if (description !== undefined) entry.description = description;
        if (item.action != null) {
          if (++state.buttons > LIMITS.cardButtons)
            invalid(
              `A card may contain at most ${LIMITS.cardButtons} buttons.`,
            );
          entry.action = validateAction(item.action, `${field}.action`, state);
        }
        return entry;
      }),
    };
  }
  if (input.type === "form") {
    const id = text(input.id, `${name}.id`, 32, true);
    if (!ID.test(id)) invalid(`${name}.id is invalid.`);
    if (state.formIds.has(id)) invalid(`${name}.id is duplicated.`);
    state.formIds.add(id);
    if (!Array.isArray(input.fields) || !input.fields.length)
      invalid(`${name}.fields must contain at least one field.`);
    const ids = new Set();
    const node = {
      type: "form",
      id,
      action: validateAction(input.action, `${name}.action`, state),
      fields: input.fields.map((field, index) =>
        validateField(field, index, `${name}.fields[${index}]`, ids, state),
      ),
    };
    const submitLabel = text(
      input.submitLabel,
      `${name}.submitLabel`,
      LIMITS.cardLabel,
    );
    if (submitLabel !== undefined) node.submitLabel = submitLabel;
    return node;
  }
  invalid(`${name}.type is not a supported card node.`);
}

/**
 * Validates one card tree and returns a normalized copy. Unknown node types,
 * unknown keys' values, HTML and links are rejected rather than stripped, so a
 * site learns about the mistake instead of silently losing part of its card.
 */
export function validateCard(input, name = "card") {
  if (!plainObject(input) || input.type !== "card")
    invalid(`${name} must be a node of type "card".`);
  const state = {
    nodes: 1,
    buttons: 0,
    fields: 0,
    formIds: new Set(),
    hasLocal: false,
  };
  if (!Array.isArray(input.children) || !input.children.length)
    invalid(`${name}.children must contain at least one node.`);
  const card = {
    type: "card",
    children: input.children.map((child, index) =>
      validateNode(child, `${name}.children[${index}]`, 2, state),
    ),
  };
  if (input.id != null) {
    const id = text(input.id, `${name}.id`, 32, true);
    if (!ID.test(id)) invalid(`${name}.id is invalid.`);
    card.id = id;
  }
  const title = text(input.title, `${name}.title`, LIMITS.cardLabel);
  if (title !== undefined) card.title = title;
  return card;
}

/** Form values the renderer collected, checked against the declared fields. */
export function validateCardValues(fields, values) {
  if (values == null) return {};
  if (!plainObject(values)) invalid("Card form values must be an object.");
  const output = {};
  for (const field of fields) {
    const value = Object.hasOwn(values, field.id)
      ? values[field.id]
      : field.default;
    if (field.type === "checkbox") {
      if (typeof value !== "boolean")
        invalid(`Field ${field.id} expects a boolean.`);
    } else if (field.type === "select") {
      if (!field.options.some((option) => option.value === value))
        invalid(`Field ${field.id} received an unknown option.`);
    } else {
      if (typeof value !== "string" || [...value].length > LIMITS.cardText)
        invalid(`Field ${field.id} expects bounded text.`);
      if (field.required && !value.trim())
        invalid(`Field ${field.id} is required.`);
    }
    output[field.id] = value;
  }
  return output;
}
