export const WIDTH = 960;
export const HEIGHT = 600;
export const STORAGE_KEY = "arjunah.paint.project.v1";

const clone = (value) => JSON.parse(JSON.stringify(value));
const esc = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function newProject() {
  return {
    schemaVersion: 1,
    width: WIDTH,
    height: HEIGHT,
    background: "#ffffff",
    objects: [],
    updatedAt: new Date().toISOString(),
  };
}

export function loadProject(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null");
    if (
      parsed?.schemaVersion !== 1 ||
      parsed.width !== WIDTH ||
      parsed.height !== HEIGHT ||
      typeof parsed.background !== "string" ||
      !Array.isArray(parsed.objects) ||
      parsed.objects.some(
        (object) =>
          !object ||
          typeof object !== "object" ||
          typeof object.id !== "string" ||
          !["stroke", "circle", "rectangle", "text", "fill"].includes(
            object.kind,
          ),
      ) ||
      new Set(parsed.objects.map((object) => object.id)).size !==
        parsed.objects.length
    )
      return { project: newProject(), recovered: Boolean(parsed) };
    return { project: parsed, recovered: false };
  } catch {
    return { project: newProject(), recovered: true };
  }
}

export function saveProject(project, storage = globalThis.localStorage) {
  project.updatedAt = new Date().toISOString();
  storage?.setItem(STORAGE_KEY, JSON.stringify(project));
}

export function objectId() {
  return `obj_${globalThis.crypto?.randomUUID?.().slice(0, 8) ?? Math.random().toString(36).slice(2, 10)}`;
}

export function makeObject(kind, data, source = "user") {
  return {
    id: objectId(),
    kind,
    source,
    createdAt: new Date().toISOString(),
    ...clone(data),
  };
}

export function resolveValue(value, unit, axis) {
  if (!Number.isFinite(value)) throw new Error(`${axis} must be a number.`);
  if (unit === "percent") {
    if (value < 0 || value > 100)
      throw new Error(`${axis} must be between 0 and 100 percent.`);
    const scale =
      axis === "x" ? WIDTH : axis === "y" ? HEIGHT : Math.min(WIDTH, HEIGHT);
    return (value / 100) * scale;
  }
  if (unit !== "px") throw new Error('unit must be "px" or "percent".');
  const max =
    axis === "x" ? WIDTH : axis === "y" ? HEIGHT : Math.min(WIDTH, HEIGHT);
  if (value < 0 || value > max)
    throw new Error(`${axis} is outside the canvas.`);
  return value;
}

export function fitPreviewSize(width, height, maxWidth = 480, maxHeight = 300) {
  if (
    ![width, height, maxWidth, maxHeight].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    throw new Error("Preview dimensions must be positive numbers.");
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function floodFill(ctx, x, y, color, tolerance = 0) {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const sx = Math.floor(x);
  const sy = Math.floor(y);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return;
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  const start = (sy * width + sx) * 4;
  const target = [...data.slice(start, start + 4)];
  const probe = document.createElement("canvas").getContext("2d");
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const replacement = [...probe.getImageData(0, 0, 1, 1).data];
  if (target.every((value, index) => value === replacement[index])) return;
  const matches = (index) =>
    Math.abs(data[index] - target[0]) <= tolerance &&
    Math.abs(data[index + 1] - target[1]) <= tolerance &&
    Math.abs(data[index + 2] - target[2]) <= tolerance &&
    Math.abs(data[index + 3] - target[3]) <= tolerance;
  const stack = [[sx, sy]];
  const queued = new Uint8Array(width * height);
  queued[sy * width + sx] = 1;
  while (stack.length) {
    const [px, py] = stack.pop();
    const index = (py * width + px) * 4;
    if (!matches(index)) continue;
    data.set(replacement, index);
    for (const [nx, ny] of [
      [px - 1, py],
      [px + 1, py],
      [px, py - 1],
      [px, py + 1],
    ]) {
      const queuedIndex = ny * width + nx;
      if (
        nx >= 0 &&
        ny >= 0 &&
        nx < width &&
        ny < height &&
        !queued[queuedIndex]
      ) {
        queued[queuedIndex] = 1;
        stack.push([nx, ny]);
      }
    }
  }
  ctx.putImageData(image, 0, 0);
}

export function drawObject(ctx, object) {
  ctx.save();
  if (object.kind === "stroke") {
    ctx.globalCompositeOperation =
      object.mode === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = object.color;
    ctx.lineWidth = object.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    object.points.forEach((point, index) =>
      index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y),
    );
    if (object.points.length === 1)
      ctx.lineTo(object.points[0].x + 0.01, object.points[0].y);
    ctx.stroke();
  } else if (object.kind === "circle") {
    ctx.beginPath();
    ctx.ellipse(object.cx, object.cy, object.rx, object.ry, 0, 0, Math.PI * 2);
    if (object.fill) {
      ctx.fillStyle = object.fill;
      ctx.fill();
    }
    if (object.outline && object.outlineWidth > 0) {
      ctx.strokeStyle = object.outline;
      ctx.lineWidth = object.outlineWidth;
      ctx.stroke();
    }
  } else if (object.kind === "rectangle") {
    const width = object.x2 - object.x1;
    const height = object.y2 - object.y1;
    if (object.fill) {
      ctx.fillStyle = object.fill;
      ctx.fillRect(object.x1, object.y1, width, height);
    }
    if (object.outline && object.outlineWidth > 0) {
      ctx.strokeStyle = object.outline;
      ctx.lineWidth = object.outlineWidth;
      ctx.strokeRect(object.x1, object.y1, width, height);
    }
  } else if (object.kind === "text") {
    ctx.fillStyle = object.color;
    ctx.font = `${object.fontSize}px ${object.fontFamily || "Arial, sans-serif"}`;
    ctx.textAlign = object.align || "left";
    ctx.textBaseline = "top";
    ctx.fillText(object.text, object.x, object.y);
  } else if (object.kind === "fill") {
    floodFill(ctx, object.x, object.y, object.color, object.tolerance);
  }
  ctx.restore();
}

export function renderScene(ctx, project, through = project.objects.length) {
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, project.width, project.height);
  ctx.fillStyle = project.background;
  ctx.fillRect(0, 0, project.width, project.height);
  ctx.restore();
  for (const object of project.objects.slice(0, through))
    drawObject(ctx, object);
}

export function objectBounds(object) {
  if (object.kind === "circle")
    return {
      x: object.cx - object.rx,
      y: object.cy - object.ry,
      width: object.rx * 2,
      height: object.ry * 2,
    };
  if (object.kind === "rectangle")
    return {
      x: Math.min(object.x1, object.x2),
      y: Math.min(object.y1, object.y2),
      width: Math.abs(object.x2 - object.x1),
      height: Math.abs(object.y2 - object.y1),
    };
  if (object.kind === "text")
    return {
      x: object.x,
      y: object.y,
      width: object.text.length * object.fontSize * 0.6,
      height: object.fontSize * 1.2,
    };
  if (object.kind === "fill")
    return { x: 0, y: 0, width: WIDTH, height: HEIGHT };
  const xs = object.points.map((point) => point.x);
  const ys = object.points.map((point) => point.y);
  const pad = object.width / 2;
  return {
    x: Math.min(...xs) - pad,
    y: Math.min(...ys) - pad,
    width: Math.max(...xs) - Math.min(...xs) + pad * 2,
    height: Math.max(...ys) - Math.min(...ys) + pad * 2,
  };
}

export function summarizeObject(object, index) {
  const style = {};
  for (const key of [
    "mode",
    "color",
    "fill",
    "outline",
    "width",
    "fontSize",
    "text",
  ])
    if (object[key] != null) style[key] = object[key];
  return {
    id: object.id,
    z: index,
    kind: object.kind,
    source: object.source,
    bounds: objectBounds(object),
    style,
  };
}

export function hitTest(project, x, y) {
  for (let index = project.objects.length - 1; index >= 0; index--) {
    const bounds = objectBounds(project.objects[index]);
    if (
      x >= bounds.x &&
      y >= bounds.y &&
      x <= bounds.x + bounds.width &&
      y <= bounds.y + bounds.height
    )
      return project.objects[index].id;
  }
  return null;
}

export function sceneSummary(project) {
  const palette = new Set([project.background]);
  project.objects.forEach((object) =>
    [object.color, object.fill, object.outline]
      .filter(Boolean)
      .forEach((color) => palette.add(color)),
  );
  return {
    width: project.width,
    height: project.height,
    objectCount: project.objects.length,
    palette: [...palette],
    objects: project.objects.map(summarizeObject),
  };
}

function vectorElement(object) {
  if (object.kind === "circle")
    return `<ellipse cx="${object.cx}" cy="${object.cy}" rx="${object.rx}" ry="${object.ry}" fill="${esc(object.fill || "none")}" stroke="${esc(object.outline || "none")}" stroke-width="${object.outlineWidth || 0}"/>`;
  if (object.kind === "rectangle")
    return `<rect x="${Math.min(object.x1, object.x2)}" y="${Math.min(object.y1, object.y2)}" width="${Math.abs(object.x2 - object.x1)}" height="${Math.abs(object.y2 - object.y1)}" fill="${esc(object.fill || "none")}" stroke="${esc(object.outline || "none")}" stroke-width="${object.outlineWidth || 0}"/>`;
  if (object.kind === "text")
    return `<text x="${object.x}" y="${object.y}" fill="${esc(object.color)}" font-size="${object.fontSize}" font-family="Arial, sans-serif" text-anchor="${object.align === "center" ? "middle" : object.align === "right" ? "end" : "start"}" dominant-baseline="hanging">${esc(object.text)}</text>`;
  if (object.kind === "stroke")
    return `<polyline points="${object.points.map((point) => `${point.x},${point.y}`).join(" ")}" fill="none" stroke="${esc(object.color)}" stroke-width="${object.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
  return "";
}

export function projectToSvg(
  project,
  makeCanvas = () => document.createElement("canvas"),
) {
  let elements = [
    `<rect width="100%" height="100%" fill="${esc(project.background)}"/>`,
  ];
  project.objects.forEach((object, index) => {
    if (
      object.kind === "fill" ||
      (object.kind === "stroke" && object.mode === "eraser")
    ) {
      const canvas = makeCanvas();
      canvas.width = project.width;
      canvas.height = project.height;
      renderScene(canvas.getContext("2d"), project, index + 1);
      elements = [
        `<image width="${project.width}" height="${project.height}" href="${canvas.toDataURL("image/png")}"/>`,
      ];
    } else elements.push(vectorElement(object));
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${project.width}" height="${project.height}" viewBox="0 0 ${project.width} ${project.height}">${elements.join("")}</svg>`;
}
