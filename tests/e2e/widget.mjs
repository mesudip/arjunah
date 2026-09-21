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
const state = {
  pendingTool: null,
  turns: 0,
  actions: [],
  userTurns: [],
  toolResults: [],
  entityQueries: [],
};

// The entity source the renderer's `@` picker draws from (SPEC 8.3).
const ENTITIES = [
  { id: "city:lis", title: "Lisbon", group: "Cities", description: "Portugal" },
  { id: "city:lyo", title: "Lyon", group: "Cities", description: "France" },
  { id: "hotel:9", title: "Hotel Baixa", group: "Hotels" },
];

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
  if (path === "/api/entities" && request.method === "GET") {
    const query = (url.searchParams.get("q") ?? "").toLowerCase();
    state.entityQueries.push(query);
    return json(
      ENTITIES.filter((item) => item.title.toLowerCase().includes(query)),
    );
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
      state.toolResults.push(payload);
      sse(pending.response, "tool.end", {
        id: payload.id,
        name: pending.name,
        ok: true,
        result: JSON.stringify(payload.result),
      });
      sse(pending.response, "message", {
        entry: {
          type: "message",
          id: `a-${pending.name}`,
          role: "assistant",
          content: pending.answer,
          createdAt: new Date().toISOString(),
        },
      });
      sse(pending.response, "turn.end", {
        turnId: "turn-1",
        usage: { promptTokens: 12, completionTokens: 8 },
      });
      pending.response.end();
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
      state.pendingTool = {
        response,
        name: "page_info",
        answer: "Lisbon is 420 USD for the weekend.",
      };
      return;
    }
    // The fourth turn asks the page for a declared input (SPEC 7.3).
    if (state.turns === 4) {
      sse(response, "tool.client", {
        id: "c2",
        name: "unlock",
        arguments: "{}",
      });
      state.pendingTool = {
        response,
        name: "unlock",
        answer: "The booking is unlocked.",
      };
      return;
    }
    // A backend that knows what its agent is doing says so; the renderer shows
    // it as the live turn label instead of a bare spinner (SPEC 14.3).
    sse(response, "agent.phase", { text: "Reserving the room…" });
    if (state.turns === 2) await new Promise((wait) => setTimeout(wait, 400));
    sse(response, "message", {
      entry: {
        type: "message",
        id: `a${state.turns}`,
        role: "assistant",
        content: state.turns === 2 ? "Booked." : "Noted.",
        createdAt: new Date().toISOString(),
      },
    });
    sse(response, "turn.end", {
      turnId: "turn-1",
      usage: { promptTokens: 4, completionTokens: 2 },
    });
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
const type = async (text) => {
  await shadow(`root.querySelector(".input").focus();`);
  await page.keyboard.type(text, { delay: 8 });
};
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
  // A starter prompt fills the composer rather than sending anything.
  await shadow(`root.querySelector(".suggestions button").click();`);
  assert.equal(
    await shadow(`return root.querySelector(".input").textContent;`),
    "Plan a weekend",
  );
  await page.evaluate(() => window.assistant.view.setComposerText(""));

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
  await type("How much for Lisbon?");
  await shadow(`root.querySelector(".send:not(.stop)").click();`);
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
    `root.querySelector(".activity.live .workflow-title")?.textContent.startsWith("Reserving the room…")`,
    "the agent phase as the live label",
  );
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

  // The model picker is the renderer's, drawn from the site's own catalog.
  assert.equal(
    await shadow(`return root.querySelector(".model-picker").hidden;`),
    false,
  );
  assert.equal(
    await shadow(`return root.querySelector(".model-label").textContent;`),
    "Fast",
  );
  assert.equal(
    await shadow(`return root.querySelector(".think").hidden;`),
    true,
  );
  await shadow(`root.querySelector(".model-button").click();`);
  // Opening hands focus to the search box, on the whole catalog (SPEC 8.2).
  assert.deepEqual(
    await shadow(`return {
      focused: root.activeElement?.className,
      query: root.querySelector(".model-search").value,
      count: root.querySelectorAll(".model-option").length,
    };`),
    { focused: "model-search", query: "", count: 2 },
  );
  // Typing filters to the matches and drops the provider headings, whose order
  // the ranking no longer follows.
  await shadow(`const box = root.querySelector(".model-search");
    box.value = "deep";
    box.dispatchEvent(new Event("input", { bubbles: true }));`);
  assert.deepEqual(
    await shadow(`return {
      rows: [...root.querySelectorAll(".model-option span:first-child")].map((n) => n.textContent),
      groups: root.querySelectorAll(".menu-group").length,
    };`),
    { rows: ["Deep"], groups: 0 },
  );
  // A search matching nothing says so rather than showing an empty box.
  await shadow(`const box = root.querySelector(".model-search");
    box.value = "nothing-like-this";
    box.dispatchEvent(new Event("input", { bubbles: true }));`);
  assert.match(
    await shadow(`return root.querySelector(".model-list").textContent;`),
    /No model matches/,
  );
  await shadow(`const box = root.querySelector(".model-search");
    box.value = "deep";
    box.dispatchEvent(new Event("input", { bubbles: true }));`);
  // Enter takes the best match, so the whole switch needs no mouse.
  await shadow(
    `root.querySelector(".model-search").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));`,
  );
  await waitFor(
    `root.querySelector(".model-label").textContent === "Deep"`,
    "the switched model",
  );
  // Deep declares reasoning levels, so the effort control appears with it.
  assert.equal(
    await shadow(`return root.querySelector(".think").hidden;`),
    false,
  );
  await shadow(
    `const think = root.querySelector(".think"); think.value = "high"; think.dispatchEvent(new Event("change"));`,
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.events.filter((event) => event.type === "model"),
    ),
    [
      { type: "model", model: "desk/deep", reasoning: null },
      { type: "model", model: "desk/deep", reasoning: "high" },
    ],
  );

  // `@` searches the backend and inserts one atomic chip (SPEC 8.3).
  await type("Compare @Lis");
  await waitFor(`!root.querySelector(".mention-menu").hidden`, "the @ menu");
  assert.deepEqual(state.entityQueries.at(-1), "lis");
  await shadow(`root.querySelector(".entity-option").click();`);
  await waitFor(
    `root.querySelector(".input [data-mention-id]")`,
    "the composer chip",
  );
  await type("and Lyon");
  await shadow(`root.querySelector(".send:not(.stop)").click();`);
  await waitFor(
    `[...root.querySelectorAll(".msg.assistant")].some((m) => m.textContent.includes("Noted."))`,
    "the mention answer",
  );
  const mentionTurn = state.userTurns.at(-1);
  assert.deepEqual(mentionTurn.content, [
    { type: "text", text: "Compare " },
    { type: "mention", id: "city:lis", label: "Lisbon" },
    { type: "text", text: " and Lyon" },
  ]);
  // The picker's choice rides with the turn (SPEC 14.4).
  assert.equal(mentionTurn.model, "desk/deep");
  assert.equal(mentionTurn.reasoning, "high");
  // The chip survives into the transcript and reaches the host when clicked.
  await shadow(
    `[...root.querySelectorAll(".msg.user button.mention")].at(-1).click();`,
  );
  assert.deepEqual(await page.evaluate(() => window.activated), [
    { id: "city:lis", title: "Lisbon" },
  ]);

  // A client tool collects a declared value in renderer-owned UI (SPEC 7.3).
  await type("Unlock it");
  await shadow(`root.querySelector(".send:not(.stop)").click();`);
  await waitFor(`root.querySelector(".overlay .consent")`, "the input prompt");
  assert.equal(
    await shadow(
      `return root.querySelector(".overlay input").getAttribute("type");`,
    ),
    "password",
  );
  // Too short for the declared schema: the prompt stays open and says so.
  await shadow(
    `root.querySelector(".overlay input").value = "no";
     root.querySelector(".overlay .allow").click();`,
  );
  assert.match(
    await shadow(
      `return root.querySelector(".overlay .validation").textContent;`,
    ),
    /disclosed requirements/,
  );
  await shadow(
    `root.querySelector(".overlay input").value = "open-sesame";
     root.querySelector(".overlay .allow").click();`,
  );
  await waitFor(
    `[...root.querySelectorAll(".msg.assistant")].some((m) => m.textContent.includes("unlocked"))`,
    "the unlocked answer",
  );
  assert.equal(await page.evaluate(() => window.collected), "open-sesame");
  assert.equal(
    await shadow(`return root.querySelector(".overlay") === null;`),
    true,
  );
  // The collected value is nowhere in the transcript or the tool result.
  assert.equal(
    await shadow(`return root.querySelector(".messages").textContent;`).then(
      (text) => text.includes("open-sesame"),
    ),
    false,
  );
  assert.deepEqual(state.toolResults.at(-1).result, { unlocked: true });

  // A fresh thread starts empty and is created on the backend.
  await shadow(`root.querySelector(".thread-new").click();`);
  await waitFor(`root.querySelector(".welcome")`, "the empty new thread");
  assert.equal(threads.size, 2);

  // Host callbacks reported every turn and every thread change.
  const kinds = await page.evaluate(() =>
    window.events.map((event) => event.type),
  );
  assert.equal(kinds.filter((kind) => kind === "turn.start").length, 4);
  assert.equal(kinds.filter((kind) => kind === "turn.end").length, 4);
  assert.ok(kinds.includes("thread"));
  assert.deepEqual(
    await page.evaluate(
      () => window.events.findLast((event) => event.type === "turn.end").usage,
    ),
    { promptTokens: 12, completionTokens: 8 },
  );

  // The mounted controller drives threads, controls and the catalog.
  assert.equal(
    await page.evaluate(() => {
      window.assistant.setModels(
        [{ id: "desk/only", displayName: "Only" }],
        "desk/only",
      );
      return document
        .querySelector("#assistant")
        .shadowRoot.querySelector(".model-label").textContent;
    }),
    "Only",
  );
  await page.evaluate(() => window.assistant.openThread("t1"));
  await waitFor(
    `[...root.querySelectorAll(".msg.user")].some((m) => m.textContent.includes("an earlier question"))`,
    "the reopened thread",
  );

  assert.deepEqual(errors, []);
  console.log(
    `Standalone widget E2E passed with ${state.userTurns.length} turns, ${state.actions.length} card action, a mention, a model switch and a collected input.`,
  );
} finally {
  await browser.close();
  server.close();
}
