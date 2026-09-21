import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  HEIGHT,
  WIDTH,
  drawObject,
  fitPreviewSize,
  loadProject,
  makeObject,
  newProject,
  objectIdsForGroups,
  objectId,
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
      groupName: "window_frame",
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
  assert.equal(summary.objects[0].group_name, "window_frame");
  assert.match(first.createdAt, /^\d{4}-/);
  assert.deepEqual(
    summary.objects.map(({ id, z }) => [id, z]),
    [
      [first.id, 0],
      [second.id, 1],
    ],
  );
  assert.equal(JSON.stringify(summary).includes("data:image"), false);

  const fractional = makeObject("circle", {
    cx: 364.80000000000007,
    cy: 491.99999999999994,
    rx: 42.00000000000001,
    ry: 42.00000000000001,
    fill: "#ffffff",
    outline: "#111827",
    outlineWidth: 1.2000000000000002,
  });
  const compact = sceneSummary({ ...newProject(), objects: [fractional] });
  assert.deepEqual(compact.objects[0].bounds, {
    x: 322.8,
    y: 450,
    width: 84,
    height: 84,
  });
  assert.doesNotMatch(JSON.stringify(compact), /999999|000000000000/);
});

test("Paint uses unique short alphanumeric IDs and migrates legacy IDs", () => {
  const ids = Array.from({ length: 2_000 }, () => objectId());
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(
    ids.every((id) => /^[a-z0-9]{3,4}$/.test(id)),
    true,
  );

  const legacy = newProject();
  legacy.objects = [
    {
      id: "obj_legacy1",
      kind: "circle",
      source: "assistant",
      createdAt: new Date().toISOString(),
      cx: 10,
      cy: 10,
      rx: 5,
      ry: 5,
      fill: "#ffffff",
    },
    {
      id: "a1b",
      kind: "circle",
      source: "assistant",
      createdAt: new Date().toISOString(),
      cx: 30,
      cy: 10,
      rx: 5,
      ry: 5,
      fill: "#ffffff",
    },
  ];
  const loaded = loadProject({ getItem: () => JSON.stringify(legacy) });
  assert.equal(loaded.migrated, true);
  assert.match(loaded.project.objects[0].id, /^[a-z0-9]{3,4}$/);
  assert.equal(loaded.project.objects[1].id, "a1b");
  assert.notEqual(loaded.project.objects[0].id, "a1b");
});

test("Paint groups resolve to stable object IDs for bulk deletion", () => {
  const moon = makeObject("circle", {
    cx: 100,
    cy: 100,
    rx: 40,
    ry: 40,
    fill: "#ffffff",
    groupName: "moon_face",
  });
  const eye = makeObject("circle", {
    cx: 90,
    cy: 90,
    rx: 4,
    ry: 4,
    fill: "#111827",
    groupName: "moon_face",
  });
  const star = makeObject("circle", {
    cx: 200,
    cy: 100,
    rx: 3,
    ry: 3,
    fill: "#ffffff",
    groupName: "star_one",
  });
  const result = objectIdsForGroups(
    { ...newProject(), objects: [moon, eye, star] },
    ["moon_face", "missing_group", "moon_face"],
  );
  assert.deepEqual(result, {
    ids: [moon.id, eye.id],
    foundGroups: ["moon_face"],
    missingGroups: ["missing_group"],
  });
});

test("Paint renders curves and rounded rectangles as retained objects", () => {
  const operations = [];
  const context = {
    save() {},
    restore() {},
    beginPath() {
      operations.push("begin");
    },
    moveTo(...values) {
      operations.push(["move", ...values]);
    },
    lineTo(...values) {
      operations.push(["line", ...values]);
    },
    quadraticCurveTo(...values) {
      operations.push(["curve", ...values]);
    },
    closePath() {
      operations.push("close");
    },
    fill() {
      operations.push("fill");
    },
    stroke() {
      operations.push("stroke");
    },
  };
  drawObject(
    context,
    makeObject("curve", {
      points: [
        { x: 10, y: 20 },
        { x: 30, y: 5 },
        { x: 50, y: 20 },
      ],
      color: "#111827",
      width: 3,
    }),
  );
  drawObject(
    context,
    makeObject("rounded_rectangle", {
      x1: 10,
      y1: 20,
      x2: 110,
      y2: 80,
      radius: 12,
      fill: "#ffffff",
      outline: "#111827",
      outlineWidth: 2,
    }),
  );
  drawObject(
    context,
    makeObject("line", {
      points: [
        { x: 4, y: 8 },
        { x: 40, y: 80 },
      ],
      color: "#111827",
      width: 2,
    }),
  );
  assert.equal(
    operations.filter(
      (operation) => Array.isArray(operation) && operation[0] === "curve",
    ).length,
    5,
  );
  assert.equal(operations.includes("close"), true);
  assert.equal(operations.includes("fill"), true);
  assert.equal(
    operations.filter((operation) => operation === "stroke").length,
    3,
  );
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
  const rounded = makeObject("rounded_rectangle", {
    x1: 20,
    y1: 30,
    x2: 120,
    y2: 90,
    radius: 12,
    fill: "#ffffff",
    outline: "#111827",
    outlineWidth: 2,
  });
  const curve = makeObject("curve", {
    points: [
      { x: 20, y: 40 },
      { x: 50, y: 10 },
      { x: 80, y: 40 },
    ],
    color: "#111827",
    width: 3,
  });
  const line = makeObject("line", {
    points: [
      { x: 10, y: 15 },
      { x: 90, y: 75 },
    ],
    color: "#111827",
    width: 2,
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
    quadraticCurveTo() {},
    closePath() {},
    stroke() {},
    fill() {},
    ellipse() {},
    fillText() {},
  };
  const svg = projectToSvg(
    { ...newProject(), objects: [text, eraser, later, rounded, curve, line] },
    () => ({
      width: 0,
      height: 0,
      getContext: () => fakeContext,
      toDataURL: () => "data:image/png;base64,known",
    }),
  );
  assert.match(svg, /data:image\/png;base64,known/);
  assert.match(svg, /&lt;moon &amp; stars&gt;/);
  assert.match(svg, /rx="12"/);
  assert.match(svg, /<path d="M 20 40 Q /);
  assert.match(svg, /<line x1="10" y1="15" x2="90" y2="75"/);
});

test("Pages demo is relative and Paint uses only the hosted level-0 API", () => {
  const landing = readFileSync("demo/index.html", "utf8");
  const paintPage = readFileSync("demo/paint/index.html", "utf8");
  const tripPage = readFileSync("demo/trip-planner/index.html", "utf8");
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
  assert.match(landing, /href="\.\/favicon\.svg"/);
  assert.match(paintPage, /href="\.\.\/favicon\.svg"/);
  assert.match(tripPage, /href="\.\.\/favicon\.svg"/);
  for (const forbidden of [".enable(", "models.generate(", "providers.list("])
    assert.equal(paint.includes(forbidden), false, forbidden);
  assert.match(paint, /api\.site\.register/);
  assert.match(paint, /api\.chat\.open/);
  assert.doesNotMatch(paint, /window\.prompt/);
  assert.match(paint, /canvas-text-input/);
});
