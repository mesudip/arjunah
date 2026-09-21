# अर्जुनः Protocol

Version: **1.0.0-alpha**

Status: **Implemented draft with a bounded schema subset, tiered site access, extension-collected tool inputs, transcript cards, tool progress, site-owned threads, declared remote tools, an optional desktop companion, and a standalone renderer with its own model picker and entity mentions**
License: MIT

The reference extension reports `version` `1.0.0` and implements everything here. One renderer serves both modes: sections 8.2 and 8.3 make the model and effort picker and the `@` entity mentions the renderer's own, as section 7.3's collected-input prompt already is, so a host supplies the data behind a control rather than building the control. The standalone renderer ships as the `arjunah-widget` package, built from the same renderer source the extension loads.

This document is normative. The words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be interpreted as requirements.

## 1. Purpose and actors

The protocol lets a website use AI selected and controlled by the user. It follows the wallet pattern: a page discovers `window.ai.arjunah`, describes what it wants, and the extension mediates access with an origin-bound grant. The website never receives provider credentials, and the user, not the site, decides which provider and model answer.

A site starts with the least access and asks for more. The protocol defines three **access levels**, detailed in section 4:

- **Level 0, `assistant`**: the site publishes an assistant contract (prompt, site tools, MCP servers, page context, widget options) and the extension hosts the chat, owns the model, and holds the credential. The site never calls a model itself and needs no grant to publish the contract; the user is asked when they first send a message.
- **Level 1, `completion`**: the site asks the extension for plain completions on the one model the user picked for it. This is what a bare `enable()` requests.
- **Level 2, `catalog`**: the site may also list the providers and models the user exposed to it and choose among them per request.

Actors are:

- **Page**: JavaScript executing for one web origin.
- **Browser extension**: the consent surface, policy store, model catalog, and model router. This document calls it _the extension_.
- **Provider**: any model backend the user configured, such as an API-compatible endpoint or a subscription agent exposed by the desktop companion. An extension can hold several providers at once; one model is the **global default**. The protocol does not require an OpenAI API, SDK, wire format, account, or hosted service.
- **Desktop companion**: an optional application on the user's computer that pairs with the extension, synchronizes extension configuration, and runs locally installed subscription agents (Claude Code, Codex, OpenCode) on the extension's behalf. See section 12.
- **Site tool**: a page-owned function callable by the extension during hosted chat.
- **MCP server**: a remote Streamable HTTP Model Context Protocol endpoint declared by the site and approved by the user. A site's own backend is an MCP server too; section 7.7 lets it declare its tools up front.
- **Renderer**: the chat user interface (transcript, activity feed, cards, composer, thread panel). The extension hosts it inside its closed shadow root in **wallet mode**. The same renderer runs without the extension in **standalone mode** (section 14), where a site backend takes the extension's place, and in **bridged mode** (section 14.7), where the backend runs the loop and the renderer, as page code, supplies the visitor's model to it. Section 15 lays out which renderer can pair with which loop.
- **Site backend**: in standalone and bridged mode, the server that owns the conversation, the tools, and the threads and streams renderer events to the page. It is the site's own trust domain; no wallet consent applies to what it does with the conversation. In bridged mode it does not hold a model credential: each completion is answered by the visitor's session on the page.

## 2. Security boundaries

1. Grants MUST be keyed by the exact serialized origin (`scheme://host[:port]`), never by registrable domain or URL path.
2. The extension MUST isolate consent controls, the hosted chat, and their contents from page CSS and JavaScript. The reference content-script implementation uses a closed Shadow DOM; the containing page can still obscure, reposition, or imitate its host. This in-page UI is not a browser-native security indicator.
3. Provider secrets, desktop pairing tokens, subscription credentials, and account identities (e-mail addresses, plan names, quotas) MUST NOT be placed in page-world objects, events, DOM attributes, error details, or API results. Account details are shown only in extension-owned UI.
4. Registering an assistant MUST NOT itself grant `models.generate`, `context.read`, or MCP network access.
5. Page context MUST be minimized to fields approved by the user and MUST be bounded before transmission.
6. A site tool MUST run in the page, with the page's authority. Its result is untrusted model input.
7. MCP endpoints MUST be disclosed before discovery. Discovered tool names, descriptions, and schemas MUST be available for inspection and approved before model generation or tool invocation. Site-provided MCP headers MUST reject `authorization`, `cookie`, `proxy-authorization`, `sec-*`, and `chrome-*` names.
8. Revocation MUST take effect before the next privileged operation, including later model/tool rounds in an active turn. Grant mutations MUST be serialized. Top-level navigation creates a new page session; stored grants remain origin-scoped. Outstanding hosted operations MUST be bound to the initiating document session and assistant registration, and cancelled on navigation, registration replacement, unregister, or reset. Already-started page tool side effects cannot be undone.
9. The extension MUST validate message shapes, lengths, capability names, schemas, URL schemes, image payloads, and response sizes at every trust boundary.
10. Only top-level `http:` and `https:` documents are in scope. Sandboxed/cross-origin frames and opaque origins are not supported.
11. A site sees only the model catalog the user exposed to it (section 4.1). Model identifiers, provider identifiers, display names, and capability flags are the only provider metadata a page can observe.
12. Extension-collected tool inputs (section 7.3) MUST be separately disclosed, bound to one active invocation, and omitted from the model-facing tool schema, model messages, and extension chat history. The site tool receives the value and remains a trust boundary: the extension cannot prevent page code from transmitting it or returning it in a tool result.
13. A transcript card (section 7.4) is site-authored UI inside the extension's UI. It MUST be bounded and validated at every trust boundary, MUST carry a text fallback that is the only thing the model receives, MUST NOT contain HTML, scripts, or navigable links, and its actions MUST NOT produce model messages the user cannot see or tool arguments the model did not author.
14. A site-owned transcript (section 7.6) is untrusted model input. The extension MUST disclose in consent that the site stores and supplies the conversation, MUST mark site-supplied history as untrusted in the provider request, MUST apply its own history budget after any site truncation, and MUST NOT let a supplied transcript widen the disclosed contract.
15. Tool progress (section 7.5) is presentation only. It MUST NOT enter model messages, chat history, or the site-owned transcript.

## 3. Discovery and versioning

The extension injects a non-writable `arjunah` object on the `window.ai` namespace at document start when possible. `window.ai` is a shared, extensible namespace: when it is absent the extension creates it as a plain non-writable object; when another actor already created it as an extensible object the extension reuses it, so several extensions can coexist under their own keys.

```webidl
partial interface Window {
  readonly attribute AINamespace ai;
}

interface AINamespace {
  readonly attribute Arjunah arjunah;
}

interface Arjunah {
  readonly attribute DOMString version; // "1.0.0"
  Promise<boolean> isEnabled();
  Promise<Session> enable(optional AccessRequest request = {});
  Promise<boolean> disable();
  readonly attribute AISite site; // publish the assistant contract (section 7)
  readonly attribute AIChat chat; // open and steer the extension-hosted chat (section 8)
}

interface Session {
  readonly attribute Grant grant; // the grant as it stood when enable() resolved
  readonly attribute AIPermissions permissions; // query() the current grant
  readonly attribute AIProviders providers; // list exposed providers (level 2)
  readonly attribute AIModels models; // list models and generate (level 1 and 2)
  readonly attribute AIContext context; // read approved page context
}
```

The root object follows the wallet pattern. Its two attributes, `site` and `chat`, are the level 0 surface: they let a page publish its assistant contract and open the extension-hosted chat, and they work without any grant because the extension, not the page, does the model work and asks the user itself. Everything the page would use to do its own model work lives on the **session** that `enable()` resolves to, and the session's methods succeed only for the capabilities the user granted (section 4); a page cannot reach `models`, `providers`, or `context` without first enabling access. `isEnabled()` reports whether the origin currently holds a grant at level 1 or 2, so a page can decide whether calling `enable()` will prompt. `disable()` removes the origin's whole grant.

Feature detection MUST use members, not version string comparison. Unknown input fields MUST be ignored unless explicitly forbidden. Unknown capability names and unknown access levels MUST be rejected.

If `window.ai.arjunah` already exists, or `window.ai` exists but is not an extensible object, the extension MUST NOT overwrite either. It SHOULD dispatch `arjunah:conflict` on `window`.

After successful installation of the object, the extension SHOULD dispatch `arjunah:ready` on `window`; its `detail` is `{ "version": "1.0.0" }`. Pages MUST still check `window.ai.arjunah` first so they work when injection precedes their event listener.

## 4. Access levels, capabilities, and consent

Like a wallet, a site starts with the least access and asks for more. The protocol defines three access levels. Each level is a named bundle of capabilities; capabilities remain the unit that grants store and that the extension enforces.

| Level | Name         | What the site gets                                                                                                                                                                                                     | Capabilities                                                      |
| ----- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 0     | `assistant`  | Default. The site publishes an assistant contract: prompt, site tools, MCP servers, page context, and widget options. The extension owns the chat, the model, and the credential. The site never calls a model itself. | `chat.hosted`, `tools.site`, `tools.mcp`, `context.read` (hosted) |
| 1     | `completion` | The site does its own work and asks the extension for plain completions. The **user** picks the model that answers this site; the site sees exactly that one model as its default and cannot choose another.           | `models.list`, `models.generate`                                  |
| 2     | `catalog`    | The site may list the providers and models the user exposed to it and choose among them per request, for example to offer its own model picker. Account identities and quotas are never included.                      | level 1 plus `models.catalog`                                     |

Defined capabilities:

| Capability        | Allows                                                                   |
| ----------------- | ------------------------------------------------------------------------ |
| `models.list`     | Read the model metadata exposed to this site                             |
| `models.generate` | Submit messages to the model selected for this site                      |
| `models.catalog`  | List exposed providers and select any exposed model in `models.generate` |
| `context.read`    | Read approved page context fields                                        |
| `chat.hosted`     | Use the extension's hosted chat with the site's contract                 |
| `tools.site`      | Allow hosted chat to invoke declared page tools                          |
| `tools.mcp`       | Allow hosted chat to connect to declared MCP servers                     |

`enable({ level?, capabilities?, context?, reason? })` MUST resolve to a session after approval and MUST reject with `AIError` code `USER_DENIED` on denial. A request with neither `level` nor `capabilities`, including `enable()` with no argument, MUST be treated as `{ level: "completion" }`: like a wallet connect, the default asks for level 1. Otherwise `level` (`"completion"` or `"catalog"`) or a non-empty unique `capabilities` array is used; `level` expands to the capabilities in the table and MAY be combined with `context.read`. Duplicate capabilities MUST be rejected. Repeated context fields are normalized to one occurrence. `context` is a subset of `title`, `url`, `selection`, and `text`; `text` requires `context.read`. Level 0 is never requested: the extension's hosted chat asks for its own capabilities when the user first sends a message (section 8).

The session's `grant` is metadata, not a bearer credential:

```json
{
  "origin": "https://example.test",
  "level": "completion",
  "capabilities": ["models.list", "models.generate"],
  "context": [],
  "model": "openai/gpt-5.6-sol",
  "grantedAt": "2026-01-01T00:00:00.000Z"
}
```

`level` is derived from the stored capabilities: `catalog` when `models.catalog` is present, `completion` when `models.generate` is present, otherwise `assistant`. `model` is the model the user selected for this site (section 4.1) or `null` when the site has no model access.

`session.permissions.query()` returns the current origin grant or `null`. `isEnabled()` on the root object resolves `true` when that grant is at level `completion` or `catalog`. `disable()` on the root object removes the complete grant for the current origin, including a hosted-chat grant, and resolves `true`. An extension MAY provide finer-grained revocation UI outside the page API.

Consent is additive: requesting already granted capabilities MUST NOT prompt again. Requesting any new capability MUST show both the new request and the resulting effective grant. When a request raises the site to level 1 or 2 the consent dialog MUST let the user choose the model for this site (defaulting to the global default) and, at level 2, which providers the site may see (defaulting to every available provider).

Capability grants do not silently authorize newly declared external resources. The extension MUST retain private approval metadata for hosted assistant contract fingerprints, MCP origins, and discovered tool-set fingerprints. The full system prompt, site tool definitions (including declared output kinds such as cards), declared remote tool definitions (section 7.7), widget controls, and whether the site stores the conversation (section 7.6) MUST be available for inspection in consent. A changed contract, previously undisclosed MCP origin, or changed remote tool metadata MUST trigger fresh consent before the next hosted model request. Both the consent layer and background execution layer MUST enforce these approvals. This metadata is extension-internal and MUST NOT be exposed by `session.permissions.query()`.

### 4.1 Per-site model settings

Every grant carries two user-owned settings that pages cannot change:

- **Site model** (`model`): the model that answers `models.generate` calls without an explicit `model`, and the hosted chat on this site. It defaults to the global default model. The user MAY change it in the consent dialog, the toolbar popup, or the hosted chat header. When the selected model becomes unavailable (key removed, agent signed out), the extension falls back to the global default and MUST say so in its UI.
- **Exposed providers** (`providers`): at level 2, the providers whose models `models.list()` and `providers.list()` return. `null` means every available provider. At level 1 the exposed set is exactly the site model.

Changing either setting cancels the site's in-flight hosted operations so a running turn cannot continue on a model the user just deselected.

## 5. Providers and models

### 5.1 Identifiers

Every model has an opaque identifier `<provider-id>/<model>`: `openai/gpt-5.6-sol`, `claude-code/sonnet`, `opencode/opencode/big-pickle`. Provider identifiers match `^[a-z][a-z0-9-]{0,63}$`; `openai` is the user's API key provider and desktop providers use the identifiers in section 12.2. Pages MUST treat both identifiers as opaque and MUST NOT parse plan or account information from them; there is none.

### 5.2 Listing

`providers.list()` requires `models.catalog` and returns the providers exposed to this site:

```json
[
  {
    "id": "claude-code",
    "name": "Claude Code",
    "vendor": "Anthropic",
    "kind": "subscription",
    "models": ["claude-code/default", "claude-code/sonnet"]
  }
]
```

`kind` is `api-key` or `subscription`. No account label, plan, quota, version, or path is included.

`models.list()` requires `models.list`. At level 1 it returns exactly one entry, the site model. At level 2 it returns every model of every exposed provider. Each entry is:

```json
{
  "id": "openai/gpt-5.6-sol",
  "provider": "openai",
  "displayName": "GPT-5.6 Sol",
  "default": true,
  "capabilities": { "tools": true, "vision": true, "reasoning": true },
  "contextWindow": 272000,
  "reasoningLevels": ["none", "low", "medium", "high"]
}
```

`default` marks the site model. `capabilities.tools` says the model accepts function tools; `capabilities.vision` says it accepts image content parts (section 5.3); `capabilities.reasoning` says the model can think before answering and accepts a reasoning effort. `contextWindow` is the model's context size in tokens when the provider publishes or reports it, otherwise `null`; extensions MUST NOT guess it. `reasoningLevels` lists the effort names the model accepts (a subset of `none`, `low`, `medium`, `high`, `xhigh`, `max`), empty when reasoning cannot be steered. Extensions MAY add further boolean capability flags; pages MUST ignore unknown ones.

### 5.3 Generation

`models.generate(request)` requires `models.generate`. Request fields:

- `messages` (required): 1–100 objects with role `system`, `user`, `assistant`, or `tool`. `content` is a string of at most 12,000 UTF-16 code units, or, for user messages, an array of 1–8 content parts. A text part is `{ "type": "text", "text": "…" }` with the same length bound. An image part is `{ "type": "image", "mediaType": "image/png" | "image/jpeg" | "image/webp" | "image/gif", "data": "<base64>" }` with at most 2,000,000 base64 characters; at most 4 image parts per message. Image parts require a model whose `capabilities.vision` is true; otherwise the extension rejects the request with `NOT_SUPPORTED` before contacting any provider. A mention part is `{ "type": "mention", "id": "machine:12", "label": "web-01" }`: something the user picked from the renderer's entity picker (section 8.3) rather than typed. `id` matches `^[A-Za-z0-9_.:-]{1,128}$` and `label` is limited to 80 Unicode code points; a message carries at most 16 mention parts and they do not count toward the eight text and image parts. Pages MUST NOT send mention parts to `models.generate` and implementations MUST reject them there with `INVALID_REQUEST`: they exist so a stored transcript (section 7.6) and a standalone turn (section 14) keep the identity the user chose beside the label they saw. An implementation that forwards a conversation containing mention parts to a provider MUST flatten each one to `@` followed by its `label` and MUST NOT send the `id`, unless it first resolves the id into text of its own. A page MAY supply `name`, `toolCallId`, and OpenAI-compatible `toolCalls`. Tool messages MUST include `toolCallId`; only assistant messages may carry `toolCalls`. Each call has a unique non-empty `id`, `type: "function"`, and `function: { name, arguments }`, with arguments encoded as a JSON string. There are at most 32 calls per message.
- `model` (optional): a model id exposed by `models.list`. Absent, or the literal string `"default"`, means the site model. At level 1 any other value MUST be rejected with `INVALID_REQUEST`; at level 2 the value MUST belong to the exposed catalog.
- `temperature` (optional): finite number from 0 through 2. Providers that expose no sampling control (the subscription agents of section 12) MUST drop it and warn in the page console rather than fail the request; a site cannot tell at level 1 which kind answers it.
- `maxTokens` (optional): integer from 1 through 32768. The same drop-and-warn rule applies.
- `tools` (optional): up to 64 function definitions using the schema subset in section 7.1. Tools require a model whose `capabilities.tools` is true.
- `reasoning` (optional): `{ "effort": "none" | "low" | "medium" | "high" | "xhigh" | "max" }` (or the bare string). The extension maps the effort to the provider's own control (OpenAI `reasoning_effort`, Codex `model_reasoning_effort`, Claude Code `--effort`, OpenCode `--variant`) and clamps to what the model supports; unknown values are rejected with `INVALID_REQUEST`. Absent means the provider's default.

The serialized provider request is limited to 12,000,000 UTF-8 bytes; the response is read incrementally with a 2,000,000-byte ceiling. Extension-generated context and tool messages use a separate 180,000-code-unit per-message budget and at most 256 messages so documented context/tool sizes remain usable. Hosted chat history uses the most recent 40 user/assistant messages, each bounded to 12,000 code units of text plus its image parts.

The extension MAY enforce stricter user policy. It returns:

```json
{
  "id": "response-id",
  "model": "openai/gpt-5.6-sol",
  "message": {
    "role": "assistant",
    "content": "...",
    "toolCalls": [],
    "attachments": [],
    "reasoning": null
  },
  "finishReason": "stop",
  "usage": {
    "promptTokens": 0,
    "completionTokens": 0,
    "totalTokens": 0,
    "cachedTokens": 0,
    "reasoningTokens": 0
  },
  "contextWindow": 272000
}
```

`usage.cachedTokens` counts prompt tokens the provider served from its prompt cache and `usage.reasoningTokens` the hidden thinking tokens, both `0` when the provider does not report them. `contextWindow` repeats the answering model's context size (or `null`) so a page can show how much of it the request used. `attachments` holds images the provider produced, each `{ "type": "image", "mediaType", "data" }` bounded like input images and limited to 4 per response; extensions MUST pass through only image types they validated. `reasoning` is an optional provider-supplied reasoning summary (string, at most 12,000 code units) or `null`; the extension MUST NOT synthesize it. Both fields are present with empty/null values when the provider returned none, so pages can rely on the shape.

The page API is non-streaming. Providers may stream internally, but the extension MUST return one bounded result. For extension-hosted chat, an implementation MAY render provider output incrementally inside its isolated UI. Those private deltas MUST NOT cross the page bridge, MUST be bounded by the same final-response limits, and MUST be discarded if the round ends in tool calls or the turn is cancelled. The final validated result remains authoritative. `models.generate` MAY take up to 180 seconds because desktop subscription agents start a local process per request; all other page requests time out after 30 seconds.

## 6. Page context

`context.get({ fields })` requires `context.read`; every requested field MUST also exist in the grant. It returns only requested fields. The extension limits `text` to 20,000 Unicode code units and `selection` to 4,000. Text extraction is a best-effort visible-text snapshot and MUST NOT include form control values, cookies, storage, network data, or extension UI.

Hosted chat has an explicit **Share page context** control. Enabling it triggers consent if necessary and sends `title`, `url`, `selection`, and bounded visible text with that chat turn. Disabling it sends no page snapshot.

## 7. Site assistant contracts

`site.register(manifest)` advertises a hosted experience and does not require a grant. It resolves to `{ id, unregister() }` in JavaScript; the function is local and is not serialized across the bridge.

Manifest fields:

- `name` (required, 1–80 characters)
- `description` (optional, up to 280 characters)
- `systemPrompt` (optional, up to 12,000 characters; disclosed during hosted-chat consent)
- `widget` (optional): see section 7.2.
- `tools` (optional): up to 32 `{ name, description, inputSchema, outputContent?, userInputs?, handler }` values. Names match `^[A-Za-z0-9_-]{1,64}$`; `handler(args, invocation)` is async or sync. `invocation` is `{ id, name, controls, requestInput(id), reportProgress(text) }` where `controls` is the current widget control state (section 7.2), `requestInput` follows section 7.3, and `reportProgress` follows section 7.5.
- `mcpServers` (optional): up to 8 descriptors `{ id, name, url, headers?, tools? }`. URL MUST be HTTPS, except loopback HTTP for development. URL credentials and fragments are forbidden. `tools` declares the server's tool definitions up front (section 7.7).
- `onControlChange(id, value, values)` (optional, local function): called when the user changes a widget control.
- `onCardAction(action)` (optional, local function): called when the user activates a `local` card action (section 7.4).
- `threads` (optional, local functions): the site stores conversations and supplies the thread list (section 7.6).
- `loop` (optional): a section 14 backend, or an in-page one, that runs the conversation while the extension hosts the panel and supplies the model (section 15.1). Exclusive with `systemPrompt`; `mcpServers` is ignored with it.

At most one active registration exists per page. A later successful registration replaces it and clears the prior hosted-chat history. The extension MUST fingerprint the validated contract, including widget controls; a new fingerprint requires redisclosure before use. The extension MAY show a launcher when a site registers; `autoShow` opens the chat panel but MUST NOT approve capabilities or send a model request.

Site tool invocations have a random id, tool name, parsed arguments, and abort-neutral metadata. Arguments MUST be JSON objects matching the declared schema; malformed JSON and schema failures MUST produce a tool error without calling the handler. When `outputContent` is absent, results MUST be JSON-serializable and their serialized UTF-8 representation is limited to 65,536 bytes (64 KiB). Exceptions and invalid/oversized results become safe tool error results; they do not expose extension internals. A result in flight after registration replacement or revocation MUST NOT be forwarded to the provider.

When `outputContent` is present, it is a unique subset of `"text" | "image" | "card"` and the handler result MUST be `{ "kind": "content", "content": [...] }`. Content contains 1–8 text/image/card parts, no more than four images, no more than one card, and every returned part type MUST be declared. Card parts follow section 7.4. Text uses the ordinary 12,000-character part limit. Images use the section 5.3 MIME, base64, and 2,000,000-character limits. Every result containing an image MUST also contain text so a non-vision model receives a useful fallback.

Output modes are part of the fingerprinted contract and consent disclosure. The broker appends the textual fallback as the ordinary matching `role: "tool"` message. Only when the selected model advertises `capabilities.vision`, and only after all matching tool results for that round, the broker appends user messages containing the returned images in the provider-neutral section 5.3 shape. This bridge is necessary because function outputs are textual while vision inputs are user-message image parts. Non-vision models receive only the text. Base64 data MUST NOT appear in consent activity cards, logs, errors, or progress events; those surfaces show bounded metadata such as `[image/webp, 84 KB]`. Page API, content bridge, and background broker each validate content results independently. A result in flight after registration replacement or revocation MUST NOT be forwarded to the provider.

### 7.1 Supported JSON Schema subset

Schemas are JSON objects, limited to 32,768 UTF-8 bytes and 16 nested schema levels. Tool input schemas describe objects. The supported assertion keywords are `type` (one of object, array, string, number, integer, boolean, null), `properties`, `required`, `additionalProperties` (boolean or schema), `items` (schema), `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `anyOf`, `oneOf`, and `allOf`. Combinator arrays contain 1–32 schemas. String length assertions count Unicode code points.

`title`, `description`, `default`, `examples`, `$schema`, and `$comment` are annotations; defaults are not inserted into arguments. All other schema keywords, including `$ref`, regex `pattern`, `format`, and type arrays, are explicitly unsupported and MUST be rejected with `INVALID_REQUEST` for site/page definitions (or a safe `TOOL_ERROR` for discovered MCP definitions). This extension does not claim full JSON Schema dialect support.

### 7.2 Widget options (client SDK surface)

The `widget` object lets a site shape the extension-hosted chat without ever touching the model request itself:

- `autoShow` (boolean): open the panel after registration.
- `toolCallView` (`"compact" | "detailed"`, default `"compact"`): initial presentation for tool activity. Compact shows a small tool name with an animated/check/error state marker inside the elapsed workflow; detailed opens a bordered card with the source, textual state, arguments, and results. Both modes MUST keep the same information user-expandable, and this option cannot hide a tool call from the user.
- `greeting` (≤ 500 characters): supporting copy in the empty conversation state, shown locally and never sent to the model.
- `placeholder` (≤ 80 characters): composer placeholder.
- `suggestions` (≤ 6 strings, ≤ 120 characters each): starter prompts shown while the history is empty; clicking one fills the composer.
- `theme` (optional): `{ accent?: "#rrggbb", mode?: "light" | "dark" | "auto" }`. Only the accent colour and colour scheme are site-controllable; layout, typography, and the consent dialog are extension-owned.
- `controls` (≤ 8 items): user-facing options rendered in the widget's **Options** drawer, similar to the toggles in embeddable chat kits. Each control is `{ id, label, type, description?, default?, options?, model? }`:
  - `id` matches `^[a-z][a-z0-9_-]{0,31}$` and is unique;
  - `label` ≤ 40 characters, `description` ≤ 120 characters;
  - `type` is `toggle` (boolean), `select` (one of ≤ 8 `{ value ≤ 40, label ≤ 40 }` options), or `button` (momentary; fires `onControlChange` with `value: true` and has no persistent state);
  - `default` matches the type;
  - `model` (boolean, default `true`) says whether the current value is disclosed to the model.

Control state lives in the extension for the page session. It is passed to tool handlers as `invocation.controls`, delivered to the page through `onControlChange`, and readable/settable by the page through `chat.getControls()` / `chat.setControls(values)` (page-set values are validated against the declared controls). Controls whose `model` flag is true are appended to the extension's conversation as one system line, `Widget options set by the user (untrusted): {…}`, after the disclosed site prompt. Widget options MUST NOT grant capabilities, change the model, or alter the consent text.

### 7.3 Extension-collected tool inputs

A site tool may need a value that the model should neither invent nor see: for example a passphrase, one-time code, exact confirmation, or user-selected scalar. The optional `userInputs` array declares up to eight such values. Each item is:

```json
{
  "id": "passphrase",
  "label": "Server passphrase",
  "description": "Used only for this connection attempt.",
  "schema": { "type": "string", "minLength": 1, "maxLength": 200 },
  "secret": true
}
```

- `id` MUST match `^[a-z][a-z0-9_-]{0,31}$`, be unique within the tool, and MUST NOT also be a property of `inputSchema`. This separation prevents the model from supplying or overriding the value.
- `label` is required and limited to 80 characters; `description` is optional and limited to 280 characters.
- `schema` MUST declare exactly one scalar type: `string`, `number`, `integer`, or `boolean`. Only `type`, `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `title`, `description`, and `$comment` are accepted. Assertions and `enum`/`const` values MUST match the declared type, bounds MUST be internally consistent, and string inputs are limited to 4,096 Unicode code points.
- `secret: true` is permitted only for strings without `enum` or `const`. It requests a masked, non-autofill control; it does not make an untrusted page a safe recipient.
- A tool declaring `userInputs` MUST set `inputSchema.additionalProperties` to `false` so the model-facing and extension-collected parameter sets are closed and unambiguous.

`userInputs` is part of the fingerprinted contract and MUST be shown in consent, including whether each control is masked. It MUST NOT be included in the function schema sent to a provider. During the corresponding active handler, `await invocation.requestInput(id)` asks the extension to render an origin- and tool-labelled prompt. The extension MUST verify that the id was declared for that tool, validate the submitted value against its scalar schema, and resolve the promise with the value. The reference extension permits at most four requests per invocation and gives each prompt at most 120 seconds.

The value is bound to that invocation, returned only to its page handler, kept only in memory, and MUST NOT be automatically merged into `args`, persisted, placed in model messages, or added to chat history. Cancellation, timeout, navigation, revocation, registration replacement, unregister, or chat reset MUST reject the pending request. Values MUST NOT be reused for another invocation without prompting again.

The prompt itself is the renderer's (section 8.1), so it looks and validates the same in both modes. In standalone mode (section 14) the declaration and the prompt are unchanged and the wallet steps fall away: there is no consent dialog and no contract fingerprint, the origin shown is the page's own, and the recipient is the site's own handler. What remains is the separation that gives the mechanism its value, because the field is absent from the model-facing schema, bound to one invocation, and never written to the transcript the backend stores.

This mechanism transports data; it does not add authority. It cannot grant a browser permission, widen an origin grant, or substitute for a platform-required user gesture. The page handler receives the value and can misuse it. The extension UI MUST say which origin and tool will receive it and MUST NOT promise that the site itself cannot transmit it. A conforming site SHOULD use the value only for the exact disclosed operation and MUST NOT include a secret value in its tool result, because tool results are model input.

Example:

```js
tools: [
  {
    name: "connect",
    inputSchema: {
      type: "object",
      properties: { host: { type: "string" } },
      required: ["host"],
      additionalProperties: false,
    },
    userInputs: [
      {
        id: "passphrase",
        label: "Passphrase",
        schema: { type: "string", minLength: 1 },
        secret: true,
      },
    ],
    async handler(args, invocation) {
      const passphrase = await invocation.requestInput("passphrase");
      return connectToExactHost(args.host, passphrase);
    },
  },
];
```

### 7.4 Transcript cards

A tool that declares `"card"` in `outputContent` may return one card part, `{ "type": "card", "card": <CardNode> }`, alongside its mandatory text part. The renderer shows the card inside the conversation under that tool's activity entry; the model receives only the text parts. The word _card_ is used deliberately: `widget` in this document means the panel options of section 7.2.

A card is a JSON tree whose root has `type: "card"`:

- `{ "type": "card", "id"?, "title"?, "children": [...] }`: the root, and the only node that may contain other containers.
- `{ "type": "text", "text", "style"?: "body" | "muted" | "heading" }`.
- `{ "type": "list", "items": [{ "title", "description"?, "action"? }] }`: at most 50 items.
- `{ "type": "button", "label", "action", "style"?: "primary" | "secondary" | "danger" }`.
- `{ "type": "form", "id", "submitLabel"?, "action", "fields": [...] }` where each field is `{ "type": "input" | "select" | "checkbox", "id", "label", "placeholder"?, "required"?, "options"?, "default"? }`. `options` is required for `select` and holds at most 20 `{ value, label? }` entries; field ids follow the control id syntax of section 7.2 and are unique within the form.

Bounds, enforced by the page API, the content bridge, the background broker, and the renderer independently: at most 200 nodes, nesting depth 6, text of 2,000 Unicode code points per node, labels and titles of 80, at most 16 buttons and 16 form fields per card, and the whole card part within the 64 KiB tool-result limit. Images, links, raw HTML, Markdown, styles, and unknown node types MUST be rejected. Card ids follow the control id syntax and are unique within a turn.

An action is one of:

- `{ "type": "message", "text" }` (≤ 2,000 code points): activating it submits `text` as a new user turn. The renderer MUST show the exact text as the user's own bubble before sending it, so the model never receives an action the user did not see. A form with a `message` action appends one line per field, `label: value`, to the bubble. The turn runs under the ordinary hosted-chat consent and MUST NOT bypass a pending consent.
- `{ "type": "local", "name", "payload"? }` (name ≤ 64 characters, payload a JSON value ≤ 4,096 UTF-8 bytes): activating it calls the manifest's `onCardAction({ cardId, name, payload, values })` in wallet mode, or posts it to the site backend in standalone mode (section 14.4). `values` holds validated form field values when the action came from a form. A `local` action never produces a model message. The callback MAY return a replacement `CardNode`, which the renderer validates and swaps in place; anything else leaves the card unchanged.

`outputContent` including `"card"` is part of the fingerprinted contract and consent MUST say that the assistant can show interactive site-authored cards. Cards remain active for the lifetime of the registration; registration replacement clears them with the rest of the conversation. Both `toolCallView` modes render cards inline and keep the underlying arguments and text result user-expandable, so a card can never hide a tool call. A card is part of the activity entry of its turn in the transcript (section 7.6), so a stored conversation replays it.

### 7.5 Tool progress

A site tool handler may call `invocation.reportProgress(text)` while it runs. The extension renders the text as an ephemeral line under that tool's activity step, replacing the previous line. Each report is limited to 200 code points and each invocation to 50 reports; further reports and reports after the handler settles are dropped silently. Progress never enters model messages, chat history, or a stored transcript, and is discarded with the turn on cancellation. In standalone mode the site backend emits the same information as `progress` events (section 14.3). Desktop-agent activity (section 12.3.1) already reaches the same feed.

### 7.6 Site-owned threads

By default the extension keeps one document-memory conversation per hosted chat (section 8, section 11). A site that wants persistent, cross-device, or multi-thread conversations supplies them itself through the manifest's `threads` object of local functions:

```ts
threads: {
  list(): Promise<ThreadSummary[]>;              // ≤ 100 entries
  create(): Promise<ThreadSummary>;
  load(id): Promise<TranscriptEntry[]>;          // ≤ 200 entries
  append(id, entries: TranscriptEntry[]): Promise<void>;
  rename?(id, title): Promise<void>;
  delete(id): Promise<void>;
}
```

A `ThreadSummary` is `{ id, title, updatedAt }` with `id` matching `^[A-Za-z0-9_-]{1,100}$`, `title` ≤ 120 code points, and `updatedAt` an ISO-8601 string. A `TranscriptEntry` is one of:

- `{ "type": "message", "id", "role": "user" | "assistant", "content", "reasoning"?, "createdAt" }` where `content` follows the section 5.3 message content rules and `reasoning` is bounded like a section 5.3 reasoning summary;
- `{ "type": "activity", "id", "turnId", "steps": [...] }` where each step is `{ "id", "name", "source": "site" | "mcp" | "backend" | "agent", "status": "ok" | "error", "arguments"?, "result"?, "card"? }`, with `arguments` and `result` textual previews of at most 2,000 code points and `card` a section 7.4 card.

Entry ids follow the thread id syntax and are unique within a thread. Each call times out after 30 seconds; a rejected or invalid result shows an error in the thread panel and MUST NOT reach the model. The renderer drives the callbacks: it lists threads in a panel, loads one when the user selects it, creates one for a fresh conversation, and after each completed turn calls `append` with the user message, the activity entry, and the assistant message it produced. The extension MUST NOT pass page context, extension-collected inputs, progress lines, usage, or provider identity to `append`.

Site-supplied entries are untrusted model input. When building the provider conversation the extension uses message entries only, applies the section 5.3 history budget after any truncation the site performed, and precedes entries loaded from the site (as opposed to produced in this document session) with one system line stating that the prior conversation was supplied by the site and is untrusted. The renderer marks loaded entries visibly. A supplied transcript cannot widen the contract: the system prompt, tools, and card declarations that apply are the fingerprinted ones the user approved.

Declaring `threads` is part of the fingerprinted contract, and consent MUST state that the site stores the conversation and can supply earlier messages. Thread contents are never exposed through `session.permissions.query()` or any page API other than the site's own callbacks. For desktop providers the extension keeps one companion thread (section 12.3.1) per site thread, keyed by an extension-minted conversation id rather than the site's id, and releases it when the user deletes or leaves the thread. When `threads` is absent, nothing changes: history is document memory and the page never receives it.

### 7.7 Declared remote tools

An `mcpServers` entry MAY carry `tools`: 1–64 definitions `{ name, description?, inputSchema }` following section 7.1. When present, the extension MUST NOT call `tools/list` for that server and MUST use the declared definitions as the server's tool set. The declarations are part of the fingerprinted contract, so they receive the single-stage consent of site tools instead of the two-stage discovery consent of section 8; a change to any declaration requires fresh consent. The extension still calls `tools/call` over the transport of section 8 and validates results identically. The request's `params._meta` carries `{ "arjunah": { "conversationId" } }`, the extension-minted conversation id, so a site backend can correlate calls without any page involvement. A server that answers `tools/call` for an undeclared name, or whose declared schema the extension rejects, produces a safe `TOOL_ERROR`.

This is how a site runs tools on its own backend in wallet mode: the backend holds its secrets, the page holds only a short-lived token in `headers`, and the model never sees either. Because `headers` are set by page JavaScript they are never secret from the page. The same handler definitions serve the standalone turn endpoint of section 14, so a site writes each tool once.

## 8. Hosted chat and tools

`chat.open()` asks the extension to show the hosted chat and resolves after the request is accepted; `chat.close()` hides it. The extension toolbar popup also opens it for the active tab. The first submitted message requests the effective hosted capabilities:

- always `chat.hosted` (the extension generates on the site's behalf; the page itself receives no `models.generate`);
- `context.read` when sharing page context;
- `tools.site` when site tools exist;
- `tools.mcp` when MCP servers exist, including servers with declared tools (section 7.7).

The consent text additionally states, when the contract declares them, that the assistant can show site-authored cards (section 7.4) and that the site stores the conversation (section 7.6).

When the extension runs the loop, it constructs the provider conversation as: extension safety instruction, disclosed site `systemPrompt`, widget option state (section 7.2), optional page context, then chat history. With a manifest `loop` (section 15.1) the external loop composes the conversation and the extension answers its completions as a level 1 or 2 provider; the rest of this section then applies to the panel and not to authorship. Site instructions, widget labels, and page text are untrusted with respect to provider credentials and extension policy.

The hosted chat runs on the site model (section 4.1). It MUST show the current provider and model and MUST let the user switch to any model of any available provider; the picker is the renderer's, in the composer, and the extension supplies the catalog and applies the switch to the site model (section 8.2). When the model advertises `reasoningLevels`, the composer MUST offer a thinking-effort picker whose value is sent as the turn's `reasoning`; the footer MUST show the context window in use as a meter of the final upstream model request's input tokens against `contextWindow`, plus that request's cached portion and the turn's thinking token count when reported. It MUST NOT use aggregate turn or session prompt usage as the live context value: an agent may make many model requests while one visible turn runs tools.

Each open hosted chat is one **conversation** with a random id that changes on reset, registration replacement, navigation, and, with site-owned threads, thread switch. The extension passes the id to desktop providers as the thread id (section 12.3) so an agent can keep one session per browser tab instead of replaying the transcript, and MUST release the thread when the conversation ends. The panel MUST be resizable and movable by its header, MUST show live activity (contacting the model, each tool call with its arguments and result, elapsed time), and MUST preserve user-expandable arguments and results even when the site selects the compact tool presentation. It SHOULD render normalized answer and reasoning deltas as they arrive, MUST render provider reasoning summaries and image attachments when present, MUST let the user attach images when the site model advertises `vision`, MUST show the tokens the last turn used and the session total, the hosted history budget in use, and the provider's quota status when known (section 11.1). A provider that cannot emit deltas still participates and renders its final answer normally. All of this is extension-owned UI in the closed shadow root; the page cannot read it.

### 8.1 Renderer requirements

The renderer is the same code in wallet and standalone mode (section 14) and MUST behave identically for everything it owns: transcript and activity rendering, cards, progress lines, the thread panel, the composer, and attachments. Cards render inline under their tool step in both `toolCallView` modes. Progress lines are ephemeral and never persisted. The thread panel appears only when threads exist (site-owned in wallet mode, backend-owned in standalone mode); its actions are select, new, rename when supported, and delete. Switching threads MUST NOT cancel a running turn: the turn completes in the thread that submitted it, and the panel shows that thread as busy. Deleting a thread cancels its turn. The renderer also owns three surfaces that both modes need and neither should re-implement: the model and thinking-effort picker (section 8.2), the entity picker that produces mention parts (section 8.3), and the prompt that collects a declared tool input (section 7.3). In each case the renderer owns the control and the host owns the data behind it, so a host supplies a catalog, an entity source or a tool declaration and never markup. Wallet-only chrome (consent, context sharing, usage and quota, launcher) belongs to the extension shell around the renderer and is absent in standalone mode.

The extension popup MUST NOT host a chat of its own. When the active page has registered an assistant, the popup opens that assistant on the page (or offers to hide it); otherwise it states that the page does not implement the protocol. All user-visible chat therefore happens inside the page the user is looking at, under that origin's grant, with the page's disclosed contract.

For tool-capable responses, the extension MAY execute up to 100 sequential tool rounds per user turn. It MUST invoke only names declared in the active contract or discovered from an approved MCP server. Names normally use `site__name` and `mcp_<server-id>__name`. Names that exceed 64 characters, contain provider-incompatible characters, or collide MUST receive deterministic collision-resistant aliases, with an exact reverse route to the original tool. The aggregate site-plus-MCP tool limit is 64; exceeding it MUST fail before a model request rather than silently dropping tools. Tool outputs are appended using the provider's tool message format. The final user-visible answer MUST be rendered as text, not HTML.

MCP transport is JSON-RPC 2.0 over Streamable HTTP, negotiating version `2025-03-26`. The extension performs `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`. It accepts JSON or `text/event-stream` responses, parses complete multi-line SSE events incrementally, validates response IDs, and honors `Mcp-Session-Id`. Response bodies are limited to 1,000,000 UTF-8 bytes while reading. On a session-bearing 404 the client reinitializes and retries once. Tool pagination is bounded to 64 tools per server and 16 continuation cursors; descriptions are limited to 500 characters. Sessions are scoped to the page session and endpoint/headers. Redirects are rejected and ambient cookies are omitted for provider and MCP requests. OAuth flows, acting on server-sent requests/notifications, resources, prompts, sampling, and stdio transport are outside this version. Unrelated stream messages are ignored while locating the matching response.

For remote tools without declared definitions (section 7.7), consent has two stages: approve the contract and endpoints for discovery, then inspect and approve the discovered tool metadata. The extension stores a short-lived, single-use preparation token bound to the page session, registration, and discovered routes. Completion MUST execute that prepared tool set and MUST NOT substitute newly discovered definitions. Subsequent turns rediscover metadata and request approval if its fingerprint changed. Preparation expires after five minutes or on cancellation/background restart; the user can start a new turn to prepare again.

### 8.2 Model and effort picker

The picker is the renderer's; the catalog behind it is the host's. The host supplies section 5.2 model entries and the current selection, and the renderer groups them by provider, labels each with `displayName` and, when known, a compact `contextWindow`, and marks the selected one. When the selected model lists `reasoningLevels` the renderer shows a thinking-effort control offering those levels plus the provider default, and sends the chosen level as the turn's `reasoning`; otherwise the control is hidden and no effort is sent. An empty catalog hides both controls rather than showing an empty menu.

Choosing a model reports the choice to the host, which decides whether it holds: only the host knows whether the switch was permitted. The renderer applies the new selection when the host accepts it and restores the previous one when the host rejects or fails it, so a refused switch never leaves the composer claiming a model that is not answering. In wallet mode the host is the extension, the catalog is the exposed provider and model list of sections 4.1 and 5.2, and the switch updates the site model; a site cannot supply or filter that catalog, because widget options MUST NOT change the model (section 7.2). In standalone mode the site supplies the catalog directly (section 14.1), because the site already owns inference. In bridged mode (section 14.7) the renderer fills it from the visitor's session: one model at level 1, the exposed catalog at level 2, and a site-supplied `widget.models` is ignored, because the site does not own the model there either.

### 8.3 Entity mentions

A host MAY give the renderer an entity source, and the composer then offers mentions. Typing `@` at the start of the message or after whitespace opens a picker; the characters typed after it are the query. The renderer asks the host for matches, lists them grouped by their optional `group`, and inserts the chosen one as a chip: one atomic, non-editable token in the composer that a single backspace removes whole.

An entity is `{ id, title, group?, description? }`. `id` follows the mention id syntax of section 5.3, `title` is limited to 80 Unicode code points, `group` to 40, and `description` to 120. A query is limited to 64 code points, a search to 20 results, and a message to 16 chips. Entities are untrusted host-supplied data: the renderer renders them as text, never as markup, and shows no images or icons. A search that rejects or times out shows no matches rather than an error in the transcript, and the renderer sends no query while the composer is disabled.

On submit each chip becomes a mention part (section 5.3) in its position among the text, so the host receives both the identity the user picked and the text around it. A chip in the transcript is activatable exactly when the host offers somewhere to send the click, and activating it reports the mention's `id` and label; the renderer itself does nothing with it, and chips in the composer stay inert so editing around them is predictable. Because clickability follows the host rather than the entity, a chip replayed from a stored thread behaves like one just inserted. The model never receives an `id`; section 5.3 flattening decides what it sees.

## 9. Errors

Rejected promises use an `Error` whose `name` is `AIError` and whose `code` is one of:

- `INVALID_REQUEST`
- `NOT_SUPPORTED`
- `NOT_CONFIGURED`
- `PERMISSION_REQUIRED`
- `USER_DENIED`
- `PROVIDER_ERROR`
- `TOOL_ERROR`
- `TIMEOUT`
- `INTERNAL_ERROR`

Messages MUST be safe to expose to the page. Provider response bodies, API keys, extension URLs, account identities, and stack traces MUST NOT be included. An optional JSON-safe `details` value MAY identify invalid fields.

## 10. Bridge protocol

The reference implementation uses `window.postMessage` because extension content scripts live in an isolated world. Messages use a fixed channel, direction, page-session nonce, request id, method, and JSON-safe params. The content script MUST accept messages only from the same `window`, exact expected direction/channel, and current random nonce. The background MUST derive the origin and tab id from `chrome.runtime.MessageSender`, never from page-supplied claims.

Requests time out after 30 seconds, except `models.generate`, which times out after 180 seconds. Site tool invocations and extension-collected input prompts time out after 120 seconds. Navigation destroys pending requests. The bridge is transport, not authority: every privileged background method independently checks the stored origin grant.

Hosted-chat progress (model start/end, tool start/end, usage, bounded `output.delta`, reasoning delta, `progress`, `card`, and `card.update` events, the same vocabulary as section 14.3) travels from the background to the content script over the extension's own messaging and never through the page bridge. Page-originated `reportProgress` calls and `threads` callback results cross the page bridge as bounded, invocation- or request-bound messages that the content script validates before use; `threads` callbacks are invoked through the bridge like tool handlers and time out after 30 seconds. Provider-specific streams are normalized before this hop; the content script does not parse provider wire formats.

## 11. Data retention and user controls

The reference extension stores provider configuration, the global default model, grants with their per-site settings, and a local usage ledger in `chrome.storage.local`. Chat history, assistant registrations, and widget control state are document-memory only. With site-owned threads (section 7.6) the site stores the conversation and the extension keeps only the loaded thread in document memory; the extension never persists thread contents itself. New documents and tab close discard them; explicit panel reset clears history and cancels outstanding work while retaining the registration. On back/forward-cache restoration a browser may restore that document UI, but all outstanding operations from before pagehide are cancelled. After an extension reload, existing pages should be reloaded to reconnect the content script. It does not add analytics or remote telemetry. Provider and MCP endpoints necessarily receive approved request data under their own policies.

### 11.1 Usage ledger and quota disclosure

The extension keeps a local, per-provider ledger of requests and reported prompt/completion tokens for the current day and in total. The ledger never leaves the browser and is never shown to pages. Providers MAY report a quota `{ used, limit, unit, resetsAt?, label?, windows? }` where `windows` lists every rolling allowance the account has (`{ id, kind: "session" | "weekly" | "monthly" | "other", label, usedPercent, resetsAt? }`) and the top-level fields summarise the session window; when they do the extension shows it next to the provider, and when they do not the extension MUST say the provider does not report quota rather than estimate one. The reference companion reads these from the agents' own control interfaces (Claude Code's stream-json `get_usage` control request, Codex's app-server `account/rateLimits/read`) without spending model tokens.

### 11.2 Options and popup

The options UI MUST let the user independently configure/test/clear each supported API-key provider (currently OpenAI and OpenCode Zen), remove only the selected provider's saved key, choose the global default model among all available providers, pair or unpair the desktop companion, and revoke individual or all site grants. Saved key reuse MUST be bound to the provider origin in both Save and Test; a different origin receives no retained key unless the user explicitly enters it. Provider changes cancel active page-origin operations. Provider configuration returned to settings includes only key-presence metadata, not the saved key.

The toolbar popup is the wallet view. It MUST show:

- every provider with its availability, account label, plan (when the provider reports it), local usage from the ledger, quota status per section 11.1, and model count; and a selector for the global default model;
- for the current site, when it registered an assistant or holds a grant: the assistant name, the access level, the site model with a selector, at level 2 the exposed providers with toggles, the granted context fields, an open/hide control for the hosted chat, and a revoke control;
- otherwise, that the page does not implement the protocol (or cannot, for browser-internal pages).

Popup, options, consent, and widget MUST use one visual system: a single primary action per view, secondary and ghost actions for everything else, and a danger style for revocation and key removal.

## 12. Desktop companion and subscription providers

The desktop companion is optional. An extension without it is conforming. When present, it lets the user select a provider that runs on their computer with an existing subscription sign-in instead of an API key, so websites use, for example, the user's Claude, ChatGPT/Codex, or OpenCode account without any site- or browser-held credential.

### 12.1 Actors and trust

- The companion is a local process the user starts. It listens only on the loopback interface (`127.0.0.1`, default port 48123) and serves a local dashboard, a JSON API, and per-session MCP endpoints.
- Browsers are **paired** explicitly. The companion shows a six-digit pairing code; the user enters it in the extension's options page. The companion answers with a random bearer token (at least 256 bits) that the extension stores in extension storage next to the provider key. The companion MUST store only a hash of the token. Either side can revoke a pairing.
- Pairing codes MUST expire within ten minutes and MUST rotate after each successful pairing and after at most five failed attempts. Attempts MUST be rate limited.
- The companion MUST reject requests whose `Host` is not a loopback host and requests whose `Origin` header is present and is neither its own dashboard origin nor a browser-extension origin (`chrome-extension:`, `moz-extension:`, `safari-web-extension:`). Every API and MCP endpoint other than status and pairing MUST require a valid pairing token or session token.
- The local dashboard is trusted like any other process of the same operating-system user. It MUST mask synchronized secrets and MUST NOT be reachable from web origins.

### 12.2 Provider discovery

`GET /api/providers` returns the subscription agents detected on the computer. Each entry has `id`, `name`, `vendor`, `installed`, `available`, `account` (non-secret label such as a sign-in method), `connection` (`{ account, method, plan, source }`), `reason` when unavailable, an optional `notice`, structured `guidance`, `supportsTools`, `supportsVision` (default false), `supportsReasoning`, `supportsThreads`, `sandboxed`, an optional `quota` per section 11.1, `models`, and `defaultModel`. Each model MAY carry `contextWindow`, `reasoningLevels`, `defaultReasoning`, and per-model `capabilities` that override the provider flags; the reference companion reads them from the Codex model catalog, from `opencode models --verbose`, and, for Claude Code, from the window and rate limit each run reports. A successful `POST /api/generate` MAY additionally return private extension fields `contextTokens` and `contextCachedTokens`: exact input and cache-read tokens from the final upstream model request, or `null` when the agent does not report them. These are distinct from `usage`, which totals every upstream request in the agent run, and they do not cross the page API. The reference companion detects:

- **Claude Code** (`claude-code`): the `claude` CLI, available when `claude auth status` reports a sign-in. Accepts images.
- **Codex** (`codex`): the `codex` CLI, available when `codex login status` reports a sign-in. Accepts images for the catalog models whose input modalities include one. Codex keeps a read-only shell sandbox that this companion cannot disable, so it is disabled until the user enables it on the dashboard; the extension shows the reason.
- **OpenCode** (`opencode`): the `opencode` CLI, available when it lists at least one model. `opencode run` has no image input, so every OpenCode model reports `vision: false` even where the upstream model would accept one.

The extension MUST show detected providers in its options UI and popup with their availability and account label, MUST let the user choose the global default model and per-site models among them, and MUST disclose the model that will answer in consent dialogs (`Requests are sent to: …`). A provider that is not available MUST NOT be selectable.

### 12.3 Generation bridge

`POST /api/generate` accepts `{ providerId, model, messages, tools? }` using the same validated message and tool shapes as section 5 (wire fields `tool_calls` and `tool_call_id`) and returns the section 5 result shape with `finishReason` `stop` or `tool_calls`. Subscription-agent CLIs expose no sampling controls, so a section 5 `temperature` or `maxTokens` is dropped rather than sent; the extension MUST warn in the page console when it drops one, and MUST NOT fail the request. Companion errors use the section 9 codes.

**Images.** A CLI agent takes one prompt, so `content` on this route is always a string: the extension flattens section 5.3 content parts and writes `[image]` where each picture sat. A user message MAY additionally carry `images`, an array of at most four `{ mediaType, data }` objects using the section 5.3 media types and base64 bound. The extension MUST send `images` only to a provider advertising `supportsVision`, and the companion MUST reject them on a message whose role is not `user` and drop them for a provider without vision rather than discarding them silently at the CLI. The companion attaches the images carried by the messages of the prompt it is about to send, most recent first when more than eight arrive, and each adapter delivers them the way its CLI accepts: the reference companion uses a `--input-format stream-json` user message for Claude Code and scratch files passed with `-i` for Codex. A resumed thread (section 12.3 threads) attaches only the images that arrived since the agent last saw the conversation.

The companion MUST run each agent with its built-in file, shell, web, and editing tools disabled (`claude --tools ""`, OpenCode agent permissions set to deny, and for Codex the read-only sandbox with the documented notice), in an empty scratch working directory, with a minimal environment, and with the user's own MCP servers and project instructions excluded. Where the agent cannot drop its shell tool, the companion SHOULD add an operating-system sandbox around the whole agent process that denies access to the user's files (the reference companion uses macOS `sandbox-exec` for Codex) and MUST report `sandboxed: true` on the provider only when that outer sandbox is active.

### 12.3.1 Threads

`POST /api/generate` MAY carry a `threadId` (`^[A-Za-z0-9_-]{1,100}$`, the extension's conversation id) and a `reasoning` effort (section 5.3). For adapters that support resumable sessions the companion keeps one **thread** per `threadId`: the agent's own session handle, a working directory that lives as long as the thread, the hash of the system prompt and tool names, and how much of the conversation the agent has seen. The first turn runs the full transcript and records the handle; later turns resume the agent's session and send only the messages the thread has not seen. The companion MUST start a fresh thread when the provider, model, or system-prompt hash changes or when the conversation no longer extends the one it saw, MUST expire idle threads (the reference companion after 10 minutes), MUST end them on `DELETE /api/threads/<threadId>`, and MUST delete the agent's persisted session data when a thread ends. The result carries `thread: true` when a thread was used. Page-level `models.generate` calls carry no thread id and always run fresh. With site-owned threads (section 7.6) the extension mints one conversation id per site thread and ends the companion thread when the user deletes or leaves that thread.

The companion SHOULD expose the agent's own activity. `POST /api/generate` accepts an optional `progressId` (`^[A-Za-z0-9_-]{1,100}$`); while the run is in flight, `GET /api/progress/<progressId>?after=<n>` returns `{ items, total, done }` where each item is `{ type: "command", phase: "start" | "end", id, command, exitCode?, output? }`, `{ type: "reasoning", text }`, `{ type: "reasoning_delta", text }`, `{ type: "output_delta", text }`, or `{ type: "phase", text }` (at most 200 code points: one plain sentence naming the stage the run is in, such as checking the CLI, launching it, resuming a session, or waiting on the model). Adjacent text deltas MAY be coalesced without changing their order, but only into an item the client has not already collected. Items MAY also be `{ type: "thinking", tokens }` (a running estimate of hidden reasoning tokens). A companion SHOULD emit a phase before any step that can take seconds — detection, launch, and session resume all qualify — so the browser can say what the wait is for rather than showing a bare spinner. The result additionally carries `steps` (the completed commands), `reasoning`, `contextWindow` (when the agent reported the model's window), and `quota` (section 11.1) when the agent reported its rate-limit state. The extension forwards these to the hosted widget as activity and MUST NOT return them to pages. Only the tools the browser extension disclosed and the user approved for the current hosted turn MAY be offered, via a per-session MCP endpoint on the companion whose URL contains a random session id and whose requests carry a random session bearer token.

Tool execution stays in the browser. When the agent calls a bridged tool, the companion suspends that call, returns the pending calls to the extension as `toolCalls`, and the extension validates arguments and runs the site or remote tool under sections 7 and 8. The extension then repeats `POST /api/generate` with the assistant `tool_calls` message and matching `tool` results appended; the companion matches the trailing results to the suspended calls of a live session, resumes the agent, and returns its next event. Results for unknown or partial call sets MUST NOT resume a session; the companion then starts a fresh run from the transcript. Sessions MUST be abandoned, with the agent process terminated, when results do not arrive within two minutes or when a run exceeds the request timeout.

Section 8 tool disclosure, approval, and revocation semantics are unchanged: the companion sees only tool names, descriptions, and schemas already approved by the user, and revocation in the extension prevents the next `POST /api/generate`.

### 12.3.2 Diagnostics

A companion SHOULD keep a bounded diagnostic log and serve it at `GET /api/logs?after=<seq>&limit=<n>` to a paired browser or its own dashboard, answering `{ entries, latest, version, device }` where each entry is `{ seq, at, level, source, message }` with `level` one of `debug`, `info`, `warn`, `error`. `DELETE /api/logs` clears it. The log is diagnostic metadata only: prompts, model output, tool arguments and results, page context, pairing codes, and bearer tokens MUST NOT appear in it, and a logged command line MUST have its long argument values elided. The extension keeps an equivalent log of its own under the same rule and shows both in its settings, so a slow or failed turn can be explained without a terminal. Neither log is sent anywhere: the companion's stays on the computer, the extension's stays in the browser profile, and neither is part of sync (section 12.2).

### 12.4 Configuration sync

`GET /api/sync` and `PUT /api/sync` exchange one configuration document `{ openai: { model, apiKey } | null, active }` with a monotonically increasing `revision` maintained by the companion. `active` is the global default: `{ type: "openai" }` or `{ type: "desktop", providerId, model }`. The extension pushes after each provider save, clear, or default change and pulls when the companion reports a newer revision or when it pairs. A newly paired extension without any configuration adopts the companion's document. The companion stores the document in a user-only file (mode 0600) and shows it, with secrets masked, on the dashboard where the user can edit it; edits sync to every paired browser. Sync never includes site grants, per-site models, chat history, page context, or the usage ledger.

### 12.5 Live state invalidation

The companion exposes an authenticated WebSocket at `/api/events`. Browser extensions authenticate with their pairing bearer in the `arjunah.v1.client.<token>` subprotocol; the dashboard uses its ephemeral dashboard token in `arjunah.v1.dashboard.<token>`. Tokens MUST NOT appear in the URL, event payloads, or logs. The same loopback `Host` and `Origin` restrictions as section 12.1 apply.

The first frame is `{ type: "hello", revision, protocol }`. Each relevant change emits `{ type: "state.changed", revision, topic }`, where `revision` increases for the lifetime of the companion process. Events are invalidations, not state: they contain no account, provider, configuration, grant, prompt, or credential data. A receiver MUST re-read the authoritative JSON API after an event and after every reconnect. This reconnect snapshot rule makes missed frames harmless. The extension relays invalidations to its popup, options page, and content scripts over extension runtime ports; the hosted widget then re-reads `hosted.settings`. Extension storage changes use the same local invalidation path.

The reference companion monitors provider discovery centrally and emits when availability, sign-in, models, quota, or enabled state changes. Clients MUST NOT independently poll the full provider probes. The dashboard state endpoint MAY return a cached provider view with `providersRefreshing: true`; its pairing code and other local state MUST render without waiting for slow CLI discovery.

## 13. Conformance

A conforming v1 extension MUST pass tests for:

1. immutable discovery and version;
2. exact-origin grant isolation and denial;
3. model credential and account non-disclosure;
4. request validation, bounded context, and bounded image parts;
5. direct model generation after consent, at level 1 (single site model, other models rejected) and level 2 (exposed catalog only);
6. hosted chat registration, consent, response rendering, activity display, and site tool routing;
7. grant revocation and per-site model changes cancelling in-flight work;
8. safe provider and tool errors;
9. MCP descriptor validation and Streamable HTTP lifecycle;
10. Chrome unpacked installation with no manifest or service-worker errors;
11. Firefox temporary installation with a compatible background page and no Mozilla linter warnings;
12. popup wallet view (providers, global default, current-site dashboard) without a popup-owned chat, and fresh consent after an assistant contract change;
13. widget controls: validation, disclosure, tool-handler delivery, and page callbacks;
14. desktop companion pairing, provider selection, configuration sync, and bridged tool rounds through a desktop provider (section 12), when the desktop companion is implemented;
15. extension-collected tool input declaration, disclosure, scalar validation, invocation binding, cancellation, and absence from model traffic and chat history;
16. transcript cards: node and size bounds, rejection of HTML, links, and unknown nodes, text-only model input, visible `message` actions, `local` actions never reaching the model, and consent disclosure of the card output kind;
17. tool progress: bounds, ephemeral rendering, and absence from model messages, history, and stored transcripts;
18. site-owned threads: callback validation and timeouts, the untrusted marker and extension-side history budget on loaded entries, consent disclosure of site storage, replay of stored cards, and companion thread release on delete;
19. declared remote tools: fingerprinted declarations, single-stage consent, no `tools/list` call, `_meta` conversation id, and fresh consent after a declaration change;
20. standalone renderer: the section 14 event stream and routes against a mock backend, including a client tool round, a card update, and thread switching, with the same rendering bounds as wallet mode;
21. model and effort picker: catalog grouping, a switch the host can refuse without leaving the composer claiming it, effort levels drawn from the selected model, and both controls hidden on an empty catalog;
22. entity mentions: query and result bounds, chips as atomic composer tokens, mention parts in the submitted content, no `id` in model traffic, entities rendered as text, and a failing search that produces no matches rather than an error;
23. collected tool inputs in standalone mode: the renderer-owned prompt, scalar validation, invocation binding, and absence from the stored transcript;
24. standalone host callbacks: turn, thread, model, control, and error reports, and the mounted controller's thread, control, and catalog methods;
25. bridged mode: the turn body's `bridge` announcement, a `model.client` round answered through a level 1 session with the result posted on its route, a refused or revoked session surfacing as a section 9 error on the stream rather than a dialog, the catalog drawn from the session and not from the site, and no `model.client` accepted on a turn that announced no bridge;
26. in-page backend: the widget mounted on `backend.fetch`, a turn answered from page JavaScript with the same bounds enforced, and no network request made by the renderer;
27. hosted external loop: the manifest's `loop`, consent that names the site's server as the author of the conversation and offers no prompt disclosure, the extension answering `model.client` from the visitor's provider, `tool.client` reaching the page's site tools, context sharing absent, and revocation ending the pending completion and nothing else.

Extensions MAY implement additional APIs under another namespace. They MUST NOT change the semantics of the members defined here while claiming v1 conformance.

## 14. Standalone renderer

The renderer of section 8.1 is published as a dependency-free ES module that a site can embed without the extension. In this **standalone mode** the site backend owns inference, tools, and threads; the renderer is a view. There are no access levels, grants, or consent dialogs, because the site is already the trust domain of its own page. Section 14.7 adds **bridged mode**, in which the backend still owns the conversation and the loop but each completion is answered by the visitor's own model through an ordinary level 1 or 2 session the renderer holds as page code; the extension's consent applies to that session and to nothing else. In neither mode does the renderer present itself as the extension or as a wallet, and it MUST NOT expose or replace `window.ai.arjunah`; in bridged mode it uses that object exactly as any page may. Section 15 places these modes beside wallet mode and says which combinations of interface and loop the protocol supports.

### 14.1 Embedding

The site mounts the renderer with `{ mount, backend: { baseUrl, headers?, credentials? }, widget?, tools?, entities?, bridge? }` plus the callbacks below. `bridge` turns on section 14.7 and is described there. `widget` accepts the presentation fields of section 7.2 (`greeting`, `placeholder`, `suggestions`, `theme`, `toolCallView`, `controls`); `autoShow` and consent-related behavior do not apply. `tools` accepts section 7 site tool definitions whose handlers run in the page when the backend requests them (section 14.3, `tool.client`); `userInputs` and `reportProgress` work as in sections 7.3 and 7.5, the prompt being the renderer's own. `baseUrl` MUST be same-origin or HTTPS; `credentials` selects whether cookies are sent and defaults to same-origin only. Alternatively `backend` is `{ fetch }`: a page function with the signature of the global `fetch` that answers the section 14.4 routes itself, given a relative path and an init. The renderer then never touches the network, and a page can run the loop in its own JavaScript (section 15) by returning a `Response` whose body is a `ReadableStream` of section 14.3 events. Every bound of section 14.6 applies to what that function returns exactly as it applies to a server's answer.

Two host-owned data sources drive renderer-owned controls, so a site configures them rather than building them:

- `widget.models` is a list of section 5.2 model entries and `widget.defaultModel` the id to start on. The picker of section 8.2 appears when the list is non-empty, and the chosen `model` and `reasoning` ride with each turn (section 14.4). Nothing here is a wallet: the site names its own models and its own backend decides what they mean.
- `entities` enables the mentions of section 8.3. `entities.search(query)` resolves to matching entities; when it is absent the renderer queries the backend route instead. `entities.onActivate(entity)` receives a click on a transcript chip, and omitting it leaves chips inert. Omitting `entities` leaves `@` an ordinary character.

Callbacks are all optional and all local: `onClose()`, `onControlChange(id, value, values)`, `onModelChange({ model, reasoning })`, `onThreadChange({ threadId })`, `onTurnStart({ threadId, turnId })`, `onTurnEnd({ threadId, turnId, usage })`, and `onError({ code, message })` with a section 9 code. They report; they cannot veto, and a callback that throws MUST NOT break the turn.

Mounting resolves to `{ panel, open(), close(), destroy(), openThread(id), newThread(), getControls(), setControls(values), setModels(models, selected?) }`. `openThread` is how a site restores the conversation the visitor last had; `setModels` replaces the catalog after the site loads it. `destroy` aborts a running turn and empties the shadow root.

### 14.2 Transcript

Standalone mode uses the `ThreadSummary` and `TranscriptEntry` shapes of section 7.6 unchanged. The backend is the store; the renderer keeps only the loaded thread in memory. A backend that stores a user message containing mention parts SHOULD return them as parts when the thread is loaded, so a replayed conversation keeps its chips; flattening them to text loses the ids and is permitted but lossy.

### 14.3 Event stream

A turn is a `POST` that answers with `text/event-stream`. Each SSE event has `event: <type>` and a JSON `data` object. Event types and their bounds are the wallet-mode progress vocabulary of section 10:

- `turn.start { turnId, threadId }` and `turn.end { turnId, usage? }`;
- `model.start { round }` and `model.end { round, usage? }`;
- `output.delta { text }` and `reasoning.delta { text }`, bounded and coalescable like section 12.3.1 deltas;
- `message { entry }`: a complete assistant `TranscriptEntry`, authoritative over any deltas;
- `tool.start { id, name, source, arguments }` and `tool.end { id, name, ok, result, card? }` with the preview bounds of section 7.6;
- `tool.client { id, name, arguments }`: the backend asks the page to run a declared site tool; the renderer validates the arguments against the declared schema, runs the handler, and posts the result (section 14.4), after which the same stream continues;
- `model.client { id, request }` (bridged mode, section 14.7): the backend asks the page for one completion; `request` is a section 5.3 `models.generate` request, the renderer runs it through the bridge, posts the result or error (section 14.4), and the same stream continues. A backend MUST NOT emit it on a turn whose body carried no `bridge`;
- `progress { toolId, text }` (section 7.5);
- `agent.phase { text }`: the stage the turn is in, at most 200 code points, shown as the live turn label and never stored (the same item a companion reports in section 12.3.1);
- `card { toolId, card }` and `card.update { cardId, card }` (section 7.4);
- `error { code, message }` using the section 9 codes, which ends the turn.

The renderer reads the body incrementally with a 2,000,000-byte ceiling, ignores unknown event types, rejects malformed data, and applies every section 7.4 and 7.6 bound to what it renders. Provider wire formats never reach the renderer; the backend normalizes them.

### 14.4 Routes

Relative to `baseUrl`:

- `GET threads` → `ThreadSummary[]`; `POST threads` → `ThreadSummary`; `GET threads/{id}` → `TranscriptEntry[]`; `PATCH threads/{id}` with `{ title }`; `DELETE threads/{id}`.
- `POST threads/{id}/turns` with `{ content, controls?, model?, reasoning?, bridge? }` where `content` follows section 5.3 user message content and MAY contain the mention parts of section 8.3. `model` is an id from the catalog the picker shows and `reasoning` one of its `reasoningLevels`; both are absent when no picker is shown. `bridge` is present only in bridged mode and describes what the page can do for this turn (section 14.7). The response is the event stream.
- `POST threads/{id}/turns/{turnId}/tool-results` with `{ id, result }` where `result` follows section 7 result validation → `204`; the open stream continues.
- `POST threads/{id}/turns/{turnId}/model-results` with `{ id, result }` where `result` is a section 5.3 generation result, or `{ id, error: { code, message } }` with a section 9 code → `204`; the open stream continues. Bridged mode only.
- `POST threads/{id}/actions` with `{ cardId, name, payload?, values? }` → `204`, or `{ card }` to update the card in place.
- `POST threads/{id}/turns/{turnId}/cancel` → `204`.
- `GET entities?q={query}` → `Entity[]` (section 8.3), at most 20 entries. The renderer calls it only when `entities` is configured without its own `search`, and a non-2xx answer or an invalid body means no matches.

Backends MAY require their own authentication through `headers` or cookies. Responses other than the event stream are JSON bounded to 1,000,000 bytes. The renderer applies the section 7.6 list and entry limits to every response.

### 14.5 Backend tools and the shared definition

In standalone mode server tools need no protocol: the backend runs them inside the turn and reports them with `tool.start` and `tool.end` using `source: "backend"`. A backend that also serves wallet-mode sites exposes the same handlers as a section 7.7 MCP endpoint. The reference SDK provides one definition helper that produces both, so a site writes each tool once and chooses per deployment whether the extension or its own backend runs the model.

### 14.6 Security

The renderer renders answers as text and Markdown-derived DOM, never HTML; it evaluates no code, loads no remote code, and works under a strict content security policy. Card, transcript, stream, entity, and collected-input bounds are enforced by the renderer itself because no broker sits in front of it. Standalone mode provides none of the wallet guarantees of section 2: the site sees everything the user types, and the renderer MUST NOT display any wording that suggests otherwise. Bridged mode restores exactly one of them, credential non-disclosure, and section 14.7 says which wording that permits.

### 14.7 Bridged mode

Standalone mode puts the loop and the model on the same server. Bridged mode separates them: the site backend runs the loop, and the page answers each completion from the visitor's own model. The backend keeps everything it owns in standalone mode, meaning the conversation, its tools, its policy, the threads, and the event stream. What it gives up is the model credential. It never holds one, because every completion is a `models.generate` call made by the renderer, as page code, through an ordinary level 1 or level 2 session (section 4). The extension's consent dialog for that session is the only consent involved, and it means what it always means at those levels: the site may send prompts to the model the visitor chose for it. Here the site's backend composes those prompts.

**Enabling it.** The site passes `bridge` when mounting:

```js
bridge: {
  arjunah: true | AccessRequest,          // hold a session on the visitor's extension
  generate?(request): Promise<Result>,    // or answer completions some other way
}
```

`arjunah: true` requests level 1; an `AccessRequest` may ask for level 2 and page context. The renderer calls `enable()` lazily, on the first send after mount, so the consent dialog follows a user gesture rather than a server event, and it keeps the session for the life of the mount. `generate` replaces the extension with a page function that accepts a section 5.3 request and resolves to a section 5.3 result; when both are given, `generate` wins. A site with neither has no bridge, and the turn body carries no `bridge` field.

**Announcing it.** Every `POST threads/{id}/turns` in bridged mode carries:

```json
"bridge": {
  "model": { "id": "openai/gpt-5.6-sol", "capabilities": { "tools": true, "vision": true, "reasoning": true }, "contextWindow": 272000, "reasoningLevels": ["low", "medium", "high"] },
  "tools": [{ "name": "page_info", "description": "…", "inputSchema": { "type": "object", "additionalProperties": false } }]
}
```

`model` is the section 5.2 entry of the model that will answer this turn, or `null` when the page has no session yet, was refused one, or lost it, so the backend can decide before composing whether to run the turn, fall back to a provider of its own, or fail. `tools` lists the site tools declared to the renderer as `{ name, description?, inputSchema }`, at most 32, without handlers or `userInputs`; they are what the backend may request with `tool.client`. The announcement is per turn because the grant can change between turns.

**Running a completion.** When the loop needs the model, the backend emits `model.client { id, request }`. `request` is a section 5.3 request: `messages` (required), and optionally `model`, `tools`, `reasoning`, `temperature`, and `maxTokens`, all under section 5.3 bounds, with `tools` in the section 7.1 schema subset because the extension validates them as it validates any page's. The renderer passes the request to the bridge unchanged, shows the round as in progress, and posts to `model-results` either `{ id, result }` with the section 5.3 result, or `{ id, error }` with the section 9 code the session rejected with. The backend then continues the loop: it dispatches `toolCalls` to its own tools inline or to the page with `tool.client`, emits `message` or `output.delta` for the text, and ends the turn. The renderer does not display a completion result itself, because only the backend knows whether the round is the answer or the middle of a tool exchange.

At level 1, `request.model` MUST be absent, `"default"`, or the announced id; anything else is rejected by the extension with `INVALID_REQUEST`, and the backend learns that through `error`. At level 2 the renderer's picker (section 8.2) shows the exposed catalog, the choice rides the turn as `model`, and a backend that echoes it into `request.model` gets that model. `messages` is the backend's to compose; the section 5.3 history budget (100 messages, 12,000 code units each) and the mention flattening rule of section 5.3 apply to what it sends. A completion MAY take up to 180 seconds (section 5.3), so the turn's stream MUST stay open for at least that long after `model.client`.

**Failure.** A session that is refused, revoked, or invalidated by a per-site model change rejects the pending `models.generate` with a section 9 code; the renderer posts it as `error` on `model-results` and MUST NOT open a dialog of its own or retry. The backend ends the turn with a section 14.3 `error` event, or with a `message` if it answered another way. Revocation therefore cancels the completion the visitor was paying for and nothing else; the conversation stays on the backend. A `model.client` on a turn whose body carried no `bridge` is a backend defect: the renderer MUST answer it with `{ id, error: { code: "NOT_SUPPORTED" } }` and the backend MUST treat that as final.

**What the visitor is and is not protected by.** The credential stays in the extension, the grant is per exact origin and revocable, and the visitor chooses the model. Those three claims are true and a renderer MAY state them. The backend sees everything the visitor types and composes every prompt, the wallet's system prompt disclosure does not exist because a level 1 site authors its own messages, and nothing prevents the backend from logging the conversation. A renderer MUST NOT describe bridged mode as the wallet, and the section 14.6 wording rule stands. The extension, for its part, sees a level 1 or 2 page like any other: it cannot tell that a server is behind the page and MUST NOT need to.

**No deltas.** The completion arrives whole. Section 5.3 makes the page API non-streaming, so `model.client` cannot yield `output.delta` for the text the model is still producing; the backend MAY stream its own progress and tool activity as usual, and the visitor sees the answer when the round ends.

## 15. Where the interface lives and who runs the loop

Three actors can render the chat and three can run the inference and tool loop. This section names each combination the protocol supports, points at the section that specifies it, and says why the remaining one is out. In every supported combination the **frontend can add tools that act on the page itself**, and those tools are always handled by the frontend: as site tools of section 7 when the extension runs the loop, as `tools` requested through `tool.client` when a backend does, and directly when the page is the loop.

| Interface \ Loop    | arjunah                                 | backend                                           | frontend                                            |
| ------------------- | --------------------------------------- | ------------------------------------------------- | --------------------------------------------------- |
| **arjunah panel**   | wallet mode, level 0 (sections 7 and 8) | hosted external loop (section 15.1)               | hosted external loop with an in-page backend (15.1) |
| **frontend widget** | not supported (below)                   | standalone (section 14) or bridged (section 14.7) | in-page backend (section 14.1, `backend.fetch`)     |

Two questions decide the cell. **Who holds the model credential?** In wallet mode, bridged mode, and the hosted external loop it is the extension, and the visitor chooses the model; in standalone mode and the in-page backend the site does, unless the page itself calls `models.generate` at level 1 or 2, which is ordinary page use and needs nothing from this section. **Who composes the prompts?** Only wallet mode lets the extension disclose the system prompt, because only there does the extension author the conversation; in every other cell the site does, and consent says so.

The **frontend-widget with arjunah-loop** cell is not supported, and this is deliberate rather than pending. It would require the extension's live turn events to cross the page bridge, and section 10 forbids that: hosted-chat progress travels over the extension's own messaging so that every delta the visitor sees is one the broker bounded and never one the page can read, replay, or alter. A site that wants the extension's loop uses the extension's panel; a site that wants its own panel runs the loop itself or on its backend. What the page may have is the finished conversation: with site-owned threads (section 7.6) the extension calls `append` after every completed turn, so a page can archive, search, or redraw past turns in its own widget. It cannot show them arriving.

### 15.1 Hosted external loop

The extension hosts the panel, and a loop outside the extension runs the turn: the site's backend speaking section 14, or the page itself through the in-page backend of section 14.1. The extension acts as the section 14 renderer toward that loop and as the section 14.7 bridge toward the visitor's providers, answering every `model.client` itself. Nothing new is granted. A level 1 page can already compose prompts and call `models.generate`; this shape lends it the extension's panel, model picker, usage display, and consent surface, and the discipline that goes with them.

**Declaring it.** The section 7 manifest gains `loop`:

```js
loop: {
  baseUrl: "/api/assistant/", headers?: {…},   // a section 14 backend, or
  fetch?(path, init): Promise<Response>,       // an in-page one (section 14.1)
  level?: 1 | 2,                               // grant to request; default 1
}
```

`loop` and `systemPrompt` are mutually exclusive, and `mcpServers` is ignored with `loop`, because the external loop runs its own server tools inline. `tools`, `widget`, `threads`, and the card and control callbacks keep their meaning; site tools are what the loop may request with `tool.client`, and they are announced to it in `bridge.tools` on every turn exactly as in section 14.7. `threads` is normally absent, because a section 14 backend owns its threads; when present the extension drives the section 14.4 thread routes and ignores the manifest callbacks.

**Consent.** The first message requests a **level 1 grant** (or level 2 if the manifest's `loop.level` asks for it), not the hosted capabilities of section 8. The dialog MUST state, in these terms: that this site's own server (or page) runs the conversation and composes what is sent to the model; that the extension supplies the model, this window, and nothing else; that it cannot show the prompts because it does not see them; and which site tools the loop may call, disclosed as in section 7. It MUST NOT show a system prompt, because there is none to show. The panel MUST carry a persistent line to the same effect while a `loop` is active, so the extension's chrome never implies the extension's authorship. Page context sharing (section 6) is absent in this shape: the extension cannot inject context into a conversation it does not compose, and the page can pass its own context to its own loop.

**Running a turn.** The extension POSTs the turn to `loop` as section 14.4 describes, with `bridge.model` set to the model the visitor's grant selects for this site and `bridge.tools` to the manifest's site tools. It consumes the section 14.3 stream and renders it in the panel. On `model.client` it runs the request against the visitor's provider under the same validation a page's `models.generate` receives, including the level 1 rule that `request.model` be absent, `"default"`, or the site model, and posts the section 5.3 result or a section 9 error to `model-results`. On `tool.client` it invokes the page's site tool through the bridge as in hosted chat, with `requestInput` and `reportProgress` working as in sections 7.3 and 7.5, and posts the result to `tool-results`. Cards, progress, and mentions render as in any section 14 stream. The model picker shows the visitor's catalog; the choice rides the turn as `model` and the extension answers with that model when the grant permits.

**What holds.** Credential non-disclosure, exact-origin grants, and the visitor's choice of model hold exactly as at level 1. Revocation or a per-site model change rejects the pending `models.generate`, which the extension posts as `error` on `model-results` and the loop ends the turn; nothing else is cancelled, because the conversation is the loop's. Usage is recorded in the extension's ledger (section 11.1) per completion it answers. The loop sees everything the visitor types and everything the model returns, and consent said so. A `model.client` from a loop that was not declared, or on a turn for which the extension announced no `bridge`, is answered with `NOT_SUPPORTED`.
