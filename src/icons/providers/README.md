# Provider icon sources

These files are bundled with the extension and are never loaded from a remote origin at runtime.

- `openai.svg`: OpenAI blossom from the official OpenAI Codex VS Code extension (`resources/blossom-black.svg`).
- `codex.png`: Codex application icon from the official ChatGPT macOS application (`Contents/Resources/icon-codex-dark-color.png`). No SVG asset was available.
- `claude.svg`: Claude mark from Simple Icons v16, whose metadata points to Anthropic's official press assets.
- `ollama.svg`: Ollama mark from Simple Icons v16.33 (CC0-1.0), whose metadata points to the Ollama maintainers' own asset in [`ollama/ollama#2152`](https://github.com/ollama/ollama/issues/2152#issuecomment-1905286922). Used for both the self-hosted server and Ollama Cloud.
- `opencode.svg`: OpenCode square logo from the official [`anomalyco/opencode`](https://github.com/anomalyco/opencode) repository.

The `[API]` marker on OpenCode Zen is drawn by the picker rather than baked into the downloaded artwork, allowing the same official mark to identify the OpenCode CLI without the marker. Ollama Cloud carries a `[Cloud]` marker the same way; the unmarked Ollama mark is the user's own server.
