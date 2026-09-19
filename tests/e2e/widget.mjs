/**
 * Standalone widget end-to-end (SPEC section 14): the same renderer the
 * extension hosts, mounted by a page against a mock backend, with no extension
 * installed. Covers the event stream, a client tool round, transcript cards
 * and their two action kinds, tool progress, and thread switching.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import puppeteer from "puppeteer";

const fixture = await readFile(resolve("tests/fixtures/widget.html"));
const widgetDir = resolve("packages/widget/dist");
const TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
};

const card = {
  type: "card",
  id: "quote",
  children: [
    { type: "text", text: "Two options for Lisbon", style: "heading" },
    {
      type: "list",
      items: [{ title: "Fri–Sun", description: "420 USD" }],
    },
    {
      type: "button",
      label: "Save this quote",
      action: { type: "local", name: "save", payload: { id: 7 } },
      style: "primary",
    },
    {
      type: "form",
      id: "book",
      submitLabel: "Book it",
      action: { type: "message", text: "Book the Lisbon trip" },
      fields: [
        { type: "input", id: "traveller", label: "Traveller", default: "Ada" },
      ],
    },
  ],
};
const updatedCard = {
  type: "card",
  id: "quote",
  children: [{ type: "text", text: "Saved to your trips." }],
};

const threads = new Map([
  [
    "t1",
    { id: "t1", title: "First trip", updatedAt: new Date().toISOString() },
  ],
]);
const transcripts = new Map([
  [
    "t1",
    [
      {
        type: "message",
        id: "m1",
        role: "user",
        content: "an earlier question",
        createdAt: new Date().toISOString(),
      },
    ],
  ],
]);
const state = { pendingTool: null, turns: 0, actions: [], userTurns: [] };

function sse(response, type, data) {
  response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function body(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const path = url.pathname;
  const json = (value, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(value === null ? "" : JSON.stringify(value));
  };
  if (path === "/widget.html") {
    response.writeHead(200, { "Content-Type": "text/html" });
    return response.end(fixture);
  }
  if (path.startsWith("/widget/")) {
    const file = join(widgetDir, normalize(path.slice("/widget/".length)));
    if (!file.startsWith(widgetDir)) return json(null, 403);
    const content = await readFile(file).catch(() => null);
    if (!content) return json(null, 404);
    response.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    });
    return response.end(content);
  }
  if (path === "/api/threads" && request.method === "GET")
    return json([...threads.values()]);
  if (path === "/api/threads" && request.method === "POST") {
    const id = `t${threads.size + 1}`;
    const summary = {
      id,
      title: "New conversation",
      updatedAt: new Date().toISOString(),
    };
    threads.set(id, summary);
    transcripts.set(id, []);
    return json(summary);
  }
  const thread = path.match(/^\/api\/threads\/([^/]+)$/);
  if (thread && request.method === "GET")
    return json(transcripts.get(thread[1]) ?? []);
  if (thread && request.method === "DELETE") {
    threads.delete(thread[1]);
    return json(null, 204);
  }
  const actions = path.match(/^\/api\/threads\/([^/]+)\/actions$/);
  if (actions && request.method === "POST") {
    state.actions.push(await body(request));
    return json({ card: updatedCard });
  }
  const results = path.match(
    /^\/api\/threads\/([^/]+)\/turns\/([^/]+)\/tool-results$/,
  );
  if (results && request.method === "POST") {
    const payload = await body(request);
    const pending = state.pendingTool;
    state.pendingTool = null;
    if (pending) {
      sse(pending, "tool.end", {
        id: payload.id,
        name: "page_info",
        ok: true,
        result: JSON.stringify(payload.result),
      });
      sse(pending, "message", {
        entry: {
          type: "message",
          id: "a1",
          role: "assistant",
          content: "Lisbon is 420 USD for the weekend.",
          createdAt: new Date().toISOString(),
        },
      });
      sse(pending, "turn.end", { turnId: "turn-1" });
      pending.end();
    }
    return json(null, 204);
  }
  const turns = path.match(/^\/api\/threads\/([^/]+)\/turns$/);
  if (turns && request.method === "POST") {
    const payload = await body(request);
    state.userTurns.push(payload);
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    sse(response, "turn.start", { turnId: "turn-1", threadId: turns[1] });
    if (++state.turns === 1) {
      sse(response, "tool.start", {
        id: "s1",
        name: "quote",
        source: "backend",
        arguments: '{"city":"Lisbon"}',
      });
      sse(response, "progress", { toolId: "s1", text: "Checking prices" });
      sse(response, "tool.end", {
        id: "s1",
        name: "quote",
        ok: true,
        result: "420 USD",
        card,
      });
      sse(response, "tool.client", {
        id: "c1",
        name: "page_info",
        arguments: "{}",
      });
      state.pendingTool = response;
      return;
    }
    sse(response, "message", {
      entry: {
        type: "message",
        id: `a${state.turns}`,
        role: "assistant",
        content: "Booked.",
        createdAt: new Date().toISOString(),
      },
    });
    sse(response, "turn.end", { turnId: "turn-1" });
    return response.end();
  }
  return json(null, 404);
});

await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
const shadow = async (script, ...args) =>
  page.evaluate(
    (source, ...rest) => {
      const root = document.querySelector("#assistant").shadowRoot;
      return new Function("root", ...rest.map((_, i) => `a${i}`), source)(
        root,
        ...rest,
      );
    },
    script,
    ...args,
  );
const waitFor = async (source, label) => {
  const deadline = Date.now() + 15000;
  for (;;) {
    if (await shadow(`return Boolean(${source});`)) return;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 100));
  }
};

try {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`${base}/widget.html`, { waitUntil: "networkidle0" });
  await waitFor(`root.querySelector(".panel")`, "the panel");

  // The greeting, suggestions and thread panel come from the shared renderer.
  assert.match(
    await shadow(`return root.querySelector(".welcome").textContent;`),
    /Trip desk|Ask about a trip/,
  );
  await shadow(`root.querySelector(".thread-toggle").click();`);
  await waitFor(`root.querySelector(".thread-open")`, "the thread list");
  assert.equal(
    await shadow(`return root.querySelector(".thread-open").textContent;`),
    "First trip",
  );

  // Open the stored conversation: its messages are the backend's, replayed.
  await shadow(`root.querySelector(".thread-open").click();`);
  await waitFor(
    `[...root.querySelectorAll(".msg.user")].some((m) => m.textContent.includes("an earlier question"))`,
    "the stored message",
  );

  // One turn: backend tool, progress, card, then a client tool round.
  await page.evaluate(() => {
    const root = document.querySelector("#assistant").shadowRoot;
    const input = root.querySelector("textarea");
    input.value = "How much for Lisbon?";
    root.querySelector(".send:not(.stop)").click();
  });
  await waitFor(`root.querySelector(".card")`, "the card");
  assert.equal(
    await shadow(
      `return root.querySelector(".tool-progress")?.textContent ?? "";`,
    ),
    "Checking prices",
  );
  await waitFor(
    `[...root.querySelectorAll(".msg.assistant")].some((m) => m.textContent.includes("420 USD"))`,
    "the answer",
  );
  assert.equal(await page.evaluate(() => window.clientToolCalls), 1);

  // A form's message action shows the user the exact text it sends.
  const turnsBefore = state.userTurns.length;
  await shadow(`root.querySelector(".card-form button[type=submit]").click();`);
  await waitFor(
    `[...root.querySelectorAll(".msg.user")].some((m) => m.textContent.includes("Book the Lisbon trip"))`,
    "the visible message action",
  );
  await waitFor(
    `[...root.querySelectorAll(".msg.assistant")].some((m) => m.textContent.includes("Booked."))`,
    "the second answer",
  );
  assert.equal(state.userTurns.length, turnsBefore + 1);
  assert.equal(
    state.userTurns.at(-1).content,
    "Book the Lisbon trip\nTraveller: Ada",
  );

  // A card's local action never becomes a model message; it updates the card.
  await shadow(
    `root.querySelector(".card .card-button:not([type=submit])").click();`,
  );
  await waitFor(
    `root.querySelector(".card")?.textContent.includes("Saved to your trips")`,
    "the updated card",
  );
  assert.equal(state.actions.length, 1);
  assert.deepEqual(state.actions[0], {
    cardId: "quote",
    name: "save",
    payload: { id: 7 },
    values: null,
  });

  // A fresh thread starts empty and is created on the backend.
  await shadow(`root.querySelector(".thread-new").click();`);
  await waitFor(`root.querySelector(".welcome")`, "the empty new thread");
  assert.equal(threads.size, 2);

  assert.deepEqual(errors, []);
  console.log(
    `Standalone widget E2E passed with ${state.userTurns.length} turns and ${state.actions.length} card action.`,
  );
} finally {
  await browser.close();
  server.close();
}
