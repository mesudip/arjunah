# arjunah-widget

The अर्जुनः (Arjunah) chat widget, mounted against your own backend.

This is the same renderer the [अर्जुनः browser extension](https://github.com/mesudip/arjunah)
hosts, published so a site can use it without the extension. The build is a copy
of `src/renderer/core.js` from that repository plus an ESM footer, so the widget
your visitors see is the file the extension loads, not a re-implementation.

**There is no wallet here.** In the extension the visitor's own provider answers
under a per-origin grant, and the site never sees a credential. Mounted this way,
your backend owns inference, tools and conversations, and it sees everything the
visitor types. The widget never claims otherwise and never touches
`window.ai.arjunah`.

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
reach each other. `backend.baseUrl` must be same-origin or HTTPS.

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

## What your backend implements

The contract is SPEC section 14. Relative to `baseUrl`:

| Route                                      | Method | Returns                       |
| ------------------------------------------ | ------ | ----------------------------- |
| `threads`                                  | GET    | `ThreadSummary[]`             |
| `threads`                                  | POST   | `ThreadSummary`               |
| `threads/{id}`                             | GET    | `TranscriptEntry[]`           |
| `threads/{id}`                             | PATCH  | `204`, body `{ title }`       |
| `threads/{id}`                             | DELETE | `204`                         |
| `threads/{id}/turns`                       | POST   | `text/event-stream`           |
| `threads/{id}/turns/{turnId}/tool-results` | POST   | `204`, stream continues       |
| `threads/{id}/turns/{turnId}/cancel`       | POST   | `204`                         |
| `threads/{id}/actions`                     | POST   | `204`, or `{ card }` to swap  |
| `entities?q={query}`                       | GET    | `Entity[]`, ≤ 20 (see below)  |

`entities` is only called when you enable mentions without your own `search`.
A turn answers with Server-Sent Events. Each event has an `event:` name and a
JSON `data:` object:

`turn.start`, `model.start`, `output.delta`, `reasoning.delta`, `tool.start`,
`progress`, `tool.end`, `card`, `card.update`, `tool.client`, `message`,
`turn.end`, `error`.

A minimal turn is `turn.start`, `output.delta` (or a single `message` carrying
the finished assistant entry), then `turn.end`. The turn body is
`{ content, controls?, model?, reasoning? }`.

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

No consent UI, no usage or quota display, no credential handling, and no
provider catalog. The model menu here lists what **you** named in
`widget.models` and means whatever your backend decides; in the extension the
same menu lists the visitor's own providers and switches which credential
answers. That difference is the whole wallet, and this package has none of it.
If you want it, ship the extension integration instead: see
[docs/INTEGRATION.md](https://github.com/mesudip/arjunah/blob/main/docs/INTEGRATION.md).

MIT licensed. Protocol contract: [SPEC.md](https://github.com/mesudip/arjunah/blob/main/SPEC.md).
