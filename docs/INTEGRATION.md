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

## Install

```sh
npm install arjunah
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
site.register(manifest): level 0. Publishes the assistant contract; needs no grant; grants nothing.
chat.open() / chat.close() / chat.getControls() / chat.setControls(values): the extension-hosted chat.

Session, what enable() resolves to:

grant: the grant as it stood when enable() resolved (origin, level, capabilities, context, model, grantedAt).
permissions.query(): the origin's current grant or null.
models.list(): models this site may use. At level 1 exactly one, the model the visitor picked for this site.
models.generate(request): a completion. Needs level 1 or 2.
providers.list(): needs level 2.
context.get({ fields }): needs the context.read capability and the fields in the grant.

SDK helpers, all in the arjunah package: getArjunah(), isInstalled(),
waitForArjunah({ timeoutMs }), isEnabled(), enable(request), disable(),
registerSite(manifest), openChat(), isAIError(error), PROTOCOL_VERSION,
READY_EVENT. Each async helper waits for the API first and rejects with code
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
you; account identities, plans, and quotas are never included.

## Flows

Level 0, hosted assistant:

1. await registerSite({ name, systemPrompt, tools, widget }). Resolves { id, unregister() }.
2. Optionally await openChat(), or set widget.autoShow: true.
3. Tool handlers run in your page with your page's authority when the model calls them.

Level 1 or 2, your own model calls:

1. const ai = await enable() or enable({ level: "catalog" }).
2. const { message } = await ai.models.generate({ messages: [...] }).
3. await window.ai.arjunah.disable() when the visitor asks to disconnect.

Live examples: demo/index.html (trip planner: six site tools, widget controls, level
1 and 2 buttons) and tests/fixtures/site.html (minimal registrations used by the
browser tests). Copy their shapes rather than inventing new ones.

## Site manifest: fields and bounds

name: required, 1 to 80 characters.
description: up to 280 characters.
systemPrompt: up to 12,000 characters. Disclosed to the visitor verbatim at consent.
tools: up to 32 of { name, description, inputSchema, userInputs?, handler }. Names match ^[A-Za-z0-9_-]{1,64}$. inputSchema uses the JSON Schema subset in SPEC section 7.1 (object schemas with typed properties; keep them small and set additionalProperties false).
handler(args, invocation): sync or async. invocation is { id, name, controls, requestInput(id) }. Return JSON-serialisable data, at most 64 KiB serialised; anything else becomes a tool error the model sees.
userInputs: scalars the model must never supply (passphrase, one-time code, confirmation). Declared outside inputSchema, collected by the extension in its own labelled prompt, delivered only to your handler via await invocation.requestInput(id), never added to model messages or history. Your handler receives the value, so this protects against accidental model exposure, not against your own code. See SPEC 7.3.
mcpServers: up to 8 { id, name, url, headers? }. HTTPS only, loopback HTTP for development. The visitor approves the server, then its discovered tool metadata, before any model call.
widget: { autoShow, toolCallView: "compact" | "detailed", greeting (500), placeholder (80), suggestions (6 x 120), theme: { accent: "#rrggbb", mode }, controls (8) }. Controls are { id, label, type: toggle | select | button, default?, options?, model? }; values reach handlers as invocation.controls and fire onControlChange(id, value, values). Widget options never change permissions, the model, or the consent text.
onControlChange(id, value, values): local function, never crosses to the extension.

One registration per page. Registering again replaces the previous one and clears
the hosted chat history. Any change to the contract, including widget controls,
changes its fingerprint and the visitor is asked again before the next model call.

## models.generate request and result

Request: messages (1 to 100; roles system, user, assistant, tool; string content up
to 12,000 UTF-16 code units, or for user messages 1 to 8 parts of { type: "text",
text } or { type: "image", mediaType: image/png | image/jpeg | image/webp |
image/gif, data: base64 }), model?, temperature? (0 to 2), maxTokens? (1 to 32768),
tools? (up to 64, needs a model with capabilities.tools), reasoning? ({ effort } or
the bare effort string: none, low, medium, high, xhigh, max).

Result: { id, model, message: { role, content, toolCalls, attachments, reasoning },
finishReason, usage: { promptTokens, completionTokens, totalTokens, cachedTokens,
reasoningTokens }, contextWindow }. Zero counts mean the provider did not report
them; do not infer cost from them.

Allow up to 180 seconds per call. Subscription agents behind the desktop companion
start a process per turn.

## Errors

Rejections are Error instances with name "AIError" and a code: INVALID_REQUEST,
NOT_SUPPORTED, NOT_CONFIGURED, PERMISSION_REQUIRED, USER_DENIED, PROVIDER_ERROR,
TOOL_ERROR, TIMEOUT, INTERNAL_ERROR, plus the SDK's NOT_INSTALLED. Messages are
safe to show; they never contain provider error bodies or credentials.

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
PERMISSION_REQUIRED.

## Verify locally

1. Install the extension (docs/INSTALL.md) and configure a provider in its settings.
2. Run npm run demo in this repository and open http://127.0.0.1:8090/ to see every API path working, with an on-page event log.
3. Load your own page over HTTP. In the console, await window.ai.arjunah.isEnabled() should resolve without throwing.
