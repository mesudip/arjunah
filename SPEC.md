# अर्जुनः Protocol

Version: **1.1.0-alpha**

Status: **Implemented draft with a bounded schema subset, tiered site access, extension-collected tool inputs, and an optional desktop companion**
License: MIT

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
- **MCP server**: a remote Streamable HTTP Model Context Protocol endpoint declared by the site and approved by the user.

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
  readonly attribute DOMString version; // "1.1.0"
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

After successful installation of the object, the extension SHOULD dispatch `arjunah:ready` on `window`; its `detail` is `{ "version": "1.1.0" }`. Pages MUST still check `window.ai.arjunah` first so they work when injection precedes their event listener.

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

Capability grants do not silently authorize newly declared external resources. The extension MUST retain private approval metadata for hosted assistant contract fingerprints, MCP origins, and discovered tool-set fingerprints. The full system prompt, site tool definitions, and widget controls MUST be available for inspection in consent. A changed contract, previously undisclosed MCP origin, or changed remote tool metadata MUST trigger fresh consent before the next hosted model request. Both the consent layer and background execution layer MUST enforce these approvals. This metadata is extension-internal and MUST NOT be exposed by `session.permissions.query()`.

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

- `messages` (required): 1–100 objects with role `system`, `user`, `assistant`, or `tool`. `content` is a string of at most 12,000 UTF-16 code units, or, for user messages, an array of 1–8 content parts. A text part is `{ "type": "text", "text": "…" }` with the same length bound. An image part is `{ "type": "image", "mediaType": "image/png" | "image/jpeg" | "image/webp" | "image/gif", "data": "<base64>" }` with at most 2,000,000 base64 characters; at most 4 image parts per message. Image parts require a model whose `capabilities.vision` is true; otherwise the extension rejects the request with `NOT_SUPPORTED` before contacting any provider. A page MAY supply `name`, `toolCallId`, and OpenAI-compatible `toolCalls`. Tool messages MUST include `toolCallId`; only assistant messages may carry `toolCalls`. Each call has a unique non-empty `id`, `type: "function"`, and `function: { name, arguments }`, with arguments encoded as a JSON string. There are at most 32 calls per message.
- `model` (optional): a model id exposed by `models.list`. Absent, or the literal string `"default"`, means the site model. At level 1 any other value MUST be rejected with `INVALID_REQUEST`; at level 2 the value MUST belong to the exposed catalog.
- `temperature` (optional): finite number from 0 through 2.
- `maxTokens` (optional): integer from 1 through 32768.
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
- `tools` (optional): up to 32 `{ name, description, inputSchema, outputContent?, userInputs?, handler }` values. Names match `^[A-Za-z0-9_-]{1,64}$`; `handler(args, invocation)` is async or sync. `invocation` is `{ id, name, controls, requestInput(id) }` where `controls` is the current widget control state (section 7.2) and `requestInput` follows section 7.3.
- `mcpServers` (optional): up to 8 descriptors `{ id, name, url, headers? }`. URL MUST be HTTPS, except loopback HTTP for development. URL credentials and fragments are forbidden.
- `onControlChange(id, value, values)` (optional, local function): called when the user changes a widget control.

At most one active registration exists per page. A later successful registration replaces it and clears the prior hosted-chat history. The extension MUST fingerprint the validated contract, including widget controls; a new fingerprint requires redisclosure before use. The extension MAY show a launcher when a site registers; `autoShow` opens the chat panel but MUST NOT approve capabilities or send a model request.

Site tool invocations have a random id, tool name, parsed arguments, and abort-neutral metadata. Arguments MUST be JSON objects matching the declared schema; malformed JSON and schema failures MUST produce a tool error without calling the handler. When `outputContent` is absent, results MUST be JSON-serializable and their serialized UTF-8 representation is limited to 65,536 bytes (64 KiB). Exceptions and invalid/oversized results become safe tool error results; they do not expose extension internals. A result in flight after registration replacement or revocation MUST NOT be forwarded to the provider.

When `outputContent` is present, it is a unique subset of `"text" | "image"` and the handler result MUST be `{ "kind": "content", "content": [...] }`. Content contains 1–8 text/image parts, no more than four images, and every returned part type MUST be declared. Text uses the ordinary 12,000-character part limit. Images use the section 5.3 MIME, base64, and 2,000,000-character limits. Every result containing an image MUST also contain text so a non-vision model receives a useful fallback.

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

## 8. Hosted chat and tools

`chat.open()` asks the extension to show the hosted chat and resolves after the request is accepted; `chat.close()` hides it. The extension toolbar popup also opens it for the active tab. The first submitted message requests the effective hosted capabilities:

- always `chat.hosted` (the extension generates on the site's behalf; the page itself receives no `models.generate`);
- `context.read` when sharing page context;
- `tools.site` when site tools exist;
- `tools.mcp` when MCP servers exist.

The extension constructs the provider conversation as: extension safety instruction, disclosed site `systemPrompt`, widget option state (section 7.2), optional page context, then chat history. Site instructions, widget labels, and page text are untrusted with respect to provider credentials and extension policy.

The hosted chat runs on the site model (section 4.1). Its extension-owned chrome MUST show the current provider and model and MUST let the user switch to any model of any available provider; the reference UI keeps this selector in the composer. The switch updates the site model. When the model advertises `reasoningLevels`, the composer MUST offer a thinking-effort picker whose value is sent as the turn's `reasoning`; the footer MUST show the context window in use as a meter of the last turn's prompt tokens against `contextWindow`, plus cached and thinking token counts when reported.

Each open hosted chat is one **conversation** with a random id that changes on reset, registration replacement, and navigation. The extension passes the id to desktop providers as the thread id (section 12.3) so an agent can keep one session per browser tab instead of replaying the transcript, and MUST release the thread when the conversation ends. The panel MUST be resizable and movable by its header, MUST show live activity (contacting the model, each tool call with its arguments and result, elapsed time), and MUST preserve user-expandable arguments and results even when the site selects the compact tool presentation. It SHOULD render normalized answer and reasoning deltas as they arrive, MUST render provider reasoning summaries and image attachments when present, MUST let the user attach images when the site model advertises `vision`, MUST show the tokens the last turn used and the session total, the hosted history budget in use, and the provider's quota status when known (section 11.1). A provider that cannot emit deltas still participates and renders its final answer normally. All of this is extension-owned UI in the closed shadow root; the page cannot read it.

The extension popup MUST NOT host a chat of its own. When the active page has registered an assistant, the popup opens that assistant on the page (or offers to hide it); otherwise it states that the page does not implement the protocol. All user-visible chat therefore happens inside the page the user is looking at, under that origin's grant, with the page's disclosed contract.

For tool-capable responses, the extension MAY execute up to six sequential tool rounds per user turn. It MUST invoke only names declared in the active contract or discovered from an approved MCP server. Names normally use `site__name` and `mcp_<server-id>__name`. Names that exceed 64 characters, contain provider-incompatible characters, or collide MUST receive deterministic collision-resistant aliases, with an exact reverse route to the original tool. The aggregate site-plus-MCP tool limit is 64; exceeding it MUST fail before a model request rather than silently dropping tools. Tool outputs are appended using the provider's tool message format. The final user-visible answer MUST be rendered as text, not HTML.

MCP transport is JSON-RPC 2.0 over Streamable HTTP, negotiating version `2025-03-26`. The extension performs `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`. It accepts JSON or `text/event-stream` responses, parses complete multi-line SSE events incrementally, validates response IDs, and honors `Mcp-Session-Id`. Response bodies are limited to 1,000,000 UTF-8 bytes while reading. On a session-bearing 404 the client reinitializes and retries once. Tool pagination is bounded to 64 tools per server and 16 continuation cursors; descriptions are limited to 500 characters. Sessions are scoped to the page session and endpoint/headers. Redirects are rejected and ambient cookies are omitted for provider and MCP requests. OAuth flows, acting on server-sent requests/notifications, resources, prompts, sampling, and stdio transport are outside this version. Unrelated stream messages are ignored while locating the matching response.

For remote tools, consent has two stages: approve the contract and endpoints for discovery, then inspect and approve the discovered tool metadata. The extension stores a short-lived, single-use preparation token bound to the page session, registration, and discovered routes. Completion MUST execute that prepared tool set and MUST NOT substitute newly discovered definitions. Subsequent turns rediscover metadata and request approval if its fingerprint changed. Preparation expires after five minutes or on cancellation/background restart; the user can start a new turn to prepare again.

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

Hosted-chat progress (model start/end, tool start/end, usage, bounded `output.delta`, and reasoning delta events) travels from the background to the content script over the extension's own messaging and never through the page bridge. Provider-specific streams are normalized before this hop; the content script does not parse provider wire formats.

## 11. Data retention and user controls

The reference extension stores provider configuration, the global default model, grants with their per-site settings, and a local usage ledger in `chrome.storage.local`. Chat history, assistant registrations, and widget control state are document-memory only. New documents and tab close discard them; explicit panel reset clears history and cancels outstanding work while retaining the registration. On back/forward-cache restoration a browser may restore that document UI, but all outstanding operations from before pagehide are cancelled. After an extension reload, existing pages should be reloaded to reconnect the content script. It does not add analytics or remote telemetry. Provider and MCP endpoints necessarily receive approved request data under their own policies.

### 11.1 Usage ledger and quota disclosure

The extension keeps a local, per-provider ledger of requests and reported prompt/completion tokens for the current day and in total. The ledger never leaves the browser and is never shown to pages. Providers MAY report a quota `{ used, limit, unit, resetsAt?, label?, windows? }` where `windows` lists every rolling allowance the account has (`{ id, kind: "session" | "weekly" | "monthly" | "other", label, usedPercent, resetsAt? }`) and the top-level fields summarise the session window; when they do the extension shows it next to the provider, and when they do not the extension MUST say the provider does not report quota rather than estimate one. The reference companion reads these from the agents' own control interfaces (Claude Code's stream-json `get_usage` control request, Codex's app-server `account/rateLimits/read`) without spending model tokens.

### 11.2 Options and popup

The options UI MUST let the user configure/test/clear the OpenAI key, remove only its saved key, choose the global default model among all available providers, pair or unpair the desktop companion, and revoke individual or all site grants. Saved key reuse MUST be bound to the provider origin in both Save and Test; a different origin receives no retained key unless the user explicitly enters it. Provider changes cancel active page-origin operations. Provider configuration returned to settings includes only key-presence metadata, not the saved key.

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

`GET /api/providers` returns the subscription agents detected on the computer. Each entry has `id`, `name`, `vendor`, `installed`, `available`, `account` (non-secret label such as a sign-in method), `connection` (`{ account, method, plan, source }`), `reason` when unavailable, an optional `notice`, structured `guidance`, `supportsTools`, `supportsVision` (default false), `supportsReasoning`, `supportsThreads`, `sandboxed`, an optional `quota` per section 11.1, `models`, and `defaultModel`. Each model MAY carry `contextWindow`, `reasoningLevels`, `defaultReasoning`, and per-model `capabilities` that override the provider flags; the reference companion reads them from the Codex model catalog, from `opencode models --verbose`, and, for Claude Code, from the window and rate limit each run reports. The reference companion detects:

- **Claude Code** (`claude-code`): the `claude` CLI, available when `claude auth status` reports a sign-in.
- **Codex** (`codex`): the `codex` CLI, available when `codex login status` reports a sign-in. Codex keeps a read-only shell sandbox that this companion cannot disable, so it is disabled until the user enables it on the dashboard; the extension shows the reason.
- **OpenCode** (`opencode`): the `opencode` CLI, available when it lists at least one model.

The extension MUST show detected providers in its options UI and popup with their availability and account label, MUST let the user choose the global default model and per-site models among them, and MUST disclose the model that will answer in consent dialogs (`Requests are sent to: …`). A provider that is not available MUST NOT be selectable.

### 12.3 Generation bridge

`POST /api/generate` accepts `{ providerId, model, messages, tools?, temperature?, maxTokens? }` using the same validated message and tool shapes as section 5 (wire fields `tool_calls` and `tool_call_id`; text content only unless the provider advertises `supportsVision`) and returns the section 5 result shape with `finishReason` `stop` or `tool_calls`. Companion errors use the section 9 codes.

The companion MUST run each agent with its built-in file, shell, web, and editing tools disabled (`claude --tools ""`, OpenCode agent permissions set to deny, and for Codex the read-only sandbox with the documented notice), in an empty scratch working directory, with a minimal environment, and with the user's own MCP servers and project instructions excluded. Where the agent cannot drop its shell tool, the companion SHOULD add an operating-system sandbox around the whole agent process that denies access to the user's files (the reference companion uses macOS `sandbox-exec` for Codex) and MUST report `sandboxed: true` on the provider only when that outer sandbox is active.

### 12.3.1 Threads

`POST /api/generate` MAY carry a `threadId` (`^[A-Za-z0-9_-]{1,100}$`, the extension's conversation id) and a `reasoning` effort (section 5.3). For adapters that support resumable sessions the companion keeps one **thread** per `threadId`: the agent's own session handle, a working directory that lives as long as the thread, the hash of the system prompt and tool names, and how much of the conversation the agent has seen. The first turn runs the full transcript and records the handle; later turns resume the agent's session and send only the messages the thread has not seen. The companion MUST start a fresh thread when the provider, model, or system-prompt hash changes or when the conversation no longer extends the one it saw, MUST expire idle threads (the reference companion after 30 minutes), MUST end them on `DELETE /api/threads/<threadId>`, and MUST delete the agent's persisted session data when a thread ends. The result carries `thread: true` when a thread was used. Page-level `models.generate` calls carry no thread id and always run fresh.

The companion SHOULD expose the agent's own activity. `POST /api/generate` accepts an optional `progressId` (`^[A-Za-z0-9_-]{1,100}$`); while the run is in flight, `GET /api/progress/<progressId>?after=<n>` returns `{ items, total, done }` where each item is `{ type: "command", phase: "start" | "end", id, command, exitCode?, output? }`, `{ type: "reasoning", text }`, `{ type: "reasoning_delta", text }`, or `{ type: "output_delta", text }`. Adjacent text deltas MAY be coalesced without changing their order. Items MAY also be `{ type: "thinking", tokens }` (a running estimate of hidden reasoning tokens). The result additionally carries `steps` (the completed commands), `reasoning`, `contextWindow` (when the agent reported the model's window), and `quota` (section 11.1) when the agent reported its rate-limit state. The extension forwards these to the hosted widget as activity and MUST NOT return them to pages. Only the tools the browser extension disclosed and the user approved for the current hosted turn MAY be offered, via a per-session MCP endpoint on the companion whose URL contains a random session id and whose requests carry a random session bearer token.

Tool execution stays in the browser. When the agent calls a bridged tool, the companion suspends that call, returns the pending calls to the extension as `toolCalls`, and the extension validates arguments and runs the site or remote tool under sections 7 and 8. The extension then repeats `POST /api/generate` with the assistant `tool_calls` message and matching `tool` results appended; the companion matches the trailing results to the suspended calls of a live session, resumes the agent, and returns its next event. Results for unknown or partial call sets MUST NOT resume a session; the companion then starts a fresh run from the transcript. Sessions MUST be abandoned, with the agent process terminated, when results do not arrive within two minutes or when a run exceeds the request timeout.

Section 8 tool disclosure, approval, and revocation semantics are unchanged: the companion sees only tool names, descriptions, and schemas already approved by the user, and revocation in the extension prevents the next `POST /api/generate`.

### 12.4 Configuration sync

`GET /api/sync` and `PUT /api/sync` exchange one configuration document `{ openai: { model, apiKey } | null, active }` with a monotonically increasing `revision` maintained by the companion. `active` is the global default: `{ type: "openai" }` or `{ type: "desktop", providerId, model }`. The extension pushes after each provider save, clear, or default change and pulls when the companion reports a newer revision or when it pairs. A newly paired extension without any configuration adopts the companion's document. The companion stores the document in a user-only file (mode 0600) and shows it, with secrets masked, on the dashboard where the user can edit it; edits sync to every paired browser. Sync never includes site grants, per-site models, chat history, page context, or the usage ledger.

### 12.5 Live state invalidation

The companion exposes an authenticated WebSocket at `/api/events`. Browser extensions authenticate with their pairing bearer in the `arjunah.v1.client.<token>` subprotocol; the dashboard uses its ephemeral dashboard token in `arjunah.v1.dashboard.<token>`. Tokens MUST NOT appear in the URL, event payloads, or logs. The same loopback `Host` and `Origin` restrictions as section 12.1 apply.

The first frame is `{ type: "hello", revision, protocol }`. Each relevant change emits `{ type: "state.changed", revision, topic }`, where `revision` increases for the lifetime of the companion process. Events are invalidations, not state: they contain no account, provider, configuration, grant, prompt, or credential data. A receiver MUST re-read the authoritative JSON API after an event and after every reconnect. This reconnect snapshot rule makes missed frames harmless. The extension relays invalidations to its popup, options page, and content scripts over extension runtime ports; the hosted widget then re-reads `hosted.settings`. Extension storage changes use the same local invalidation path.

The reference companion monitors provider discovery centrally and emits when availability, sign-in, models, quota, or enabled state changes. Clients MUST NOT independently poll the full provider probes. The dashboard state endpoint MAY return a cached provider view with `providersRefreshing: true`; its pairing code and other local state MUST render without waiting for slow CLI discovery.

## 13. Conformance

A conforming v1.1 extension MUST pass tests for:

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
14. desktop companion pairing, provider selection, configuration sync, and bridged tool rounds through a desktop provider (section 12), when the desktop companion is implemented.
15. extension-collected tool input declaration, disclosure, scalar validation, invocation binding, cancellation, and absence from model traffic and chat history.

Extensions MAY implement additional APIs under another namespace. They MUST NOT change the semantics of the members defined here while claiming v1.1 conformance.
