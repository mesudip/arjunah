import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HEIGHT,
  WIDTH,
  fitPreviewSize,
  loadProject,
  makeObject,
  newProject,
  projectToSvg,
  resolveValue,
  saveProject,
  sceneSummary,
} from "../demo/paint/scene.js";

test("Paint resolves pixel and percentage geometry without clamping", () => {
  assert.equal(resolveValue(50, "percent", "x"), WIDTH / 2);
  assert.equal(resolveValue(50, "percent", "y"), HEIGHT / 2);
  assert.equal(resolveValue(10, "percent", "size"), 60);
  assert.equal(resolveValue(960, "px", "x"), 960);
  assert.throws(() => resolveValue(101, "percent", "x"), /between 0 and 100/);
  assert.throws(() => resolveValue(601, "px", "size"), /outside/);
});

test("Paint snapshot dimensions preserve the source aspect ratio", () => {
  assert.deepEqual(fitPreviewSize(960, 600), { width: 480, height: 300 });
  assert.deepEqual(fitPreviewSize(1920, 600), { width: 480, height: 150 });
  assert.deepEqual(fitPreviewSize(600, 960), { width: 188, height: 300 });
  assert.deepEqual(fitPreviewSize(240, 120), { width: 240, height: 120 });
});

test("Paint objects have stable metadata and ordered compact summaries", () => {
  const first = makeObject(
    "rectangle",
    {
      x1: 10,
      y1: 20,
      x2: 50,
      y2: 70,
      fill: "#ffffff",
      outline: "#111827",
      outlineWidth: 2,
    },
    "assistant",
  );
  const second = makeObject("text", {
    x: 30,
    y: 40,
    text: "hello",
    color: "#111827",
    fontSize: 20,
    align: "left",
  });
  const project = { ...newProject(), objects: [first, second] };
  const summary = sceneSummary(project);
  assert.notEqual(first.id, second.id);
  assert.equal(first.source, "assistant");
  assert.match(first.createdAt, /^\d{4}-/);
  assert.deepEqual(
    summary.objects.map(({ id, z }) => [id, z]),
    [
      [first.id, 0],
      [second.id, 1],
    ],
  );
  assert.equal(JSON.stringify(summary).includes("data:image"), false);
});

test("Paint persistence recovers from corruption and surfaces quota failures", () => {
  const broken = { getItem: () => "not json" };
  assert.equal(loadProject(broken).recovered, true);
  assert.equal(loadProject(broken).project.objects.length, 0);
  assert.throws(() =>
    saveProject(newProject(), {
      setItem() {
        throw new Error("quota");
      },
    }),
  );
});

test("SVG export escapes text and creates a raster checkpoint for erasing", () => {
  const text = makeObject("text", {
    x: 10,
    y: 10,
    text: "<moon & stars>",
    color: "#111827",
    fontSize: 20,
    align: "left",
  });
  const eraser = makeObject("stroke", {
    mode: "eraser",
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ],
    color: "#ffffff",
    width: 5,
  });
  const later = makeObject("text", {
    x: 20,
    y: 20,
    text: "<moon & stars>",
    color: "#ef4444",
    fontSize: 18,
    align: "left",
  });
  const fakeContext = {
    canvas: { width: WIDTH, height: HEIGHT },
    save() {},
    restore() {},
    clearRect() {},
    fillRect() {},
    strokeRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    fill() {},
    ellipse() {},
    fillText() {},
  };
  const svg = projectToSvg(
    { ...newProject(), objects: [text, eraser, later] },
    () => ({
      width: 0,
      height: 0,
      getContext: () => fakeContext,
      toDataURL: () => "data:image/png;base64,known",
    }),
  );
  assert.match(svg, /data:image\/png;base64,known/);
  assert.match(svg, /&lt;moon &amp; stars&gt;/);
});

test("Pages demo is relative and Paint uses only the hosted level-0 API", () => {
  const landing = readFileSync("demo/index.html", "utf8");
  const paint = [
    "demo/paint/index.html",
    "demo/paint/app.js",
    "demo/paint/arjunah.js",
  ]
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  assert.doesNotMatch(landing, /(?:href|src)=["']\//);
  assert.match(landing, /href="\.\/paint\/"/);
  assert.match(landing, /href="\.\/trip-planner\/"/);
  for (const forbidden of [".enable(", "models.generate(", "providers.list("])
    assert.equal(paint.includes(forbidden), false, forbidden);
  assert.match(paint, /api\.site\.register/);
  assert.match(paint, /api\.chat\.open/);
});
