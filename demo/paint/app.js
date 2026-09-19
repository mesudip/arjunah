import {
  HEIGHT,
  WIDTH,
  drawObject,
  hitTest,
  loadProject,
  makeObject,
  newProject,
  objectBounds,
  projectToSvg,
  renderScene,
  saveProject,
} from "./scene.js";

const canvas = document.querySelector("#canvas");
const display = canvas.getContext("2d");
const logical = document.createElement("canvas");
logical.width = WIDTH;
logical.height = HEIGHT;
const context = logical.getContext("2d", { willReadFrequently: true });
const status = document.querySelector("#status");
const coordinates = document.querySelector("#coords");
const objectList = document.querySelector("#object-list");
const objectCount = document.querySelector("#object-count");
const deleteButton = document.querySelector("#delete-object");
const undoButton = document.querySelector("#undo");
const redoButton = document.querySelector("#redo");
const colorInput = document.querySelector("#color");
const sizeInput = document.querySelector("#size");
const shapeStyleInput = document.querySelector("#shape-style");
const palette = document.querySelector("#palette");
const toolButtons = [...document.querySelectorAll("[data-tool]")];

const colors = [
  "#111827",
  "#ffffff",
  "#ef4444",
  "#f97316",
  "#facc15",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#6366f1",
  "#a855f7",
  "#ec4899",
  "#92400e",
];
const recovered = loadProject();
let project = recovered.project;
let tool = "pencil";
let selectedId = null;
let gesture = null;
let undoStack = [];
let redoStack = [];
let saveTimer = null;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setStatus(message, problem = false) {
  status.textContent = message;
  status.classList.toggle("problem", problem);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      saveProject(project);
      setStatus(
        `Saved ${project.objects.length} object${project.objects.length === 1 ? "" : "s"}`,
      );
    } catch {
      setStatus("Could not autosave; your drawing is still open.", true);
    }
  }, 180);
}

function resizeDisplay() {
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.round(WIDTH * ratio);
  const height = Math.round(HEIGHT * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  display.imageSmoothingEnabled = true;
  display.clearRect(0, 0, width, height);
  display.drawImage(logical, 0, 0, width, height);
}

function paint(preview = null) {
  renderScene(context, project);
  if (preview) drawObject(context, preview);
  const selected = project.objects.find((object) => object.id === selectedId);
  if (selected) {
    const bounds = objectBounds(selected);
    context.save();
    context.globalCompositeOperation = "source-over";
    context.strokeStyle = "#3157c8";
    context.lineWidth = 1;
    context.setLineDash([6, 4]);
    context.strokeRect(
      bounds.x - 3,
      bounds.y - 3,
      bounds.width + 6,
      bounds.height + 6,
    );
    context.restore();
  }
  resizeDisplay();
}

function refreshObjects() {
  objectCount.textContent = String(project.objects.length);
  objectList.replaceChildren();
  [...project.objects].reverse().forEach((object, reverseIndex) => {
    const index = project.objects.length - reverseIndex - 1;
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = selectedId === object.id ? "active" : "";
    button.textContent = `${index + 1}. ${object.kind}${object.source === "assistant" ? " ✨" : ""} · ${object.id}`;
    button.addEventListener("click", () => selectObject(object.id));
    item.append(button);
    objectList.append(item);
  });
  deleteButton.disabled = !project.objects.some(
    (object) => object.id === selectedId,
  );
  undoButton.disabled = undoStack.length === 0;
  redoButton.disabled = redoStack.length === 0;
}

function selectObject(id) {
  selectedId = id;
  refreshObjects();
  setStatus(id ? `Selected ${id}` : "Ready");
}

function snapshotForUndo() {
  undoStack.push(clone(project));
  if (undoStack.length > 80) undoStack.shift();
  redoStack = [];
}

export function commitObjects(objects, message = "Drawing updated") {
  if (!objects.length) return [];
  snapshotForUndo();
  project.objects.push(...objects);
  selectedId = objects.at(-1).id;
  paint();
  refreshObjects();
  scheduleSave();
  setStatus(message);
  window.dispatchEvent(new CustomEvent("arjunah-paint-change"));
  return objects;
}

export function deleteObjects(ids) {
  const requested = [...new Set(ids)];
  const present = new Set(project.objects.map((object) => object.id));
  const deleted = requested.filter((id) => present.has(id));
  const missing = requested.filter((id) => !present.has(id));
  if (deleted.length) {
    snapshotForUndo();
    const removing = new Set(deleted);
    project.objects = project.objects.filter(
      (object) => !removing.has(object.id),
    );
    if (removing.has(selectedId)) selectedId = null;
    paint();
    refreshObjects();
    scheduleSave();
    window.dispatchEvent(new CustomEvent("arjunah-paint-change"));
  }
  return { deleted, missing };
}

export function getProject() {
  return clone(project);
}

export function renderLogicalCanvas() {
  renderScene(context, project);
  return logical;
}

function setTool(next) {
  tool = next;
  toolButtons.forEach((button) =>
    button.classList.toggle("active", button.dataset.tool === next),
  );
  canvas.dataset.tool = next;
  setStatus(`${next[0].toUpperCase()}${next.slice(1)} selected`);
}

function canvasPoint(event) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - bounds.left) / bounds.width) * WIDTH,
    y: ((event.clientY - bounds.top) / bounds.height) * HEIGHT,
  };
}

function strokeWidth() {
  const size = Number(sizeInput.value);
  if (tool === "brush") return size * 2;
  if (tool === "eraser") return Math.max(8, size * 3);
  return size;
}

function shapePaint() {
  return {
    fill: shapeStyleInput.value === "outline" ? null : colorInput.value,
    outline: shapeStyleInput.value === "fill" ? null : colorInput.value,
    outlineWidth: shapeStyleInput.value === "fill" ? 0 : strokeWidth(),
  };
}

function pointerDown(event) {
  if (event.button !== 0) return;
  const point = canvasPoint(event);
  canvas.setPointerCapture(event.pointerId);
  if (tool === "select") {
    selectObject(hitTest(project, point.x, point.y));
    return;
  }
  if (tool === "eyedropper") {
    paint();
    const pixel = context.getImageData(
      Math.max(0, Math.min(WIDTH - 1, Math.floor(point.x))),
      Math.max(0, Math.min(HEIGHT - 1, Math.floor(point.y))),
      1,
      1,
    ).data;
    colorInput.value = `#${[pixel[0], pixel[1], pixel[2]]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("")}`;
    updatePaletteSelection();
    setStatus(`Picked ${colorInput.value}`);
    return;
  }
  if (tool === "fill") {
    commitObjects(
      [
        makeObject("fill", {
          x: point.x,
          y: point.y,
          color: colorInput.value,
          tolerance: 0,
        }),
      ],
      "Area filled",
    );
    return;
  }
  if (tool === "text") {
    const text = window.prompt("Text to place on the canvas:");
    if (text) {
      commitObjects(
        [
          makeObject("text", {
            x: point.x,
            y: point.y,
            text: text.slice(0, 500),
            color: colorInput.value,
            fontSize: Math.max(12, Number(sizeInput.value) * 4),
            align: "left",
            fontFamily: "Arial, sans-serif",
          }),
        ],
        "Text added",
      );
    }
    return;
  }
  gesture = { start: point, points: [point], pointerId: event.pointerId };
}

function pointerMove(event) {
  const point = canvasPoint(event);
  coordinates.textContent = `${Math.round(point.x)}, ${Math.round(point.y)} px`;
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  if (["pencil", "brush", "eraser"].includes(tool)) {
    const last = gesture.points.at(-1);
    const minimum = Math.max(0.8, strokeWidth() * 0.16);
    if (
      gesture.points.length < 2048 &&
      Math.hypot(point.x - last.x, point.y - last.y) >= minimum
    )
      gesture.points.push(point);
    paint(
      makeObject("stroke", {
        mode: tool,
        points: gesture.points,
        color: colorInput.value,
        width: strokeWidth(),
      }),
    );
  } else if (tool === "circle") {
    paint(
      makeObject("circle", {
        cx: (gesture.start.x + point.x) / 2,
        cy: (gesture.start.y + point.y) / 2,
        rx: Math.abs(point.x - gesture.start.x) / 2,
        ry: Math.abs(point.y - gesture.start.y) / 2,
        ...shapePaint(),
      }),
    );
  } else if (tool === "rectangle") {
    paint(
      makeObject("rectangle", {
        x1: gesture.start.x,
        y1: gesture.start.y,
        x2: point.x,
        y2: point.y,
        ...shapePaint(),
      }),
    );
  }
}

function pointerUp(event) {
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const point = canvasPoint(event);
  let object = null;
  if (["pencil", "brush", "eraser"].includes(tool)) {
    if (gesture.points.length < 2048) gesture.points.push(point);
    object = makeObject("stroke", {
      mode: tool,
      points: gesture.points,
      color: colorInput.value,
      width: strokeWidth(),
    });
  } else if (tool === "circle") {
    const rx = Math.abs(point.x - gesture.start.x) / 2;
    const ry = Math.abs(point.y - gesture.start.y) / 2;
    if (rx >= 0.5 && ry >= 0.5)
      object = makeObject("circle", {
        cx: (gesture.start.x + point.x) / 2,
        cy: (gesture.start.y + point.y) / 2,
        rx,
        ry,
        ...shapePaint(),
      });
  } else if (tool === "rectangle") {
    if (
      Math.abs(point.x - gesture.start.x) >= 1 &&
      Math.abs(point.y - gesture.start.y) >= 1
    )
      object = makeObject("rectangle", {
        x1: gesture.start.x,
        y1: gesture.start.y,
        x2: point.x,
        y2: point.y,
        ...shapePaint(),
      });
  }
  gesture = null;
  object ? commitObjects([object]) : paint();
}

function restore(next, destination) {
  destination.push(clone(project));
  project = clone(next);
  selectedId = null;
  paint();
  refreshObjects();
  scheduleSave();
  window.dispatchEvent(new CustomEvent("arjunah-paint-change"));
}

function download(name, blob) {
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function updatePaletteSelection() {
  [...palette.children].forEach((button) =>
    button.classList.toggle(
      "selected",
      button.dataset.color.toLowerCase() === colorInput.value.toLowerCase(),
    ),
  );
}

for (const value of colors) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "swatch";
  button.dataset.color = value;
  button.title = value;
  button.setAttribute("aria-label", `Use ${value}`);
  button.style.background = value;
  button.addEventListener("click", () => {
    colorInput.value = value;
    updatePaletteSelection();
  });
  palette.append(button);
}

toolButtons.forEach((button) =>
  button.addEventListener("click", () => setTool(button.dataset.tool)),
);
colorInput.addEventListener("input", updatePaletteSelection);
canvas.addEventListener("pointerdown", pointerDown);
canvas.addEventListener("pointermove", pointerMove);
canvas.addEventListener("pointerup", pointerUp);
canvas.addEventListener("pointercancel", () => {
  gesture = null;
  paint();
});
window.addEventListener("resize", resizeDisplay);

deleteButton.addEventListener("click", () => {
  if (selectedId) deleteObjects([selectedId]);
});
undoButton.addEventListener("click", () => {
  const prior = undoStack.pop();
  if (prior) restore(prior, redoStack);
});
redoButton.addEventListener("click", () => {
  const next = redoStack.pop();
  if (next) restore(next, undoStack);
});
document.querySelector("#new").addEventListener("click", () => {
  if (
    project.objects.length &&
    !window.confirm("Start a new canvas? The current drawing will be replaced.")
  )
    return;
  snapshotForUndo();
  project = newProject();
  selectedId = null;
  paint();
  refreshObjects();
  scheduleSave();
});
document.querySelector("#download-png").addEventListener("click", () => {
  renderLogicalCanvas().toBlob((blob) => {
    if (blob) download("arjunah-paint.png", blob);
  }, "image/png");
});
document.querySelector("#download-svg").addEventListener("click", () => {
  const svg = projectToSvg(project);
  download(
    "arjunah-paint.svg",
    new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
  );
});

updatePaletteSelection();
paint();
refreshObjects();
if (recovered.recovered)
  setStatus("Saved drawing was damaged; opened a fresh canvas.", true);
else if (project.objects.length)
  setStatus(`Restored ${project.objects.length} saved objects`);
