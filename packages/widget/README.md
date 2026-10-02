# arjunah-widget

The अर्जुनः (Arjunah) chat widget, mounted against your own backend.

This is the same renderer the [अर्जुनः browser extension](https://github.com/mesudip/arjunah)
hosts, published so a site can use it without the extension. The build is a copy
of `src/renderer/core.js` from that repository plus an ESM footer, so the widget
your visitors see is the file the extension loads, not a re-implementation.

**There is no wallet here.** In the extension the visitor's own provider answers
under a per-origin grant, and the site never sees a credential. Mounted this way,
your backend owns inference, tools and conversations, and it sees everything the
visitor types. The widget never claims otherwise. It touches `window.ai.arjunah`
only in [bridged mode](#bridged-mode), and then only through the public API any
page may call.

## Install

```sh
npm install arjunah-widget
```

## Mount it

```js
import { mountAssistant } from "arjunah-widget";

const assistant = mountAssistant({
  mount: document.querySelector("#assistant"),
  backend: { baseUrl: "/api/assistant/" },
  widget: {
    name: "Trip desk",
    greeting: "Ask about a trip.",
    suggestions: ["Plan a weekend in Lisbon"],
    theme: { accent: "#3b5bdb", mode: "auto" },
    // Non-empty shows the built-in picker; the choice rides with each turn.
    models: [
      { id: "fast", displayName: "Fast", contextWindow: 128000 },
      { id: "deep", displayName: "Deep", reasoningLevels: ["low", "high"] },
    ],
    defaultModel: "fast",
  },
  // Enables `@` in the composer. Omit `search` to use `GET entities?q=`.
  entities: {
    search: (query) => findTrips(query),
    onActivate: (entity) => openTrip(entity.id),
  },
  tools: [
    {
      name: "page_info",
      inputSchema: { type: "object", additionalProperties: false },
      handler: (_args, invocation) => {
        invocation.reportProgress("reading the page");
        return { title: document.title };
      },
    },
  ],
  onTurnEnd: ({ usage }) => showUsage(usage),
  onThreadChange: ({ threadId }) => remember(threadId),
});

assistant.openThread(lastThreadId);
```

`mount` gets a shadow root, so the widget's styles and your page's styles cannot
reach each other. `backend.baseUrl` must be same-origin or HTTPS. Instead of a
server, `backend: { fetch }` lets your page answer the routes itself; see
[In-page backend](#in-page-backend).

Tools listed here run **in the page**, and only when your backend asks for one
with a `tool.client` event. Tools that need a secret run on your backend inside
the turn; they need no declaration here.

## What the widget already draws

These are the widget's own controls, so a site supplies data and never markup:

| You give it            | The visitor gets                                             |
| ---------------------- | ------------------------------------------------------------ |
| `widget.models`        | A provider-grouped model menu and, for a model with `reasoningLevels`, a thinking-effort control. Both hide when the list is empty. |
| `entities`             | `@` in the composer: a search menu, and the chosen match as one atomic chip that a single backspace removes whole. |
| `widget.controls`      | Toggles, selects and buttons in the Options drawer, sent with every turn. |
| `tools[].userInputs`   | A masked, validated prompt for a value the model must not supply (below). |
| `input.client`, `approval.client` events | The same prompt for your backend's own tools, and an approval prompt (below). |

Callbacks report what happened and cannot veto it: `onTurnStart`, `onTurnEnd`
(with the turn's `usage`), `onThreadChange`, `onModelChange`, `onControlChange`,
`onError` and `onClose`. The mounted object adds `openThread(id)`,
`newThread()`, `getControls()`, `setControls(values)`, `setModels(models,
selected)`, `open()`, `close()` and `destroy()`.

## Mentions

A chip submits as a `mention` content part beside the text:

```json
{
  "content": [
    { "type": "text", "text": "Compare " },
    { "type": "mention", "id": "city:lis", "label": "Lisbon" },
    { "type": "text", "text": " and Lyon" }
  ],
  "model": "deep",
  "reasoning": "high"
}
```

So your backend resolves the id from your own data instead of trusting a typed
name, and a model only ever sees `@Lisbon`. Return the parts unchanged from
`GET threads/{id}` and a replayed conversation keeps its chips.

## Values the model must not see

A tool can declare inputs apart from its model-facing schema:

```js
{
  name: "unlock",
  inputSchema: { type: "object", additionalProperties: false },
  userInputs: [
    { id: "passphrase", label: "Passphrase", secret: true,
      schema: { type: "string", minLength: 3 } },
  ],
  async handler(args, invocation) {
    const passphrase = await invocation.requestInput("passphrase");
    return { unlocked: await unlock(args, passphrase) };
  },
}
```

The model's schema has no `passphrase`, so it cannot invent the value, ask for
it in conversation, or read it back. The widget prompts, validates against the
declared scalar schema, and resolves it to that one invocation; it is never
merged into the arguments, the transcript or anything the backend stores. Your
handler receives it and can still misuse it, so use it for the disclosed
operation and keep it out of the tool result.

A tool that runs on your backend asks for the same prompt with an
`input.client` event, `{ id, toolId, input }`, where `input` is one declaration
of the shape above. The widget validates the declaration, shows the prompt, and
posts `{ id, value }` or `{ id, cancelled: true }` to
`threads/{id}/turns/{turnId}/inputs`, once per `id`. An invalid declaration is
answered `cancelled` without a prompt. Apply the value to that pending call
only, never write it to the transcript, and never echo it on the stream.

## Approvals

Before your backend runs an operation the visitor should confirm, emit
`approval.client`:

```json
{
  "id": "p1",
  "toolId": "s4",
  "approval": {
    "title": "Deploy build 42",
    "summary": "Ships build 42 to production.",
    "target": "prod-1",
    "detail": "{ \"tag\": \"v42\" }",
    "danger": true
  }
}
```

The widget draws `title` (at most 80 characters), `summary` (280), `target`
(80) and `detail` (4,000, preformatted) as plain text with the asking origin,
under its own Approve and Deny buttons. Neither button is the default, so Enter
does not answer; `danger` draws Approve in red. It posts `{ id, approved }` to
`threads/{id}/turns/{turnId}/approvals`. Deny, Escape, a prompt past any bound,
two minutes without an answer, and the end of the turn all answer `false`, and
the decision is shown on the tool's step. Whether a call needs approval is your
policy, and so is binding the answer to the exact operation and using it once:
the prompt carries a decision, not authority, so act only on `approved: true`
for a request you sent.

## Bridged mode

Your backend can run the loop while the **visitor's own model** answers each
round, through an ordinary level 1 or 2 session on the अर्जुनः extension:

```js
mountAssistant({
  mount,
  backend: { baseUrl: "/api/assistant/" },
  bridge: { arjunah: true }, // or { arjunah: { level: "catalog" } }
});
```

The widget calls `window.ai.arjunah.enable()` on the visitor's first send, so
the extension's consent follows a click, and keeps the session for the life of
the mount. Every turn body then carries what the page can do:

```json
"bridge": {
  "model": { "id": "openai/gpt-5.6-sol", "capabilities": { "tools": true }, "contextWindow": 272000 },
  "tools": [{ "name": "page_info", "description": "…", "inputSchema": { "type": "object" } }]
}
```

`model` is the visitor's model entry, or `null` when there is no extension, the
visitor refused, or the session was lost; decide before composing whether to
run, use a model of your own, or fail. `tools` are the page tools declared
here, without handlers or `userInputs`, at most 32. The model picker shows the
visitor's catalog instead of `widget.models`, and `setModels` is ignored.

When the loop needs the model, emit `model.client`:

```json
{ "id": "m1", "request": { "messages": [...], "tools": [...] }, "conversation": "c-91", "stream": true }
```

`request` is a SPEC 5.3 `models.generate` request and is passed on unchanged.
The widget posts the outcome to `threads/{id}/turns/{turnId}/model-results` as
`{ id, result, conversation? }` or `{ id, error: { code, message }, conversation? }`
with a SPEC section 9 code, and your stream continues. It never retries and
never opens a dialog of its own; a revoked or refused session is just an
`error`. Keep the turn's stream open for at least 180 seconds after a
`model.client`.

- **Conversations.** You own the mapping from your thread to a conversation.
  Send the id you stored as `conversation`; without one the widget creates a
  conversation on the visitor's session and returns its id with the answer, so
  store that. An id the extension no longer knows starts a new one, whose id
  comes back in its place. Deleting a thread in the widget releases the
  conversations it used. A session without conversations falls back to
  `models.generate`, and no `conversation` is returned.
- **Deltas.** When the session can stream a round, the widget draws its answer
  and reasoning as provisional text. Your `message` event replaces it, and a
  result that ends in tool calls discards it, so do not echo those deltas back
  as `output.delta`. With `stream: true` it also posts each delta, in order and
  coalesced while a post is in flight, as `{ id, delta: { type, text } }`
  before the final `{ id, result }`; `type` is `output.delta` or
  `reasoning.delta`.
- **Cancel.** `model.cancel { id }` aborts that completion and nothing more is
  posted for it. The stop control, deleting the thread, and `destroy()` abort
  every completion the turn still has outstanding, silently.
- **No bridge.** A `model.client` on a turn whose body had no `bridge` is
  answered `{ id, error: { code: "NOT_SUPPORTED" } }`; treat that as final.

`bridge.generate(request, { signal })` answers completions with a page function
instead, for example one that calls a model the site runs; it wins when both are
given. It is held to the same 180 seconds, after which the widget answers
`TIMEOUT`, and its result carries no `conversation`. With `generate`,
`bridge.model` is the selected `widget.models` entry, or `null` without one.

**What bridged mode may claim.** Three things are true and the visitor may be
told them: the credential stays in the extension, the grant is per exact origin
and revocable, and the visitor chooses the model. Everything else is as above:
your backend sees everything the visitor types, writes every prompt, and can
log the conversation. There is no system-prompt disclosure: at level 1 the site
writes its own messages, so the extension has no prompt to show the visitor in
advance. Do not describe this as the wallet.

## In-page backend

`backend: { fetch }` replaces the server with a page function of the global
`fetch` signature, so your page JavaScript runs the loop and draws it in the
widget. The widget then makes no network request of its own: every route below
goes through your function, called with the path relative to the routes (for
example `"threads/t1/turns"`) and an init of `{ method, headers, body?,
signal? }`, where `body` is a JSON string and `signal`, on the turn POST,
aborts when the visitor stops the turn. Pass exactly one of `baseUrl` and
`fetch`; `headers` and `credentials` are refused with `fetch` because nothing
would send them.

What the function returns is held to every bound a server's answer is: a
non-2xx status is a rejection, anything without an integer `status` and a
readable `body` (or `null`) is refused, a turn stream is read incrementally
and cut off at 2,000,000 bytes, other answers at 1,000,000, body chunks must be
bytes, and malformed events are dropped. A function that throws fails the
request as "The in-page backend failed." without showing your error text.

`eventStreamResponse(events)` turns an iterable or async iterable of
`{ type, ...data }` events into a `text/event-stream` `Response`. It pulls one
event at a time, so a generator can wait between yields, and when the widget
stops reading (stop, `destroy()`, a bound) the iterator's `return()` runs, so a
generator's `finally` sees the end. A page loop answering a turn, with one
`tool.client` round:

```js
import { mountAssistant, eventStreamResponse } from "arjunah-widget";

const threads = [];
const toolResults = new Map(); // tool.client id -> resolve
const reply = (value) =>
  value === undefined
    ? new Response(null, { status: 204 })
    : new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json" },
      });

async function* turn(threadId, { content }) {
  const turnId = crypto.randomUUID();
  yield { type: "turn.start", turnId, threadId };
  // The widget validates the arguments, runs page_info, and posts the result
  // to tool-results, which resolves this promise.
  const pending = new Promise((resolve) => toolResults.set("c1", resolve));
  yield { type: "tool.client", id: "c1", name: "page_info", arguments: {} };
  const info = await pending;
  const text = `“${content}” on ${info.title}.`;
  yield { type: "output.delta", text };
  yield {
    type: "message",
    entry: {
      type: "message",
      id: crypto.randomUUID(),
      role: "assistant",
      content: text,
      createdAt: new Date().toISOString(),
    },
  };
  yield { type: "turn.end", turnId };
}

mountAssistant({
  mount: document.querySelector("#assistant"),
  backend: {
    async fetch(path, { method, body }) {
      const [root, id, sub, turnId, route] = path.split("/");
      if (root !== "threads") return reply([]); // entities?q=…
      if (!id && method === "POST") {
        const summary = {
          id: crypto.randomUUID(),
          title: "Chat",
          updatedAt: new Date().toISOString(),
        };
        threads.unshift(summary);
        return reply(summary);
      }
      if (!id) return reply(threads);
      if (!sub) return method === "GET" ? reply([]) : reply();
      if (sub === "turns" && !turnId)
        return eventStreamResponse(turn(id, JSON.parse(body)));
      if (route === "tool-results") {
        const answer = JSON.parse(body);
        toolResults.get(answer.id)?.(answer.result);
        toolResults.delete(answer.id);
      }
      return reply(); // cancel, inputs, approvals, actions
    },
  },
  tools: [
    {
      name: "page_info",
      inputSchema: { type: "object", additionalProperties: false },
      handler: () => ({ title: document.title }),
    },
  ],
});
```

Register a tool-call's waiter before yielding the event that asks for it, as
above: the widget may post the answer before your generator resumes.

Add `bridge` and the loop can answer with the **visitor's** model: emit
`model.client` exactly as a server would, and the widget runs it through the
extension session and posts `{ id, result }` to `model-results` through the
same function. Behind `fetch` the access request declares `composer: "webapp"`,
so the extension's consent says the page writes the prompts; a function that
only forwards each route to your server should pass
`bridge: { arjunah: { composer: "server" } }`. Page code may of course call
`window.ai.arjunah` itself instead. Either way the [bridged-mode
claims](#bridged-mode) are the limit of what the visitor may be told.

## What your backend implements

The contract is SPEC section 14. Relative to `baseUrl`, or as the path given
to `backend.fetch`:

| Route                                      | Method | Returns                       |
| ------------------------------------------ | ------ | ----------------------------- |
| `threads`                                  | GET    | `ThreadSummary[]`             |
| `threads`                                  | POST   | `ThreadSummary`               |
| `threads/{id}`                             | GET    | `TranscriptEntry[]`           |
| `threads/{id}`                             | PATCH  | `204`, body `{ title }`       |
| `threads/{id}`                             | DELETE | `204`                         |
| `threads/{id}/turns`                       | POST   | `text/event-stream`           |
| `threads/{id}/turns/{turnId}/tool-results` | POST   | `204`, stream continues       |
| `threads/{id}/turns/{turnId}/inputs`       | POST   | `204`, stream continues       |
| `threads/{id}/turns/{turnId}/approvals`    | POST   | `204`, stream continues       |
| `threads/{id}/turns/{turnId}/model-results` | POST  | `204`, stream continues (bridged mode) |
| `threads/{id}/turns/{turnId}/cancel`       | POST   | `204`                         |
| `threads/{id}/actions`                     | POST   | `204`, or `{ card }` to swap  |
| `entities?q={query}`                       | GET    | `Entity[]`, ≤ 20 (see below)  |

`entities` is only called when you enable mentions without your own `search`.
A turn answers with Server-Sent Events. Each event has an `event:` name and a
JSON `data:` object:

`turn.start`, `model.start`, `output.delta`, `reasoning.delta`, `tool.start`,
`progress`, `tool.end`, `card`, `card.update`, `tool.client`, `input.client`,
`approval.client`, `model.client`, `model.cancel`, `agent.phase`,
`model.stalled`, `message`, `turn.end`, `error`.

A minimal turn is `turn.start`, `output.delta` (or a single `message` carrying
the finished assistant entry), then `turn.end`. The turn body is
`{ content, controls?, model?, reasoning?, bridge? }`; `bridge` is present only
in bridged mode.

## Cards

A `tool.end` or `card` event may carry a `card`: a small JSON tree the widget
draws inside the conversation. Nodes are `text`, `list`, `button` and `form`
(with `input`, `select` and `checkbox` fields). There is no HTML, no Markdown, no
links and no images, and every card is validated against the same bounds the
extension enforces before anything is drawn.

A button or form carries one action:

- `{ type: "message", text }` sends `text` as a visible user turn, so the model
  never receives something the visitor did not see.
- `{ type: "local", name, payload }` posts to `threads/{id}/actions` and never
  becomes a model message. Answer with `{ card }` to replace the card in place.

## Progress

`progress` events, and `invocation.reportProgress(text)` inside a client tool,
show one ephemeral line under that tool's step. Progress is never stored and
never sent to a model. Reports are capped at 200 characters.

## What this package does not do

No consent UI, no usage or quota display, and no credential handling. The model
menu here lists what **you** named in `widget.models` and means whatever your
backend decides; in the extension the same menu lists the visitor's own
providers and switches which credential answers. That difference is the whole
wallet, and this package has none of it. Bridged mode borrows one piece of it,
the visitor's model behind the extension's own consent, and the menu then lists
what that session exposes; the conversation is still yours.
If you want it, ship the extension integration instead: see
[docs/INTEGRATION.md](https://github.com/mesudip/arjunah/blob/main/docs/INTEGRATION.md).

MIT licensed. Protocol contract: [SPEC.md](https://github.com/mesudip/arjunah/blob/main/SPEC.md).
