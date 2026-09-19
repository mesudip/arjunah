# अर्जुनः — project aim and working context

## Aim
Build an open protocol, browser extension, and desktop companion that let users bring their own AI provider or subscription to websites. A website registers an assistant prompt and narrowly scoped local/MCP tools through `window.ai.arjunah`; the extension supplies chat and extensions model requests using the user's locally stored credential. Preserve exact-origin consent, full prompt/tool disclosure, optional page-context sharing, revocation, and document-bound tool execution. Never put credentials in website code or logs.

## Repository map
- `SPEC.md`, `SECURITY.md`: protocol contract and security boundaries. `docs/INTEGRATION.md` and `llms.txt` are the site-integrator and AI-assistant entry points; `docs/INSTALL.md` and `docs/DESKTOP.md` are the user guides. README is a landing page only; do not grow it back into a manual.
- npm workspaces: `packages/sdk/` is the published `arjunah` SDK (TypeScript, built by `tsc` into `packages/sdk/dist/`, which `npm run check` runs; `src/types.ts` is the only copy of the page API types), `desktop/` is the published `arjunah-desktop` companion (zero runtime dependencies; `desktop/package.json` `files` decides what ships). The root package stays private.
- `desktop/lib/autostart.mjs`: login-program registration (`arjunah-desktop install|uninstall|status`). `plan()` is pure and unit-tested; only `install`/`uninstall` touch launchd, systemd, or the registry. Never run `install` on a developer's machine as part of a test.
- `src/`: shared extension; Chrome loads this directory unpacked. `src/lib/catalog.js` builds the unified provider/model catalog (`<provider>/<model>` ids) from the OpenAI key (`provider`), the paired desktop link (`desktop`), and the global default (`active`); `background.js` enforces access levels (assistant/completion/catalog), per-site model settings stored on grants, the local usage ledger (`usage`), and emits `arjunah-progress` events to the widget. `src/lib/desktop.js` is the client for the desktop companion. `src/theme.css` is the shared visual system for popup and options; the widget in `content.js` inlines its own copy of the tokens.
- `desktop/lib/t3/`: optional T3 Code integration (`client.mjs` speaks T3's token exchange, WebSocket ticket, and Effect RPC JSON framing; `catalog.mjs` maps T3 provider snapshots into अर्जुनः models, quota, and external providers). Read-only use; see `docs/T3CODE.md`.
- `desktop/`: the desktop companion (Node, loopback HTTP on 48123). `lib/server.mjs` routes, `lib/sessions.mjs` suspends agent tool calls until the browser returns results, `lib/providers/*` detect and start Claude Code, Codex, and OpenCode CLIs with built-in tools disabled.
- `manifests/`, `scripts/build-targets.mjs`: Firefox adaptation and release packaging.
- `tests/`: unit, extension, browser integration, and security regressions.
- `sample-site/dist/`: static Assistant Protocol Lab integration fixture.
- `demo/`: interactive playground (trip-planner form with six site tools, widget controls, level 1/2 buttons). `npm run demo` serves it and the sample site via `scripts/demo-server.mjs`.
- `docs/PROGRESS.md`: current findings, verification, and remaining work; update after meaningful changes.

## Working rules
- Version bump touches, all enforced by `scripts/check.mjs`: `src/lib/constants.js` VERSION, `src/page-api.js` version, both manifests' `version` plus the Chrome `version_name` (carries the prerelease tag), `desktop/lib/server.mjs` APP_VERSION and PROTOCOL_VERSION, the three `package.json` versions (identical, may carry `-alpha.N`), `packages/sdk/src/index.ts` PROTOCOL_VERSION and `src/types.ts` version literal, the `version` assertions in `tests/e2e/chrome.mjs`, `tests/e2e/firefox.mjs`, `tests/background.test.mjs`, and `desktop/lib/providers/codex.mjs`, and SPEC.md's header and section 3. A release tag must equal `v` + package version or the release workflow fails.
- Naming: everything a person sees (titles, labels, docs) says अर्जुनः; code, paths, identifiers, and comments use the ASCII slug `arjunah` / `Arjunah` (`window.ai.arjunah`, `ARJUNAH_*`, `arjunah-desktop`).
- Read the progress notes and relevant implementation before changing behavior.
- Diagnose site registration, consent, provider requests, and tool execution separately.
- Preserve the selected model and existing credentials/grants when repairing provider compatibility.
- Keep raw provider error bodies and credentials out of page-visible errors.
- Test real wire formats and multi-step tool round trips, not only text-only connection checks.
- Run `npm run check` and relevant browser/security tests for extension changes; rebuild packages when extension source changes.
- Reload the unpacked extension and then the site to verify fixes in the user's Brave session. Restart `npm run desktop` after changing `desktop/`.
- Desktop provider runs must never expose the agent's built-in file/shell tools to a website; keep `--tools ""`, the OpenCode deny permissions, and the Codex opt-in gate.
- Do not claim a hosted-site fix from local tests alone. Record any remaining blocker precisely.

## Active task (2026-09-13)
v0.3.0 adds tiered site access (SPEC section 4: level 0 assistant, level 1 completion with a user-chosen site model, level 2 catalog with exposed providers), a unified model catalog, widget options for sites (`widget.controls/suggestions/placeholder/theme`, `onControlChange`, `chat.getControls/setControls`), image content parts, provider reasoning/attachments in results, a resizable/draggable widget with live activity and usage, and a wallet-style popup. Verification evidence is in `docs/PROGRESS.md`.

## Previous task (2026-09-12)
v0.2.0 adds the desktop companion: pairing, configuration sync, subscription providers (Claude Code, Codex, OpenCode) selectable from the extension, and a bridged tool loop. See `docs/PROGRESS.md` for verification evidence and limitations (Claude Code CLI on this machine is not signed in; Codex requires the dashboard opt-in).
