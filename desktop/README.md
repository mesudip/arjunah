# arjunah-desktop

**अर्जुनः Desktop**: the optional companion for the अर्जुनः browser extension. It pairs with the extension over loopback and lends websites the Claude Code, Codex, or OpenCode subscription you are already signed in to, so sites can use your AI without any API key.

Requires Node.js 22.22 or later on macOS, Linux, or Windows.

```sh
npm install -g arjunah-desktop@alpha
arjunah-desktop install
```

`install` registers the app as a login program for your user (a LaunchAgent on macOS, a systemd user service or XDG autostart entry on Linux, a Run key on Windows) and starts it now. Then open <http://127.0.0.1:48123/>, read the six-digit pairing code, and enter it under **Desktop app** in the extension's settings.

```sh
arjunah-desktop status      # login registration, running state, data file
arjunah-desktop providers   # which agents are installed and signed in
arjunah-desktop start --open  # run in the foreground instead
arjunah-desktop uninstall   # remove the login program; pairings and settings stay
```

What it does and does not do:

- Listens only on `127.0.0.1` and never contacts a remote service itself; the agent CLIs talk to their own vendors with your existing sign-in.
- Runs agents with their built-in file, shell, and web tools disabled, in an empty scratch directory, with only the site tools you approved for that turn bridged through a per-session MCP endpoint. Codex keeps a shell it cannot drop, so it stays off until you enable it on the dashboard after reading the sandbox notice.
- Keeps one data file, `desktop.json`, with mode 0600 under your OS application-support folder. `ARJUNAH_DESKTOP_HOME` moves it; `ARJUNAH_DESKTOP_PORT` changes the port.
- Reads each agent's own control interface for account, plan, model list, and usage windows without spending model tokens.

Provider states and how to fix them, T3 Code as a model catalog, and the rest of the desktop documentation live in the repository's `docs/DESKTOP.md`; installing the extension itself is in `docs/INSTALL.md`. Everything a person sees says अर्जुनः; code and packages use `arjunah`.

License: MIT.
