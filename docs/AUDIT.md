# Project audit — 2026-09-11

**Historical snapshot:** these findings were subsequently addressed. See [REMEDIATION.md](REMEDIATION.md) for the fix/evidence mapping and [CONFORMANCE.md](CONFORMANCE.md) for current validation scope. Source line numbers below refer to the pre-fix files.

The current implementation has reproducible authorization, credential-routing, and protocol correctness defects despite passing its existing checks. Address the P1 findings before distributing it for use with real credentials or sensitive site tools.

Scope: all source JavaScript, browser manifests, packaging/check scripts, declarations, tests, README, SPEC, SECURITY, and conformance record in the working directory. The project files were untracked at audit start, so this is a working-tree audit, not a comparison against a committed release. Application source was not changed. Browser tests rebuilt distribution artifacts.

## Validation performed

- `npm run check`: passed; nine unit tests and the static checks.
- `npm run test:e2e`: Chrome and Firefox passed, with six mock provider requests each.
- `npm run lint:firefox`: zero errors, notices, or warnings.
- `npm audit` and `npm audit --omit=dev`: zero reported vulnerabilities. This is dependency advisory coverage, not proof of application security.
- Additional isolated Chrome reproduction: navigation into an ungranted origin during a tool round; provider-origin changes with a saved dummy key.
- Additional Node harnesses invoked the actual background listener and library functions with mocked browser storage/network APIs. They reproduced message-field loss, context-size failures, model override, revocation failures, a storage race, tool-name rejection, malformed schema acceptance, and MCP parsing defects.

All runtime probes used dummy credentials and local or mocked endpoints. No real provider or MCP account was used. The navigation reproduction was run in Chrome; Firefox passed the existing suite but did not receive that additional reproduction. Shared source makes Firefox worth regression-testing explicitly when fixing it.

## Findings

### F01 — P1: Tool invocations cross document and origin boundaries after navigation

Locations: [background.js:67](../src/background.js), [background.js:232](../src/background.js), [background.js:244](../src/background.js), [content.js:146](../src/content.js).

The hosted request retains only the tab ID for site-tool routing. After an awaited model response, `chrome.tabs.sendMessage(tabId, ...)` addresses the tab's current content script. Neither the message nor its receiving handler checks the originating document, registration, or grant.

**Browser reproduction:** start a granted hosted turn on `localhost`, hold the model response, navigate that same tab to `127.0.0.1`, and register a same-named tool there. `permissions.query()` on the new origin returned `null`. Releasing the old response invoked the new origin's tool once and sent its returned `NEW_ORIGIN_PRIVATE_TOOL_DATA` to the provider as a tool message.

**Fix:** bind each turn and invocation to the initiating document/session and registration; target the exact document where supported and verify a registration/session token in the content script. Cancel outstanding work on navigation or registration replacement. Recheck authorization before tool execution. This violates SPEC sections 2, 10, and 11.

### F02 — P1: Changing the provider destination reuses the previous provider's key

Location: [options.js:6](../src/options.js), with transmission in [provider.js:35](../src/lib/provider.js).

`values()` falls back to `existing.apiKey` whenever the key input is empty, even when the base URL has changed. Both Test and Save use that result. A user switching to another provider or a keyless local service can therefore send the previous provider's credential to the new destination.

**Browser reproduction:** save a dummy key, reload settings, change only the URL to a different origin, and save. `provider.get` returned the new origin together with the old dummy key. The fetch adapter subsequently uses that configured key as Authorization.

**Fix:** associate retained keys with the provider origin. Clear the retained key on origin changes and make any transfer of a key to another origin an explicit user action. Provide a way to remove a key without clearing every provider field.

### F03 — P1: Revoking access does not stop subsequent operations in a hosted turn

Locations: [background.js:65](../src/background.js), [background.js:220](../src/background.js).

Authorization is checked once before the complete hosted loop. Subsequent MCP discovery, site/MCP calls, and model rounds do not consult the grant again.

**Harness reproduction:** remove the grant while the first model request is outstanding, then return a site-tool call. The tool still executed, a second provider request was sent, and the turn resolved successfully while `grant.query` returned `null`.

**Fix:** reauthorize before each privileged operation and use cancellation or a grant generation number to invalidate outstanding turns. SPEC section 2 requires revocation before the next privileged operation, not merely before the next user message.

### F04 — P1: Concurrent grant updates can restore revoked access

Locations: [background.js:111](../src/background.js), [background.js:156](../src/background.js), [background.js:29](../src/background.js).

Approvals and revocations independently read, modify, and replace the complete `grants` object. The content-script consent queue is local to one page and does not serialize these background writes across tabs or against clear-all.

**Harness reproduction:** pause an approval for origin B after it reads the grants containing A; revoke A and verify that its grant is absent; resume B's stale write. A's `models.generate` grant reappeared. Two overlapping approvals can similarly lose one another's changes.

**Fix:** serialize all grant mutations in the extension, including clear-all, or use a transactional store. Per-origin storage keys can reduce cross-origin conflicts but still require coordination for same-origin mutations and global revocation.

### F05 — P1: Consent does not disclose the tools or complete contract being approved

Locations: [content.js:122](../src/content.js), [background.js:208](../src/background.js).

The dialog shows generic capability labels, only the first 500 characters of a possible 12,000-character system prompt, and MCP hostnames. It never displays site-tool definitions or discovered MCP tool metadata. MCP discovery happens after approval and the first model turn may immediately invoke those undisclosed tools. Two prompts sharing their first 500 characters produce indistinguishable prompt disclosure even when their remaining instructions differ.

The dialog also shows only the current request, not the union with the existing grant. For example, adding `context.read` to an origin with generation access does not show generation in the resulting effective permission set.

**Fix:** present inspectable full contract details, tool names/descriptions and relevant schemas, and requested versus effective permissions. Introduce a discovery/approval stage for remote tool metadata before invocation. Bind the displayed contract to the approved fingerprint and enforce resource approvals in the background as well. README's disclosure claim and SPEC sections 2, 4, and 7 currently exceed this implementation.

### F06 — P2: A page can select models outside the extension-visible list

Locations: [background.js:40](../src/background.js), [validation.js:88](../src/lib/validation.js), [provider.js:26](../src/lib/provider.js).

`models.list()` exposes only the user's configured model, but generation accepts any bounded model string and forwards it under the user's credential.

**Harness reproduction:** with `allowed-model` configured, a page request specifying `unlisted-expensive-model` put that exact ID on the provider wire.

**Fix:** enforce the extension's permitted model set before sending a request. This contradicts SPEC section 5 and can bypass the user's model/cost selection if their key permits other models.

### F07 — P2: Direct generation drops tool-call metadata through double normalization

Locations: [background.js:48](../src/background.js), [provider.js:24](../src/lib/provider.js), [validation.js:64](../src/lib/validation.js).

The background validates a direct request, converting `toolCalls` and `toolCallId` to provider snake_case fields. `generate()` validates that already-normalized request again; the validator only reads camelCase inputs, so the second pass discards both fields.

**Harness reproduction:** an assistant message with a function call followed by a tool message with `toolCallId: "c"` reached fetch as `[{"role":"assistant","content":""},{"role":"tool","content":"ok"}]`. A provider validating tool conversations will reject it.

**Fix:** validate once and separate public request validation from wire conversion, or use an explicit canonical representation that survives validation. Add a page-API test that asserts the actual outgoing tool fields.

### F08 — P2: Advertised context and tool-result sizes exceed the conversation validator

Locations: [background.js:178](../src/background.js), [background.js:198](../src/background.js), [background.js:236](../src/background.js), [validation.js:62](../src/lib/validation.js).

The snapshot allows 20,000 text code units, and hosted tool results allow approximately 64 KiB, but every message passed to the provider is constrained to 12,000 characters. The context wrapper and JSON escaping add further length.

**Harness reproduction:** a 20,000-character text snapshot caused both popup and hosted chat to reject with `INVALID_REQUEST: messages[1].content ... no longer than 12000 characters`, before a provider request. A tool result above 12,000 characters encounters the same limit on the next round.

**Fix:** define separate budgets for page-supplied messages and extension-generated context/tool messages, budget after serialization, and align SPEC and runtime limits. Exercise the documented maximums, not just a short fixture paragraph.

### F09 — P2: Valid tool contracts become invalid or lose tools after namespacing

Locations: [background.js:203](../src/background.js), [background.js:212](../src/background.js), [validation.js:70](../src/lib/validation.js).

A valid 59–64-character site-tool name becomes longer than the provider validator's 64-character maximum after adding `site__`. MCP names are instead truncated and sanitized; distinct names can collide and the later route is silently skipped. The aggregate tool list can also exceed the 64-tool generation limit even though each server and the site independently pass their limits.

**Harness reproduction:** a site manifest with one 64-character tool name registered as valid, but hosted completion rejected `tools[0] has an invalid or duplicate name`.

**Fix:** allocate stable, collision-resistant provider aliases within the final length limit and maintain the reverse map. Apply an explicit aggregate tool budget and report unsupported contracts before approving/submitting them.

### F10 — P2: MCP response parsing does not reliably match the requested result

Locations: [mcp.js:7](../src/lib/mcp.js), [mcp.js:35](../src/lib/mcp.js), [mcp.js:39](../src/lib/mcp.js).

The SSE parser selects the last individually parseable `data:` line instead of parsing complete events. It does not join multi-line data. The RPC layer also accepts a result without checking the JSON-RPC version or matching response ID. It waits for the entire body before parsing, so a response event is not usable until the stream closes.

**Harness reproduction:** a valid JSON event split across two `data:` lines failed with `TOOL_ERROR`; responses bearing unrelated ID `999999` were accepted for discovery.

**Fix:** parse SSE incrementally by event, join data lines, and resolve only the matching validated RPC response. Handle unrelated notifications explicitly. The [HTML SSE parsing standard](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream) defines event framing; [MCP 2025-03-26 transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports) allows multiple messages in a response stream.

Session handling also needs an expiry test: `rpc()` throws on a session-bearing 404 without resetting initialization, whereas the linked MCP transport specification requires starting a new session. The production code never calls `clearMcpSessions()`, so an expired cached session remains unusable until the background is restarted.

### F11 — P2: Validation and size checks fall short of the documented trust boundaries

Locations: [validation.js:31](../src/lib/validation.js), [validation.js:46](../src/lib/validation.js), [validation.js:80](../src/lib/validation.js), [background.js:229](../src/background.js), [provider.js:8](../src/lib/provider.js), [mcp.js:35](../src/lib/mcp.js).

Reproduced inconsistencies:

- `inputSchema: "not a schema"` is accepted because schemas are only JSON-cloned. Tool-call structures likewise are cloned rather than structurally validated.
- `context: 42` throws an ordinary `TypeError` while constructing a Set, before the array check. The background turns it into `INTERNAL_ERROR` instead of `INVALID_REQUEST`.
- A JSON string containing 30,000 CJK characters is accepted by the nominal 65,536-byte limit even though its UTF-8 encoding is 90,002 bytes. `encoded.length` measures UTF-16 code units.

Additional source-confirmed gaps: invalid model-generated tool arguments become `{}` and may execute a tool with unintended defaults; arguments are not validated against the declared schema. Provider and MCP bodies are fully consumed with `response.text()` before their limits are checked or sliced, so those checks do not bound download/memory use.

**Fix:** validate input types before iteration, validate supported schema and tool-call shapes, reject invalid arguments as tool errors, and enforce byte budgets while reading streams. Clarify code-unit versus byte limits in the contract. Add negative and boundary tests for SPEC sections 2, 7, and 9.

## Documentation, packaging, and test inconsistencies

1. **Conformance claims are too broad.** README calls both targets validated v0.1 implementations; SPEC calls itself an implemented normative draft; `docs/CONFORMANCE.md` presents complete requirement coverage. The existing tests establish useful happy paths, but F01–F11 contradict several claimed guarantees. Mark these requirements partial/failing until regression tests pass.
2. **Uniqueness semantics disagree.** SPEC section 4 says capabilities must be unique; `validateAccessRequest` silently deduplicates them and the first validation test explicitly expects that behavior. Choose rejection or normalization and update all three together.
3. **Approval enforcement is split inconsistently.** SECURITY says changed contracts cause redisclosure. The content script checks private fingerprints, but `chat.complete` independently checks only capabilities and context fields. It neither verifies the fingerprint nor checks approved MCP origins. This is not a claim that page code can directly call that background route; it is a missing independent extension enforcement layer and matters for registration races and future callers.
4. **Error evidence is overstated.** The conformance record's safe-error row cites unit/permission assertions, but the provider unit tests only cover successful responses and model listing. Add rejected/malformed/oversized provider responses, throwing tools, malformed arguments, and body-read timeouts with explicit assertions that errors contain no response bodies or credentials.
5. **Firefox setup is not self-contained.** Its quick start selects `dist/firefox-unpacked/manifest.json` without first telling a fresh checkout to build it. That directory is ignored. Add the build command to the Firefox instructions.
6. **Browser test setup is platform-dependent.** `tests/e2e/firefox.mjs:119` searches only macOS application layouts unless `FIREFOX_PATH` is set. `scripts/build-targets.mjs:26` requires an external `zip` command. Document prerequisites/platforms or make discovery and packaging portable. The conformance record calls test browsers pinned, but Firefox installation uses `firefox@stable` and its lookup chooses a cached directory rather than an exact recorded version.
7. **Release metadata can drift.** Archive names hardcode `v0.1.0`; protocol version literals also appear independently in page API, types, and MCP client metadata. The static check compares browser manifests but not all these versions. `.gitignore` ignores ZIP packages and unpacked directories but misses `dist/*.xpi`, leaving generated Firefox binaries visible as untracked project content.
8. **Security reporting lacks a destination.** SECURITY asks for private reports to the maintainer without giving an email address or private reporting link. Add a usable route before public distribution.
9. **Settings wording promises a narrower control than the UI offers.** Consent says an origin can be revoked from settings, but settings has only a revoke-all button. Either provide a per-origin list/control or say that settings revokes all sites.
10. **Shared constants already disagree with enforcement.** `src/lib/constants.js` declares `messageChars: 100_000`, but the separate validator limit is 12,000; the shared LIMITS object is unused. Several UI modules also compress whole asynchronous flows into single lines. Formatting and a single source for shared limits would make authorization paths and future drift easier to review. This is cleanup, not a substitute for the defects above.

## Recommended repair order

1. Fix document/registration binding, grant mutation serialization, and revocation during turns; add delayed-provider and concurrent-grant regression tests.
2. Bind credentials to provider origins and make complete tool/contract disclosure enforceable.
3. Fix model selection enforcement, request normalization, size budgets, and tool aliasing.
4. Implement robust MCP event/session handling and negative boundary tests.
5. Reconcile the normative spec, declarations, setup instructions, and conformance matrix with the verified behavior.

Existing strengths worth preserving: page operations are allowlisted at the content bridge; privileged provider/settings routes check the extension sender; normal grants are keyed by exact origin; credentials are absent from ordinary page API results; assistant messages use text rendering; HTTPS is required outside loopback; shipped extension code has no framework/runtime dependency bundle.
