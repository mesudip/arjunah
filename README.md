# अर्जुनः

> अर्जुनः कृष्णं पश्यति। — Arjuna sees Krishna.

अर्जुनः has seen the divine form, the AI and the human, so your website never has to. अर्जुनः (romanized _Arjunah_) is a browser extension and an open protocol that let a website use the AI its visitor already has.

**Think of it as a wallet for AI access: a site starts with the least access and asks for more, the visitor decides which provider and model answer, and the site never sees a credential, an account, or a quota.**

- **Visitors** install the extension once and bring an OpenAI or OpenCode Zen API key, or pair the desktop app to lend their Claude Code, Codex, or OpenCode subscription to websites.
- **Websites** either publish an assistant contract and let the extension host the chat, or call `enable()` and get completions from the visitor's chosen model.
- **Chats can show more than text.** A site tool can return an interactive card, report progress while it runs, and keep the conversation in the site's own store. The same chat widget is published as [`arjunah-widget`](packages/widget/README.md) for sites that want to run it against their own backend, without the extension and without any of the wallet guarantees.

## Install the extension

Download the latest build from [GitHub releases](../../releases): `arjunah-chrome-<version>.zip` for Chrome, Brave, and Edge, or `arjunah-firefox-<version>.xpi` for Firefox. Unzip the Chrome build, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select the folder. Then open the extension's settings and enter an OpenAI or OpenCode Zen API key, or pair the desktop app below.

Step-by-step instructions, Firefox notes, and updating are in [docs/INSTALL.md](docs/INSTALL.md). This is a 1.0.0 beta: store listings and signed builds come with the first stable release.

## Install the desktop app (optional)

Lets websites use the subscriptions you are already signed in to, with no API key. Needs Node.js 22.22 or later on macOS, Linux, or Windows.

```sh
npm install -g arjunah-desktop@beta
arjunah-desktop install
```

`install` registers the app to start when you log in and starts it now; `arjunah-desktop status` and `arjunah-desktop uninstall` do what they say. Pair it from the extension's settings with the six-digit code on <http://127.0.0.1:48123/>. Details, provider states, and how agents are sandboxed: [docs/DESKTOP.md](docs/DESKTOP.md).

## For website developers

```sh
npm install arjunah@beta
```

```js
import { registerSite, enable, isEnabled } from "arjunah";

// Level 0: the extension hosts a chat that can call your page's tools.
await registerSite({
  name: "Store helper",
  systemPrompt: "Help with orders. Never claim a tool succeeded unless it did.",
  tools: [
    {
      name: "order_status",
      description: "Look up the current order.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: async () => ({ status: "shipped" }),
    },
  ],
});

// Level 1: your own model calls on the model the visitor picked for this site.
// enable() defaults to level 1 and resolves to the session that carries the APIs.
if (!(await isEnabled())) console.log("The visitor will be asked once.");
const ai = await enable();
const { message } = await ai.models.generate({
  messages: [{ role: "user", content: "Summarise this order in one line." }],
});
```

Read [docs/INTEGRATION.md](docs/INTEGRATION.md) for the whole API on one screen, the three access levels, request bounds, error codes, and the traps. The normative contract is [SPEC.md](SPEC.md); the SDK's types are in [packages/sdk/src/types.ts](packages/sdk/src/types.ts). The [hosted playgrounds](https://mesudip.github.io/arjunah/) feature a level-0 Paint studio and preserve the original trip planner; both also run locally with `npm run demo`.

**Using an AI coding assistant?** Point it at [llms.txt](llms.txt), which links the integration guide, the types, and the spec in the order an agent should read them.

## What the visitor is protected by

The credential stays in extension storage and is never returned to the page. Grants are per exact origin. Page context, the full system prompt, and site tools are disclosed in an extension-owned consent dialog before use. MCP endpoints need one approval for discovery and a second for the discovered tool metadata. Subscription agents run with their file, shell, and web tools disabled. The full model is in [SECURITY.md](SECURITY.md).

## Development

Node.js 22.22 or later.

```sh
npm ci
npm run check          # static checks, SDK build, formatting, unit tests
npx puppeteer browsers install chrome
npx puppeteer browsers install firefox@stable
npm run validate       # check + Firefox lint + Chrome, Firefox, security, desktop e2e
npm run pack           # dist/arjunah-chrome-<version>.zip and dist/arjunah-firefox-<version>.xpi
```

The repository is an npm workspace: the extension in `src/`, the shared chat renderer in `src/renderer/`, the `arjunah` SDK in `packages/sdk/`, the `arjunah-widget` standalone renderer in `packages/widget/`, the `arjunah-desktop` companion in `desktop/`. Browser suites use temporary profiles and local mock services; `ARJUNAH_E2E_LIVE=opencode` (or `codex`, `claude-code`) drives a real CLI, and `CHROME_PATH` or `FIREFOX_PATH` picks a browser. Tags matching `v*` run the checked npm and GitHub release pipeline. Contributor context is in [AGENTS.md](AGENTS.md); verification history is in [docs/PROGRESS.md](docs/PROGRESS.md).

## Status

1.0.0-alpha.3. Chrome Manifest V3 and Firefox Manifest V3 are tested targets; the desktop app has been exercised on macOS with OpenCode, Codex, and Claude Code and on the fake-agent end-to-end suite. Linux and Windows autostart are implemented and unit-tested but not yet exercised on real machines. This is not an independent security certification; see [docs/REMEDIATION.md](docs/REMEDIATION.md) for the audit findings and their regression tests.

License: MIT.
