# ChatKit and machine-manager review

Date: 2026-09-17 (updated 2026-09-20 for the renderer-owned composer surfaces)

## Decision

अर्जुनः will not load the official ChatKit renderer directly. It will keep a extension-owned, provider-neutral UI and adopt useful interaction patterns at the protocol level.

This is not a rejection of ChatKit's product design. It is a dependency and trust-boundary decision: the published [`openai/chatkit-js`](https://github.com/openai/chatkit-js) repository contains the TypeScript types, React wrapper, and documentation, while the actual `<openai-chatkit>` renderer is loaded from `https://cdn.platform.openai.com/deployments/chatkit/chatkit.js`. The wrapper also requires a `domainKey`. The renderer source needed to build, vendor, audit, and maintain that UI is not present in the repository or the `@openai/chatkit` package.

For अर्जुनः, direct use would therefore add:

- a runtime dependency on an OpenAI-controlled CDN;
- domain verification/key configuration across every site where the extension runs;
- an unavailable renderer if the CDN, product, or account policy changes;
- a remote-code dependency inside a security-sensitive extension UI; and
- a mismatch with extension CSP and अर्जुनः's requirement that consent remains locally owned and auditable.

[ChatKit's custom-server mode](https://developers.openai.com/api/docs/guides/custom-chatkit) can point the UI at a custom backend, but that does not remove the renderer and domain-key dependency. Supporting non-OpenAI model providers behind that backend is not the same as having a provider-neutral UI runtime.

No ChatKit runtime, SDK, stylesheet, or copied source is added to अर्जुनः by this change.

### Local renderer verification

The renderer was also exercised locally rather than judged only from repository contents. At `openai/chatkit-js` commit `22613848a656077a408788f028c7727e38d10449`, a disposable loopback page loaded the published CDN script and configured the web component with a custom API URL plus `domainKey: "local-dev"`. A disposable local server built with `openai/chatkit-python` then streamed synthetic progress, workflow-task, completion, and assistant-text events; no model or OpenAI API key was used.

The repository source we found is useful but not the complete visual client: it contains the React wrapper, public types, examples, documentation, and package metadata. The tested web component still fetched its renderer document and runtime from `cdn.platform.openai.com`; no corresponding renderer implementation was present in the inspected repository tree. अर्जुनः can therefore learn from the published contracts and behavior, but copying or self-hosting that missing renderer is not an available integration path from this source alone.

Observed behavior:

- loopback development skips production domain verification;
- the local page still loads the implementation from an iframe at `cdn.platform.openai.com`;
- the open repository's web component creates and configures that iframe but does not contain its renderer implementation;
- streamed workflow events produce the polished thinking, task timeline, spinner/check, collapse, and answer-reveal interactions; and
- the inspected renderer ran several 150–600 ms entrance/state transitions, looping 800–1200 ms progress motion, and a longer subtle answer animation.

The repository's top-level `LICENSE` and README identify Apache 2.0, while the two package manifests currently say MIT. That metadata discrepancy does not change the dependency conclusion: neither licensed source set contains the iframe renderer that produced the observed UI.

## What machine-manager gets right

The reviewed `mesudip/machine-manager` implementation has a strong two-channel pattern:

1. The model supplies the ordinary operation parameters.
2. When a missing sensitive value or a high-impact operation needs user involvement, the server emits a client-side tool request.
3. The frontend opens a dedicated prompt instead of asking for the value in conversation.
4. The frontend applies the value to the exact pending operation and returns only a safe result to the model.

The relevant implementation is split across:

- `src/host_manager/chatkit/server.py`, which defines `request_secure_parameter`, `request_root_command_authorization`, and `request_modify_command_approval`, validates their exact operation payloads, and instructs the model not to request secrets in conversation; and
- `frontend/src/app/components/FloatingChatKit.tsx`, whose `onClientTool` handler serializes the secure prompts and resolves the waiting client-tool call.

Its mutation approvals add several worthwhile safeguards in `src/host_manager/chatkit/approvals.py`: random approval identifiers, principal and credential-revision binding, a two-minute expiry, and transactional single use.

The design is already partly provider-generic on the server: machine-manager normalizes ChatKit history and routes to configured OpenAI-compatible, Gemini-compatible, Ollama, or other model paths. The remaining lock-in is the visible renderer (`useChatKit`, CDN script, and `domainKey`), not the underlying tool idea.

## Generalized अर्जुनः design

अर्जुनः v0.4 calls the generalized mechanism **extension-collected tool inputs**. It is deliberately not modeled as a special OpenAI/ChatKit client tool.

A registered site tool can declare `userInputs` separately from its model-facing `inputSchema`. During that tool's active handler, it calls `invocation.requestInput(id)`. अर्जुनः renders the prompt in its closed, extension-owned shadow root, validates a bounded scalar value, and resolves it only to that handler.

The separation establishes these invariants:

- the model cannot synthesize or override the value because its tool schema does not contain that field;
- the value is bound to the active registration, tool, and invocation;
- it is not automatically merged into tool arguments, a model message, or chat history;
- the declaration is contract-fingerprinted and redisclosed when changed;
- navigation, reset, revocation, unregister, replacement, cancellation, and timeout invalidate the request; and
- the API and UI work identically regardless of which provider produced the tool call.

The extension cannot enforce information-flow policy inside page JavaScript. Once delivered, a malicious handler could transmit the value or put it in the model-visible result. The UI therefore states that the site receives the value. Sites should execute the exact disclosed operation and return only a non-sensitive outcome.

See [SPEC.md](../SPEC.md#73-extension-collected-tool-inputs) for the normative contract and [SECURITY.md](../SECURITY.md) for the trust boundary.

## What अर्जुनः built instead

The four ChatKit capabilities this project actually needed are now in the
protocol and the implementation, each shaped to keep the wallet boundary:

- **In-transcript widgets → transcript cards (SPEC 7.4).** A bounded JSON tree
  (text, list, button, form) that a site tool returns beside its text. The
  extension draws it; the model receives only the text. A button either sends
  its exact declared text as a visible user turn, or fires a local callback that
  never becomes a model message. No HTML, Markdown, links, or images, so a card
  cannot smuggle markup into extension UI. The word _card_ is deliberate:
  `widget` already means the panel options of SPEC 7.2.
- **Threads and history → site-owned threads (SPEC 7.6).** Rather than growing a
  store inside the extension, the site keeps its conversations and supplies them
  through manifest callbacks. This answers the ownership question the plan left
  open: the extension is the renderer and the policy boundary, not the archive.
  Consent says the site stores the conversation, and supplied messages reach the
  model between explicit untrusted markers.
- **Progress → `invocation.reportProgress` (SPEC 7.5).** One ephemeral line under
  the running tool's step, capped and never stored or sent to a model. Desktop
  agent activity already reached the same feed.
- **Server tools → declared remote tools (SPEC 7.7).** Instead of a second
  transport, an `mcpServers` entry may declare its tool definitions up front. The
  extension then skips discovery, folds the definitions into the fingerprinted
  contract, and grants them the single-stage consent site tools get. The site's
  backend holds the secret, the page holds only a short-lived token in `headers`,
  and `tools/call` carries the conversation id in `params._meta`. One backend
  definition serves both deployments, which a bespoke POST shape could not.

## The renderer, without the extension

ChatKit's real pull was never its protocol; it was that a site can drop in a
finished chat surface. अर्जुनः now ships that as
[`arjunah-widget`](../packages/widget/README.md): the extension's own renderer,
published as an ES module and mounted against the site's backend (SPEC section
14). The package is built from `src/renderer/core.js` with an ESM footer, and a
static check fails the build if the published file drifts from the one the
extension loads, so there is one renderer rather than two that resemble each
other.

Standalone mode provides none of the wallet guarantees, and the package says so
in its README: the site's backend owns inference, tools and conversations, and it
sees everything the visitor types. The widget never presents itself as the
extension and never touches `window.ai.arjunah`. What the two modes share is the
conversation surface — transcript, activity feed, cards, progress, thread panel,
composer — driven by the same normalized event vocabulary.

This is the opposite trade from loading `chatkit.js`: no vendor CDN, no domain
key, no remote code inside a security-sensitive extension UI, and a renderer a
site can read before shipping it.

## Future ChatKit compatibility

अर्जुनः can revisit a renderer adapter if the complete renderer becomes available under an OSI-approved license, can be bundled locally, needs no vendor domain key or account, and can preserve अर्जुनः's closed consent boundary. The adapter would consume अर्जुनः's provider-neutral conversation and tool events; it would not own provider sessions, credentials, grants, or tool authorization.

Until those conditions hold, matching useful ChatKit interaction patterns in the अर्जुनः-owned UI is safer than using ChatKit directly.

A ChatKit **server** adapter is a smaller and more plausible step: a translator
from the ChatKit server event stream to the section 14 vocabulary would let a site
already running a custom ChatKit backend swap in this renderer without touching
that backend. It is not implemented, and it would not change any boundary above.

## Closing the gap for a real ChatKit frontend

Reviewing `machine-manager`'s own `useChatKit` call showed which ChatKit
features a site cannot simply do without, and four of them were chrome each host
had to build for itself. They are now the renderer's, so both modes get them and
a standalone site configures data rather than controls:

- **The model picker (SPEC 8.2).** The provider-grouped menu and the
  thinking-effort control lived in `content.js`, filling a renderer slot, so the
  widget shipped without them. They moved into `core.js`: a host supplies
  section 5.2 model entries and receives the choice, and the wallet may refuse a
  switch without leaving the composer claiming a model that is not answering.
  `widget.models` is how a standalone site gets the same control, and the choice
  rides with each turn as `model` and `reasoning`.
- **Entity mentions (SPEC 8.3).** ChatKit's `entities.onTagSearch` has an
  equivalent, and the composer became contenteditable so a mention can be one
  atomic chip rather than text a visitor can edit into nonsense. A chip submits
  as a `mention` content part, which is the point: `machine-manager` tags a host
  so the **server** can describe it from the database, and flattening to
  `@web-01` would have thrown the id away. Section 5.3 keeps the id away from
  the provider, which only ever sees the label.
- **Collected tool inputs in standalone mode (SPEC 7.3).** The mechanism was
  already native, but its prompt lived in the extension's content script, so the
  widget inherited a promise section 14.1 could not keep. The prompt is now the
  renderer's and `invocation.requestInput(id)` works in both modes. A backend
  that adopts it stops inventing a client tool whose only purpose is to make the
  frontend open a dialog.
- **Host callbacks (SPEC 14.1).** Turn, thread, model, control and error
  reports, plus `openThread`, `setControls` and `setModels` on the mounted
  object, so a usage panel, a remembered thread and an unauthorized handler have
  somewhere to attach.

What a ChatKit backend would still have to do is speak section 14: eight routes
and the event vocabulary of 14.3 in place of the ChatKit server stream. The
translator above is the smaller half of that, and it remains unwritten.
