# Installing अर्जुनः

Two parts. The **browser extension** is all you need if you have an OpenAI, OpenCode Zen, or Ollama Cloud API key, or run your own Ollama server. The **desktop app** is optional: it lets websites use the Claude Code, Codex, or OpenCode subscription you are already signed in to, with no API key.

## 1. The browser extension

### Chrome, Brave, Edge (Chromium 120 or later)

1. Download `arjunah-chrome-<version>.zip` from the latest [GitHub release](../../../releases) and unzip it. Keep the folder; the browser loads the extension from it.
2. Open `chrome://extensions` (`brave://extensions`, `edge://extensions`), turn on **Developer mode** in the top-right corner, choose **Load unpacked**, and select the unzipped folder.
3. Pin अर्जुनः to the toolbar. Its icon opens the wallet view: your providers, the default model, and what the current site may do.

A Chrome Web Store listing is planned for the first stable release; until then the unpacked install is the supported path. When you update, unzip the new release over the old folder and click **Reload** on `chrome://extensions`.

### Firefox (140 or later)

1. Download `arjunah-firefox-<version>.xpi` from the release.
2. Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and pick the `.xpi`.

The beta build is unsigned, so Firefox removes it when it restarts and you load it again. Signed builds through Mozilla's add-on service are planned.

### Configure a provider

Open the extension's settings (right-click the icon, **Options**) and do one of:

- Enter an **OpenAI API key** and pick a default model. The key stays in extension storage and is never given to any website.
- Enter an **OpenCode Zen API key** and pick a model from its live catalog. अर्जुनः uses the native Responses, Anthropic Messages, Gemini generateContent, or Chat Completions format required by that model, including supported image input and incremental output.
- Connect your own **Ollama** server (see below), or enter an **Ollama Cloud API key** from [ollama.com/settings/keys](https://ollama.com/settings/keys).
- Pair the **desktop app** (next section) to use your subscriptions instead.

### Ollama

Under **Providers**, open **Ollama server**, enter the server's address (`127.0.0.1:11434` for Ollama on this computer), and choose **Connect**. No key is needed; the optional key under **Authentication** is for a server behind an authenticating proxy. अर्जुनः asks the server what each model can do, so images go only to models that report vision, site tools only to models that report tools, and the thinking control matches the model. **Refresh models** picks up anything you pull later; the list also refreshes by itself about once a minute while the extension is in use.

- **Another computer on your network:** start Ollama there with `OLLAMA_HOST=0.0.0.0 ollama serve` and enter its address, for example `192.168.1.20:11434`. Plain `http` is accepted only for this computer, private network addresses (including Tailscale's `100.64.0.0/10`), and local names such as `gpubox` or `nas.local`; anything else needs `https`, typically through a reverse proxy.
- **No `OLLAMA_ORIGINS` change is needed.** Ollama refuses requests that carry a browser extension's origin, so अर्जुनः removes that one header on its own requests to the configured address (a `declarativeNetRequest` rule, Chrome and Firefox). Web pages' requests to the same server are untouched and still face Ollama's own origin check.
- **Context length** is the server's setting (`OLLAMA_CONTEXT_LENGTH`). The chat shows the length the model was actually loaded with, not its trained maximum, because Ollama silently drops the start of a prompt that does not fit.
- **CPU or GPU:** beside the context bar under the composer, a marker shows where the server holds the model, read the same way `ollama ps` reports it: `GPU`, `CPU`, or `CPU+GPU 52%` (the share on the GPU) for a model split between them, which is the usual reason a local model is slow. It appears as soon as the chat opens if the model is already loaded, and otherwise after the first round of a reply; the context details list the exact split. Sites never see it.

**Ollama Cloud** uses the same native API at `https://ollama.com` with your API key, and its catalog shows each hosted model's capabilities and thinking levels.

Then try it: open a site that supports अर्जुनः, visit the [hosted Paint playground](https://mesudip.github.io/arjunah/paint/), or run `npm run demo` from a checkout and open <http://127.0.0.1:8090/paint/>.

## 2. The desktop app

Requires [Node.js](https://nodejs.org) 22.22 or later on macOS, Linux, or Windows.

```sh
npm install -g arjunah-desktop@beta
arjunah-desktop install
```

`install` registers the app as a login program for your user and starts it now:

- macOS: a LaunchAgent at `~/Library/LaunchAgents/io.arjunah.desktop.plist`, kept alive by launchd; log at `~/Library/Application Support/arjunah/arjunah-desktop.log`.
- Linux: a systemd user service, `~/.config/systemd/user/arjunah-desktop.service` (`journalctl --user -u arjunah-desktop` for logs). Without systemd it writes an XDG autostart entry instead.
- Windows: a value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.

The app listens only on `127.0.0.1:48123` and never contacts a remote service itself. Check it with `arjunah-desktop status`; remove the login program with `arjunah-desktop uninstall` (your pairings and settings stay). To run it in a terminal instead, use `arjunah-desktop start --open`.

### Pair the extension

1. Open the dashboard at <http://127.0.0.1:48123/>. It shows a six-digit pairing code.
2. In the extension settings, open **Desktop app**, enter the code, and choose **Pair**.
3. Your signed-in agents appear as providers. Pick the default model.

Pairing is per browser profile and can be revoked from either side. Everything else about the desktop app, including what to do when a provider shows as unavailable, is in [DESKTOP.md](DESKTOP.md).

## Environment variables

- `ARJUNAH_DESKTOP_PORT`: loopback port for the desktop app (default 48123). Update the desktop address in the extension settings to match.
- `ARJUNAH_DESKTOP_HOME`: directory for the desktop app's data file (`desktop.json`, mode 0600). Defaults to the OS application-support folder under `arjunah`.

Both are captured when you run `arjunah-desktop install`, so set them first if you need them.
