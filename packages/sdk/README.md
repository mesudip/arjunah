# arjunah

TypeScript SDK and types for **अर्जुनः** (Arjunah): let your website use the AI your visitor already has.

The visitor installs the अर्जुनः browser extension. It injects `window.ai.arjunah` into every page. Your site never holds an API key: it publishes an assistant contract and lets the extension host the chat (level 0), or it calls `enable()` and gets completions from the model the visitor chose (level 1 or 2). The visitor approves every request in an extension-owned dialog, per exact origin.

```sh
npm install arjunah
```

```ts
import { registerSite, enable, isEnabled, isAIError } from "arjunah";

// Level 0: the extension hosts a chat that can call your page's functions.
await registerSite({
  name: "Store helper",
  systemPrompt: "Help with orders. Never claim a tool succeeded unless it did.",
  tools: [
    {
      name: "order_status",
      description: "Look up the current order.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => ({ status: "shipped" }),
    },
  ],
});

// Level 1: your own model calls. enable() asks for level 1 by default and
// resolves to the session that carries models, providers, context, permissions.
try {
  const ai = await enable();
  const { message } = await ai.models.generate({
    messages: [{ role: "user", content: "Summarise this order in one line." }],
  });
} catch (error) {
  if (isAIError(error) && error.code === "NOT_INSTALLED") {
    // Tell the visitor where to get the extension.
  }
}
```

What the package exports:

- `getArjunah()`, `isInstalled()`, `waitForArjunah({ timeoutMs })`: find the injected API; the wait covers pages whose script ran before injection and rejects with code `NOT_INSTALLED` after 3 seconds by default.
- `isEnabled()`, `enable(request?)`, `disable()`: the wallet-style access flow.
- `registerSite(manifest)`, `openChat()`: the level 0 surface.
- `isAIError(error)`, `PROTOCOL_VERSION`, `READY_EVENT`, `CONFLICT_EVENT`.
- Every request and result type (`AISiteManifest`, `AIGenerateRequest`, `AIGrant`, `AISession`, and so on), with the protocol's limits in the doc comments.

The package has no runtime dependencies and no model code; the extension is the source of truth. If you only want the types for a page that uses `window.ai.arjunah` directly, install it as a dev dependency.

Integration guide, request bounds, error codes, and traps: `docs/INTEGRATION.md` in the repository. Normative protocol: `SPEC.md` there. Hand `llms.txt` at the repository root to an AI coding assistant to give it the reading order. Everything a person sees says अर्जुनः; code and packages use `arjunah`.

License: MIT.
