# ChatKit and machine-manager review

Date: 2026-09-17

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

## Future ChatKit compatibility

अर्जुनः can revisit a renderer adapter if the complete renderer becomes available under an OSI-approved license, can be bundled locally, needs no vendor domain key or account, and can preserve अर्जुनः's closed consent boundary. The adapter would consume अर्जुनः's provider-neutral conversation and tool events; it would not own provider sessions, credentials, grants, or tool authorization.

Until those conditions hold, matching useful ChatKit interaction patterns in the अर्जुनः-owned UI is safer than using ChatKit directly.
