// SPDX-License-Identifier: MIT
import { BrokerError } from "./errors.js";
import { GENERATE_LIMITS } from "./constants.js";

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
// Annotations that schema generators (Pydantic, FastAPI, zod-to-json-schema)
// emit routinely, with the JSON type each value must have. They are accepted
// so that one of them does not fail a whole catalog, are never enforced, and
// are removed by `providerSchema` before any provider wire format, because
// providers disagree about which of them they accept.
const hints = new Map([
  ["format", "string"],
  ["contentMediaType", "string"],
  ["contentEncoding", "string"],
  ["readOnly", "boolean"],
  ["writeOnly", "boolean"],
  ["deprecated", "boolean"],
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
const combinators = ["anyOf", "oneOf", "allOf"];
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = () => {
  throw new BrokerError(
    "INVALID_REQUEST",
    "Tool schema is invalid or uses an unsupported keyword.",
  );
};

// Keywords that constrain instances of one type only. A type list hands each
// of them to the alternative of its own type, which leaves the meaning alone.
const typedKeywords = {
  object: ["properties", "required", "additionalProperties"],
  array: ["items", "minItems", "maxItems"],
  string: ["minLength", "maxLength"],
  number: ["minimum", "maximum"],
  integer: ["minimum", "maximum"],
};

/**
 * `{ type: [a, b], ...rest }` rewritten with one type per schema: an `anyOf`
 * of single-type alternatives, each carrying the keywords that constrain only
 * its own type. That is the shape Pydantic emits for an optional field, the
 * one providers already receive most. When `anyOf` is already taken the
 * alternatives join `allOf` as one more member. A one-element list is a plain
 * `type`. Only this level is rewritten; children are reached by validation.
 */
function expandTypeList(schema) {
  const names = schema.type;
  if (
    !names.length ||
    names.some((name) => typeof name !== "string" || !types.has(name)) ||
    new Set(names).size !== names.length
  )
    fail();
  if (names.length === 1) return { ...schema, type: names[0] };
  const moved = new Set(names.flatMap((name) => typedKeywords[name] ?? []));
  const rest = Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== "type" && !moved.has(key)),
  );
  const branches = names.map((name) =>
    Object.fromEntries([
      ["type", name],
      ...(typedKeywords[name] ?? [])
        .filter((key) => Object.hasOwn(schema, key))
        .map((key) => [key, schema[key]]),
    ]),
  );
  if (!Object.hasOwn(rest, "anyOf")) return { ...rest, anyOf: branches };
  if (Object.hasOwn(rest, "allOf") && !Array.isArray(rest.allOf)) fail();
  return { ...rest, allOf: [...(rest.allOf ?? []), { anyOf: branches }] };
}

/**
 * Checks a schema against the bounded subset and returns the copy the broker
 * uses from then on; the input is never modified. A `type` list is rewritten
 * first (see `expandTypeList`), so argument validation, the contract
 * fingerprint, and every provider see one form, and the depth and combinator
 * bounds apply to that form rather than to what was sent.
 */
export function validateSchema(schema, depth = 0) {
  if (depth > GENERATE_LIMITS.schemaDepth || !object(schema)) fail();
  if (Array.isArray(schema.type)) {
    const expanded = expandTypeList(schema);
    // Tool input schemas describe objects, so the root takes one type.
    if (depth === 0 && !Object.hasOwn(expanded, "type")) fail();
    return validateSchema(expanded, depth);
  }
  if (depth === 0 && schema.type != null && schema.type !== "object") fail();
  const entries = [];
  for (const [key, value] of Object.entries(schema)) {
    if (annotations.has(key)) {
      if (
        ["title", "description", "$schema", "$comment"].includes(key) &&
        typeof value !== "string"
      )
        fail();
      if (key === "examples" && !Array.isArray(value)) fail();
      entries.push([key, value]);
      continue;
    }
    if (hints.has(key)) {
      if (typeof value !== hints.get(key)) fail();
      entries.push([key, value]);
      continue;
    }
    if (!keywords.has(key)) fail();
    let next = value;
    if (key === "type" && !(typeof value === "string" && types.has(value)))
      fail();
    if (key === "properties") {
      if (!object(value)) fail();
      // fromEntries, not assignment, so a property named `__proto__` stays
      // an ordinary property.
      next = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          validateSchema(child, depth + 1),
        ]),
      );
    }
    if (
      key === "required" &&
      (!Array.isArray(value) ||
        value.some((item) => typeof item !== "string") ||
        new Set(value).size !== value.length)
    )
      fail();
    if (key === "items") next = validateSchema(value, depth + 1);
    if (key === "additionalProperties" && typeof value !== "boolean")
      next = validateSchema(value, depth + 1);
    if (["minimum", "maximum"].includes(key) && !Number.isFinite(value)) fail();
    if (
      ["minLength", "maxLength", "minItems", "maxItems"].includes(key) &&
      (!Number.isSafeInteger(value) || value < 0)
    )
      fail();
    if (key === "enum" && (!Array.isArray(value) || !value.length)) fail();
    if (combinators.includes(key)) {
      if (!Array.isArray(value) || !value.length || value.length > 32) fail();
      next = value.map((child) => validateSchema(child, depth + 1));
    }
    entries.push([key, next]);
  }
  return Object.fromEntries(entries);
}

/**
 * A validated schema as it may reach a provider: the `hints` are removed at
 * every schema position and everything else is kept. Only schema positions
 * are walked; property names and the values of `enum`, `const`, `default`
 * and `examples` are data, so a property called `format` survives.
 */
export function providerSchema(schema) {
  if (!object(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema)
      .filter(([key]) => !hints.has(key))
      .map(([key, value]) => [
        key,
        key === "properties"
          ? Object.fromEntries(
              Object.entries(value).map(([name, child]) => [
                name,
                providerSchema(child),
              ]),
            )
          : key === "items" || key === "additionalProperties"
            ? providerSchema(value)
            : combinators.includes(key)
              ? value.map(providerSchema)
              : value,
      ]),
  );
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

/** The JSON type name of a value, as a schema would spell it. */
function typeName(value) {
  return value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : typeof value;
}

/**
 * Records why a value was rejected, and where.
 *
 * Only the path, the declared constraint, and the *type* of what arrived are
 * ever written down: a reason travels back to the model and into the
 * transcript, so it must describe the shape of the mistake and never the
 * content of an argument. Enum members are the one exception, and they are the
 * site's own declared schema rather than anything the model or the user typed.
 *
 * First write wins, so the outermost meaningful failure is the one reported
 * instead of whatever the last short-circuit happened to be.
 */
function note(report, path, reason) {
  if (report && !report.reason) {
    report.path = path;
    report.reason = `${path || "the arguments"} ${reason}`;
  }
  return false;
}

function preview(values) {
  const list = values.map((item) => JSON.stringify(item)).join(", ");
  return list.length > 200 ? `${list.slice(0, 200)}…` : list;
}

function matches(value, schema, depth = 0, path = "", report = null) {
  if (depth > 32)
    return note(report, path, "is nested too deeply to validate.");
  const actual = typeName(value);
  if (
    schema.type &&
    !(
      schema.type === actual ||
      (schema.type === "integer" && Number.isInteger(value))
    )
  )
    return note(
      report,
      path,
      `must be ${schema.type}, but ${actual} was sent.`,
    );
  if (schema.enum && !schema.enum.some((item) => equal(value, item)))
    return note(report, path, `must be one of: ${preview(schema.enum)}.`);
  if (Object.hasOwn(schema, "const") && !equal(value, schema.const))
    return note(report, path, `must be ${JSON.stringify(schema.const)}.`);
  // Branch keywords validate their children silently: a child's reason
  // describes one rejected alternative, not why the whole branch failed.
  if (
    schema.anyOf &&
    !schema.anyOf.some((item) => matches(value, item, depth + 1))
  )
    return note(report, path, "did not match any of the allowed shapes.");
  if (
    schema.oneOf &&
    schema.oneOf.filter((item) => matches(value, item, depth + 1)).length !== 1
  )
    return note(report, path, "must match exactly one of the allowed shapes.");
  if (
    schema.allOf &&
    !schema.allOf.every((item) => matches(value, item, depth + 1))
  )
    return note(report, path, "did not match all of the required shapes.");
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      return note(report, path, "must be a finite number.");
    if (value < (schema.minimum ?? -Infinity))
      return note(report, path, `must be at least ${schema.minimum}.`);
    if (value > (schema.maximum ?? Infinity))
      return note(report, path, `must be at most ${schema.maximum}.`);
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (length < (schema.minLength ?? 0))
      return note(
        report,
        path,
        `must be at least ${schema.minLength} characters, but ${length} were sent.`,
      );
    if (length > (schema.maxLength ?? Infinity))
      return note(
        report,
        path,
        `must be at most ${schema.maxLength} characters, but ${length} were sent.`,
      );
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0))
      return note(
        report,
        path,
        `must have at least ${schema.minItems} items, but ${value.length} were sent.`,
      );
    if (value.length > (schema.maxItems ?? Infinity))
      return note(
        report,
        path,
        `must have at most ${schema.maxItems} items, but ${value.length} were sent.`,
      );
    if (
      schema.items &&
      !value.every((item, index) =>
        matches(item, schema.items, depth + 1, `${path}[${index}]`, report),
      )
    )
      return false;
  }
  if (object(value)) {
    const missing = (schema.required ?? []).filter(
      (key) => !Object.hasOwn(value, key),
    );
    if (missing.length)
      return note(
        report,
        path,
        `is missing the required ${missing.length === 1 ? "property" : "properties"} ${preview(missing)}.`,
      );
    for (const [key, item] of Object.entries(value)) {
      const child = Object.hasOwn(schema.properties ?? {}, key)
        ? schema.properties[key]
        : schema.additionalProperties;
      const childPath = path ? `${path}.${key}` : key;
      if (child === false)
        return note(report, childPath, "is not a property this tool accepts.");
      if (object(child) && !matches(item, child, depth + 1, childPath, report))
        return false;
    }
  }
  return true;
}

/**
 * Model-supplied arguments checked against the tool's declared schema.
 *
 * A failure is the model's mistake to correct, so the thrown message names the
 * offending property and the constraint it broke. The turn hands that text
 * back as the tool result rather than ending the turn, and a useless "invalid
 * arguments" would only earn the same invalid call again.
 */
export function validateArguments(args, schema) {
  if (!object(args))
    throw new BrokerError(
      "TOOL_ERROR",
      `Tool arguments must be a JSON object, but ${typeName(args)} was sent.`,
    );
  const report = { path: "", reason: "" };
  if (!matches(args, schema, 0, "", report))
    throw new BrokerError(
      "TOOL_ERROR",
      report.reason
        ? `Tool arguments do not match the declared schema: ${report.reason}`
        : "Tool arguments do not match the declared schema.",
    );
  return args;
}
