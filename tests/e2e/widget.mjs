/**
 * Standalone widget end-to-end (SPEC section 14): the same renderer the
 * extension hosts, mounted by a page against a mock backend, with no extension
 * installed. Covers the event stream, a client tool round, transcript cards
 * and their two action kinds, tool progress, and thread switching. A second
 * page covers bridged mode (SPEC 14.7): relayed completions through the
 * visitor's session, conversations, deltas, cancellation, and the composer
 * prompts `input.client` and `approval.client` (SPEC 7.8). A third page mounts
 * on `backend.fetch` (SPEC 14.1, SPEC 15 mode 5): the page runs the loop, every
 * route goes through its function, the stream bounds hold against what it
 * returns, and the renderer makes no network request at all.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import puppeteer from "puppeteer";

const fixture = await readFile(resolve("tests/fixtures/widget.html"));
const bridgeFixture = await readFile(
  resolve("tests/fixtures/widget-bridge.html"),
);
const inpageFixture = await readFile(
  resolve("tests/fixtures/widget-inpage.html"),
);
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
  modelResults: [],
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

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Resolves to the first truthy value of `check`, polling. */
async function until(check, label = "a condition", ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
}

// ------------------------------------------------------------ bridged mode

// The composer of SPEC 15 mode 4: this backend runs the loop, and every
// completion is answered by the page through the visitor's session.
const bridged = {
  turns: [],
  posts: { "model-results": [], inputs: [], approvals: [], cancel: [] },
  gates: new Set(),
  threads: 0,
  lists: {},
};
const posted = (route, id) =>
  bridged.posts[route].filter((item) => item.id === id);
const final = (id) =>
  posted("model-results", id).find((item) => item.result || item.error);
const entry = (id, content) => ({
  type: "message",
  id,
  role: "assistant",
  content,
  createdAt: new Date().toISOString(),
});

async function bridgeApi(request, response, path) {
  const json = (value, status = 200) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(value === null ? "" : JSON.stringify(value));
  };
  const prefix = path.startsWith("/gen-api/") ? "gen" : "bridge";
  const route = path.replace(/^\/(bridge|gen)-api\//, "");
  const list = (bridged.lists[prefix] ??= []);
  if (route === "threads" && request.method === "GET") return json(list);
  if (route === "threads" && request.method === "POST") {
    const summary = {
      id: `b${++bridged.threads}`,
      title: "Bridged",
      updatedAt: new Date().toISOString(),
    };
    list.push(summary);
    return json(summary);
  }
  if (/^threads\/[^/]+$/.test(route)) return json([]);
  const answer = route.match(
    /^threads\/[^/]+\/turns\/[^/]+\/(model-results|inputs|approvals|cancel)$/,
  );
  if (answer && request.method === "POST") {
    bridged.posts[answer[1]].push(await body(request));
    return json(null, 204);
  }
  const turn = route.match(/^threads\/([^/]+)\/turns$/);
  if (!turn || request.method !== "POST") return json(null, 404);
  const payload = await body(request);
  bridged.turns.push(payload);
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  const turnId = `bt${bridged.turns.length}`;
  sse(response, "turn.start", { turnId, threadId: turn[1] });
  const finish = (id, content) => {
    sse(response, "message", { entry: entry(id, content) });
    sse(response, "turn.end", { turnId });
    response.end();
  };
  const ask = (id, mode, extra = {}) =>
    sse(response, "model.client", {
      id,
      request: { messages: [{ role: "user", content: mode }] },
      ...extra,
    });

  if (payload.content === "hello") {
    // No conversation named: the renderer creates one and returns its id.
    ask("m1", "mode:text", { stream: true });
    const done = await until(() => final("m1"), "the m1 result");
    return finish("f1", `${done.result.message.content} (final)`);
  }
  if (payload.content === "tools") {
    ask("m2", "mode:tools", { conversation: "conv1.tag" });
    await until(() => final("m2"), "the m2 result");
    await until(() => bridged.gates.has("tools"), "the tools gate");
    sse(response, "tool.start", {
      id: "k1",
      name: "lookup",
      source: "backend",
      arguments: "{}",
    });
    sse(response, "tool.end", {
      id: "k1",
      name: "lookup",
      ok: true,
      result: "3",
    });
    return finish("f2", "Done with tools");
  }
  if (payload.content === "cancel") {
    ask("m3", "mode:hang", { conversation: "conv-old.tag", stream: true });
    await until(() => bridged.gates.has("cancel"), "the cancel gate");
    sse(response, "model.cancel", { id: "m3" });
    await sleep(500);
    return finish("f3", "Cancelled cleanly");
  }
  if (payload.content === "stop") {
    // Held open until the visitor stops the turn.
    ask("m4", "mode:hang:stop");
    return;
  }
  if (payload.content === "input") {
    sse(response, "tool.start", {
      id: "b1",
      name: "vault",
      source: "backend",
      arguments: "{}",
    });
    const input = {
      id: "otp",
      label: "One-time code",
      schema: { type: "string", minLength: 6, maxLength: 6 },
      secret: true,
    };
    // Asked twice under one id: it is answered once.
    sse(response, "input.client", { id: "i1", toolId: "b1", input });
    sse(response, "input.client", { id: "i1", toolId: "b1", input });
    await until(() => posted("inputs", "i1").length, "the input");
    await sleep(400);
    sse(response, "tool.end", {
      id: "b1",
      name: "vault",
      ok: true,
      result: "open",
    });
    return finish("f4", "Vault opened");
  }
  if (payload.content === "approve") {
    sse(response, "tool.start", {
      id: "b2",
      name: "deploy",
      source: "backend",
      arguments: "{}",
    });
    // Past a bound: never shown, answered as denied.
    sse(response, "approval.client", {
      id: "p0",
      toolId: "b2",
      approval: { title: "x".repeat(81), summary: "too long" },
    });
    await until(() => posted("approvals", "p0").length, "p0");
    sse(response, "approval.client", {
      id: "p1",
      toolId: "b2",
      approval: {
        title: '<img src=x onerror="window.pwned=1">Deploy',
        summary: "Ship <b>build 42</b> to production",
        target: "prod-1 <script>window.pwned=2</script>",
        detail: '{"tag":"v42"}\n<script>window.pwned=3</script>',
        danger: true,
      },
    });
    await until(() => posted("approvals", "p1").length, "p1");
    sse(response, "approval.client", {
      id: "p2",
      toolId: "b2",
      approval: { title: "Restart worker", summary: "Restarts one worker." },
    });
    await until(() => posted("approvals", "p2").length, "p2");
    sse(response, "approval.client", {
      id: "p3",
      toolId: "b2",
      approval: { title: "Drop cache", summary: "Clears the cache." },
    });
    await until(() => posted("approvals", "p3").length, "p3");
    sse(response, "tool.end", {
      id: "b2",
      name: "deploy",
      ok: true,
      result: "done",
    });
    return finish("f5", "Approvals done");
  }
  if (payload.content === "gen") {
    ask("g1", "from-gen");
    const done = await until(() => final("g1"), "the g1 result");
    return finish("f6", `Got: ${done.result.message.content}`);
  }
  return finish("f0", "Unscripted");
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
  if (path === "/widget-bridge.html") {
    response.writeHead(200, { "Content-Type": "text/html" });
    return response.end(bridgeFixture);
  }
  if (path === "/widget-inpage.html") {
    response.writeHead(200, { "Content-Type": "text/html" });
    return response.end(inpageFixture);
  }
  if (path.startsWith("/bridge-api/") || path.startsWith("/gen-api/"))
    return bridgeApi(request, response, path);
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
  const modelResults = path.match(
    /^\/api\/threads\/([^/]+)\/turns\/([^/]+)\/model-results$/,
  );
  if (modelResults && request.method === "POST") {
    state.modelResults.push(await body(request));
    return json(null, 204);
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
    // A defective backend asks for a completion on a turn that announced no
    // bridge; the renderer answers NOT_SUPPORTED and the backend ends there.
    if (payload.content === "Ask the page model") {
      sse(response, "model.client", {
        id: "x1",
        request: { messages: [{ role: "user", content: "hi" }] },
      });
      const answer = await until(() =>
        state.modelResults.find((item) => item.id === "x1"),
      );
      sse(response, "message", {
        entry: {
          type: "message",
          id: "a-x1",
          role: "assistant",
          content: `The page answered ${answer.error?.code}.`,
          createdAt: new Date().toISOString(),
        },
      });
      sse(response, "turn.end", { turnId: "turn-1" });
      return response.end();
    }
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
    if (state.turns === 2) {
      // Thinking streamed a token at a time is drawn in chunks of at most
      // fifty words; the word split across two tokens is counted once.
      for (let index = 0; index < 120; index++)
        sse(response, "reasoning.delta", {
          text: index === 7 ? " sp" : index === 8 ? "lit" : ` w${index}`,
        });
      await new Promise((wait) => setTimeout(wait, 400));
      // A quiet round says so instead of failing: the turn keeps running, the
      // visitor keeps the stop control, and the next event takes the notice
      // away again (SPEC 10).
      sse(response, "model.stalled", { round: 0 });
      await new Promise((wait) => setTimeout(wait, 600));
    }
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
const shadowIn =
  (target, selector) =>
  async (script, ...args) =>
    target.evaluate(
      (selector, source, ...rest) => {
        const root = document.querySelector(selector).shadowRoot;
        return new Function("root", ...rest.map((_, i) => `a${i}`), source)(
          root,
          ...rest,
        );
      },
      selector,
      script,
      ...args,
    );
const shadow = shadowIn(page, "#assistant");
const type = async (text) => {
  await shadow(`root.querySelector(".input").focus();`);
  await page.keyboard.type(text, { delay: 8 });
};
const waitIn = (inShadow) => async (source, label) => {
  const deadline = Date.now() + 15000;
  for (;;) {
    if (await inShadow(`return Boolean(${source});`)) return;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 100));
  }
};
const waitFor = waitIn(shadow);

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
    `root.querySelector(".activity.live details.reason pre")?.textContent.includes("w119")`,
    "the streamed reasoning",
  );
  assert.deepEqual(
    await shadow(
      `return [...root.querySelector(".activity.live details.reason pre").childNodes].map((node) => node.data.split(/\\s+/).filter(Boolean).length);`,
    ),
    [50, 50, 19],
  );
  assert.match(
    await shadow(
      `return root.querySelector(".activity.live details.reason pre").textContent;`,
    ),
    / w6 split w9 /,
  );
  // The wait notice: the turn is still live, still spinning, and the stop
  // control is still there, because nothing was cancelled.
  await waitFor(
    `root.querySelector(".activity.live.stalled .workflow-title")?.textContent.startsWith("The model is taking longer than usual…")`,
    "the stall notice as the live label",
  );
  assert.equal(
    await shadow(`return root.querySelector(".stop").hidden;`),
    false,
  );
  await waitFor(
    `[...root.querySelectorAll(".msg.assistant")].some((m) => m.textContent.includes("Booked."))`,
    "the second answer",
  );
  // The answer supersedes the notice rather than leaving it on the transcript.
  assert.equal(
    await shadow(`return root.querySelectorAll(".stalled").length;`),
    0,
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

  // A model.client on a turn that announced no bridge is answered
  // NOT_SUPPORTED, and the backend treats that as final (SPEC 14.7).
  await type("Ask the page model");
  await shadow(`root.querySelector(".send:not(.stop)").click();`);
  await waitFor(
    `[...root.querySelectorAll(".msg.assistant")].some((m) => m.textContent.includes("The page answered NOT_SUPPORTED."))`,
    "the NOT_SUPPORTED answer",
  );
  assert.equal(state.modelResults.length, 1);
  assert.equal(state.modelResults[0].error.code, "NOT_SUPPORTED");
  assert.equal("bridge" in state.userTurns.at(-1), false);

  assert.deepEqual(errors, []);

  // ------------------------------------------------------------ bridged mode
  const bridgePage = await browser.newPage();
  const bridgeErrors = [];
  bridgePage.on("pageerror", (error) => bridgeErrors.push(String(error)));
  await bridgePage.goto(`${base}/widget-bridge.html`, {
    waitUntil: "networkidle0",
  });
  const b = shadowIn(bridgePage, "#assistant");
  const bWait = waitIn(b);
  const log = () => bridgePage.evaluate(() => window.bridgeLog);
  const send = async (text) => {
    await b(`root.querySelector(".input").focus();`);
    await bridgePage.keyboard.type(text, { delay: 5 });
    await b(`root.querySelector(".send:not(.stop)").click();`);
  };
  const answered = (text) =>
    bWait(
      `[...root.querySelectorAll(".msg.assistant")].some((m) => m.textContent.includes(${JSON.stringify(text)}))`,
      text,
    );
  await bWait(`root.querySelector(".panel")`, "the bridged panel");
  // Nothing is asked of the extension until the visitor sends (SPEC 14.7).
  assert.equal((await log()).enables.length, 0);

  // A relayed round: deltas drawn provisionally, posted in order before the
  // result, the created conversation returned with it, and the backend's
  // message replacing the provisional text.
  await send("hello");
  await bWait(
    `root.querySelector(".msg.assistant.streaming")?.textContent.includes("Hello there")`,
    "the provisional answer",
  );
  await bWait(
    `[...root.querySelectorAll("details.reason pre")].some((n) => n.textContent.includes("Weighing the dates"))`,
    "the provisional reasoning",
  );
  await answered("Hello there (final)");
  assert.equal(
    await b(
      `return [...root.querySelectorAll(".msg.assistant")].filter((m) => m.textContent.includes("Hello there")).length;`,
    ),
    1,
  );
  assert.equal(
    await b(
      `return [...root.querySelectorAll("details.reason")].some((n) => n.textContent.includes("Weighing"));`,
    ),
    false,
  );
  const m1 = posted("model-results", "m1");
  const deltas = m1.filter((item) => item.delta);
  assert.ok(deltas.length >= 2);
  assert.ok(m1.at(-1).result, "the result is posted last");
  assert.ok(m1.slice(0, -1).every((item) => item.delta));
  const joined = (kind) =>
    deltas
      .filter((item) => item.delta.type === kind)
      .map((item) => item.delta.text)
      .join("");
  assert.equal(joined("output.delta"), "Hello there");
  assert.equal(joined("reasoning.delta"), "Weighing the dates");
  assert.equal(m1.at(-1).conversation, "conv1.tag");
  assert.equal(m1.at(-1).result.message.content, "Hello there");
  // The announcement: the visitor's model and the page's tools, nothing else.
  const announced = bridged.turns[0].bridge;
  assert.equal(announced.model.id, "openai/gpt-test");
  assert.deepEqual(
    announced.tools.map((tool) => Object.keys(tool).sort()),
    [
      ["description", "inputSchema", "name"],
      ["inputSchema", "name"],
    ],
  );
  assert.deepEqual(
    announced.tools.map((tool) => tool.name),
    ["page_info", "unlock"],
  );
  assert.equal(bridged.turns[0].model, "openai/gpt-test");
  // The picker shows the visitor's one model, not the site's list.
  assert.equal(
    await b(`return root.querySelector(".model-label").textContent;`),
    "GPT Test",
  );
  assert.deepEqual((await log()).enables, [{ composer: "server" }]);

  // A round that ends in tool calls: its provisional text is discarded as the
  // result arrives, and the stored conversation is reused, not recreated.
  await send("tools");
  await bWait(
    `root.querySelector(".msg.assistant.streaming")?.textContent.includes("Provisional draft")`,
    "the provisional draft",
  );
  await until(() => final("m2"), "the m2 result");
  await bWait(
    `!root.querySelector(".messages").textContent.includes("Provisional draft")`,
    "the discarded draft",
  );
  assert.equal(
    await b(
      `return root.querySelector(".messages").textContent.includes("Need a lookup");`,
    ),
    false,
  );
  bridged.gates.add("tools");
  await answered("Done with tools");
  assert.equal(final("m2").conversation, "conv1.tag");
  assert.equal(final("m2").result.message.toolCalls.length, 1);
  assert.equal(
    posted("model-results", "m2").filter((item) => item.delta).length,
    0,
  );
  assert.deepEqual((await log()).created, ["conv1.tag"]);
  assert.equal(bridged.turns[1].bridge.model.id, "openai/gpt-test");
  assert.equal((await log()).enables.length, 1);

  // model.cancel aborts that completion through its signal and nothing more
  // is posted for it. An id this mount never saw is opened, not recreated.
  await send("cancel");
  await until(async () => (await log()).rounds.includes("mode:hang"), "m3");
  bridged.gates.add("cancel");
  await answered("Cancelled cleanly");
  assert.deepEqual((await log()).aborts, ["mode:hang"]);
  assert.deepEqual((await log()).opened, ["conv-old.tag"]);
  await sleep(200);
  assert.equal(posted("model-results", "m3").length, 0);

  // The stop control aborts the outstanding completion of its turn too.
  await send("stop");
  await until(
    async () => (await log()).rounds.includes("mode:hang:stop"),
    "m4",
  );
  await b(`root.querySelector(".stop").click();`);
  await until(async () => (await log()).aborts.length === 2, "the stop abort");
  await until(() => bridged.posts.cancel.length, "the cancel route");
  await sleep(200);
  assert.equal(posted("model-results", "m4").length, 0);

  // input.client: the renderer's prompt, the value posted once, and the value
  // nowhere afterwards.
  await send("input");
  await bWait(`root.querySelector(".overlay .consent")`, "the input prompt");
  assert.equal(
    await b(
      `return root.querySelector(".overlay input").getAttribute("type");`,
    ),
    "password",
  );
  assert.match(
    await b(`return root.querySelector(".overlay").textContent;`),
    /vault is asking for One-time code/,
  );
  await b(`root.querySelector(".overlay input").value = "123456";
    root.querySelector(".overlay .allow").click();`);
  await answered("Vault opened");
  assert.deepEqual(posted("inputs", "i1"), [{ id: "i1", value: "123456" }]);
  assert.equal(
    await b(`return root.querySelector(".overlay") === null;`),
    true,
  );
  assert.equal(
    await b(
      `return [root.textContent, ...[...root.querySelectorAll("input")].map((n) => n.value)].some((text) => text.includes("123456"));`,
    ),
    false,
  );
  assert.equal(
    await bridgePage.evaluate(() =>
      JSON.stringify(window.assistant.view.entries()).includes("123456"),
    ),
    false,
  );
  assert.ok(!JSON.stringify(bridged.turns).includes("123456"));

  // approval.client: bounded, text-only, no default answer, Approve, Deny, and
  // the two-minute timeout answering denied.
  await send("approve");
  await until(() => posted("approvals", "p0").length, "p0");
  assert.deepEqual(posted("approvals", "p0"), [{ id: "p0", approved: false }]);
  await bWait(
    `root.querySelector(".overlay .approval")`,
    "the approval prompt",
  );
  const prompt = await b(`const card = root.querySelector(".overlay .approval");
    return {
      title: card.querySelector("h2").textContent,
      summary: card.querySelector(".scope").textContent,
      target: card.querySelector(".approval-target strong").textContent,
      detail: card.querySelector("pre.approval-detail").textContent,
      origin: card.querySelector(".origin").textContent,
      markup: card.querySelectorAll("img, b, script").length,
      buttons: [...card.querySelectorAll("button")].map((n) => n.textContent),
      danger: card.querySelector(".approve").classList.contains("danger"),
      focused: root.activeElement === card,
    };`);
  assert.deepEqual(prompt, {
    title: '<img src=x onerror="window.pwned=1">Deploy',
    summary: "Ship <b>build 42</b> to production",
    target: "prod-1 <script>window.pwned=2</script>",
    detail: '{"tag":"v42"}\n<script>window.pwned=3</script>',
    origin: `Asked by ${base}`,
    markup: 0,
    buttons: ["Deny", "Approve"],
    danger: true,
    focused: true,
  });
  // Enter answers nothing: neither action is the default.
  await bridgePage.keyboard.press("Enter");
  await sleep(300);
  assert.equal(posted("approvals", "p1").length, 0);
  assert.equal(
    await b(`return Boolean(root.querySelector(".overlay .approval"));`),
    true,
  );
  await b(`root.querySelector(".overlay .approve").click();`);
  await until(() => posted("approvals", "p1").length, "p1");
  assert.deepEqual(posted("approvals", "p1"), [{ id: "p1", approved: true }]);
  await bWait(
    `root.querySelector(".overlay .approval h2")?.textContent === "Restart worker"`,
    "the second approval",
  );
  assert.equal(
    await b(
      `return root.querySelector(".overlay .approve").classList.contains("danger");`,
    ),
    false,
  );
  // The third prompt waits for nobody; shorten its two minutes for the test.
  await bridgePage.evaluate(() => (window.shrinkTimeouts = true));
  await b(`root.querySelector(".overlay .deny").click();`);
  await until(() => posted("approvals", "p2").length, "p2");
  assert.deepEqual(posted("approvals", "p2"), [{ id: "p2", approved: false }]);
  await until(() => posted("approvals", "p3").length, "p3");
  await bridgePage.evaluate(() => (window.shrinkTimeouts = false));
  assert.deepEqual(posted("approvals", "p3"), [{ id: "p3", approved: false }]);
  await answered("Approvals done");
  assert.equal(
    await b(`return root.querySelector(".tool-approval")?.textContent;`),
    "Not approved",
  );
  assert.equal(await bridgePage.evaluate(() => window.pwned), undefined);

  // `generate` wins when both are given: no session is asked for and no
  // conversation travels with the result.
  const g = shadowIn(bridgePage, "#gen");
  await g(`root.querySelector(".input").focus();`);
  await bridgePage.keyboard.type("gen", { delay: 5 });
  await g(`root.querySelector(".send:not(.stop)").click();`);
  await waitIn(g)(
    `[...root.querySelectorAll(".msg.assistant")].some((m) => m.textContent.includes("Got: from the page"))`,
    "the page-generated answer",
  );
  assert.deepEqual((await log()).generated, ["from-gen"]);
  assert.equal((await log()).enables.length, 1);
  assert.equal("conversation" in final("g1"), false);
  assert.deepEqual(bridged.turns.at(-1).bridge, { model: null, tools: [] });

  // Deleting the thread releases the conversations it used, and only those.
  await b(`root.querySelector(".thread-toggle").click();`);
  await bWait(`root.querySelector(".thread-row")`, "the bridged thread row");
  await b(`root.querySelector(".thread-act[aria-label^=Delete]").click();`);
  await until(async () => (await log()).released.length === 3, "the releases");
  assert.deepEqual((await log()).released.sort(), [
    "conv-old.tag",
    "conv1.tag",
    "conv2.tag",
  ]);
  await bridgePage.evaluate(() => window.assistant.destroy());
  assert.deepEqual(bridgeErrors, []);

  // ------------------------------------------------- in-page backend (mode 5)
  const inpage = await browser.newPage();
  const inpageErrors = [];
  inpage.on("pageerror", (error) => inpageErrors.push(String(error)));
  // Every request the page makes is seen here; only the fixture and the
  // widget's own module files may load, and anything else is refused.
  const requests = [];
  await inpage.setRequestInterception(true);
  inpage.on("request", (request) => {
    const { pathname } = new URL(request.url());
    requests.push(pathname);
    if (pathname === "/widget-inpage.html" || pathname.startsWith("/widget/"))
      return request.continue();
    return request.abort();
  });
  await inpage.goto(`${base}/widget-inpage.html`, {
    waitUntil: "networkidle0",
  });
  const loadRequests = requests.length;
  const p = shadowIn(inpage, "#assistant");
  const pWait = waitIn(p);
  const pLog = () => inpage.evaluate(() => window.inpageLog);
  const pSend = async (text) => {
    await pWait(`root.querySelector(".send:not(.stop)")`, "an idle composer");
    await p(`root.querySelector(".input").focus();`);
    await inpage.keyboard.type(text, { delay: 5 });
    await p(`root.querySelector(".send:not(.stop)").click();`);
  };
  const pSays = (text) =>
    pWait(
      `[...root.querySelectorAll(".msg.assistant")].some((m) => m.textContent.includes(${JSON.stringify(text)}))`,
      text,
    );
  await pWait(`root.querySelector(".panel")`, "the in-page panel");
  // Exactly one of baseUrl and fetch, and no options fetch would ignore.
  assert.deepEqual((await pLog()).mountErrors, [
    "backend needs exactly one of baseUrl or fetch.",
    "backend needs exactly one of baseUrl or fetch.",
    "backend.headers and backend.credentials apply only to baseUrl.",
    "backend.fetch must be a function.",
  ]);

  // A full turn from page JS: deltas, then the authoritative message.
  await pSend("hello");
  await pSays("Hello from the page.");
  assert.equal(
    await p(
      `return [...root.querySelectorAll(".msg.assistant")].filter((m) => m.textContent.includes("from the page")).length;`,
    ),
    1,
  );
  const helloTurn = (await pLog()).calls.find(
    (call) => call.method === "POST" && /\/turns$/.test(call.path),
  );
  assert.equal(helloTurn.body.content, "hello");
  assert.match(helloTurn.path, /^threads\/[^/]+\/turns$/);
  // The bridge is announced through the function as to a server.
  assert.deepEqual(
    helloTurn.body.bridge.tools.map((tool) => tool.name),
    ["page_info"],
  );

  // A tool.client round: the handler ran in the page, and its result went
  // back through the same function while the stream stayed open.
  await pSend("tool");
  await pSays("The page is called In-page backend fixture.");
  assert.deepEqual((await pLog()).toolResults, [
    { id: "c1", result: { title: "In-page backend fixture" } },
  ]);
  assert.ok(
    (await pLog()).calls.some((call) =>
      /^threads\/[^/]+\/turns\/pt2\/tool-results$/.test(call.path),
    ),
  );

  // A model.client round answered by the bridge and posted back in page.
  await pSend("model");
  await pSays("Model said hi.");
  assert.deepEqual((await pLog()).generated, ["say hi"]);
  assert.equal((await pLog()).modelResults.at(-1).id, "m1");

  // Bounds hold against the page exactly as against a server.
  const failures = [
    ["flood", "The backend stream was too large."],
    ["strings", "The backend stream is malformed."],
    ["shapeless", "The in-page backend returned an invalid response."],
    ["rejected", "The backend rejected the request (500)."],
    ["throws", "The in-page backend failed."],
  ];
  for (const [content, message] of failures) {
    await pSend(content);
    await pWait(
      `[...root.querySelectorAll(".msg.assistant")].some((m) => m.textContent.includes(${JSON.stringify(`Could not complete the request: ${message}`)}))`,
      `the ${content} rejection`,
    );
  }
  // The flood was read incrementally and cancelled at the ceiling, not
  // buffered whole: it would never have ended on its own.
  const flood = (await pLog()).flood;
  assert.equal(flood.cancelled, true);
  assert.ok(flood.pulled > 2_000_000 && flood.pulled < 2_400_000, flood.pulled);
  // The page's own error text stays the page's.
  assert.equal(
    await p(
      `return root.querySelector(".messages").textContent.includes("exploded");`,
    ),
    false,
  );
  // A JSON answer past 1,000,000 bytes is refused like a server's.
  await inpage.evaluate(() => window.assistant.openThread("big"));
  await pWait(
    `root.querySelector(".thread-error")?.textContent.includes("The backend response was too large.")`,
    "the oversized transcript rejection",
  );

  // Stop reaches a page-built stream: the body is cancelled, the loop's
  // generator closes, and the cancel route goes through the function too.
  await pSend("hang");
  await pWait(`!root.querySelector(".stop").hidden`, "the stop control");
  await sleep(200);
  await p(`root.querySelector(".stop").click();`);
  await until(async () => (await pLog()).hangClosed, "the closed loop");
  await until(
    async () =>
      (await pLog()).calls.some((call) =>
        /^threads\/[^/]+\/turns\/pt4\/cancel$/.test(call.path),
      ),
    "the cancel route",
  );
  await pWait(`root.querySelector(".send:not(.stop)")`, "the idle composer");

  // The renderer made no network request: everything after load went
  // through the page's function.
  assert.deepEqual(requests.slice(loadRequests), []);
  assert.ok(
    requests.every(
      (path) => path === "/widget-inpage.html" || path.startsWith("/widget/"),
    ),
    requests.join(", "),
  );
  const routes = new Set(
    (await pLog()).calls.map((call) =>
      call.path
        .replace(/^threads\/[^/?]+/, "threads/{id}")
        .replace(/turns\/[^/]+\//, "turns/{turn}/"),
    ),
  );
  for (const route of [
    "threads",
    "threads/{id}/turns",
    "threads/{id}/turns/{turn}/tool-results",
    "threads/{id}/turns/{turn}/model-results",
    "threads/{id}/turns/{turn}/cancel",
  ])
    assert.ok(routes.has(route), `${route} went through backend.fetch`);
  // bridge.arjunah behind a page function declares the page as the composer.
  const v = shadowIn(inpage, "#visitor");
  await v(`root.querySelector(".input").focus();`);
  await inpage.keyboard.type("hello", { delay: 5 });
  await v(`root.querySelector(".send:not(.stop)").click();`);
  await waitIn(v)(
    `[...root.querySelectorAll(".msg.assistant")].some((m) => m.textContent.includes("Hello from the page."))`,
    "the visitor-mount answer",
  );
  assert.deepEqual((await pLog()).enables, [{ composer: "webapp" }]);
  assert.equal(
    (await pLog()).calls.findLast((call) => /\/turns$/.test(call.path)).body
      .bridge.model,
    null,
  );
  assert.deepEqual(requests.slice(loadRequests), []);
  await inpage.evaluate(() => window.assistant.destroy());
  assert.deepEqual(inpageErrors, []);
  const inpageCalls = (await pLog()).calls.length;

  console.log(
    `Standalone widget E2E passed with ${state.userTurns.length} turns, ${state.actions.length} card action, a mention, a model switch and a collected input; bridged mode passed with ${bridged.turns.length} turns, ${bridged.posts["model-results"].length} model-results posts, ${bridged.posts.inputs.length} input and ${bridged.posts.approvals.length} approvals; the in-page backend passed with ${inpageCalls} routed calls, ${failures.length} bound violations rejected and no network request.`,
  );
} finally {
  await browser.close();
  server.close();
}
