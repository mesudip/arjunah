# T3 Code as a catalog source

Investigation of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (MIT, checked at
commit `cfeaca41`, 2026-09-12) and how अर्जुनः reuses it. Verified against a headless
`npx t3@0.0.40 serve` on this machine.

## What T3 Code is

An "agent harness control surface": a Node WebSocket server (`npx t3`, published on npm
as `t3`, 115 MB bundle) that wraps provider CLIs and serves web, desktop, and mobile
clients. Providers: Codex (app-server protocol), Claude (Claude Agent SDK), Cursor, Grok
Build, OpenCode (`@opencode-ai/sdk`), Antigravity (ACP). Remote access is first class:
LAN pairing, Tailscale HTTPS, SSH-launched servers, and the T3 Connect relay.

Everything T3 does with an agent is a _coding-agent thread_: a project directory, a
permission mode (`approval-required` … `full-access`), a sandbox mode
(`read-only` … `danger-full-access`), checkpoints, terminals, and the agent's full tool
set. There is no request-level "plain completion" API; the internal `textGeneration`
service (commit messages, thread titles) is not exposed over RPC. Threads always carry
T3's own MCP tools and the agent's built-in tools.

## What we can reuse, and how

| Need in अर्जुनः                             | In T3 Code                                                                                                                                     | Reuse                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Model catalog with names, options, defaults | `server.getConfig` → `providers[].models` (`slug`, `name`, `capabilities.optionDescriptors`: effort levels, context window choices, fast mode) | Read over RPC; map to अर्जुनः models (`desktop/lib/t3/catalog.mjs`)             |
| Sign-in state and account                   | `providers[].auth` (`status`, `email`), `installed`, `version`                                                                                 | Read over RPC                                                                   |
| Subscription usage / quota                  | `providers[].usageLimits.windows` (`five_hour`, `seven_day`, … with `usedPercent`, `resetsAt`), reset credits                                  | Read over RPC → अर्जुनः `quota`                                                 |
| Live updates                                | `subscribeServerConfig` stream (`providerStatuses`, `usageLimitSourcesUpdated`)                                                                | Possible follow-up; today अर्जुनः polls with a 20 s cache                       |
| Provider sign-in from a UI                  | `provider.auth.start/complete`, `provider.install.*`                                                                                           | Possible follow-up (needs `orchestration:operate`)                              |
| Model metadata without a server             | `apps/server/src/provider/model-manifest.json`, fetched from `main` at runtime                                                                 | Could be fetched directly (MIT JSON); not done yet                              |
| Running completions for websites            | Threads only, with agent tools                                                                                                                 | **Not reused.** अर्जुनः keeps its own tool-less, sandboxed CLI runs (SPEC 12.3) |
| Library import                              | `@t3tools/contracts`, `client-runtime` are workspace-private; only the bundled server is published                                             | Not possible; we speak the wire protocol instead                                |

The wire surface we depend on is small and documented in T3's `packages/contracts`:

1. `POST /oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`,
   `subject_token=<pairing token>`, `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap`
   → `{ access_token, scope, expires_in }`. The pairing token comes from `npx t3 serve`
   or `npx t3 pair` and is single use.
2. `POST /api/auth/websocket-ticket` with the bearer → `{ ticket }`.
3. `GET /ws?wsTicket=…` then Effect RPC messages as JSON: `{"_tag":"Request","id","tag","payload","headers":[]}`,
   answered by `Chunk`/`Exit`/`Defect`, with `Ping`/`Pong` keep-alives.
4. Calls: `server.probe`, `server.getConfig` (`orchestration:read`), `server.refreshProviders`
   (`orchestration:operate`; `refreshModels: true` may open agent sessions, so it runs only
   on explicit refresh).

## Measured

From a plain Node script (`desktop/lib/t3/client.mjs` is the productised version):

- Pairing + ticket + `server.getConfig`: under one second on loopback.
- Claude: 10 models (Fable 5.1 default, Fable 5, Opus 5, Opus 4.8 … Sonnet 4.6) with
  `effort` choices `low|medium|high|xhigh|max|ultracode|ultrathink`, `contextWindow`
  `200k|1m`, `fastMode`; auth `authenticated (sudip@sireto.io)`; usage windows
  `five_hour 74 %`, `seven_day 28 %`, `seven_day_fable 42 %` with reset times.
- Codex: `status=error` because the ChatGPT.app-bundled CLI is not on `PATH`; T3 accepts a
  `binaryPath` setting per provider. Cursor, Grok, OpenCode, Antigravity are disabled until
  enabled in T3's settings.
- `server.getUsageSummary` needs `sinceDay`; not used.

## What अर्जुनः learned and now does itself

The facts T3 shows do not require a T3 server; T3 obtains them from the agents' own
control interfaces, and अर्जुनः Desktop now uses the same techniques directly:

| Fact          | Claude Code                                                                                                                                                                | Codex                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account, plan | `claude -p --input-format stream-json` control request `initialize` → `account { email, organization, subscriptionType }`                                                  | `codex app-server` JSON-RPC `account/read` → `{ type: "chatgpt", email, planType }`                                                                                                    |
| Model catalog | the same `initialize` response carries `models[]` (`value`, `displayName`, `resolvedModel`, `supportedEffortLevels`); `[1m]` variants run in the 1M window, others in 200k | `model/list` → `id`, `displayName`, `supportedReasoningEfforts`, `defaultReasoningEffort`, `inputModalities`, `isDefault`, `hidden`; context windows from `~/.codex/models_cache.json` |
| Usage windows | control request `get_usage` (`skip_behaviors: true`) → `rate_limits.five_hour / seven_day / model_scoped[]`                                                                | `account/rateLimits/read` → `primary` (5 h) and `secondary` (weekly) windows plus the `individualLimit` spend cap                                                                      |

For **OpenCode**, T3 asks `opencode serve` for `provider.list` (`connected` provider ids, models with limits, cost, and capabilities). अर्जुनः gets the same model metadata from `opencode models --verbose` and the connected set from OpenCode's own credential file (`~/.local/share/opencode/auth.json`, what `opencode auth list` prints): the provider card shows each upstream credential ("OpenCode Go (API key)"), free models are marked, retired models are dropped. OpenCode has no rolling allowance of its own, so no usage window is invented.

All probes finish in about a second and cost no tokens. They live in
`desktop/lib/providers/{claude-code,codex}.mjs` (`parseClaudeProbe`, `parseCodexProbe`) and feed
the provider's `models`, `connection`, and multi-window `quota`. Pairing a T3 server remains
optional; it adds the drivers अर्जुनः cannot run (Cursor, Grok, Antigravity) and T3's curated
model names.

## What अर्जुनः does with a paired T3 server

Pair a T3 server on the अर्जुनः Desktop dashboard (address + pairing token). The companion
stores the bearer in its 0600 data file (masked on the dashboard), then on every
`GET /api/providers`:

- merges T3 models into the matching अर्जुनः provider (`claudeAgent → claude-code`,
  `codex → codex`, `opencode → opencode`): T3 models first with display names, context
  window, reasoning levels and default; अर्जुनः's own entries that T3 lacks stay;
- fills `quota` and `account` when अर्जुनः has none;
- appends drivers अर्जुनः cannot run (Cursor, Grok, Antigravity) as unavailable providers
  with their models, so the wallet shows the whole catalog honestly.

Execution is unchanged: the extension still asks अर्जुनः Desktop to run `claude`, `codex`,
or `opencode` with tools disabled and the outer sandbox. A model slug from T3 (for example
`claude-fable-5-1`) is passed straight to the CLI, which is why only drivers with a अर्जुनः
runner become selectable.

## Trust notes

- The T3 server is another process of the same OS user (or a machine you paired over your
  tailnet). Its bearer grants T3's standard scopes; अर्जुनः uses only read calls plus the
  explicit provider refresh.
- T3 model names, e-mails, and usage windows are shown only in अर्जुनः-owned UI, like every
  other account detail (SPEC 2.3).
- Following T3 upstream means following its wire contract, not its code. The four calls
  above have been stable across the 0.0.x line; a breaking change surfaces as a
  `T3 Code request failed` line on the dashboard, never as a crash.

## Not done / next

- `subscribeServerConfig` for push updates instead of polling.
- Provider sign-in through T3 (`provider.auth.*`) from the अर्जुनः dashboard.
- Fetching `model-manifest.json` directly for machines without a T3 server.
- Runners for Cursor, Grok, and Antigravity, which would make their T3-listed models
  selectable.
