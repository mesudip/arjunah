import { BrokerError } from "./errors.js";

// Deliberately bounded JSON Schema subset; unsupported assertions are rejected,
// never silently treated as validated. No references or executable regexes.
const types = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);
const annotations = new Set([
  "title",
  "description",
  "default",
  "examples",
  "$schema",
  "$comment",
]);
const keywords = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "anyOf",
  "oneOf",
  "allOf",
]);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = () => {
  throw new BrokerError(
    "INVALID_REQUEST",
    "Tool schema is invalid or uses an unsupported keyword.",
  );
};

export function validateSchema(schema, depth = 0) {
  if (depth > 16 || !object(schema)) fail();
  if (depth === 0 && schema.type != null && schema.type !== "object") fail();
  for (const [key, value] of Object.entries(schema)) {
    if (annotations.has(key)) {
      if (
        ["title", "description", "$schema", "$comment"].includes(key) &&
        typeof value !== "string"
      )
        fail();
      if (key === "examples" && !Array.isArray(value)) fail();
      continue;
    }
    if (!keywords.has(key)) fail();
    if (key === "type" && !(typeof value === "string" && types.has(value)))
      fail();
    if (key === "properties") {
      if (!object(value)) fail();
      for (const child of Object.values(value))
        validateSchema(child, depth + 1);
    }
    if (
      key === "required" &&
      (!Array.isArray(value) ||
        value.some((item) => typeof item !== "string") ||
        new Set(value).size !== value.length)
    )
      fail();
    if (key === "items") validateSchema(value, depth + 1);
    if (key === "additionalProperties" && typeof value !== "boolean")
      validateSchema(value, depth + 1);
    if (["minimum", "maximum"].includes(key) && !Number.isFinite(value)) fail();
    if (
      ["minLength", "maxLength", "minItems", "maxItems"].includes(key) &&
      (!Number.isSafeInteger(value) || value < 0)
    )
      fail();
    if (key === "enum" && (!Array.isArray(value) || !value.length)) fail();
    if (["anyOf", "oneOf", "allOf"].includes(key)) {
      if (!Array.isArray(value) || !value.length || value.length > 32) fail();
      value.forEach((child) => validateSchema(child, depth + 1));
    }
  }
  return schema;
}

function equal(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => equal(item, b[i]));
  if (object(a) && object(b))
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.keys(a).every(
        (key) => Object.hasOwn(b, key) && equal(a[key], b[key]),
      )
    );
  return false;
}

function matches(value, schema, depth = 0) {
  if (depth > 32) return false;
  const actual =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (
    schema.type &&
    !(
      schema.type === actual ||
      (schema.type === "integer" && Number.isInteger(value))
    )
  )
    return false;
  if (schema.enum && !schema.enum.some((item) => equal(value, item)))
    return false;
  if (Object.hasOwn(schema, "const") && !equal(value, schema.const))
    return false;
  if (
    schema.anyOf &&
    !schema.anyOf.some((item) => matches(value, item, depth + 1))
  )
    return false;
  if (
    schema.oneOf &&
    schema.oneOf.filter((item) => matches(value, item, depth + 1)).length !== 1
  )
    return false;
  if (
    schema.allOf &&
    !schema.allOf.every((item) => matches(value, item, depth + 1))
  )
    return false;
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) ||
      value < (schema.minimum ?? -Infinity) ||
      value > (schema.maximum ?? Infinity))
  )
    return false;
  if (
    typeof value === "string" &&
    ([...value].length < (schema.minLength ?? 0) ||
      [...value].length > (schema.maxLength ?? Infinity))
  )
    return false;
  if (Array.isArray(value)) {
    if (
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? Infinity)
    )
      return false;
    if (
      schema.items &&
      !value.every((item) => matches(item, schema.items, depth + 1))
    )
      return false;
  }
  if (object(value)) {
    if (schema.required?.some((key) => !Object.hasOwn(value, key)))
      return false;
    for (const [key, item] of Object.entries(value)) {
      const child = Object.hasOwn(schema.properties ?? {}, key)
        ? schema.properties[key]
        : schema.additionalProperties;
      if (
        child === false ||
        (object(child) && !matches(item, child, depth + 1))
      )
        return false;
    }
  }
  return true;
}

export function validateArguments(args, schema) {
  if (!object(args) || !matches(args, schema))
    throw new BrokerError(
      "TOOL_ERROR",
      "Tool arguments do not match the declared schema.",
    );
  return args;
}
