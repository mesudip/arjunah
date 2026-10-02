# अर्जुनः Protocol

Version: **1.0.0-beta**

Status: **Implemented draft with a bounded schema subset, tiered site access, extension-collected tool inputs, transcript cards, tool progress, site-owned threads, declared remote tools, approvals, an optional desktop companion, a standalone renderer with its own model picker and entity mentions, a hosted external loop, and the site's own models**
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
11. A site sees only the model catalog the user exposed to it (section 4.1). The provider metadata a page can observe is exactly this: per provider, `id`, `name`, `vendor` (or `null`), `kind`, and its model identifiers (section 5.2); per model, `id`, `provider`, `displayName`, `default`, `capabilities`, `contextWindow`, `reasoningLevels`, `limits`, `kind`, `local`, and `builtinTools` (section 5.2); and in a generation result, the answering model's identifier, `contextWindow`, `kind`, `local`, and `builtinTools` (section 5.3). None of it names an account, plan, quota, version, server address, or path; `local` says only that the model runs on the user's own computer or network, never where.
12. Extension-collected tool inputs (section 7.3) MUST be separately disclosed, bound to one active invocation, and omitted from the model-facing tool schema, model messages, and extension chat history. The site tool receives the value and remains a trust boundary: the extension cannot prevent page code from transmitting it or returning it in a tool result.
13. A transcript card (section 7.4) is site-authored UI inside the extension's UI. It MUST be bounded and validated at every trust boundary, MUST carry a text fallback that is the only thing the model receives, MUST NOT contain HTML, scripts, or navigable links, and its actions MUST NOT produce model messages the user cannot see or tool arguments the model did not author.
14. A site-owned transcript (section 7.6) is untrusted model input. The extension MUST disclose in consent that the site stores and supplies the conversation, MUST mark site-supplied history as untrusted in the provider request, MUST apply its own history budget after any site truncation, and MUST NOT let a supplied transcript widen the disclosed contract.
15. Tool progress (section 7.5) is presentation only. It MUST NOT enter model messages, chat history, or the site-owned transcript.
16. Provider continuation state (section 5.4: signed thinking, thought signatures, encrypted reasoning) MUST NOT be placed in page-world objects, events, DOM attributes, results, or error details, and MUST NOT be logged. A page cannot read it and cannot supply it: it holds only a conversation the extension minted for its origin and the tool-call ids it was given, the extension verifies the conversation against the origin it derives from the sender on every use, and the key that makes conversation ids verifiable never leaves the extension.

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
  Promise<boolean> openSettings(); // the extension's view of this site; needs a user gesture
  readonly attribute AISite site; // publish the assistant contract (section 7)
  readonly attribute AIChat chat; // open and steer the extension-hosted chat (section 8)
}

interface Session {
  readonly attribute Grant grant; // the grant as it stood when enable() resolved
  readonly attribute AIPermissions permissions; // query() the current grant
  readonly attribute AIProviders providers; // list exposed providers (level 2)
  readonly attribute AIModels models; // list models, generate, and stream a round (level 1 and 2)
  readonly attribute AIConversations conversations; // create and open conversations (level 1 and 2, section 5.4)
  readonly attribute AIContext context; // read approved page context
}
```

The root object follows the wallet pattern. Its two attributes, `site` and `chat`, are the level 0 surface: they let a page publish its assistant contract and open the extension-hosted chat, and they work without any grant because the extension, not the page, does the model work and asks the user itself. Everything the page would use to do its own model work lives on the **session** that `enable()` resolves to, and the session's methods succeed only for the capabilities the user granted (section 4); a page cannot reach `models`, `providers`, or `context` without first enabling access. `isEnabled()` reports whether the origin currently holds a grant at level 1 or 2, so a page can decide whether calling `enable()` will prompt. `disable()` removes the origin's whole grant.

Feature detection MUST use members, not version string comparison. Unknown input fields MUST be ignored unless explicitly forbidden. Unknown capability names and unknown access levels MUST be rejected.

If `window.ai.arjunah` already exists, or `window.ai` exists but is not an extensible object, the extension MUST NOT overwrite either. It SHOULD dispatch `arjunah:conflict` on `window`.

After successful installation of the object, the extension SHOULD dispatch `arjunah:ready` on `window`; its `detail` is `{ "version": "1.0.0" }`. Pages MUST still check `window.ai.arjunah` first so they work when injection precedes their event listener.

The extension dispatches `arjunah:grantchange` on `window` whenever the origin's grant or its site model changes, whatever surface changed it: consent, the toolbar popup, the options page, the hosted chat header, a change of the global default that the site follows, `disable()`, or a revocation. Its `detail` is `{ "level", "model", "revoked" }`: the access level now held (`"assistant"`, `"completion"`, or `"catalog"`), the site model id (or `null`, as in the grant), and `revoked: true` with `level` and `model` both `null` when the origin no longer holds a grant. It carries nothing else, never another origin's grant, and no account, provider, or quota. A page that holds a session SHOULD re-read what it shows (`permissions.query()`, `models.list()`) when it arrives. The reference extension has each document's content script compare its own origin's grant after every state invalidation (section 12.5); the first read is the baseline and announces nothing, so the event reports changes made while the document was alive, including ones made while it sat in the back/forward cache.

`openSettings()` opens the extension's own view of this site: its toolbar popup, which shows the current site, where the browser lets an extension open it, otherwise the options page at its list of sites. It resolves `true` once opened. It MUST be called with transient user activation in the page (a click or key press the page is still handling); the content script checks `navigator.userActivation.isActive` and rejects with `PERMISSION_REQUIRED` without it, so a page cannot open extension UI on its own. It needs no grant. The reference extension opens it at most once per second per tab.

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

`enable({ level?, capabilities?, context?, reason?, require? })` MUST resolve to a session after approval and MUST reject with `AIError` code `USER_DENIED` on denial. A request with neither `level` nor `capabilities`, including `enable()` with no argument, MUST be treated as `{ level: "completion" }`: like a wallet connect, the default asks for level 1. Otherwise `level` (`"completion"` or `"catalog"`) or a non-empty unique `capabilities` array is used; `level` expands to the capabilities in the table and MAY be combined with `context.read`. Duplicate capabilities MUST be rejected. Repeated context fields are normalized to one occurrence. `context` is a subset of `title`, `url`, `selection`, and `text`; `text` requires `context.read`. Level 0 is never requested: the extension's hosted chat asks for its own capabilities when the user first sends a message (section 8).

`require` lets a site restrict which of the visitor's models may answer it, for example because it promised its own users that their data stays on their computer: `{ kinds?, local?, builtinTools? }`, where `kinds` is a non-empty list of unique provider kinds (`"api-key"`, `"subscription"`, `"self-hosted"`), `local` can only be `true`, and `builtinTools` can only be `false`. A model qualifies when it meets every member given, read from its section 5.2 metadata. Any other member or value, or `require` in a request without `models.list` or `models.generate`, MUST be rejected with `INVALID_REQUEST`. `require` constrains only the visitor's models; the site's own models (section 15.2) are not subject to it.

- The grant stores the `require` of the request the user approved. A later request whose `require` differs asks again, a request without `require` keeps the stored one, and `require: {}` removes it after consent.
- Consent offers only the models that qualify, preselecting the site's current model or the model the widget preselected when it qualifies, otherwise the first that does, and says that the site restricted the choice. At level 2 it lists only providers with a qualifying model. When no configured model qualifies, the sheet says so, offers no approval, and the request rejects with `NOT_CONFIGURED`.
- A restricted grant is always pinned to a qualifying model: choosing the global default pins it, and the extension refuses with `NOT_SUPPORTED` a site-model change on any surface (popup, options, hosted header) to a model that does not qualify.
- At level 2 `models.list()` and `providers.list()` return only qualifying models. A `models.generate` round, one-off or through a conversation, answered by a model that does not qualify (an explicitly selected one, or the global default the extension fell back to when the pinned model became unavailable) fails with `NOT_SUPPORTED` before any provider is contacted.

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

Consent is additive: requesting already granted capabilities MUST NOT prompt again. Requesting any new capability MUST show both the new request and the resulting effective grant. When a request raises the site to level 1 or 2 the consent dialog MUST let the user choose the model for this site (defaulting to the global default) and, at level 2, which providers the site may see (defaulting to every available provider). When the resulting grant includes `models.generate`, the dialog MUST also say that the extension keeps provider state between a reply's tool rounds on the device for at most two days (section 5.4); the reference wording is "Keeps the model's working state during a reply's tool steps on this device, for up to 2 days."

Capability grants do not silently authorize newly declared external resources. The extension MUST retain private approval metadata for hosted assistant contract fingerprints, MCP origins, and discovered tool-set fingerprints. The full system prompt, site tool definitions (including declared output kinds such as cards), declared remote tool definitions (section 7.7), widget controls, and whether the site stores the conversation (section 7.6) MUST be available for inspection in consent. A changed contract, previously undisclosed MCP origin, or changed remote tool metadata MUST trigger fresh consent before the next hosted model request. Both the consent layer and background execution layer MUST enforce these approvals. This metadata is extension-internal and MUST NOT be exposed by `session.permissions.query()`.

### 4.1 Per-site model settings

Every grant carries two user-owned settings that pages cannot change:

- **Site model** (`model`): the model that answers `models.generate` calls without an explicit `model`, and the hosted chat on this site. It defaults to the global default model. The user MAY change it in the consent dialog, the toolbar popup, or the hosted chat header; for a site with `require` (section 4) every one of them offers and accepts only qualifying models. When the selected model becomes unavailable (key removed, agent signed out), the extension falls back to the global default and MUST say so in its UI.
- **Exposed providers** (`providers`): at level 2, the providers whose models `models.list()` and `providers.list()` return. `null` means every available provider and an empty list means none. The site-model provider is not added implicitly: the extension-owned hosted chat may keep using the site model without disclosing that provider to page code. At level 1 the exposed set is exactly the site model.

Changing the site model cancels the site's in-flight hosted operations. Narrowing exposed providers does not cancel hosted chat, because its site model is a separate user-owned setting; it cancels only a direct page completion that explicitly selected a model from a provider the user just hid.

## 5. Providers and models

### 5.1 Identifiers

Every model has an opaque identifier `<provider-id>/<model>`: `openai/gpt-5.6-sol`, `claude-code/sonnet`, `opencode-api/muse-spark-1.3`, `opencode-cli/opencode/big-pickle`. Provider identifiers match `^[a-z][a-z0-9-]{0,63}$`; `openai` is the user's OpenAI API-key provider, `opencode-api` is the OpenCode Zen API-key provider, `ollama` is an Ollama server the user runs, `ollama-cloud` is the Ollama Cloud API-key provider, and desktop providers use the public catalog identifiers in section 12.2. Pages MUST treat both identifiers as opaque and MUST NOT parse plan or account information from them; there is none.

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

`kind` is `api-key`, `subscription`, or `self-hosted` (a model server the user runs, such as Ollama, reached by an address the user configured). `vendor` names the company behind the models only when the configuration settles it, and is `null` otherwise: an OpenAI-compatible provider whose base URL is not `api.openai.com`, an OpenCode Zen key used at another address, a self-hosted server, and the OpenCode CLI, which forwards to whichever upstream the user configured. No account label, plan, quota, version, server address, or path is included.

`models.list()` requires `models.list`. At level 1 it returns exactly one entry, the site model. At level 2 it returns every model of every exposed provider. Each entry is:

```json
{
  "id": "openai/gpt-5.6-sol",
  "provider": "openai",
  "displayName": "GPT-5.6 Sol",
  "default": true,
  "capabilities": { "tools": true, "vision": true, "reasoning": true },
  "contextWindow": 272000,
  "reasoningLevels": ["none", "low", "medium", "high"],
  "limits": {
    "messages": 400,
    "messageUnits": 180000,
    "tools": 128,
    "toolDescriptionUnits": 2000,
    "toolCallsPerMessage": 32,
    "toolArgumentUnits": 65536,
    "schemaBytes": 32768,
    "schemaDepth": 16,
    "requestBytes": 12000000,
    "maxTokens": 32768,
    "timeoutMs": 180000
  },
  "kind": "api-key",
  "local": false,
  "builtinTools": false
}
```

`default` marks the site model. `capabilities.tools` says the model accepts function tools; `capabilities.vision` says it accepts image content parts (section 5.3); `capabilities.reasoning` says the model can think before answering and accepts a reasoning effort. `contextWindow` is the model's context size in tokens when the provider publishes or reports it, otherwise `null`; extensions MUST NOT guess it. `reasoningLevels` lists the effort names the model accepts (a subset of `none`, `low`, `medium`, `high`, `xhigh`, `max`), empty when reasoning cannot be steered. Extensions MAY add further boolean capability flags; pages MUST ignore unknown ones.

`kind` repeats the provider's kind. `local` is `true` only when the extension knows the model runs on the user's own computer or network: the reference extension reports it only for a self-hosted Ollama server whose address is a loopback name or a loopback, private, link-local, or carrier-grade NAT IP literal, and only for a model the server runs itself, not one it forwards to ollama.com (a `-cloud` model, or one `/api/show` reports with a remote host). A name it cannot resolve (`gpu-box`, `*.lan`), any other provider, and anything unknown is `false`. `builtinTools` is `true` when the agent that answers can run tools of its own beside the ones a request offers; today that is Codex, whose read-only shell sandbox the companion cannot disable (section 12.3). Claude Code and OpenCode run with their built-in tools disabled and API providers have none, so they report `false`.

`limits` gives the bounds a `models.generate` request answered by this model is held to, one member per row of the section 5.3 table that has one, in that row's unit. An extension MUST enforce exactly the values it reports, MUST report every member, and MAY report less than a section 5.3 default for a model whose provider accepts less; the reference extension reports 300 messages, 64 tools, and 500-unit tool descriptions for the desktop companion's models, because the companion accepts no more (section 12.3). Pages SHOULD size their requests from `limits` and MUST ignore members they do not know.

### 5.3 Generation

`models.generate(request, options?)` requires `models.generate`. `options` is `{ signal }`, where `signal` is an `AbortSignal`; aborting it ends the call with `ABORTED` and cancels the provider request (section 10). A `signal` that is not an `AbortSignal` is rejected with `INVALID_REQUEST`. `models.stream(request, options?)` is the same call with the round's deltas delivered as they arrive (round streaming, below).

Every bound of a generation request and of its result is in this table, with the unit it counts. A row with a `limits` member is reported per model by `models.list()` (section 5.2), and the value here is that member's default, which no model exceeds; rows without one are fixed. The extension's own provider requests (hosted rounds, with their page context and tool results) are held to the same bounds; there is no larger budget for extension-made messages.

| Bound | `limits` member | Default | Unit |
| --- | --- | --- | --- |
| Messages per request | `messages` | 400 | messages |
| Text of one message, any role: a string `content`, or its text parts together | `messageUnits` | 180,000 | UTF-16 code units |
| Tool definitions per request | `tools` | 128 | tools |
| One tool `description` | `toolDescriptionUnits` | 2,000 | UTF-16 code units |
| `toolCalls` on one assistant message | `toolCallsPerMessage` | 32 | calls |
| One tool call's `function.arguments` | `toolArgumentUnits` | 65,536 | UTF-16 code units |
| One tool `inputSchema`, serialized as JSON | `schemaBytes` | 32,768 | UTF-8 bytes |
| Schema nesting below the root (section 7.1) | `schemaDepth` | 16 | levels |
| The serialized provider request | `requestBytes` | 12,000,000 | UTF-8 bytes |
| `maxTokens`, from 1 | `maxTokens` | 32,768 | tokens |
| How long the page API waits for the answer | `timeoutMs` | 180,000 | milliseconds |
| Content parts in one user message | — | 8 | text and image parts |
| Image parts in one message | — | 4 | parts |
| One image part's `data` | — | 2,000,000 | base64 characters |
| Combinator arrays in a schema (section 7.1) | — | 1–32 | schemas |
| `name`, and a tool name in a definition or a call | — | 64 | UTF-16 code units, `^[A-Za-z0-9_-]{1,64}$` for tool names |
| `toolCallId`, and a call's `id` | — | 128 | UTF-16 code units |
| `model` | — | 200 | UTF-16 code units |
| `temperature` | — | 0 through 2 | finite number |
| A mention part's `label` (never accepted here, see below) | — | 80 | Unicode code points |
| A result's `reasoning` summary | — | 12,000 | UTF-16 code units |
| A result's `attachments` | — | 4 | images, each bounded like an input image |
| A non-streamed provider response | — | 2,000,000 | UTF-8 bytes |
| One server-sent event of a streamed provider response | — | 8,000,000 | UTF-8 bytes |

A request past any of its bounds is rejected with `INVALID_REQUEST` before any provider is contacted; a provider answer past the result bounds is a `PROVIDER_ERROR`. A request within its bounds can still be too long for the model: the extension does not estimate tokens, so that is learned from the provider and reported as `CONTEXT_TOO_LONG` (section 9). Request fields:

- `messages` (required): objects with role `system`, `user`, `assistant`, or `tool`. `content` is a string, or, for user messages, an array of content parts. A text part is `{ "type": "text", "text": "…" }`. An image part is `{ "type": "image", "mediaType": "image/png" | "image/jpeg" | "image/webp" | "image/gif", "data": "<base64>" }`. Image parts require a model whose `capabilities.vision` is true; otherwise the extension rejects the request with `NOT_SUPPORTED` before contacting any provider. A mention part is `{ "type": "mention", "id": "machine:12", "label": "web-01" }`: something the user picked from the renderer's entity picker (section 8.3) rather than typed. `id` matches `^[A-Za-z0-9_.:-]{1,128}$` and `label` is limited to 80 Unicode code points; a message carries at most 16 mention parts and they do not count toward the eight text and image parts. Pages MUST NOT send mention parts to `models.generate` and implementations MUST reject them there with `INVALID_REQUEST`: they exist so a stored transcript (section 7.6) and a standalone turn (section 14) keep the identity the user chose beside the label they saw. An implementation that forwards a conversation containing mention parts to a provider MUST flatten each one to `@` followed by its `label` and MUST NOT send the `id`, unless it first resolves the id into text of its own. A page MAY supply `name`, `toolCallId`, and OpenAI-compatible `toolCalls`. Tool messages MUST include `toolCallId`; only assistant messages may carry `toolCalls`. Each call has a unique non-empty `id`, `type: "function"`, and `function: { name, arguments }`, with arguments encoded as a JSON string.
- `model` (optional): a model id exposed by `models.list`. Absent, or the literal string `"default"`, means the site model. At level 1 any other value MUST be rejected with `INVALID_REQUEST`; at level 2 the value MUST belong to the exposed catalog.
- `temperature` (optional): finite number from 0 through 2. Providers that expose no sampling control (the subscription agents of section 12) MUST drop it and warn in the page console rather than fail the request; a site cannot tell at level 1 which kind answers it.
- `maxTokens` (optional): integer from 1 through `limits.maxTokens`. The same drop-and-warn rule applies.
- `tools` (optional): function definitions `{ name, description?, inputSchema? }` using the schema subset in section 7.1. Tools require a model whose `capabilities.tools` is true.
- `toolChoice` (optional): `"auto"` (the model decides), `"none"` (it answers without calling a tool), `"required"` (it calls at least one tool), or `{ "name": "<tool>" }` (it calls that tool). It requires `tools`, and `name` MUST be one of the request's tools; otherwise `INVALID_REQUEST` with `details.field` `"toolChoice"`. The tools stay declared under every choice. Absent means the provider's default. The extension maps it as follows and rejects, before contacting the provider, with `NOT_SUPPORTED` any choice a wire format has no control for:

| Wire format | `"auto"` | `"none"` | `"required"` | `{ name }` |
| --- | --- | --- | --- | --- |
| Chat Completions | `tool_choice: "auto"` | `tool_choice: "none"` | `tool_choice: "required"` | `tool_choice: { type: "function", function: { name } }` |
| Responses | `tool_choice: "auto"` | `tool_choice: "none"` | `tool_choice: "required"` | `tool_choice: { type: "function", name }` |
| Anthropic Messages | `tool_choice: { type: "auto" }` | `{ type: "none" }` | `{ type: "any" }` | `{ type: "tool", name }` |
| Gemini | `toolConfig.functionCallingConfig.mode: "AUTO"` | `"NONE"` | `"ANY"` | `"ANY"` with `allowedFunctionNames: [name]` |
| Ollama native | provider default, nothing sent | `NOT_SUPPORTED` | `NOT_SUPPORTED` | `NOT_SUPPORTED` |
| Desktop companion | provider default, nothing sent | `NOT_SUPPORTED` | `NOT_SUPPORTED` | `NOT_SUPPORTED` |

Anthropic refuses extended thinking together with a forced tool, so with `"required"` or `{ name }` the reference extension sends no `thinking` block: the reasoning effort is clamped (as above), the tool choice is not.
- `reasoning` (optional): `{ "effort": "none" | "low" | "medium" | "high" | "xhigh" | "max" }` (or the bare string). The extension maps the effort to the provider's own control (OpenAI `reasoning_effort`, Codex `model_reasoning_effort`, Claude Code `--effort`, OpenCode `--variant`, Ollama `think`: `false` for `none`, the level itself where the model publishes levels, otherwise `true`) and clamps to what the model supports; unknown values are rejected with `INVALID_REQUEST`. Absent means the provider's default.

`session.models.generate(request)` is a one-off completion. The same request sent through a conversation's `generate` (section 5.4) continues that conversation; nothing in the request itself names one. `session.models.stream` and a conversation's `stream` are the streamed forms of the same two calls.

A non-streamed response is read incrementally to its ceiling. A streamed response has no total ceiling, since its wire size runs far ahead of its text; instead each server-sent event is bounded and parsed then dropped, answer and reasoning text are held to the final-response limits, and streamed tool arguments are kept only until they pass `toolArgumentUnits`, after which the call is reported to the model as oversized. Hosted chat history uses the most recent 40 user/assistant messages, each text part bounded to 12,000 UTF-16 code units, plus its image parts; that is the hosted chat's own budget and does not change a model's `limits`.

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
  "contextWindow": 272000,
  "kind": "api-key",
  "local": false,
  "builtinTools": false,
  "providerState": "none"
}
```

`providerState` is `"reused"` when the extension reattached provider state it kept from an earlier round of this turn to at least one assistant message of the request (section 5.4), otherwise `"none"`. It says only that; the state itself is never part of a result.

`kind`, `local`, and `builtinTools` repeat the answering model's section 5.2 metadata, so a page that let the extension pick (level 1, or `"default"`) knows where the answer came from. `usage.cachedTokens` counts prompt tokens the provider served from its prompt cache and `usage.reasoningTokens` the hidden thinking tokens, both `0` when the provider does not report them. `contextWindow` repeats the answering model's context size (or `null`) so a page can show how much of it the request used. `attachments` holds images the provider produced, each `{ "type": "image", "mediaType", "data" }` bounded like input images and limited to 4 per response; extensions MUST pass through only image types they validated. `reasoning` is an optional provider-supplied reasoning summary (string, at most 12,000 code units) or `null`; the extension MUST NOT synthesize it. Both fields are present with empty/null values when the provider returned none, so pages can rely on the shape.

**Round streaming.** `models.stream(request, options?)` takes the same request and options as `models.generate`, requires the same capability, and is held to the same bounds, deadline, and errors. It returns an async iterable (read with `for await`) of these events, in this order:

- `{ "type": "output.delta", "text" }` and `{ "type": "reasoning.delta", "text" }`: answer and reasoning text as the provider produces it, in the provider's order. The extension coalesces adjacent text of one type for at most 250 milliseconds or 4,000 UTF-16 code units before it sends it, so an event carries at most 4,000 code units, and the deltas of one round together carry at most what the result may hold: 120,000 code units of answer (the length the extension keeps of a result's `content`) and 12,000 of reasoning (the result's `reasoning` bound). Deltas are provisional: when the round ends in tool calls, fails, or is cancelled they mean nothing, and only the result counts.
- `{ "type": "stalled" }`: nothing has arrived from the provider for 20 seconds and the round is still being waited on, as hosted chat's `model.stalled` (section 10). It repeats after every further 20 seconds of silence, ends nothing, and is not an error.
- `{ "type": "result", "result" }`, last: exactly what `models.generate` resolves to for the same request, with the same validation, model metadata, `providerState`, usage, and console warnings. It is authoritative over the deltas.

Tool calls are never streamed; they arrive only in the result. Neither are agent activity (commands, phases, token estimates), usage, or provider state. A failure rejects the iterator's `next()` with the section 9 error `models.generate` would reject with, including its `details`, after any deltas already delivered. Aborting `signal` rejects `next()` with `ABORTED` and cancels the provider request exactly as for `models.generate`; leaving the loop early (the iterator's `return()`, which `break` calls) cancels the round the same way and ends the iteration without an error. A provider that produces no deltas still answers: its stream yields only stall notices and the result. For the desktop companion the deltas are the `output_delta` and `reasoning_delta` items of the run's live activity (section 12.3.1); a companion that reports none yields only the result.

`models.generate` returns one bounded result even when the provider streams internally. For extension-hosted chat (level 0) an implementation MAY render provider output incrementally inside its isolated UI. Those private deltas MUST NOT cross the page bridge, MUST be bounded by the same final-response limits, and MUST be discarded if the round ends in tool calls or the turn is cancelled. A page's own round stream is the only model output that crosses the bridge before a result, and only for a round the page itself sent (section 10). The final validated result remains authoritative. `models.generate` and `models.stream` MAY take up to `limits.timeoutMs` (180 seconds) because desktop subscription agents start a local process per request; all other page requests time out after 30 seconds.

### 5.4 Provider-state continuity

A page that runs its own tool loop over `models.generate` sends back, on each round, the assistant message with the `toolCalls` it was given and the matching `tool` results. Some providers also need opaque state from the earlier rounds of the same turn, which section 5.3 results never carry: Anthropic needs the signed `thinking` and `redacted_thinking` blocks of an assistant message that continues with a tool result, Gemini 3 validates the `thoughtSignature` of every function call since the last user turn and refuses the request without it, and the Responses API, used with `store: false`, can reason on only from the reasoning items it handed back encrypted. The extension keeps that state itself and reattaches it; the page never sees it (section 2, item 16).

**Which providers.** State is kept only for a wire format whose replies carry it: Anthropic Messages (thinking blocks, each with its `signature`, and redacted thinking blocks, all or none), Gemini (`thoughtSignature` per function call), and the Responses API (`reasoning` items with `encrypted_content`, which a request with tools asks for with `include: ["reasoning.encrypted_content"]`, kept with the position of the reply's message and the item id of each call). Chat Completions, Ollama's native API, and the desktop companion carry no required state, and nothing is kept for them.

**Conversations.** A **conversation** is the object every mode keeps one of per thread. The extension's own hosted chat (section 8) has one per panel conversation or site thread, which is the id it gives MCP servers (section 7.7) and the desktop companion (section 12.3.1); a hosted external loop (section 15.1) gets one per thread from the extension; and a page, or a server composing through its page, creates one per thread and stores its id beside that thread. A page's conversation is an object with this interface:

```webidl
interface AIConversations {
  Promise<AIConversation> create();
  Promise<AIConversation> open(DOMString id);
};

interface AIConversation {
  readonly attribute DOMString id;
  Promise<AIGenerateResult> generate(AIGenerateRequest request, optional AIGenerateOptions options = {});
  AIRoundStream stream(AIGenerateRequest request, optional AIGenerateOptions options = {}); // section 5.3
  Promise<boolean> release();
};
```

`session.conversations.create()` resolves to a new conversation the extension minted for the requesting origin. `session.conversations.open(id)` resolves to the conversation with an id this origin was given earlier, for example after a reload or from a server that stored it with its thread, and rejects with `INVALID_REQUEST` for any id the extension did not mint for this origin. Both require `models.generate`. `conversation.generate(request, options)` is `models.generate` (section 5.3) within that conversation, with the same request, options, result, bounds, and errors, and `conversation.stream(request, options)` is `models.stream` within it. The id is opaque to pages. The reference extension mints `base64url(nonce) "." base64url(tag)`, where `nonce` is 16 random bytes and `tag` is the first 16 bytes of HMAC-SHA-256 over the origin, a newline, and the encoded nonce, keyed by a random key made once per install, and it verifies the tag against the sender's origin on every request that carries an id, so it needs no list of the ids it handed out. A page cannot choose an id, and an id minted for one origin is refused for any other. An id whose state expired or was released is still valid; it simply has no state.

**Conversation key.** Every request belongs to one conversation of the requesting origin, which the extension derives from the sender (section 10) and never takes from the page: the conversation it was sent through, or, for a one-off `session.models.generate`, the requesting document. Conversations of different origins never share state.

**Capture.** After a round answered by such a provider whose result ends in tool calls, the extension stores one entry under `[origin, conversation, the tool-call ids exactly as returned to the page, in order]` holding the state the provider translation needs to replay that assistant message as issued, the catalog model id, the provider id, a configuration revision (a digest over the provider id, base URL, and credential that changes when any of them changes; the credential itself is not stored), the state's size, and its last use. A round that the page, a revocation, or a navigation ended (section 10) stores nothing. A single entry larger than 2,000,000 UTF-8 bytes is not kept, since a cut copy cannot be replayed.

**Reattach.** For each assistant message after the last `user` message of a request (the turn in progress) that has `toolCalls`, the extension looks up the entry for exactly that conversation and that ordered list of call ids. When the entry exists and the model and provider configuration answering this request have the same catalog model id and revision, its state is handed to the provider translation for that message, and the provider request carries it exactly as the provider issued it. Otherwise the entry is deleted and the message is sent without state. An assistant message before the last `user` message never gets state. A result reports whether any state was reattached in `providerState` (section 5.3).

**Clearing.** A round that ends without tool calls ends the turn and deletes every entry of its conversation. Storing a round deletes the conversation's entries whose call ids do not belong to an assistant message in the current turn of that request. `conversation.release()` deletes one conversation's entries. Entries keyed by a document are deleted when that document ends (navigation, tab close, registration replacement). `disable()` and revoking the site delete the origin's entries; revoking all sites deletes every entry.

**Expiry and caps.** An entry unused for two days is deleted; a reattach counts as use. At most 5,000,000 UTF-8 bytes are kept per origin and 50,000,000 in total, evicting the least recently used entries past either cap. Expiry and the caps are enforced when the store is accessed and when the extension starts, without reading the stored state of entries it does not return.

**Failure.** Losing state is always allowed: a storage failure (no storage, quota, eviction, a stalled operation) reads as no state, and a round never fails because of it.

**Release.** `conversation.release()` requires `models.generate`, deletes that conversation's entries, and resolves `true`, also when nothing was kept. A page SHOULD call it when the thread behind the conversation ends, and in any case when a conversation ends without a final round. Release and revocation are where a conversation ends, so other per-conversation resources for page requests end there too: the reference extension ends the desktop agent session a conversation's rounds resumed (section 12.3.1) on `release()`, `disable()`, and revocation of the site or of all sites. A document's end releases its one-off conversation, whose rounds never had an agent session.

**Hosted chat.** The extension's own tool loop (section 8) keeps the same state between its rounds in the memory of that turn and stores none of it.

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
- `tools` (optional): up to 32 `{ name, description, inputSchema, outputContent?, userInputs?, requiresApproval?, handler }` values. Names match `^[A-Za-z0-9_-]{1,64}$` and descriptions are at most 500 UTF-16 code units, as are those of declared and discovered MCP tools (section 7.7); a hosted assistant has at most 64 tools in all. `handler(args, invocation)` is async or sync. `invocation` is `{ id, name, controls, requestInput(id), reportProgress(text) }` where `controls` is the current widget control state (section 7.2), `requestInput` follows section 7.3, and `reportProgress` follows section 7.5. `requiresApproval` (boolean, default `false`) follows section 7.8.
- `mcpServers` (optional): up to 8 descriptors `{ id, name, url, headers?, tools? }`. URL MUST be HTTPS, except loopback HTTP for development. URL credentials and fragments are forbidden. `tools` declares the server's tool definitions up front (section 7.7).
- `onControlChange(id, value, values)` (optional, local function): called when the user changes a widget control.
- `onCardAction(action)` (optional, local function): called when the user activates a `local` card action (section 7.4).
- `threads` (optional, local functions): the site stores conversations and supplies the thread list (section 7.6).
- `loop` (optional): a section 14 backend, or an in-page one, that runs the conversation while the extension hosts the panel and supplies the model (section 15.1). Exclusive with `systemPrompt`; `mcpServers` is ignored with it.
- `models` (optional): the site's own models, listed beside the visitor's (section 15.2).

At most one active registration exists per page. A later successful registration replaces it and clears the prior hosted-chat history. The extension MUST fingerprint the validated contract, including widget controls; a new fingerprint requires redisclosure before use. The extension MAY show a launcher when a site registers; `autoShow` opens the chat panel but MUST NOT approve capabilities or send a model request.

Site tool invocations have a random id, tool name, parsed arguments, and abort-neutral metadata. Arguments MUST be JSON objects matching the declared schema; malformed JSON and schema failures MUST produce a tool error without calling the handler. When `outputContent` is absent, results MUST be JSON-serializable and their serialized UTF-8 representation is limited to 65,536 bytes (64 KiB). Exceptions and invalid/oversized results become safe tool error results; they do not expose extension internals. A result in flight after registration replacement or revocation MUST NOT be forwarded to the provider.

When `outputContent` is present, it is a unique subset of `"text" | "image" | "card"` and the handler result MUST be `{ "kind": "content", "content": [...] }`. Content contains 1–8 text/image/card parts, no more than four images, no more than one card, and every returned part type MUST be declared. Card parts follow section 7.4. Text uses the ordinary 12,000-character part limit. Images use the section 5.3 MIME, base64, and 2,000,000-character limits. Every result containing an image MUST also contain text so a non-vision model receives a useful fallback.

Output modes are part of the fingerprinted contract and consent disclosure. The broker appends the textual fallback as the ordinary matching `role: "tool"` message. Only when the selected model advertises `capabilities.vision`, and only after all matching tool results for that round, the broker appends user messages containing the returned images in the provider-neutral section 5.3 shape. This bridge is necessary because function outputs are textual while vision inputs are user-message image parts. Non-vision models receive only the text. Base64 data MUST NOT appear in consent activity cards, logs, errors, or progress events; those surfaces show bounded metadata such as `[image/webp, 84 KB]`. Page API, content bridge, and background broker each validate content results independently. A result in flight after registration replacement or revocation MUST NOT be forwarded to the provider.

### 7.1 Supported JSON Schema subset

Schemas are JSON objects, limited to 32,768 bytes of UTF-8 JSON and 16 levels of nesting below the root schema (a schema reached through `properties`, `items`, `additionalProperties`, or a combinator is one level deeper than its parent). Tool input schemas describe objects: the root's `type`, when present, is `"object"`. The supported assertion keywords are `type`, `properties`, `required`, `additionalProperties` (boolean or schema), `items` (schema), `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `anyOf`, `oneOf`, and `allOf`. Combinator arrays contain 1–32 schemas. String length assertions count Unicode code points.

`type` is one of object, array, string, number, integer, boolean, null, or a non-empty list of distinct such names. The extension MUST normalize a list when it validates the schema, so the contract fingerprint, argument validation, and every provider see only the normalized form: a one-name list becomes that name, and a longer list becomes an `anyOf` of single-type schemas. Each alternative carries the schema's keywords that constrain only its own type (`properties`, `required`, and `additionalProperties` for object; `items`, `minItems`, and `maxItems` for array; `minLength` and `maxLength` for string; `minimum` and `maximum` for number and integer); every other keyword stays beside the `anyOf`. If the schema already has `anyOf`, that is kept and `{ "anyOf": [alternatives] }` is appended to `allOf` instead. The nesting and combinator bounds apply to the normalized schema: a list adds one level (two when it joins `allOf`) and may not take `allOf` past 32 schemas. The root accepts no list of more than one name.

Annotations are accepted and never enforced; defaults are not inserted into arguments. `title`, `description`, `$schema`, and `$comment` take a string, `examples` an array, and `default` any JSON value. `format`, `contentMediaType`, and `contentEncoding` take a string and `readOnly`, `writeOnly`, and `deprecated` a boolean; schema generators emit these six routinely and providers disagree about which they accept, so the extension MUST NOT let one fail a provider request. This extension removes all six from every schema position before any provider wire format, the desktop companion's (section 12.3) included, and keeps every other keyword. An annotation whose value has another JSON type invalidates the schema. All other schema keywords, including `$ref`, `$defs`, regex `pattern`, and OpenAPI's `nullable`, are explicitly unsupported and MUST be rejected with `INVALID_REQUEST` for site/page definitions (or a safe `TOOL_ERROR` for discovered MCP definitions). This extension does not claim full JSON Schema dialect support.

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

An `mcpServers` entry MAY carry `tools`: 1–64 definitions `{ name, description?, inputSchema, userInputs?, requiresApproval? }` following section 7.1. When present, the extension MUST NOT call `tools/list` for that server and MUST use the declared definitions as the server's tool set. The declarations are part of the fingerprinted contract, so they receive the single-stage consent of site tools instead of the two-stage discovery consent of section 8; a change to any declaration requires fresh consent. The extension still calls `tools/call` over the transport of section 8 and validates results identically. The request's `params._meta` carries `{ "arjunah": { "conversationId" } }`, the extension-minted conversation id, so a site backend can correlate calls without any page involvement. A server that answers `tools/call` for an undeclared name, or whose declared schema the extension rejects, produces a safe `TOOL_ERROR`.

This is how a site runs tools on its own backend in wallet mode: the backend holds its secrets, the page holds only a short-lived token in `headers`, and the model never sees either. Because `headers` are set by page JavaScript they are never secret from the page. The same handler definitions serve the standalone turn endpoint of section 14, so a site writes each tool once.

### 7.8 Approvals

A tool whose effect the visitor should confirm before it happens declares `requiresApproval: true`. This applies to site tools and to declared remote tools (section 7.7). Before the extension invokes such a tool it shows the approval prompt below, with the tool's name as `title`, the model's arguments as `detail` (pretty-printed JSON, cut to the 4,000-code-point bound), and the site's origin, and it invokes the tool only when the visitor approves. The prompt's required `summary` is the extension's own sentence naming the assistant and where the tool runs ("`<name>` wants to run this tool on this page", or "... on `<server name>`" for a remote tool, whose server name is also the `target`). A denial, the timeout, cancellation, navigation, or revocation ends that call with a tool error saying the visitor did not approve it, and the model receives that error as the call's result; the arguments are validated against the schema first, so a call that would fail anyway never asks. A site tool that asks first asks also when a hosted external loop requests it with `tool.client` (section 15.1), because the extension invokes it there too. `requiresApproval` is part of the fingerprinted contract, and consent lists the tools that ask first.

A declared remote tool MAY also carry `userInputs` (section 7.3). The extension collects them as for a site tool, in the panel and labelled with the server's origin as the recipient, before the call (after any approval), in declaration order and once each per call, validates each against its scalar schema, and sends them to the server in the `tools/call` request's `params._meta.arjunah.inputs`, an object keyed by input id; they never appear in `arguments`, model messages, history, activity, or logs. A cancelled, timed-out, or invalid input ends the call with a tool error naming the input, never its value, and the server is not called. Only declared remote tools carry either field: tools discovered with `tools/list` cannot, because their metadata is not part of the approved contract. Both fields are recorded in the contract only when set, so contracts that declare neither keep their earlier fingerprints.

When a composer other than the extension runs a tool (modes 2, 3 and 4 of section 15), it asks the interface for approval with `approval.client` and receives the answer on the `approvals` route (sections 14.3 and 14.4). Whether a given call needs approval is that composer's policy, because only it knows what the call does. The prompt is the same in every mode:

- It shows `title` (at most 80 Unicode code points), `summary` (at most 280), an optional `target` (at most 80), and an optional `detail` (at most 4,000, drawn as preformatted text), all as text, together with the origin that asks. The composer writes these from the operation it is about to run; they are not model input.
- Its two actions carry the renderer's own wording, Approve and Deny. Neither is the default, so Enter does not answer the prompt. `danger: true` draws Approve in the danger style.
- It waits at most 120 seconds and then answers as denied.
- The decision MAY be shown on the tool's step in the transcript. The answer carries no other data.

Binding a decision to the exact operation, using it once, and expiring it are the composer's responsibility. The protocol carries the prompt and the answer, not the authority to act on them; a composer MUST NOT treat anything but an `approved: true` answer to its own outstanding request as approval.

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

The renderer is the same code in wallet and standalone mode (section 14) and MUST behave identically for everything it owns: transcript and activity rendering, cards, progress lines, the thread panel, the composer, and attachments. Cards render inline under their tool step in both `toolCallView` modes. Progress lines are ephemeral and never persisted. The thread panel appears only when threads exist (site-owned in wallet mode, backend-owned in standalone mode); its actions are select, new, rename when supported, and delete. Switching threads MUST NOT cancel a running turn: the turn completes in the thread that submitted it, and the panel shows that thread as busy. Deleting a thread cancels its turn. The renderer also owns four surfaces that both modes need and neither should re-implement: the model and thinking-effort picker (section 8.2), the entity picker that produces mention parts (section 8.3), the prompt that collects a declared tool input (section 7.3), and the approval prompt (section 7.8). In each case the renderer owns the control and the host owns the data behind it, so a host supplies a catalog, an entity source or a tool declaration and never markup. Wallet-only chrome (consent, context sharing, usage and quota, launcher) belongs to the extension shell around the renderer and is absent in standalone mode.

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

- `INVALID_REQUEST`: the request breaks a shape rule or a section 5.3 bound.
- `NOT_SUPPORTED`: the operation, or a part of the request (images, tools, a `toolChoice` the wire format cannot express), is not available for this model or page, or the model is not one the site's `require` accepts (section 4).
- `NOT_CONFIGURED`: no usable provider or model.
- `PERMISSION_REQUIRED`: the grant lacks a capability, access changed while the call ran (section 10), or `openSettings()` was called without a user gesture (section 3).
- `USER_DENIED`: the user refused consent.
- `PROVIDER_ERROR`: the provider failed or refused for a reason no other code names.
- `TOOL_ERROR`: a tool or site callback failed.
- `TIMEOUT`: the page stopped waiting (section 10), or a provider or the desktop companion did not answer in time.
- `INTERNAL_ERROR`: anything else.
- `ABORTED`: the page aborted the call through its `signal` (section 5.3). A round stream the page left early ends without one.
- `CONTEXT_TOO_LONG`: the provider reported that the request does not fit the model's context window. It is never estimated in advance.
- `RATE_LIMITED`: the provider, or the subscription behind a desktop agent, is limiting requests or has used up its allowance for now.
- `MODEL_UNAVAILABLE`: the provider reports the model removed, unknown to it, or not loadable.

The list may grow. Pages MUST treat a code they do not recognize as `INTERNAL_ERROR`.

Messages MUST be safe to expose to the page. Provider response bodies, API keys, extension URLs, account identities, and stack traces MUST NOT be included. An extension SHOULD classify provider failures from the provider's status, its short machine-readable error fields (an `error.code` such as `context_length_exceeded`, an Anthropic `error.type`, a Gemini `error.status`), and fixed patterns matched against its message, and MUST then show its own sentence, never the provider's.

`details` is a JSON object on every rejection. It always has:

- `requestId`: the bridge request id of the call (section 10), or `null` when the page sent none. The extension writes the same id into its diagnostic log line for a failure of that request (section 12.3.2), so an incident a site reports can be found there.
- `retryable`: `true` when the same request sent again later may succeed unchanged. It is true for `TIMEOUT` and `RATE_LIMITED`, and for `PROVIDER_ERROR` only when the connection failed or the provider answered with a server error or a rate limit it gave no further detail for; it is false for everything else, `ABORTED` included, because only the page knows why it aborted.

It MAY also have `field` (the request field an `INVALID_REQUEST` refused), `capabilities` (what a `PERMISSION_REQUIRED` grant lacks), and, with `RATE_LIMITED`, `retryAfterMs`: a non-negative integer number of milliseconds to wait, taken from the provider's `Retry-After` or `retry-after-ms` header or its own field (Gemini's `RetryInfo`), and absent when the provider gave none. `details` MUST NOT carry provider response bodies, credentials, URLs, or account data.

## 10. Bridge protocol

The reference implementation uses `window.postMessage` because extension content scripts live in an isolated world. Messages use a fixed channel, direction, page-session nonce, request id, method, and JSON-safe params. The content script MUST accept messages only from the same `window`, exact expected direction/channel, and current random nonce. The background MUST derive the origin and tab id from `chrome.runtime.MessageSender`, never from page-supplied claims.

Requests time out after 30 seconds, except `models.generate` and `models.stream`, which time out after 180 seconds. Site tool invocations and extension-collected input prompts time out after 120 seconds. Navigation destroys pending requests. The bridge is transport, not authority: every privileged background method independently checks the stored origin grant.

These two deadlines belong to different layers and do not contradict each other: 180 seconds is how long the page's own call waits, and a direct `models.generate` is abandoned at that point because nothing is left to receive it. A hosted chat has a visitor watching, so it is bounded by them rather than by a clock, as follows.

A provider request carries a 30-second deadline, but a hosted generation round does not: a reasoning model can spend longer than that before its first token, and longer still with an image in the prompt, so a deadline covering the streamed body cannot tell a model that is thinking from a socket that is dead. A round is bounded by the visitor instead. After 20 seconds without any event the host SHOULD emit `model.stalled`, which says the model is slow and nothing else — the turn keeps running, the activity indicator keeps animating, and the stop control stays available. The notice is advisory and self-clearing: the next event of any type supersedes it.

Hosted-chat progress (model start/end, tool start/end, usage, bounded `output.delta`, reasoning delta, `progress`, `model.stalled`, `card`, and `card.update` events, the same vocabulary as section 14.3) travels from the background to the content script over the extension's own messaging and never through the page bridge. That holds for everything the extension composes (level 0) and for the rounds it answers for a hosted external loop (section 15.1): no activity or stall notice of them reaches the page. A loop round's deltas reach the loop only when its `model.client` asked with `stream: true`, as `model-results` delta posts (section 14.4) that the content script bounded and sends through the page's own `loop.fetch`; the loop composed that round and receives its result anyway. Page-originated `reportProgress` calls and `threads` callback results cross the page bridge as bounded, invocation- or request-bound messages that the content script validates before use; `threads` callbacks are invoked through the bridge like tool handlers and time out after 30 seconds. Provider-specific streams are normalized before this hop; the content script does not parse provider wire formats.

**Round streams.** A page's own round is the one exception. A `models.stream` call is a `models.stream` request with the params of `models.generate`, answered by the same single `response`. Before that response, its events (section 5.3) travel from the background to the content script over the extension's own messaging, each message bound to the page session and the bridge request id, and the content script posts each one to the page as a `stream` message `{ id, event }` on the same channel, extension-to-page direction, and nonce. The content script MUST forward only an event for a stream it forwarded for this document and has not yet answered, only the section 5.3 event types (`output.delta`, `reasoning.delta`, `stalled`), and only text of at most 4,000 UTF-16 code units per event and, per round, at most the result's answer and reasoning bounds; it drops anything else. The background sends every event before the answer and waits until the content script received them, so the page reads them in order and the result last. The page API ignores a `stream` message whose id names no stream it is waiting on, and checks the shapes and bounds again. A page therefore receives deltas only of a request it sent, and nothing of a request the extension composed.

**Cancelling a generate.** When a page aborts the `signal` of a pending `models.generate` or `models.stream` (section 5.3), or leaves a round stream early, the page API posts a `cancel` message carrying that request's id, on the same channel and direction and with the current nonce, and rejects the call's promise with `ABORTED` at once; it does not wait for the extension, and a response that later arrives for that id is ignored. A signal already aborted when `models.generate` is called rejects with `ABORTED` and posts nothing. The content script MUST validate a `cancel` exactly as it validates a request (same `window`, channel, direction, current nonce) and forwards only the id of a `models.generate` or `models.stream` it forwarded for this document and has not yet answered. The background derives origin and tab from the sender as for any request and aborts only the direct generation of that tab, page session, and request id, which cancels the provider's HTTP request; for a desktop provider it closes the companion request, and the companion then ends the agent run (section 12.3). A page can therefore cancel its own requests and nothing else. `cancel` is never answered.

**How a direct `models.generate` ends** when it does not return a result (a `models.stream` ends the same way, and leaving it early is the page aborting it):

- the page aborted it: `ABORTED`;
- the grant was revoked, the page navigated or closed, the user changed the site model (section 4.1), or the user hid the provider of the model the call selected: `PERMISSION_REQUIRED`, also when the provider request was already in flight;
- 180 seconds passed: the page rejects with `TIMEOUT`, and the extension abandons the call at the same deadline and reports `TIMEOUT`; a provider or companion timing out is `TIMEOUT` too;
- the provider failed: the section 9 code its failure classifies as.

A page `cancel` never reaches hosted chat, which keeps its own stop control; section 2, item 8, says what else ends a hosted turn.

**Conversations.** `conversations.create`, `conversations.open` (`{ id }`), and `conversations.release` (`{ id }`) are ordinary requests with the 30-second timeout. A conversation's `generate` is a `models.generate` request, and its `stream` a `models.stream` request, whose params carry the conversation's id in a `conversationId` member that the reference page API sets itself; `session.models.generate` and `session.models.stream` drop any `conversationId` a page put in its request. The background takes the origin from the sender as for every request and accepts an id only after verifying it for that origin (section 5.4), so a page can use and release only its own conversations; an unverified id is refused with `INVALID_REQUEST` before any provider is contacted. When a document ends, the content script's existing end-of-session message is what releases the document's own one-off conversation; no page message is involved.

**Extension-to-page events.** `arjunah:grantchange` (section 3) crosses the bridge as a `grantchange` message on the same channel, extension-to-page direction, and nonce; the page API rebuilds the event's `detail` from its three fields and dispatches it in the page's world. `openSettings()` is an ordinary request (`settings.open`) that the content script refuses without transient user activation before anything reaches the background.

## 11. Data retention and user controls

The reference extension stores provider configuration, the global default model, grants with their per-site settings, and a local usage ledger in `chrome.storage.local`. Chat history, assistant registrations, and widget control state are document-memory only. With site-owned threads (section 7.6) the site stores the conversation and the extension keeps only the loaded thread in document memory; the extension never persists thread contents itself. New documents and tab close discard them; explicit panel reset clears history and cancels outstanding work while retaining the registration. On back/forward-cache restoration a browser may restore that document UI, but all outstanding operations from before pagehide are cancelled. After an extension reload, existing pages should be reloaded to reconnect the content script. It does not add analytics or remote telemetry. Provider and MCP endpoints necessarily receive approved request data under their own policies.

Provider continuation state (section 5.4) is the one piece of conversation-derived data the reference extension persists. It lives in the extension's own IndexedDB (database `arjunah`, object store `providerState`), never in `chrome.storage`, never in sync (section 12.4), and never on a page. Each entry holds the origin, the conversation key (the conversation's id, or the document for one-off completions), the tool-call ids, the catalog model id, the provider id, a digest of the provider configuration (not the credential), the opaque state the provider issued (signed thinking text, thought signatures, encrypted reasoning items), its size, and its last use. It is deleted when the turn ends with a reply that calls no tool, on `conversation.release()`, when the document ends for entries keyed by it, when the user revokes the site or all sites or the site calls `disable()`, after two days without use, and by least-recently-used eviction past 5 MB per origin or 50 MB in total. Hosted chat keeps the same kind of state only in the memory of the running turn. Conversation ids are verified with a random per-install key in `chrome.storage.local` (`installKey`), which is never synchronized and never page-visible; nothing records which ids were issued.

### 11.1 Usage ledger and quota disclosure

The extension keeps a local, per-provider ledger of requests and reported prompt/completion tokens for the current day and in total. The ledger never leaves the browser and is never shown to pages. Providers MAY report a quota `{ used, limit, unit, resetsAt?, label?, windows? }` where `windows` lists every rolling allowance the account has (`{ id, kind: "session" | "weekly" | "monthly" | "other", label, usedPercent, resetsAt? }`) and the top-level fields summarise the session window; when they do the extension shows it next to the provider, and when they do not the extension MUST say the provider does not report quota rather than estimate one. The reference companion reads these from the agents' own control interfaces (Claude Code's stream-json `get_usage` control request, Codex's app-server `account/rateLimits/read`) without spending model tokens.

### 11.2 Options and popup

The options UI MUST let the user independently configure/test/clear each supported API-key or self-hosted provider (currently OpenAI, OpenCode Zen, Ollama Cloud, and a self-hosted Ollama server), remove only the selected provider's saved key, choose the global default model among all available providers, pair or unpair the desktop companion, and revoke individual or all site grants. Saved key reuse MUST be bound to the provider origin in both Save and Test; a different origin receives no retained key unless the user explicitly enters it. Provider changes cancel active page-origin operations. Provider configuration returned to settings includes only key-presence metadata, not the saved key.

The toolbar popup is the wallet view. It MUST show:

- every provider with its availability, account label, plan (when the provider reports it), local usage from the ledger, quota status per section 11.1, and model count; and a selector for the global default model;
- for the current site, when it registered an assistant or holds a grant: the assistant name, the access level, the site model with a selector (listing only qualifying models when the site set `require`, section 4), at level 2 the exposed providers with toggles, the granted context fields, an open/hide control for the hosted chat, and a revoke control;
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
- **OpenCode** (`opencode` on the companion API, `opencode-cli` in the browser catalog): the `opencode` CLI, available when it lists at least one model. `opencode run` has no image input, so every OpenCode model reports `vision: false` even where the upstream model would accept one. The distinct browser id prevents it from colliding with the `opencode-api` Zen provider; the extension translates back to `opencode` only on the private loopback request.

The extension MUST show detected providers in its options UI and popup with their availability and account label, MUST let the user choose the global default model and per-site models among them, and MUST disclose the model that will answer in consent dialogs (`Requests are sent to: …`). A provider that is not available MUST NOT be selectable.

### 12.3 Generation bridge

`POST /api/generate` accepts `{ providerId, model, messages, tools? }` using the same validated message and tool shapes as section 5 (wire fields `tool_calls` and `tool_call_id`) and returns the section 5 result shape with `finishReason` `stop` or `tool_calls`. Subscription-agent CLIs expose no sampling controls, so a section 5 `temperature` or `maxTokens` is dropped rather than sent; the extension MUST warn in the page console when it drops one, and MUST NOT fail the request. The reference companion accepts at most 300 messages, 64 tools, and 500 UTF-16 code units of each tool description, and the extension reports exactly that in the `limits` of its models (section 5.2), so a page is refused with a reason rather than cut short.

Companion errors use the section 9 codes as `{ error: { code, message } }`. An agent failure the companion can classify from the agent's output carries `CONTEXT_TOO_LONG`, `RATE_LIMITED` (status 429, optionally with an integer `retryAfterMs` beside `code`), or `MODEL_UNAVAILABLE` in `code`; for those three the extension shows its own sentence rather than the companion's `message`, which can quote the agent's output. When the extension closes a `POST /api/generate` before the answer was written (a page aborted its call, or the visitor stopped a hosted turn), the companion MUST end the agent run behind that request, terminate its process, and end its thread.

**Images.** A CLI agent takes one prompt, so `content` on this route is always a string: the extension flattens section 5.3 content parts and writes `[image]` where each picture sat. A user message MAY additionally carry `images`, an array of at most four `{ mediaType, data }` objects using the section 5.3 media types and base64 bound. The extension MUST send `images` only to a provider advertising `supportsVision`, and the companion MUST reject them on a message whose role is not `user` and drop them for a provider without vision rather than discarding them silently at the CLI. The companion attaches the images carried by the messages of the prompt it is about to send, most recent first when more than eight arrive, and each adapter delivers them the way its CLI accepts: the reference companion uses a `--input-format stream-json` user message for Claude Code and scratch files passed with `-i` for Codex. A resumed thread (section 12.3 threads) attaches only the images that arrived since the agent last saw the conversation.

The companion MUST run each agent with its built-in file, shell, web, and editing tools disabled (`claude --tools ""`, OpenCode agent permissions set to deny, and for Codex the read-only sandbox with the documented notice), in an empty scratch working directory, with a minimal environment, and with the user's own MCP servers and project instructions excluded. Where the agent cannot drop its shell tool, the companion SHOULD add an operating-system sandbox around the whole agent process that denies access to the user's files (the reference companion uses macOS `sandbox-exec` for Codex) and MUST report `sandboxed: true` on the provider only when that outer sandbox is active.

### 12.3.1 Threads

`POST /api/generate` MAY carry a `threadId` (`^[A-Za-z0-9_-]{1,100}$`, the extension's conversation id) and a `reasoning` effort (section 5.3). For adapters that support resumable sessions the companion keeps one **thread** per `threadId`: the agent's own session handle, a working directory that lives as long as the thread, the hash of the system prompt and tool names, and how much of the conversation the agent has seen. The first turn runs the full transcript and records the handle; later turns resume the agent's session and send only the messages the thread has not seen. The companion MUST start a fresh thread when the provider, model, or system-prompt hash changes or when the conversation no longer extends the one it saw, MUST expire idle threads (the reference companion after 10 minutes), MUST end them on `DELETE /api/threads/<threadId>`, and MUST delete the agent's persisted session data when a thread ends. The result carries `thread: true` when a thread was used. Rounds a page sends through a conversation (section 5.4) resume one thread; a plain `session.models.generate` carries no thread id and always runs fresh. Companion thread ids are not origin-scoped, so a conversation's thread id is not its conversation id: the reference extension derives `base64url(HMAC-SHA-256(installKey, "desktop" "\n" origin "\n" conversationId))`, first 24 bytes (32 characters), with the install key of section 5.4, so a page can neither name nor end another origin's agent session. It ends the thread with `DELETE /api/threads/<threadId>` on `conversation.release()`, on `disable()`, and when the user revokes the site or all sites, and otherwise leaves it to the companion's idle expiry. With site-owned threads (section 7.6) the extension mints one conversation id per site thread and ends the companion thread when the user deletes or leaves that thread.

The companion SHOULD expose the agent's own activity. `POST /api/generate` accepts an optional `progressId` (`^[A-Za-z0-9_-]{1,100}$`); while the run is in flight, `GET /api/progress/<progressId>?after=<n>` returns `{ items, total, done }` where each item is `{ type: "command", phase: "start" | "end", id, command, exitCode?, output? }`, `{ type: "reasoning", text }`, `{ type: "reasoning_delta", text }`, `{ type: "output_delta", text }`, or `{ type: "phase", text }` (at most 200 code points: one plain sentence naming the stage the run is in, such as checking the CLI, launching it, resuming a session, or waiting on the model). Adjacent text deltas MAY be coalesced without changing their order, but only into an item the client has not already collected. Items MAY also be `{ type: "thinking", tokens }` (a running estimate of hidden reasoning tokens). A companion SHOULD emit a phase before any step that can take seconds — detection, launch, and session resume all qualify — so the browser can say what the wait is for rather than showing a bare spinner. The result additionally carries `steps` (the completed commands), `reasoning`, `contextWindow` (when the agent reported the model's window), and `quota` (section 11.1) when the agent reported its rate-limit state. The extension forwards these to the hosted widget as activity and MUST NOT return them to pages. The one exception is a page's own round stream (section 5.3): for a `models.stream` round the extension also sends a `progressId` and passes the `output_delta` and `reasoning_delta` items on as that stream's deltas, under the stream's bounds; commands, phases, `reasoning`, `thinking`, and the result's extra members still never reach a page. Only the tools the browser extension disclosed and the user approved for the current hosted turn MAY be offered, via a per-session MCP endpoint on the companion whose URL contains a random session id and whose requests carry a random session bearer token.

Tool execution stays in the browser. When the agent calls a bridged tool, the companion suspends that call, returns the pending calls to the extension as `toolCalls`, and the extension validates arguments and runs the site or remote tool under sections 7 and 8. The extension then repeats `POST /api/generate` with the assistant `tool_calls` message and matching `tool` results appended; the companion matches the trailing results to the suspended calls of a live session, resumes the agent, and returns its next event. Results for unknown or partial call sets MUST NOT resume a session; the companion then starts a fresh run from the transcript. Sessions MUST be abandoned, with the agent process terminated, when results do not arrive within two minutes, when a run exceeds the request timeout, or when the request waiting on the run is closed.

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
4. request validation, bounded context, and bounded image parts, with every section 5.3 bound accepted at its value and refused one past it, and `limits` equal to what is enforced;
5. direct model generation after consent, at level 1 (single site model, other models rejected) and level 2 (exposed catalog only);
6. hosted chat registration, consent, response rendering, activity display, and site tool routing;
7. grant revocation and per-site model changes cancelling in-flight work, and a page's abort signal ending its own `models.generate` with `ABORTED` and cancelling the provider request (section 10);
8. safe provider and tool errors, with the section 9 codes and `details`;
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
27. hosted external loop: the manifest's `loop`, consent that names the site's server as the author of the conversation and offers no prompt disclosure, the extension answering `model.client` from the visitor's provider, `tool.client` reaching the page's site tools, context sharing absent, and revocation ending the pending completion and nothing else;
28. provider-state continuity (section 5.4), for each stateful wire format the extension implements: a two-round page tool turn whose second provider request carries the state the first round issued, byte-for-byte, under the same call ids; no state for another model, a changed configuration revision, another origin or conversation, or an assistant message before the last user message; clearing on a final round, `conversation.release()`, document end, and revocation; idle expiry, both caps, and least-recently-used eviction; conversations minted per origin, `open` and every use refusing an id minted for another origin or not minted at all, and `models.generate` carrying no conversation of its own; `providerState` values; the consent line of section 4; and no state in any page-visible result;
29. model metadata and `require` (sections 4 and 5.2): `kind`, `local`, and `builtinTools` on every model entry and generate result, `vendor` `null` where the configuration does not settle it, consent offering only qualifying models and rejecting `NOT_CONFIGURED` when none qualifies, a non-qualifying site-model change refused on every surface, and a non-qualifying round refused with `NOT_SUPPORTED` before any provider request;
30. `toolChoice` (section 5.3): each form on the wire of each implemented format, `INVALID_REQUEST` for a name outside the request's tools or a choice without tools, and `NOT_SUPPORTED` before any request where the format has no control;
31. `arjunah:grantchange` and `openSettings()` (section 3): the event on every grant mutation path with only `level`, `model`, and `revoked` and nothing of another origin, and `openSettings()` refused without a user gesture;
32. desktop conversation threads (section 12.3.1): a conversation's second turn resuming the first turn's agent session under a thread id derived from the origin and conversation, a one-off completion carrying none, and the thread ended on `release()` and revocation;
33. round streaming (sections 5.3, 5.4, 10): `models.stream` and `conversation.stream` yielding answer and reasoning deltas in the provider's order and then a `result` equal to what `models.generate` resolves to for the same request; deltas coalesced within 250 milliseconds and 4,000 code units, together within the result's answer and reasoning bounds, and never carrying a tool call; `stalled` after 20 seconds of provider silence and again after each further 20; a provider failure rejecting `next()` with the section 9 error generate gives; aborting the signal and leaving the loop both cancelling the provider request; events bound to the document and request id, dropped for any other, and none for a hosted turn.
34. the site's own models (section 15.2): `models` validation (1–8 entries, id syntax, metadata, `generate` required in mode 1 and refused with a loop), the picker listing them under the site's name and defaulting to the first only when the visitor has no model, a mode 1 round answered by the page's `generate` with its result validated like a provider's (a call to a tool the round did not offer is a `PROVIDER_ERROR`), no usage ledger entry, and consent saying the visitor's AI is not used;
35. approvals and remote inputs (section 7.8): `requiresApproval` on site and declared remote tools invoking only on Approve and answering anything else with a tool error the model receives, consent listing the tools that ask first, and a declared remote tool's `userInputs` reaching the server only in `params._meta.arjunah.inputs`;

Extensions MAY implement additional APIs under another namespace. They MUST NOT change the semantics of the members defined here while claiming v1 conformance.

## 14. Standalone renderer

The renderer of section 8.1 is published as a dependency-free ES module that a site can embed without the extension. In this **standalone mode** the site backend owns inference, tools, and threads; the renderer is a view. There are no access levels, grants, or consent dialogs, because the site is already the trust domain of its own page. Section 14.7 adds **bridged mode**, in which the backend still owns the conversation and the loop but each completion is answered by the visitor's own model through an ordinary level 1 or 2 session the renderer holds as page code; the extension's consent applies to that session and to nothing else. In neither mode does the renderer present itself as the extension or as a wallet, and it MUST NOT expose or replace `window.ai.arjunah`; in bridged mode it uses that object exactly as any page may. Section 15 places these modes beside wallet mode and says which combinations of interface and loop the protocol supports.

### 14.1 Embedding

The site mounts the renderer with `{ mount, backend: { baseUrl, headers?, credentials? }, widget?, tools?, entities?, bridge? }` plus the callbacks below. `bridge` turns on section 14.7 and is described there. `widget` accepts the presentation fields of section 7.2 (`greeting`, `placeholder`, `suggestions`, `theme`, `toolCallView`, `controls`); `autoShow` and consent-related behavior do not apply. `tools` accepts section 7 site tool definitions whose handlers run in the page when the backend requests them (section 14.3, `tool.client`); `userInputs` and `reportProgress` work as in sections 7.3 and 7.5, the prompt being the renderer's own. `baseUrl` MUST be same-origin or HTTPS (a loopback `http:` address is accepted for development); `credentials` selects whether cookies are sent and defaults to same-origin only. Alternatively `backend` is `{ fetch }`: a page function with the signature of the global `fetch` that answers the section 14.4 routes itself. Exactly one of `baseUrl` and `fetch` is given, and `headers` and `credentials` are refused beside `fetch` because nothing would send them. The function is called with the route path relative to section 14.4 (for example `threads/{id}/turns`) and an init of `{ method, headers, body?, signal? }`, where `body` is the JSON string a server would receive and `signal`, present on the turn `POST`, aborts when the turn is stopped. The renderer then never touches the network, and a page can run the loop in its own JavaScript (section 15, mode 5) by returning a `Response` whose body is a `ReadableStream` of section 14.3 events. Every bound of section 14.6 applies to what that function returns exactly as it applies to a server's answer: the renderer reads only `status` and `body`, treats a non-2xx status as a rejection, refuses a value without an integer status and a readable body, rejects a body chunk that is not bytes, applies the 2,000,000-byte stream ceiling and the 1,000,000-byte JSON bound of section 14.4 while reading, and reports a function that throws as a `PROVIDER_ERROR` without its message, except that an `AbortError` is a stop. Stopping the turn also cancels the body, so a page-built stream learns of it. With `bridge.arjunah` behind `fetch`, the renderer's access request declares `composer: "webapp"` (section 15.3) unless the site passes `composer` itself, because only the site knows whether its function runs the loop or forwards to its server; behind `baseUrl` it declares `"server"`.

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
- `input.client { id, toolId, input }`: a tool the backend runs needs a value the model must not supply. `input` is one section 7.3 declaration. The renderer shows its collected-input prompt and posts the value, or the visitor's cancellation, to `inputs` (section 14.4); the backend applies it to that pending call only and never writes it to the transcript;
- `approval.client { id, toolId, approval: { title, summary, target?, detail?, danger? } }`: the backend asks the visitor to approve an operation before it runs it. The renderer shows the approval prompt of section 7.8 and posts the decision to `approvals` (section 14.4);
- `model.client { id, request, conversation?, stream? }` (bridged mode, section 14.7): the backend asks the page for one completion; `request` is a section 5.3 `models.generate` request, `conversation` the id of the section 5.4 conversation the backend stored for this thread, and `stream: true` asks for the round's deltas as well (section 15). The renderer runs it through the bridge, posts the result or error (section 14.4), and the same stream continues. A backend MUST NOT emit it on a turn whose body carried no `bridge`;
- `model.cancel { id }` (bridged mode): the backend no longer wants that completion. The renderer aborts it through its signal and posts nothing more for that id;
- `progress { toolId, text }` (section 7.5);
- `agent.phase { text }`: the stage the turn is in, at most 200 code points, shown as the live turn label and never stored (the same item a companion reports in section 12.3.1);
- `model.stalled { round }` (section 10): the round has gone quiet and the model is still being waited on. It is not an error and does not end the turn; the renderer says so in the live label, keeps the indicator animating and the stop control available, and restores the previous label on the next event of any type;
- `card { toolId, card }` and `card.update { cardId, card }` (section 7.4);
- `error { code, message }` using the section 9 codes, which ends the turn.

The renderer reads the body incrementally with a 2,000,000-byte ceiling, ignores unknown event types, rejects malformed data, and applies every section 7.4 and 7.6 bound to what it renders. Provider wire formats never reach the renderer; the backend normalizes them.

### 14.4 Routes

Relative to `baseUrl`:

- `GET threads` → `ThreadSummary[]`; `POST threads` → `ThreadSummary`; `GET threads/{id}` → `TranscriptEntry[]`; `PATCH threads/{id}` with `{ title }`; `DELETE threads/{id}`.
- `POST threads/{id}/turns` with `{ content, controls?, model?, reasoning?, bridge? }` where `content` follows section 5.3 user message content and MAY contain the mention parts of section 8.3. `model` is an id from the catalog the picker shows and `reasoning` one of its `reasoningLevels`; both are absent when no picker is shown. `bridge` is present only in bridged mode and describes what the page can do for this turn (section 14.7). The response is the event stream.
- `POST threads/{id}/turns/{turnId}/tool-results` with `{ id, result }` where `result` follows section 7 result validation → `204`; the open stream continues.
- `POST threads/{id}/turns/{turnId}/inputs` with `{ id, value }`, validated against the declaration's scalar schema, or `{ id, cancelled: true }` → `204`; the open stream continues. A value is posted at most once per `input.client` id and is never echoed back on the stream.
- `POST threads/{id}/turns/{turnId}/approvals` with `{ id, approved }` where `approved` is a boolean → `204`; the open stream continues. A timeout posts `approved: false`.
- `POST threads/{id}/turns/{turnId}/model-results` with `{ id, result, conversation? }` where `result` is a section 5.3 generation result, or `{ id, error: { code, message }, conversation? }` with a section 9 code → `204`; the open stream continues. `conversation` is the id of the conversation the completion ran in, present whenever one was used, so a backend that sent none learns the id the renderer created and stores it with its thread. With `stream: true` on the `model.client`, zero or more `{ id, delta: { type, text } }` bodies precede that final answer, in order, where `type` is `output.delta` or `reasoning.delta` and `text` is bounded like the section 14.3 events of the same name. Bridged mode only.
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
  generate?(request, { signal }): Promise<Result>, // or answer completions some other way
}
```

`arjunah: true` requests level 1; an `AccessRequest` may ask for level 2 and page context. The renderer calls `enable()` lazily, on the first send after mount, so the consent dialog follows a user gesture rather than a server event, and it keeps the session for the life of the mount. `generate` replaces the extension with a page function that accepts a section 5.3 request and an abort signal and resolves to a section 5.3 result; when both are given, `generate` wins. It is held to the same 180 seconds as a `models.generate` call, after which the renderer answers `TIMEOUT`. A site with neither has no bridge, and the turn body carries no `bridge` field.

**Announcing it.** Every `POST threads/{id}/turns` in bridged mode carries:

```json
"bridge": {
  "model": { "id": "openai/gpt-5.6-sol", "capabilities": { "tools": true, "vision": true, "reasoning": true }, "contextWindow": 272000, "reasoningLevels": ["low", "medium", "high"] },
  "tools": [{ "name": "page_info", "description": "…", "inputSchema": { "type": "object", "additionalProperties": false } }]
}
```

`model` is the section 5.2 entry of the model that will answer this turn, or `null` when the page has no session yet, was refused one, or lost it, so the backend can decide before composing whether to run the turn, fall back to a provider of its own, or fail. `tools` lists the site tools declared to the renderer as `{ name, description?, inputSchema }`, at most 32, without handlers or `userInputs`; they are what the backend may request with `tool.client`. The announcement is per turn because the grant can change between turns.

**Running a completion.** When the loop needs the model, the backend emits `model.client { id, request }`. `request` is a section 5.3 request: `messages` (required), and optionally `model`, `tools`, `reasoning`, `temperature`, and `maxTokens`, all under section 5.3 bounds, with `tools` in the section 7.1 schema subset because the extension validates them as it validates any page's. The renderer passes the request to the bridge unchanged, shows the round as in progress, and posts to `model-results` either `{ id, result }` with the section 5.3 result, or `{ id, error }` with the section 9 code the session rejected with, each with `conversation` when the round ran in one. The backend then continues the loop: it dispatches `toolCalls` to its own tools inline or to the page with `tool.client`, emits `message` or `output.delta` for the text, and ends the turn. The renderer does not display a completion result itself, because only the backend knows whether the round is the answer or the middle of a tool exchange.

At level 1, `request.model` MUST be absent, `"default"`, or the announced id; anything else is rejected by the extension with `INVALID_REQUEST`, and the backend learns that through `error`. At level 2 the renderer's picker (section 8.2) shows the exposed catalog, the choice rides the turn as `model`, and a backend that echoes it into `request.model` gets that model. `messages` is the backend's to compose; the bounds of section 5.3, as the announced model's `limits` reports them, and the mention flattening rule of section 5.3 apply to what it sends. A completion MAY take up to 180 seconds (section 5.3), so the turn's stream MUST stay open for at least that long after `model.client`.

**Failure.** A session that is refused, revoked, or invalidated by a per-site model change rejects the pending `models.generate` with a section 9 code; the renderer posts it as `error` on `model-results` and MUST NOT open a dialog of its own or retry. The backend ends the turn with a section 14.3 `error` event, or with a `message` if it answered another way. Revocation therefore cancels the completion the visitor was paying for and nothing else; the conversation stays on the backend. A `model.client` on a turn whose body carried no `bridge` is a backend defect: the renderer MUST answer it with `{ id, error: { code: "NOT_SUPPORTED" } }` and the backend MUST treat that as final.

**What the visitor is and is not protected by.** The credential stays in the extension, the grant is per exact origin and revocable, and the visitor chooses the model. Those three claims are true and a renderer MAY state them. The backend sees everything the visitor types and composes every prompt, the wallet's system prompt disclosure does not exist because a level 1 site authors its own messages, and nothing prevents the backend from logging the conversation. A renderer MUST NOT describe bridged mode as the wallet, and the section 14.6 wording rule stands. The extension, for its part, sees a level 1 or 2 page like any other: it cannot tell that a server is behind the page and MUST NOT need to.

**Conversations.** The backend owns the mapping from its thread to a section 5.4 conversation; the renderer owns the handle. A `model.client` names the conversation in `conversation` when the backend has one stored for the thread, and the renderer runs the round in `session.conversations.open(conversation)`; without it the renderer calls `session.conversations.create()` and returns the new id as `conversation` on `model-results`, which the backend stores for the thread's later rounds. An id the extension refuses to open starts a new conversation, whose id is returned in its place. The renderer keeps the handles for the life of the mount and releases the conversations a thread used when the visitor deletes that thread. A session without `conversations` answers through `session.models.generate`, and no `conversation` is returned; a `generate` bridge never returns one.

**Deltas.** When the conversation handle offers round streaming (`stream`, section 5.3), the renderer uses it and draws the round's answer and reasoning deltas in the transcript as provisional text, bounded like the section 14.3 events of the same name. The backend's `message` for that round replaces them, and a result that ends in tool calls, a cancellation, or a failure discards them. With `stream: true` the renderer also posts each delta to `model-results` as `{ id, delta: { type, text } }`, in order and before the final answer; it MAY coalesce adjacent deltas of one type while a post is in flight. A backend MUST NOT echo those deltas back as `output.delta` on the turn stream, because the renderer already shows them. Without round streaming the completion arrives whole and the visitor sees the answer when the backend sends it.

**Cancelling.** `model.cancel { id }` aborts that completion through its signal (section 5.3), which ends it with `ABORTED`, and the renderer posts nothing more for that id. The stop control, deleting the thread, and destroying the mount abort every completion the turn or mount still has outstanding in the same way, and nothing is posted for them either: the backend learns of the stop through the `cancel` route.

## 15. Roles and modes

**Status.** All five modes are implemented. In mode 4 the section 14 renderer relays `model.client` through the page (section 14.7), forwards deltas for `stream: true`, honours `model.cancel`, and shows the `input.client` and `approval.client` prompts. The reference extension implements the hosted external loop (section 15.1, modes 2 and 3) over the page's `loop.fetch`, the site's own models (section 15.2) in mode 1 and as announced `kind: "site"` entries with a loop, the `composer` consent wording (section 15.3) for `enable()` and for a loop, and, in mode 1, `requiresApproval` and the `userInputs` of declared remote tools (section 7.8). Mode 5 is implemented as page code calling `models.generate`; the widget's `backend.fetch` (section 14.1) is tracked with that package.

Every conversation has three roles, and one actor plays each:

- **Composer**: owns the conversation and its loop. It writes the system prompt, keeps the transcript, decides which tools a round offers, runs or dispatches tool calls, chooses which model answers each round, and ends the turn. The composer is the extension (`arjunah`), the site backend (`server`), or page code (`webapp`).
- **Interface controller**: decides what the visitor sees and sends. It is the extension, rendering in its closed shadow root (section 8), or the page, rendering with the section 14 renderer or with a UI of its own. Whether the chat appears as a docked panel or an inline widget is presentation; who controls it is the architecture.
- **Answering model**: answers one round, a section 5.3 request and result. It is the visitor's model, reached through the extension under the visitor's grant, or one of the site's own models (section 15.2). It is chosen per round, not per mode, so a composer MAY change it between the rounds of one turn, for example to fall back when the visitor's model fails.

Access levels (section 4) say only how far the visitor's model reaches. At level 0 it answers only conversations the extension composes. At level 1 it answers rounds the site composes, on the one model the visitor picked for the site. At level 2 the site may also choose among the models the visitor exposed. A round answered by one of the site's own models needs no model grant at all.

In every mode the **page can add tools that act on the page itself**, and the page always runs them: as site tools of section 7 when the extension composes, through `tool.client` when a server does, and directly when the page is the composer. Tools on the site's server run there: inline when the server composes, and as declared remote tools (section 7.7) when the extension does.

### Modes

| Mode | Composer | Interface controlled by | Specified in                                                                                     |
| ---- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| 1    | arjunah  | arjunah                 | sections 7 and 8 (level 0)                                                                       |
| 2    | server   | arjunah                 | section 15.1, `loop.composer: "server"`                                                                     |
| 3    | webapp   | arjunah                 | section 15.1, `loop.composer: "webapp"`                                                                     |
| 4    | server   | webapp                  | section 14 with the site's model, section 14.7 with the visitor's, or a page relaying on its own |
| 5    | webapp   | webapp                  | section 14.1 `backend.fetch`, or page code calling `models.generate` directly                    |

The answering model is chosen inside each mode. When the extension controls the interface, the visitor picks it in the renderer's picker (section 8.2), which lists the site's own models beside the visitor's. When the page controls the interface, the site picks it, within what the visitor's grant allows.

The extension composing while the page controls the interface is not a mode, and this is deliberate rather than pending. It would require the extension's live turn events to cross the page bridge, and section 10 forbids that: hosted-chat progress travels over the extension's own messaging so that every delta the visitor sees in extension UI is one the broker bounded and never one the page can read, replay, or alter. A site that wants its own interface composes itself (mode 4 or 5). A level 0 site still receives finished turns through site-owned threads (section 7.6).

### Contracts

Three contracts connect the roles. Each has one shape wherever it travels.

- **Round** (composer and answering model): the section 5.3 request and result, with its `limits`, abort, error codes (section 9), and provider-state continuity (section 5). It travels as `models.generate` from page code to the extension, as `model.client` from a server through the page that relays it (section 14.7), and as the site's `models.generate` function when the extension composes and a site model answers (section 15.2). Because the shape is the same on every hop, a composer can switch the answering model without translating its transcript.
- **Turn** (composer and renderer, when they are different actors): the section 14.3 events and section 14.4 routes. A renderer the extension controls and one the page controls consume the same stream. A page that renders with its own UI instead of the section 14 renderer MAY speak any protocol to its own backend; only its calls to the extension are in scope.
- **Consent** (visitor and extension, whenever the extension plays any role): section 15.3.

Two rules keep rounds and turns aligned:

- **Deltas go to the interface controller.** When the extension answers a round composed elsewhere and controls the interface (modes 2 and 3), it renders that round's deltas in its own UI. When the page controls the interface it reads them from the round stream (section 5.3). The composer receives the final result, which is authoritative; its `message` event replaces the provisional text, and a round that ends in tool calls discards it. A composer that wants the deltas as well sets `stream: true` on `model.client`, and the relaying renderer posts each delta to `model-results` as `{ id, delta: { type, text } }` before the final `{ id, result }`.
- **Cancelling reaches the round.** A composer that cancels a turn while a `model.client` is outstanding emits `model.cancel { id }`. The renderer aborts that completion through its signal (section 5.3), which ends it with `ABORTED`, and posts nothing more for that id.

### 15.1 Hosted external loop

The extension hosts the panel, and a loop outside the extension runs the turn: the site's backend speaking section 14, or the page itself through the in-page backend of section 14.1. The extension acts as the section 14 renderer toward that loop and as the section 14.7 bridge toward the visitor's providers, answering every `model.client` itself. Nothing new is granted. A level 1 page can already compose prompts and call `models.generate`; this shape lends it the extension's panel, model picker, usage display, and consent surface, and the discipline that goes with them.

**Declaring it.** The section 7 manifest gains `loop`, a page function that carries the conversation between the extension's interface and the composer:

```js
loop: {
  composer: "server" | "webapp",             // who composes, for consent (section 15.3)
  fetch(path, init): Promise<Response>,      // answers the section 14.4 routes
  level?: 1 | 2,                             // grant to request; default 1
}
```

The extension never calls a site server itself. The page forwards each route to its own server with its ordinary credentials (`composer: "server"`, mode 2), or runs the loop in page code (`composer: "webapp"`, mode 3); the extension cannot tell which, so `composer` says it. Like a chat renderer pointed at a backend it does not run, the extension's interface only renders the section 14.3 stream the page returns and posts the visitor's actions back through the same function. When the extension also answers a round (`model.client`), it takes the model, usage, context and deltas of that round from its own provider rather than from the stream; when one of the site's models answers, it shows only what the stream reports (section 15.2).

`loop` and `systemPrompt` are mutually exclusive, and `mcpServers` is ignored with `loop`, because the composer runs its own server tools. `loop.composer` is required and `loop.level` is 1 or 2. `tools`, `widget`, and `onControlChange` keep their meaning; site tools are what the composer may request with `tool.client`, and they are announced to it in `bridge.tools` on every turn exactly as in section 14.7. A card's `local` action is posted to the loop's `actions` route (section 14.4), whose `{ card }` answer replaces the card after the section 7.4 validator accepts it; `onCardAction` is not called. `threads` is normally absent, because the composer owns its threads; with a loop it is `true` or `{ rename: true }`, carries no callbacks, and makes the extension drive the section 14.4 thread routes through `loop.fetch`. Without it the extension names the thread itself: one random id per panel conversation in the section 7.6 id syntax, new when the visitor clears the chat, and it calls no other thread route.

**Consent.** The first message requests a **level 1 grant** (or level 2 if the manifest's `loop.level` asks for it) carrying the loop's composer and the contract fingerprint, not the hosted capabilities of section 8, and uses the consent sheet of section 15.3 with the composer the `loop` implies. It MUST NOT show a system prompt, because there is none to show, and it discloses which site tools the loop may call as section 7 does. A changed contract (its `loop.composer` included) asks again. A visitor who picks only the site's own models (section 15.2) needs no level 1 grant; the first message then requests only `chat.hosted` with the contract approval, which is where the visitor's choice of model is stored, and the sheet says that this site's server or page runs the conversation and answers it with its own model. Page context sharing (section 6) is absent in this shape: the extension cannot inject context into a conversation it does not compose, and the page can pass its own context to its own loop.

**Running a turn.** The extension sends the turn through `loop.fetch` as section 14.4 describes, with `bridge.model` set to the model the visitor's grant selects for this site and `bridge.tools` to the manifest's site tools. It consumes the section 14.3 stream and renders it in the panel. On `model.client` it runs the request against the visitor's provider under the same validation a page's `models.generate` receives, including the level 1 rule that `request.model` be absent, `"default"`, or the site model, in the section 5.4 conversation it keeps for that loop thread (the one `conversation` names when the extension verifies it for the origin, otherwise one it creates, whose id it returns), and posts the section 5.3 result or a section 9 error to `model-results` with `conversation`. Only the section 5.3 request fields cross; anything else in `request` is dropped. On `tool.client` it invokes the page's site tool through the bridge as in hosted chat, with `requestInput` and `reportProgress` working as in sections 7.3 and 7.5, and posts the result to `tool-results`. Cards, progress, and mentions render as in any section 14 stream. The model picker shows the visitor's catalog and the site's own models (section 15.2); the choice rides the turn as `model`. For a visitor model the extension answers each `model.client` with it when the grant permits; for a site model `bridge.model` carries the site's entry and the loop answers the turn itself.

**Bounds.** `loop.fetch` is a page callback: it has 30 seconds to start answering a route, the answer crosses the page bridge as bounded text chunks that the content script counts again, and a body is held to 2,000,000 UTF-8 bytes for the event stream and 1,000,000 for every JSON route (sections 14.3, 14.4). A turn's stream may stay quiet while the extension owes the loop an answer (a completion, a site tool, a prompt); with nothing owed, 180 seconds of silence end the turn. Every event is bounded and validated as in section 14.3 before it is drawn, cards by the section 7.4 validator, and only the listed event types are applied.

**What holds.** Credential non-disclosure, exact-origin grants, and the visitor's choice of model hold exactly as at level 1. Revocation or a per-site model change rejects the pending `models.generate`, which the extension posts as `error` on `model-results` and the loop ends the turn; nothing else is cancelled, because the conversation is the loop's. Usage is recorded in the extension's ledger (section 11.1) per completion it answers. The loop sees everything the visitor types and everything the model returns, and consent said so. A `model.client` from a loop that was not declared, or on a turn for which the extension announced no `bridge`, is answered with `NOT_SUPPORTED`.

### 15.2 The site's own models

A site MAY offer models of its own beside the visitor's. In mode 1 the manifest declares them together with a local function that answers their rounds:

```js
models: {
  list: [{ id, displayName?, capabilities?, contextWindow?, reasoningLevels? }], // 1–8 entries
  generate(request, { signal }): Promise<Result>,
}
```

- `id` matches `^[A-Za-z0-9_.:-]{1,100}$` and is unique within the list; it never contains `/`, so it cannot collide with a section 5.1 model id. Every other field is optional and has its section 5.2 meaning: `displayName` (at most 80 characters), `capabilities` (booleans), `contextWindow` (a positive integer), and `reasoningLevels` (unique section 5.3 efforts). The extension adds `kind: "site"` and groups the entries under the site's name in the picker; an entry without `displayName` shows the site's name.
- For each round a site model answers, the extension calls `generate` through the bridge with the section 5.3 request it composed (held to the section 5.3 bounds first, and refused with `NOT_SUPPORTED` when it carries images for a model without `vision`) and an abort signal. The function MAY call the site's own server with the page's ordinary credentials, or run a model in the page. The extension validates what it returns exactly as it validates a provider's answer: the section 5.3 result shape and bounds (a `message` whose `content` is a string or null within the 120,000-unit answer bound, `toolCalls` of `{ id, name, arguments }` with a unique id, a JSON string of arguments, and at most 32 calls, `attachments` as section 5.3 images, `reasoning` within its bound, and optional `id`, `finishReason`, and `usage` of non-negative integers), and tool calls only to tools that round offered. The site supplies no `model`, `kind`, or other metadata in the result; the extension uses the declared entry. Anything else fails the round as a `PROVIDER_ERROR`, and a callback that does not answer in time a `TIMEOUT`. The call is bounded like `models.generate` (section 10).
- Metadata is the site's to give, and the extension shows only what was given: no context meter without `contextWindow`, no effort control without `reasoningLevels`, no usage without `usage` on the result, and no estimate in place of any of them. `kind: "site"` entries carry no `local` or `builtinTools`, because the extension cannot know either. An absent `capabilities.tools` is treated as true, so the round still offers the site's tools; an absent `capabilities.vision` is treated as false, so image attachments are refused rather than sent where they may fail.
- The site's models appear in the picker beside the visitor's. When the visitor has no model configured, the site's first model is the default; otherwise the site model of section 4.1 stays the default. The visitor's choice is stored on the grant like the site model and survives across pages of the origin; a choice made before any grant exists is held for the consent that creates one, and a stored choice the current contract no longer declares is ignored. In mode 1, switching between the visitor's and the site's models later is a switch in the extension's own picker and asks nothing again, as any hosted model switch does; with a loop, moving to a visitor model asks for the level 1 grant the first time.
- A round answered by a site model uses no visitor credential, records nothing in the usage ledger (section 11.1), and is not subject to `require` (section 4), which constrains only the visitor's models.
- With a `loop` (section 15.1) the manifest declares `models.list` without `generate`, because the loop answers its own models. When the visitor picks one, the turn's `bridge.model` is that entry, with `kind: "site"`, and the loop answers the turn itself without emitting `model.client`.
- `models` is part of the fingerprinted contract (section 4). Changing the list requires fresh consent before the next hosted request.

### 15.3 Consent across modes

Every mode in which the extension plays a role uses one consent sheet whose statements are filled in per mode:

- **Written by**: the extension, from this site's instructions, which the sheet shows in full (mode 1); or this site's server; or this site's page. In the last two cases the sheet also says that अर्जुनः cannot show these prompts because it does not see them.
- **Answered by**: the model the visitor chooses, changeable later; or this site's own model, in which case the sheet says the visitor's AI is not used for those replies.
- **Sent to the answering model**: the visitor's messages, the page context the visitor chooses to share (mode 1 only, section 6), and the results of the tools the conversation runs. When the site composes, the sheet says that the site decides what is sent, including the results of tools it runs.
- **Shown in**: while a composer other than the extension drives the extension's interface (modes 2 and 3), that interface carries a persistent line naming the composer, so extension chrome never implies extension authorship.

A page declares how its level 1 or 2 rounds are composed with `composer` in its access request: `"webapp"` (the default) or `"server"`; any other value is rejected with `INVALID_REQUEST`. The value changes only what consent says; it grants nothing, limits nothing, and cannot be verified by the extension. The grant records the composer of the request that granted model access, never returns it to the page, and a level 1 or 2 request naming another composer than the grant holds asks again. A `loop` declares it with `loop.composer`. Mode 1 is always the extension. For `"server"` the sheet states: "This site's server writes the prompts and sends them, including the results of tools it runs, to the model you choose. अर्जुनः cannot show these prompts."
