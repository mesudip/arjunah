import {
  commitObjects,
  deleteObjects,
  getProject,
  renderLogicalCanvas,
} from "./app.js";
import {
  HEIGHT,
  WIDTH,
  fitPreviewSize,
  makeObject,
  objectIdsForGroups,
  resolveValue,
  sceneSummary,
  summarizeObject,
} from "./scene.js";

const assistantPrompt = `You are the playful studio assistant inside अर्जुनः Paint: imaginative, witty, and a little mischievous, but never rude or distracting. Turn the user’s requests into real canvas edits with the provided tools; do not merely describe what you would draw. Inspect a non-empty canvas before changing it, and use look_at_canvas after substantial edits to verify the composition. Prefer percentage coordinates for whole-canvas layouts and pixels for fine details. Use true straight lines, curves, and rounded rectangles when they express the requested form better than many tiny strokes. Batch independent objects into the same tool round because tool rounds are limited. Give every multi-object visual element a short, unique snake_case group_name and reuse that exact name for all objects belonging to the element; this lets you replace or delete the element as a group later. Make bold, legible compositions with harmonious colors and useful whitespace. Use list_objects before deleting, delete only IDs or group_names the user clearly asked to remove, and prefer group_names for bulk corrections. Use eraser strokes only for spatial edits. Never claim a change succeeded unless the tool result confirms it. If a request is ambiguous, make a tasteful funny choice. After editing, reply in no more than three short sentences with a playful title or caption and a concise summary of what changed.`;

const state = document.querySelector("#extension-state");
const askButton = document.querySelector("#ask-ai");
const unitSchema = { type: "string", enum: ["px", "percent"] };
const numberSchema = { type: "number" };
const groupNameSchema = {
  type: "string",
  minLength: 1,
  maxLength: 48,
  description:
    "A short unique snake_case name shared by objects in one visual element.",
};
const colorSchema = {
  anyOf: [{ type: "string" }, { type: "null" }],
  description: "A #RRGGBB color, or null for no paint.",
};

function objectSchema(
  properties,
  required = Object.keys(properties).filter((key) => key !== "group_name"),
) {
  return { type: "object", properties, required, additionalProperties: false };
}

function groupName(value) {
  if (value == null) return null;
  if (!/^[a-z0-9][a-z0-9_]{0,47}$/.test(value))
    throw new Error(
      "group_name must be 1–48 lowercase letters, numbers, or underscores.",
    );
  return value;
}

function color(value, name, optional = false) {
  if (optional && value == null) return null;
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value))
    throw new Error(`${name} must be a #RRGGBB color.`);
  return value.toLowerCase();
}

function finite(value, name, minimum = -Infinity, maximum = Infinity) {
  if (!Number.isFinite(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  return value;
}

function resolve(value, unit, axis, name, positive = false) {
  const result = resolveValue(value, unit, axis);
  if (positive && result <= 0)
    throw new Error(`${name} must be greater than 0.`);
  return result;
}

function resultFor(objects) {
  const project = getProject();
  return {
    ok: true,
    objects: objects.map((object) =>
      summarizeObject(
        object,
        project.objects.findIndex((candidate) => candidate.id === object.id),
      ),
    ),
  };
}

function boundedSceneSummary(project, maxChars) {
  const full = sceneSummary(project);
  const result = { ...full, objects: [] };
  for (const object of full.objects) {
    result.objects.push(object);
    if (JSON.stringify(result).length > maxChars) {
      result.objects.pop();
      break;
    }
  }
  result.omittedObjects = full.objects.length - result.objects.length;
  return result;
}

function add(kind, data, label, requestedGroupName = null) {
  const name = groupName(requestedGroupName);
  const object = makeObject(
    kind,
    { ...data, ...(name ? { groupName: name } : {}) },
    "assistant",
  );
  commitObjects([object], label);
  return resultFor([object]);
}

const tools = [
  {
    name: "add_circle",
    description:
      "Add one filled and/or outlined circle at resolved canvas coordinates. Circles may clip naturally at canvas edges.",
    inputSchema: objectSchema(
      {
        unit: unitSchema,
        center_x: numberSchema,
        center_y: numberSchema,
        radius: numberSchema,
        fill: colorSchema,
        outline: colorSchema,
        outline_width: numberSchema,
        group_name: groupNameSchema,
      },
      ["unit", "center_x", "center_y", "radius"],
    ),
    handler(args) {
      const cx = resolve(args.center_x, args.unit, "x", "center_x");
      const cy = resolve(args.center_y, args.unit, "y", "center_y");
      const radius = resolve(args.radius, args.unit, "size", "radius", true);
      const outlineWidth = resolve(
        args.outline_width ?? 0,
        args.unit,
        "size",
        "outline_width",
      );
      const fill = color(args.fill, "fill", true);
      const outline = color(args.outline, "outline", true);
      if (!fill && !outline) throw new Error("Choose a fill or outline.");
      return add(
        "circle",
        { cx, cy, rx: radius, ry: radius, fill, outline, outlineWidth },
        "Assistant added a circle",
        args.group_name,
      );
    },
  },
  {
    name: "add_rectangle",
    description: "Add one filled and/or outlined rectangle from two corners.",
    inputSchema: objectSchema(
      {
        unit: unitSchema,
        x1: numberSchema,
        y1: numberSchema,
        x2: numberSchema,
        y2: numberSchema,
        fill: colorSchema,
        outline: colorSchema,
        outline_width: numberSchema,
        group_name: groupNameSchema,
      },
      ["unit", "x1", "y1", "x2", "y2"],
    ),
    handler(args) {
      const x1 = resolve(args.x1, args.unit, "x", "x1");
      const y1 = resolve(args.y1, args.unit, "y", "y1");
      const x2 = resolve(args.x2, args.unit, "x", "x2");
      const y2 = resolve(args.y2, args.unit, "y", "y2");
      if (x1 === x2 || y1 === y2)
        throw new Error("Rectangle corners must be distinct.");
      const fill = color(args.fill, "fill", true);
      const outline = color(args.outline, "outline", true);
      if (!fill && !outline) throw new Error("Choose a fill or outline.");
      const outlineWidth = resolve(
        args.outline_width ?? 0,
        args.unit,
        "size",
        "outline_width",
      );
      return add(
        "rectangle",
        { x1, y1, x2, y2, fill, outline, outlineWidth },
        "Assistant added a rectangle",
        args.group_name,
      );
    },
  },
  {
    name: "add_text",
    description: "Add a short text object with a color, size, and alignment.",
    inputSchema: objectSchema({
      unit: unitSchema,
      x: numberSchema,
      y: numberSchema,
      text: { type: "string", minLength: 1, maxLength: 500 },
      color: { type: "string" },
      font_size: numberSchema,
      alignment: { type: "string", enum: ["left", "center", "right"] },
      group_name: groupNameSchema,
    }),
    handler(args) {
      const x = resolve(args.x, args.unit, "x", "x");
      const y = resolve(args.y, args.unit, "y", "y");
      const fontSize = resolve(
        args.font_size,
        args.unit,
        "size",
        "font_size",
        true,
      );
      return add(
        "text",
        {
          x,
          y,
          text: args.text,
          color: color(args.color, "color"),
          fontSize,
          align: args.alignment,
          fontFamily: "Arial, sans-serif",
        },
        "Assistant added text",
        args.group_name,
      );
    },
  },
  {
    name: "add_rounded_rectangle",
    description:
      "Add one filled and/or outlined rounded rectangle from two corners and a corner radius.",
    inputSchema: objectSchema(
      {
        unit: unitSchema,
        x1: numberSchema,
        y1: numberSchema,
        x2: numberSchema,
        y2: numberSchema,
        corner_radius: numberSchema,
        fill: colorSchema,
        outline: colorSchema,
        outline_width: numberSchema,
        group_name: groupNameSchema,
      },
      ["unit", "x1", "y1", "x2", "y2", "corner_radius"],
    ),
    handler(args) {
      const x1 = resolve(args.x1, args.unit, "x", "x1");
      const y1 = resolve(args.y1, args.unit, "y", "y1");
      const x2 = resolve(args.x2, args.unit, "x", "x2");
      const y2 = resolve(args.y2, args.unit, "y", "y2");
      if (x1 === x2 || y1 === y2)
        throw new Error("Rounded rectangle corners must be distinct.");
      const radius = resolve(
        args.corner_radius,
        args.unit,
        "size",
        "corner_radius",
      );
      const fill = color(args.fill, "fill", true);
      const outline = color(args.outline, "outline", true);
      if (!fill && !outline) throw new Error("Choose a fill or outline.");
      const outlineWidth = resolve(
        args.outline_width ?? 0,
        args.unit,
        "size",
        "outline_width",
      );
      return add(
        "rounded_rectangle",
        { x1, y1, x2, y2, radius, fill, outline, outlineWidth },
        "Assistant added a rounded rectangle",
        args.group_name,
      );
    },
  },
  {
    name: "draw_stroke",
    description:
      "Draw one ordered pencil, brush, or eraser path with up to 256 points.",
    inputSchema: objectSchema({
      unit: unitSchema,
      points: {
        type: "array",
        minItems: 1,
        maxItems: 256,
        items: objectSchema({ x: numberSchema, y: numberSchema }),
      },
      mode: { type: "string", enum: ["pencil", "brush", "eraser"] },
      color: { type: "string" },
      width: numberSchema,
      group_name: groupNameSchema,
    }),
    handler(args) {
      const points = args.points.map((point, index) => ({
        x: resolve(point.x, args.unit, "x", `points[${index}].x`),
        y: resolve(point.y, args.unit, "y", `points[${index}].y`),
      }));
      const width = resolve(args.width, args.unit, "size", "width", true);
      return add(
        "stroke",
        { mode: args.mode, points, color: color(args.color, "color"), width },
        "Assistant drew a stroke",
        args.group_name,
      );
    },
  },
  {
    name: "draw_curve",
    description:
      "Draw one smooth curve through 2–64 ordered points. Prefer this over many short strokes for arcs and flowing lines.",
    inputSchema: objectSchema({
      unit: unitSchema,
      points: {
        type: "array",
        minItems: 2,
        maxItems: 64,
        items: objectSchema({ x: numberSchema, y: numberSchema }),
      },
      color: { type: "string" },
      width: numberSchema,
      group_name: groupNameSchema,
    }),
    handler(args) {
      const points = args.points.map((point, index) => ({
        x: resolve(point.x, args.unit, "x", `points[${index}].x`),
        y: resolve(point.y, args.unit, "y", `points[${index}].y`),
      }));
      const width = resolve(args.width, args.unit, "size", "width", true);
      return add(
        "curve",
        { points, color: color(args.color, "color"), width },
        "Assistant drew a curve",
        args.group_name,
      );
    },
  },
  {
    name: "draw_line",
    description: "Draw one straight line between two resolved canvas points.",
    inputSchema: objectSchema({
      unit: unitSchema,
      x1: numberSchema,
      y1: numberSchema,
      x2: numberSchema,
      y2: numberSchema,
      color: { type: "string" },
      width: numberSchema,
      group_name: groupNameSchema,
    }),
    handler(args) {
      const points = [
        {
          x: resolve(args.x1, args.unit, "x", "x1"),
          y: resolve(args.y1, args.unit, "y", "y1"),
        },
        {
          x: resolve(args.x2, args.unit, "x", "x2"),
          y: resolve(args.y2, args.unit, "y", "y2"),
        },
      ];
      const width = resolve(args.width, args.unit, "size", "width", true);
      return add(
        "line",
        { points, color: color(args.color, "color"), width },
        "Assistant drew a line",
        args.group_name,
      );
    },
  },
  {
    name: "fill_area",
    description:
      "Flood-fill the connected area at a seed point with bounded color tolerance.",
    inputSchema: objectSchema({
      unit: unitSchema,
      x: numberSchema,
      y: numberSchema,
      color: { type: "string" },
      tolerance: { type: "number", minimum: 0, maximum: 64 },
      group_name: groupNameSchema,
    }),
    handler(args) {
      return add(
        "fill",
        {
          x: resolve(args.x, args.unit, "x", "x"),
          y: resolve(args.y, args.unit, "y", "y"),
          color: color(args.color, "color"),
          tolerance: finite(args.tolerance, "tolerance", 0, 64),
        },
        "Assistant filled an area",
        args.group_name,
      );
    },
  },
  {
    name: "list_objects",
    description:
      "List compact object IDs, z-order, kinds, bounds rounded to 0.01 px, sources, and styles without image data.",
    inputSchema: objectSchema({}),
    handler() {
      const project = getProject();
      return boundedSceneSummary(project, 60_000);
    },
  },
  {
    name: "delete_objects",
    description:
      "Delete explicit stable object IDs and/or every object in named groups, reporting unknown targets harmlessly.",
    inputSchema: objectSchema(
      {
        ids: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: { type: "string", minLength: 1, maxLength: 80 },
        },
        group_names: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: groupNameSchema,
        },
      },
      [],
    ),
    handler(args) {
      const ids = args.ids ?? [];
      const names = (args.group_names ?? []).map(groupName);
      if (!ids.length && !names.length)
        throw new Error("Provide at least one id or group_name to delete.");
      const groups = objectIdsForGroups(getProject(), names);
      return {
        ok: true,
        ...deleteObjects([...ids, ...groups.ids]),
        deletedGroups: groups.foundGroups,
        missingGroups: groups.missingGroups,
      };
    },
  },
  {
    name: "look_at_canvas",
    description:
      "Return a downscaled WebP snapshot of the current canvas without object data.",
    outputContent: ["text", "image"],
    inputSchema: objectSchema({}),
    handler() {
      const project = getProject();
      const size = fitPreviewSize(project.width, project.height);
      const preview = document.createElement("canvas");
      preview.width = size.width;
      preview.height = size.height;
      preview
        .getContext("2d")
        .drawImage(renderLogicalCanvas(), 0, 0, size.width, size.height);
      const url = preview.toDataURL("image/webp", 0.72);
      if (!url.startsWith("data:image/webp;base64,"))
        throw new Error("This browser could not create a WebP preview.");
      return {
        kind: "content",
        content: [
          {
            type: "text",
            text: `Canvas snapshot: ${size.width}×${size.height} WebP, rendered from a ${project.width}×${project.height} canvas.`,
          },
          {
            type: "image",
            mediaType: "image/webp",
            data: url.slice("data:image/webp;base64,".length),
          },
        ],
      };
    },
  },
];

function findApi() {
  return window.ai?.arjunah ?? null;
}

async function register() {
  const api = findApi();
  if (!api) {
    state.textContent = "Install अर्जुनः to use the studio assistant";
    askButton.disabled = true;
    return;
  }
  try {
    await api.site.register({
      name: "अर्जुनः Paint studio assistant",
      description:
        "A playful assistant that edits this retained-object canvas through eleven narrow tools.",
      systemPrompt: assistantPrompt,
      tools,
      widget: {
        autoShow: false,
        toolCallView: "detailed",
        greeting:
          "Tell me what to paint, or ask me to improve the doodle already here.",
        placeholder: "Paint something mischievous…",
        suggestions: [
          "Draw a moon garden with bold, harmonious colors",
          "Create a circle-and-brush sunset",
          "Look at my doodle and improve it",
          "List the objects, then remove one that feels out of place",
        ],
        theme: { accent: "#3157c8", mode: "auto" },
      },
    });
    state.textContent = `अर्जुनः ${api.version} ready · level 0`;
    askButton.disabled = false;
    askButton.addEventListener("click", () => api.chat.open());
  } catch (error) {
    state.textContent = `Assistant unavailable: ${error.message}`;
    askButton.disabled = true;
  }
}

if (findApi()) void register();
else {
  window.addEventListener("arjunah:ready", register, { once: true });
  setTimeout(() => {
    if (!findApi()) {
      state.textContent = "Install अर्जुनः to use the studio assistant";
      askButton.disabled = true;
    }
  }, 1800);
}
