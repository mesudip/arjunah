# अर्जुनः Desktop

The desktop app is a Node.js program in [desktop/](../desktop/), published on npm as `arjunah-desktop`. It listens only on `127.0.0.1:48123`, serves a local dashboard, pairs with the browser extension, and runs the coding-agent CLIs you are already signed in to (Claude Code, Codex, OpenCode) on the extension's behalf. It never talks to a remote service itself; the agents talk to their own vendors with your existing sign-in.

Installation and autostart are in [INSTALL.md](INSTALL.md). Commands:

```sh
arjunah-desktop start [--quiet] [--open]   # run in the foreground; --open opens the dashboard
arjunah-desktop install                    # register as a login program and start now
arjunah-desktop uninstall                  # remove the login program; data stays
arjunah-desktop status                     # login registration, running state, data path
arjunah-desktop providers                  # detection results without starting the server
arjunah-desktop --version
```

From a checkout, `npm run desktop` and `npm run desktop:providers` do the same as `start` and `providers`.

## Pairing and sync

1. The dashboard at <http://127.0.0.1:48123/> shows a six-digit pairing code (also printed by `start`).
2. In the extension settings, open **Desktop app**, enter the code, and choose **Pair**. Pairing is per browser profile; revoke it from either side.
3. Detected providers appear under **Providers and default model** with their sign-in state, account, plan, local usage, and quota status. Pick the global default model. The toolbar popup is the wallet view: every provider with its account and usage, the global default, and, on a connected page, that site's access level, its model, the providers it may list, and revoke/open controls. Consent dialogs let you choose the model for that site and say which provider receives requests.
4. Anything you save in the extension (API key, model, active provider) syncs to the app and to other paired browsers; edits on the dashboard sync back.

Data lives in one file, `desktop.json`, created with mode 0600 under the OS application-support folder (`~/Library/Application Support/arjunah` on macOS, `%APPDATA%\arjunah` on Windows, `$XDG_CONFIG_HOME/arjunah` or `~/.config/arjunah` on Linux). `ARJUNAH_DESKTOP_HOME` moves it; `ARJUNAH_DESKTOP_PORT` changes the port.

## How agents run

Provider detection is honest about state: Claude Code must report a sign-in through `claude auth status`, Codex through `codex login status`, and OpenCode must list at least one model. Agents run with their built-in file, shell, and web tools disabled, in an empty scratch directory, with only the site tools you approved for that turn bridged through a per-session MCP endpoint. Codex cannot disable its shell tool and stays in a read-only sandbox, so it is off until you enable it on the dashboard.

Local subscription agents start a process per turn, but each open chat keeps one agent **thread**: the first turn sends the transcript, later turns resume the agent's own session (Codex `exec resume`, Claude Code `--resume`, OpenCode `--session`) and send only the new message. Threads end when the chat is reset, the page navigates, or after 30 minutes idle, and their session files are deleted. Answers take seconds rather than milliseconds because the agent's own prompt is processed on every turn.

Thinking and context sizes work the same way on every provider: the chat composer offers a thinking-effort picker for models that support it (OpenAI `reasoning_effort`, Codex `model_reasoning_effort`, Claude Code `--effort`, OpenCode `--variant`), reasoning summaries and thinking-token counts stream into the activity view when the agent emits them, and the footer shows the last turn against the model's context window together with cached and thinking tokens. Claude Code's 5-hour and 7-day rate-limit utilisation appears as the provider's quota after its first answer. Page-level `models.generate` calls therefore allow 180 seconds. Protocol details are in [SPEC.md](../SPEC.md) section 12.

## Account, models, and plan usage without API calls

The app reads each agent's own control interface at detection time, the way T3 Code does: Claude Code's `initialize` and `get_usage` control requests over stream-json give the signed-in e-mail, organization, plan, the CLI's model list with effort levels, and the 5-hour, weekly, and per-model usage windows; Codex's `app-server` gives the ChatGPT account and plan, the live model list with reasoning efforts, and the 5-hour and weekly rate-limit windows plus the spend cap. The popup, options page, and chat footer show these windows as "Plan usage". None of this spends model tokens.

## Optional: T3 Code as a model catalog

If you already run [T3 Code](https://github.com/pingdotgg/t3code) (`npx t3 serve` or its desktop app), pair it on the dashboard under **T3 Code**. अर्जुनः then merges T3's model catalog into its own providers (Claude's full model list with names, context-window choices, and reasoning levels; Codex and OpenCode when T3 sees them), fills in sign-in state and subscription usage windows, and lists the agents only T3 can run (Cursor, Grok Build, Antigravity) as unavailable so you can see them. Execution stays in अर्जुनः Desktop with tools disabled; T3 is read over its public pairing and RPC surface, and no T3 code is bundled. Details and measurements are in [T3CODE.md](T3CODE.md).

## When a provider shows as unavailable

Each provider row on the dashboard, and the matching card in the extension, explains its state and lists the exact steps to fix it, with links to the install pages:

- **Not installed**: the CLI was not found on `PATH` or in the usual install folders. Install it (Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`; Codex: `npm install -g @openai/codex`; OpenCode: `curl -fsSL https://opencode.ai/install | bash`), or paste the full path to the binary in the row's **Custom path** field.
- **Not signed in**: the CLI is present but has no saved login. Sign in once in a terminal (`claude` then `/login`, `codex login`, or `opencode auth login`), then click **Re-check providers**.
- **Disabled here**: Codex is ready but switched off until you tick **Enable Codex** after reading the sandbox notice. On macOS every Codex run is additionally wrapped in a `sandbox-exec` profile that denies reads and writes under your home folder, so its shell commands fail instead of reading your files; each attempted command shows up as an activity card in the chat.
- **Check failed**: the CLI or the custom path could not be run; the row shows the command to try by hand.

Two facts about the GUI apps: the Claude desktop app ships its own copy of Claude Code, but that copy runs only inside the app and does not share its sign-in, so the standalone `claude` command still needs its own login. The ChatGPT desktop app for macOS bundles a signed-in Codex CLI, and the companion finds it automatically.

When the app is installed as a login program it inherits the `PATH` you had when you ran `arjunah-desktop install`. If you install a CLI later and it is not found, run `arjunah-desktop install` again to refresh the registration.

If the extension settings page shows **Unknown extension operation** or **This page does not have a supported top-level origin** after you updated the extension, the browser is still running the previous background service worker. Click **Reload** on the extension in `chrome://extensions` and reopen the page.
