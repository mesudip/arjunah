import { clearMcpSessions } from "../../src/lib/mcp.js";

export async function broker(t) {
  clearMcpSessions();
  const previous = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  const state = {
    store: {
      provider: {
        baseUrl: "https://provider.test/v1",
        model: "allowed",
        apiKey: "dummy-audit-key",
      },
      grants: {},
    },
    sessions: new Map(),
    requests: [],
    invocations: [],
    hooks: {},
    removed: null,
  };
  let listener;
  globalThis.chrome = {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: {
        addListener(fn) {
          listener = fn;
        },
      },
      getURL: (path) => `chrome-extension://test/${path}`,
      getManifest: () => ({ name: "अर्जुनः" }),
      id: "test",
    },
    storage: {
      local: {
        async get(key) {
          const result = structuredClone({ [key]: state.store[key] });
          await state.hooks.get?.(key);
          return result;
        },
        async set(value) {
          await state.hooks.set?.(value);
          Object.assign(state.store, structuredClone(value));
        },
        async remove(key) {
          delete state.store[key];
        },
      },
    },
    tabs: {
      onRemoved: {
        addListener(fn) {
          state.removed = fn;
        },
      },
      async sendMessage(tabId, message, options) {
        const active = state.sessions.get(tabId);
        const matches =
          active &&
          options.frameId === 0 &&
          active.session === message.session &&
          active.origin === message.origin &&
          (!message.registrationId ||
            (active.registrationId === message.registrationId &&
              active.fingerprint === message.fingerprint));
        if (!matches) return { ok: false };
        if (message.kind === "arjunah-tool") {
          state.invocations.push(message);
          return {
            ok: true,
            result: (await state.hooks.tool?.(message)) ?? { ok: true },
          };
        }
        return { ok: true };
      },
    },
  };
  globalThis.fetch = async (url, init) => {
    const payload = init.body ? JSON.parse(init.body) : null;
    state.requests.push({ url, payload, init });
    return state.hooks.fetch
      ? state.hooks.fetch(url, init, payload)
      : Response.json({ choices: [{ message: { content: "done" } }] });
  };
  await import(`../../src/background.js?test=${crypto.randomUUID()}`);
  t.after(() => {
    globalThis.chrome = previous.chrome;
    globalThis.fetch = previous.fetch;
    clearMcpSessions();
  });
  state.sender = (origin = "https://site.test", tabId = 1) => ({
    url: `${origin}/page`,
    frameId: 0,
    tab: { id: tabId, url: `${origin}/page` },
  });
  state.extension = { url: "chrome-extension://test/options.html" };
  state.call = (method, params = {}, sender = state.sender()) =>
    new Promise((resolve) =>
      listener(
        {
          kind: "arjunah",
          method,
          params: {
            _session:
              state.sessions.get(sender.tab?.id)?.session ?? "session-1",
            ...params,
          },
        },
        sender,
        resolve,
      ),
    );
  state.ok = async (...args) => {
    const response = await state.call(...args);
    if (!response.ok)
      throw Object.assign(new Error(response.error.message), response.error);
    return response.result;
  };
  state.sessions.set(1, { origin: "https://site.test", session: "session-1" });
  state.approve = (capabilities, extra = {}, sender) =>
    state.ok("grant.approve", { capabilities, ...extra }, sender);
  state.register = async (manifest) => {
    const reg = await state.ok("site.register", {
      id: crypto.randomUUID(),
      manifest,
    });
    Object.assign(state.sessions.get(1), {
      registrationId: reg.id,
      fingerprint: reg.fingerprint,
    });
    return reg;
  };
  state.prepare = async (manifest, context = []) => {
    const reg = await state.register(manifest);
    const capabilities = [
      "chat.hosted",
      ...(reg.manifest.tools.length ? ["tools.site"] : []),
      ...(reg.manifest.mcpServers.length ? ["tools.mcp"] : []),
      ...(context.length ? ["context.read"] : []),
    ];
    const resources = {
      contractFingerprint: reg.fingerprint,
      mcpOrigins: reg.manifest.mcpServers.map(
        (server) => new URL(server.url).origin,
      ),
    };
    await state.approve(capabilities, {
      context,
      registrationId: reg.id,
      _resources: resources,
    });
    const prep = await state.ok("chat.prepare", {
      manifest,
      registrationId: reg.id,
    });
    if (reg.manifest.mcpServers.length)
      await state.approve(capabilities, {
        registrationId: reg.id,
        preparedId: prep.id,
        _resources: { ...resources, toolFingerprint: prep.toolFingerprint },
      });
    return {
      preparedId: prep.id,
      fingerprint: reg.fingerprint,
      registrationId: reg.id,
      history: [{ role: "user", content: "hi" }],
    };
  };
  return state;
}

export const toolReply = (name, args = "{}") =>
  Response.json({
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name, arguments: args },
            },
          ],
        },
      },
    ],
  });
