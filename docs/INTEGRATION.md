# Integrating a website with अर्जुनः

Reader: a developer or an AI coding assistant adding अर्जुनः (Arjunah) to a site.
Normative contract: SPEC.md at the repository root. This file is the working
summary; when they disagree, SPEC.md wins.

## What it is

The visitor installs the अर्जुनः browser extension. It injects window.ai.arjunah
into every http(s) page at document start. Your site never holds an API key and
never talks to a model vendor: it either publishes an assistant contract and lets
the extension host the chat (level 0), or it enables access and calls the model
the visitor chose (level 1 or 2). The visitor approves every access request in an
extension-owned dialog, per exact origin (scheme://host:port).

Levels say only how far the visitor's model reaches. Who runs the conversation
(the extension, your server, or your page) and who draws it (the extension or
your page) is a separate choice: see "The five modes" below.

## Install

```sh
npm install arjunah@beta
```

The package is the typed SDK: it finds the injected API, waits for it, and types
it. It contains no model code and adds no runtime behaviour beyond the wait.

Without npm, the API is still there as window.ai.arjunah; install arjunah as a dev
dependency for the types only.

## The API in one screen

Root, window.ai.arjunah, always present once the extension is installed:

version: protocol version string, currently "1.0.0". Feature-detect by members, not version.
isEnabled(): Promise<boolean>. True when this origin holds level 1 or 2 access.
enable(request?): Promise<Session>. Asks the visitor for access and resolves to the session. No argument means level 1. Does not prompt when the access is already held. Rejects with code USER_DENIED.
disable(): Promise<true>. Drops the origin's whole grant, including a hosted-chat grant.
openSettings(): Promise<true>. Opens the extension's view of your site (its toolbar popup, or its settings page). Call it from a click or key handler: without a user gesture it rejects with PERMISSION_REQUIRED.
window event "arjunah:grantchange": detail { level, model, revoked }. Fired when your origin's grant or site model changes anywhere (consent, the popup, settings, the chat header, a revocation); level and model are null and revoked is true once the grant is gone. Re-read models.list() when it arrives.
site.register(manifest): level 0. Publishes the assistant contract; needs no grant; grants nothing.
chat.open() / chat.close() / chat.getControls() / chat.setControls(values): the extension-hosted chat.

Session, what enable() resolves to:

grant: the grant as it stood when enable() resolved (origin, level, capabilities, context, model, grantedAt).
permissions.query(): the origin's current grant or null.
models.list(): models this site may use. At level 1 exactly one, the model the visitor picked for this site. Each entry's limits are the bounds generate holds you to for that model, and kind ("api-key", "subscription", "self-hosted"), local (true only for a model running on the visitor's own computer or network), and builtinTools (true when the answering agent runs tools of its own, today Codex) say where it runs.
models.generate(request, { signal }?): a one-off completion. Needs level 1 or 2. Aborting signal rejects with ABORTED and stops the provider request.
models.stream(request, { signal }?): the same completion as an async iterable: output.delta and reasoning.delta events as they arrive, stalled after 20 s of silence, and last { type: "result", result }, the result generate would give. Breaking out of the loop cancels it.
conversations.create(): Promise<conversation>. A conversation the extension mints for your origin: { id, generate(request, { signal }?), stream(request, { signal }?), release() }. Use one per thread for tool loops.
conversations.open(id): Promise<conversation>. The same handle again for an id you were given earlier (after a reload, or stored by your server with its thread). INVALID_REQUEST for an id not minted for your origin.
providers.list(): needs level 2.
context.get({ fields }): needs the context.read capability and the fields in the grant.

SDK helpers, all in the arjunah package: getArjunah(), isInstalled(),
waitForArjunah({ timeoutMs }), isEnabled(), enable(request), disable(),
registerSite(manifest), openChat(), openSettings(), onGrantChange(listener)
(returns an unsubscribe function), isAIError(error), PROTOCOL_VERSION,
READY_EVENT, GRANT_CHANGE_EVENT. Each async helper waits for the API first and rejects with code
NOT_INSTALLED after the timeout (default 3000 ms) when the extension is absent.

## Choosing a level

Level 0, assistant: you want a chat widget on your site that can call your page
functions. You write a system prompt and tools; the extension renders the chat,
runs the model, and asks the visitor for permission when they send the first
message. Use this unless you need model output inside your own UI.

Level 1, completion: your code needs a completion (summarise this form, draft this
message). Call enable() with no argument. You get one model, the visitor's choice
for your site; passing any other model id is INVALID_REQUEST. Use "default" or omit
model.

Level 2, catalog: you want to show your own model picker. Call enable({ level:
"catalog" }). models.list() and providers.list() return what the visitor exposed to
you; account identities, plans, quotas, and server addresses are never included.
A provider's kind is "api-key", "subscription", or "self-hosted" (a model server
the visitor runs, such as Ollama). Self-hosted models vary widely: read each
model's capabilities (tools, vision, reasoning) instead of assuming them, because
the extension refuses images for a model without vision and sends no tools to a
model without tool support. vendor is null whenever the extension cannot know it:
a custom OpenAI-compatible address, a self-hosted server, the OpenCode CLI.

Restricting which models may answer you. If you promised your users something
about where their data goes, say so in the request and the extension holds the
visitor's choice to it:

```js
const ai = await enable({ require: { local: true } }); // only on-device or own-network models
// also: { kinds: ["subscription", "self-hosted"] }, { builtinTools: false }
```

Consent then offers only qualifying models and tells the visitor you restricted
the choice; with none configured it explains why and enable() rejects with
NOT_CONFIGURED. The site model stays pinned to a qualifying one on every
surface, a round answered by any other model fails with NOT_SUPPORTED before a
provider is contacted, and at level 2 models.list() returns only qualifying
models. Calling enable() again with the same require does not prompt; a
different one asks again; require: {} removes it. Unknown members or values are
INVALID_REQUEST. Only the visitor's models are constrained, never your own.

## Flows

Level 0, hosted assistant:

1. await registerSite({ name, systemPrompt, tools, widget }). Resolves { id, unregister() }.
2. Optionally await openChat(), or set widget.autoShow: true.
3. Tool handlers run in your page with your page's authority when the model calls them.

Level 1 or 2, your own model calls:

1. const ai = await enable() or enable({ level: "catalog" }).
2. const { message } = await ai.models.generate({ messages: [...] }).
3. await window.ai.arjunah.disable() when the visitor asks to disconnect.

Live examples: demo/paint/ (a level-0 retained canvas with structured image tool
results), demo/trip-planner/ (the original level 0, 1, and 2 form example), and
tests/fixtures/site.html (minimal browser-test registrations). Copy their shapes
rather than inventing new ones.

## Site manifest: fields and bounds

name: required, 1 to 80 characters.
description: up to 280 characters.
systemPrompt: up to 12,000 characters. Disclosed to the visitor verbatim at consent.
tools: up to 32 of { name, description, inputSchema, outputContent?, userInputs?, requiresApproval?, handler }. Names match ^[A-Za-z0-9_-]{1,64}$. inputSchema uses the JSON Schema subset in SPEC section 7.1 (object schemas with typed properties; keep them small and set additionalProperties false). Generated schemas (Pydantic, FastAPI, zod) usually fit as they are: format, contentMediaType, contentEncoding, readOnly, writeOnly and deprecated are accepted as annotations that are never enforced or sent to a provider, and a type list such as ["string", "null"] is read as an anyOf. $ref, $defs and pattern are refused, so inline references before registering.
handler(args, invocation): sync or async. invocation is { id, name, controls, requestInput(id), reportProgress(text) }. Without outputContent, return JSON-serialisable data at most 64 KiB. With outputContent: ["text"], ["text", "image"] or ["text", "card"], return { kind: "content", content: [...] }; 1–8 bounded parts, at most four supported base64 images, at most one card, and every image or card requires a text fallback. Vision models see broker-generated user image parts after all ordinary tool results in the round; other models receive only the text. A card is drawn in the transcript and never reaches any model.
requiresApproval: true makes the extension show its approval prompt (the tool name, the model's arguments, your origin) before each call; only Approve runs the handler, and anything else reaches the model as a tool error saying the visitor did not approve. Consent lists the tools that ask first. See SPEC 7.8.
userInputs: scalars the model must never supply (passphrase, one-time code, confirmation). Declared outside inputSchema, collected by the extension in its own labelled prompt, delivered only to your handler via await invocation.requestInput(id), never added to model messages or history. Your handler receives the value, so this protects against accidental model exposure, not against your own code. See SPEC 7.3.
mcpServers: up to 8 { id, name, url, headers?, tools? }. HTTPS only, loopback HTTP for development. Without tools the visitor approves the server, then its discovered tool metadata, before any model call. With tools (up to 64 definitions) the extension never calls tools/list, the definitions join the fingerprinted contract, and one approval covers them — this is how you run first-party tools on your own backend while the secret stays there. tools/call carries { arjunah: { conversationId } } in params.\_meta. A declared tool may also set requiresApproval and userInputs: the extension asks first, collects the inputs in its own prompt labelled with your server's origin, and sends them as params.\_meta.arjunah.inputs, an object keyed by input id, never in arguments.
loop: { composer: "server" | "webapp", fetch(path, init), level?: 1 | 2, inputs?: boolean }. A loop outside the extension composes the conversation and the extension hosts the panel (modes 2 and 3 below). Exclusive with systemPrompt; mcpServers is ignored.
models: { list: [{ id, displayName?, capabilities?, contextWindow?, reasoningLevels? }], generate?(request, { signal }) }. One to eight of your own models, shown in the picker under your site's name beside the visitor's (SPEC 15.2). generate is required without a loop and must be absent with one.

threads: your own conversation store, as local functions { list, create, load, append, rename?, delete }. Declaring it means the extension keeps no history of its own: it asks you for the thread list, loads the one the visitor picks, and hands you the entries each finished turn produced. Consent says your site stores the conversation, and messages you supply reach the model labelled as untrusted. See SPEC 7.6.

onCardAction(event): a card's local action. Return a card to replace the one the action came from. The model is never involved.

reportProgress(text): one ephemeral line under that tool's step while it runs. At most 200 characters, 50 reports per invocation. Never model input, never stored.
widget: { autoShow, toolCallView: "compact" | "detailed", greeting (500), placeholder (80), suggestions (6 x 120), theme: { accent: "#rrggbb", mode }, controls (8) }. Controls are { id, label, type: toggle | select | button, default?, options?, model? }; values reach handlers as invocation.controls and fire onControlChange(id, value, values). Widget options never change permissions, the model, or the consent text.
onControlChange(id, value, values): local function, never crosses to the extension.

One registration per page. Registering again replaces the previous one and clears
the hosted chat history. Any change to the contract, including widget controls,
changes its fingerprint and the visitor is asked again before the next model call.

## Cards, progress, and threads in one paragraph each

A card is a small JSON tree (text, list, button, form) a tool returns beside its
text. The extension draws it in the transcript; the model sees only the text. A
button or form carries one action: { type: "message", text } sends that exact text
as a visible user turn, and { type: "local", name, payload } calls your
onCardAction and never becomes a model message. No HTML, Markdown, links, or
images; bounds are in SPEC 7.4.

Progress is invocation.reportProgress(text) inside a slow handler. It replaces one
line under that tool's step and is discarded with the turn.

Threads are yours when you declare manifest.threads. Without it the extension
keeps one document-memory conversation, as before, and the page never sees it.

## Without the extension

The same widget is published as arjunah-widget, mounted against your own backend
(a server, or a page function with backend: { fetch }). Your loop then owns
inference, tools, and threads, and there is no wallet: no consent, no
visitor-chosen model, and your backend sees everything typed. The one exception
is bridged mode (bridge: { arjunah: true }), where the widget relays your loop's
completions to the visitor's model through an ordinary level 1 or 2 session; see
mode 4 below. The package README and SPEC section 14 have the event stream and
routes.

```sh
npm install arjunah-widget
```

## The five modes

Who composes the conversation and who draws it decides the mode (SPEC 15).
The answering model is chosen per round: the visitor's, through the extension,
or one of your own. The extension never contacts your server in any of them.

### Mode 1: the extension composes and draws

The extension's own loop, your prompt and tools. Add your own models to offer
them beside the visitor's; a visitor with no AI configured starts on yours.

```js
await window.ai.arjunah.site.register({
  name: "Shop",
  systemPrompt: "Answer questions about the catalogue.",
  tools: [
    {
      name: "remove_item",
      description: "Remove an item from the cart",
      inputSchema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"], additionalProperties: false },
      requiresApproval: true, // the visitor approves each call first
      handler: ({ sku }) => cart.remove(sku),
    },
  ],
  models: {
    list: [{ id: "shop-small", displayName: "Shop assistant", contextWindow: 32000 }],
    // A section 5.3 request in, a section 5.3 result out. Call your own
    // server with the page's credentials, or run a model in the page.
    generate: (request, { signal }) =>
      fetch("/api/llm", { method: "POST", body: JSON.stringify(request), signal }).then((r) => r.json()),
  },
});
```

Your `generate` result is checked like a provider's: `message.content`, and
`message.toolCalls` of `{ id, name, arguments }` naming only tools the round
offered, else the round fails with PROVIDER_ERROR. Return `usage` if you want
the panel to show it; nothing you leave out is estimated. Rounds on your models
use no visitor credential and never reach the usage ledger.

### Mode 2: your server composes, the extension draws

Your backend runs the loop and speaks SPEC 14.3/14.4; the page forwards each
route with its own credentials. The extension renders the stream, runs your
page tools on `tool.client`, shows `input.client` and `approval.client`, and
answers `model.client` from the visitor's model, returning the conversation id
it created on `model-results`.

`approval.client` always works. `input.client` works only with `inputs: true`
in `loop`, because consent has to tell the visitor that your loop can ask for
values (masked ones included) inside the extension's panel; without it every
`input.client` is answered with a cancellation and no prompt appears. Each
prompt names your origin as the one asking, and a tool name containing the
extension's name is not shown. If you declare `tools`, consent also asks for
`tools.site`, and `tool.client` is refused until the visitor approves it.

```js
await window.ai.arjunah.site.register({
  name: "Trips",
  tools: [pageInfoTool], // what the loop may request with tool.client
  loop: {
    composer: "server",
    inputs: true, // the backend sends input.client for values the model must not see
    fetch: (path, init) => fetch(`/assistant/${path}`, { ...init, credentials: "same-origin" }),
  },
});
```

Consent asks for level 1 (or `level: 2`) and says, verbatim, that your server
writes the prompts and अर्जुनः cannot show them; the panel keeps a line naming
your server. Page context sharing is off. Declare `threads: true` to have the
panel use your thread routes; otherwise it names one thread per panel
conversation itself. With `models.list` (no `generate`) a visitor who picks one
of your models gets `bridge.model` with `kind: "site"` and no `model.client` is
answered for that turn: your server answers it.

### Mode 3: your page composes, the extension draws

The same manifest with `composer: "webapp"`, and `fetch` answering the routes in
page JavaScript: return a `Response` whose body is a `ReadableStream` of
section 14.3 events.

```js
loop: {
  composer: "webapp",
  async fetch(path, init) {
    if (path.endsWith("/turns")) return new Response(myLoop.turn(JSON.parse(init.body)), { headers: { "Content-Type": "text/event-stream" } });
    myLoop.answer(path, init.body ? JSON.parse(init.body) : null); // model-results, tool-results, approvals, ...
    return new Response(null, { status: 204 });
  },
},
```

### Mode 4: your server composes, your page draws

Mount the `arjunah-widget` package against your backend. With `bridge:
{ arjunah: true }` the widget holds a level 1 session and relays `model.client`
to the visitor's model; without it your backend answers with its own model. See
SPEC 14 and 14.7 and the package README. The widget declares the composer for
you (`"server"` behind `baseUrl`, `"webapp"` behind `fetch`). A page that
relays its server's prompts with its own UI says so when it enables access, and
consent then shows the server wording instead of the default page wording:

```js
const ai = await window.ai.arjunah.enable({ composer: "server" });
```

`composer` is `"webapp"` (the default) or `"server"`; it changes only what
consent says, and asking again with a different one prompts again.

### Mode 5: your page composes and draws

Call `enable()` and `models.generate` (or `models.stream`) from your own UI,
as in Flows above, or mount `arjunah-widget` with `backend: { fetch }` so its
renderer draws a loop your page runs, adding `bridge: { arjunah: true }` to
answer that loop with the visitor's model (the package README's "In-page
backend").

## models.generate request and result

Request: messages (roles system, user, assistant, tool; string content, or for
user messages 1 to 8 parts of { type: "text", text } or { type: "image",
mediaType: image/png | image/jpeg | image/webp | image/gif, data: base64 }),
model?, temperature? (0 to 2), maxTokens?, tools? (needs a model with
capabilities.tools), toolChoice? ("auto", "none", "required", or { name } naming
one of the request's tools; needs tools), reasoning? ({ effort } or the bare
effort string: none, low, medium, high, xhigh, max). The same request goes to
conversation.generate; see "Tool loops and reasoning continuity" below.

toolChoice reaches the API providers' own control (tool_choice, Anthropic's
tool_choice, Gemini's functionCallingConfig). Ollama and desktop subscription
agents have none, so they accept only "auto"; anything else is NOT_SUPPORTED
before the request is sent. Read models.list() kind to know which you have.

Bounds. Read them from the model entry instead of hard-coding them: every
models.list() entry carries limits, and generate refuses with INVALID_REQUEST,
before any provider is contacted, exactly past those numbers. The defaults
(SPEC 5.3 has the full table, with the fixed bounds too):

limits.messages: 400 messages per request.
limits.messageUnits: 180,000 UTF-16 code units of text per message, any role; a user message's text parts share it.
limits.tools: 128 tool definitions.
limits.toolDescriptionUnits: 2,000 UTF-16 code units per tool description.
limits.toolCallsPerMessage: 32 toolCalls on one assistant message.
limits.toolArgumentUnits: 65,536 UTF-16 code units of function.arguments per call.
limits.schemaBytes: 32,768 UTF-8 bytes per inputSchema; limits.schemaDepth: 16 levels below the root.
limits.requestBytes: 12,000,000 UTF-8 bytes for the whole serialized request.
limits.maxTokens: 32,768.
limits.timeoutMs: 180,000, how long the call may take.

UTF-16 code units are JavaScript string length. A model may report less: the
desktop companion's models report 300 messages, 64 tools, and 500-unit
descriptions. Staying within limits does not guarantee the prompt fits the
model's context window, which the extension does not estimate; the provider's
refusal comes back as CONTEXT_TOO_LONG, so shorten the conversation and retry.

Cancelling. Pass an AbortSignal as the second argument; aborting it rejects the
call with ABORTED at once and the extension cancels the provider request, or
stops the desktop agent, so the visitor stops paying for it:

```js
const controller = new AbortController();
stopButton.onclick = () => controller.abort();
try {
  const { message } = await ai.models.generate(
    { messages },
    { signal: controller.signal },
  );
} catch (error) {
  if (error.code === "ABORTED") return; // you asked for it
  throw error;
}
```

You can cancel only your own calls. Revocation, navigation, or the visitor
changing your site's model still end a call with PERMISSION_REQUIRED, and a call
that runs past 180 seconds with TIMEOUT.

Streaming. models.stream (and conversation.stream) takes the same request and
signal and answers the same round, with its text as it arrives. Draw the deltas
as provisional and replace them with the result, which comes last and is
exactly what generate would have resolved to. A round that ends in tool calls
has its calls only in the result, never in a delta. Errors reject the loop with
the same codes generate uses; breaking out of the loop cancels the round like
aborting the signal does, without an error:

```js
const controller = new AbortController();
stopButton.onclick = () => controller.abort();
let draft = "";
try {
  for await (const event of ai.models.stream(
    { messages },
    { signal: controller.signal },
  )) {
    if (event.type === "output.delta") show((draft += event.text));
    else if (event.type === "reasoning.delta") showThinking(event.text);
    else if (event.type === "stalled") showNote("The model is taking a while…");
    else if (event.type === "result") show(event.result.message.content);
  }
} catch (error) {
  if (error.code === "ABORTED") return; // you asked for it
  throw error;
}
```

Deltas arrive coalesced (at most every 250 ms, at most 4,000 characters each),
and one round never streams more than its result may hold: 120,000 characters of
answer and 12,000 of reasoning. stalled repeats every 20 seconds of silence and
is not an error. A model that does not stream yields only the result; a desktop
subscription agent streams what the companion reports of its answer and
reasoning.

temperature and maxTokens are dropped, with a warning in the page console, when
the user's chosen model is a desktop subscription agent: those CLIs expose no
sampling controls. The request still succeeds, so a site may always send them.

Result: { id, model, kind, local, builtinTools, message: { role, content,
toolCalls, attachments, reasoning }, finishReason, usage: { promptTokens,
completionTokens, totalTokens, cachedTokens, reasoningTokens }, contextWindow,
providerState }. kind, local, and builtinTools repeat the answering model's
models.list() entry. Zero counts mean the provider
did not report them; do not infer cost from them. providerState is "reused" when
the extension reattached state from an earlier round of this turn, else "none".

Allow up to 180 seconds per call. Subscription agents behind the desktop companion
start a process per turn.

## Tool loops and reasoning continuity

When your code (or your server, relaying through the page) runs the tool loop
itself, some providers need opaque state from the earlier rounds of the same
reply: Anthropic's signed thinking, Gemini 3's thought signatures (without them
Gemini refuses the next round), and OpenAI-style encrypted reasoning. You never
see it and never send it. The extension keeps it on the visitor's device and
puts it back for you, provided you do three things (SPEC 5.4):

1. Run each thread through a conversation: const conversation = await
   ai.conversations.create(), then conversation.generate(request) for every
   round. The extension mints the id for your origin; store conversation.id
   beside the thread and get the handle back later with
   ai.conversations.open(id). An id from another origin, or one you made up,
   is refused. Plain models.generate is a one-off completion: its document is
   its conversation, so two loops running through it in one page would undo
   each other's state.
2. Send each assistant message back with the toolCalls exactly as you received
   them: the same ids, in the same order, followed by one tool message per id.
   Only assistant messages after the last user message (the reply in progress)
   get state, and only while the same model and the same provider settings
   answer.
3. Call conversation.release() when the thread ends, and always when a reply
   is abandoned mid-tool-call. A round that answers without calling a tool ends
   the reply and drops its state for you.

```js
const conversation = await ai.conversations.create();
saveThread({ conversationId: conversation.id }); // your own store
const messages = [{ role: "user", content: question }];
for (;;) {
  const { message } = await conversation.generate({ messages, tools });
  messages.push({
    role: "assistant",
    content: message.content,
    toolCalls: message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    })),
  });
  if (!message.toolCalls.length) break;
  for (const call of message.toolCalls)
    messages.push({ role: "tool", toolCallId: call.id, content: await run(call) });
}
```

State lasts at most two days unused and is capped per site; losing it is never
an error, only a round without it, so do not depend on providerState being
"reused". An id whose state is gone still works. The visitor's consent dialog
says the state is kept.

On a desktop subscription agent a conversation also keeps the agent's own
session between turns, so each turn sends the agent only the messages it has
not seen. release() ends that session too (so does disable()); otherwise the
companion ends it after ten idle minutes. Plain models.generate keeps no agent
session between turns: each new turn starts a fresh agent run, and only a tool
round answered within two minutes resumes the run that asked for it.

## Errors

Rejections are Error instances with name "AIError" and a code: INVALID_REQUEST,
NOT_SUPPORTED, NOT_CONFIGURED, PERMISSION_REQUIRED, USER_DENIED, PROVIDER_ERROR,
TOOL_ERROR, TIMEOUT, INTERNAL_ERROR, ABORTED, CONTEXT_TOO_LONG, RATE_LIMITED,
MODEL_UNAVAILABLE, plus the SDK's NOT_INSTALLED. Treat any code you do not know as
INTERNAL_ERROR; the list may grow. Messages are safe to show; they never contain
provider error bodies or credentials.

ABORTED: your signal aborted the call.
CONTEXT_TOO_LONG: the provider said the request does not fit the model's context window.
RATE_LIMITED: the provider or the visitor's subscription is limiting requests; details.retryAfterMs says how long to wait when the provider said so.
MODEL_UNAVAILABLE: the model is gone, unknown to its provider, or cannot be loaded. Only the visitor can pick another.
NOT_SUPPORTED, among other things: the answering model is not one your require accepts, or its provider cannot honour your toolChoice. Fix the request, or ask the visitor to choose another model (openSettings() from a button).

error.details is always an object with requestId (quote it when reporting a
problem: the visitor's extension log has the same id) and retryable (true when
sending the same request again later may work: TIMEOUT, RATE_LIMITED, and
provider server errors). It may also name the refused field for
INVALID_REQUEST or the missing capabilities for PERMISSION_REQUIRED.

## Traps

The extension only injects into top-level http: and https: documents. A page opened
from file:// or inside a cross-origin iframe never sees window.ai.arjunah. Serve
your page over a local HTTP server while developing.

Grants are per exact origin. http://localhost:3000 and http://127.0.0.1:3000 are
different sites to the visitor and to the extension.

isEnabled() is false for a level 0 site even after the visitor approved the hosted
chat. It answers "can this page call the model itself", nothing else.

A session object survives disable(). Its methods then reject with
PERMISSION_REQUIRED. Drop the reference when you disable.

site.register() never grants anything and never prompts. Do not wait for consent
after it; the extension asks when the visitor first sends a message.

At level 1 the only accepted model values are "default" or none. Do not pass the id
you saw in models.list() back unless you are at level 2.

Tool handler exceptions, non-JSON results, and results over 64 KiB reach the model
as generic tool errors. Log locally if you need the detail.

The visitor can change your site's model, revoke you, or reset the chat at any
time from the extension. Treat every call as one that may fail with
PERMISSION_REQUIRED, and listen for arjunah:grantchange to learn about it
without waiting for a failure.

openSettings() works only while the page handles a click or key press. Calling
it on load, from a timer, or after an await that outlived the gesture rejects
with PERMISSION_REQUIRED.

## Verify locally

1. Install the extension (docs/INSTALL.md) and configure a provider in its settings.
2. Run npm run demo and open http://127.0.0.1:8090/paint/ for the level-0 Paint example, or /trip-planner/ for the original all-level example.
3. Load your own page over HTTP. In the console, await window.ai.arjunah.isEnabled() should resolve without throwing.
