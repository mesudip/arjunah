import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const DEFAULT_PORT = 48123;
const STORE_VERSION = 1;

export function dataDirectory() {
  if (process.env.ARJUNAH_DESKTOP_HOME) return process.env.ARJUNAH_DESKTOP_HOME;
  const home = homedir();
  if (process.platform === "darwin")
    return join(home, "Library", "Application Support", "arjunah");
  if (process.platform === "win32")
    return join(
      process.env.APPDATA ?? join(home, "AppData", "Roaming"),
      "arjunah",
    );
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "arjunah");
}

function defaults() {
  return {
    version: STORE_VERSION,
    port: DEFAULT_PORT,
    deviceName: hostname(),
    clients: [],
    sync: { revision: 0, updatedAt: null, source: null, config: null },
    settings: { experimentalCodex: false },
  };
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function newToken() {
  return randomBytes(32).toString("base64url");
}

export class Store {
  constructor(directory = dataDirectory()) {
    this.directory = directory;
    this.path = join(directory, "desktop.json");
    this.data = defaults();
    this.load();
  }
  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      if (parsed?.version === STORE_VERSION)
        this.data = {
          ...defaults(),
          ...parsed,
          settings: { ...defaults().settings, ...parsed.settings },
        };
    } catch {
      /* first run */
    }
  }
  save() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data, null, 2), {
      mode: 0o600,
    });
    try {
      chmodSync(temporary, 0o600);
    } catch {
      /* platform without POSIX modes */
    }
    renameSync(temporary, this.path);
  }
  get port() {
    return (
      Number(process.env.ARJUNAH_DESKTOP_PORT) || this.data.port || DEFAULT_PORT
    );
  }
  addClient(info) {
    const token = newToken();
    const client = {
      id: randomBytes(8).toString("hex"),
      name: String(info.name ?? "Browser extension").slice(0, 80),
      browser: String(info.browser ?? "unknown").slice(0, 40),
      extensionId: String(info.extensionId ?? "").slice(0, 120),
      tokenHash: hashToken(token),
      pairedAt: new Date().toISOString(),
      lastSeenAt: null,
    };
    this.data.clients = [...this.data.clients.slice(-31), client];
    this.save();
    return { token, client: publicClient(client) };
  }
  authenticate(token) {
    if (typeof token !== "string" || token.length < 20 || token.length > 200)
      return null;
    const hash = hashToken(token);
    const client = this.data.clients.find((item) => item.tokenHash === hash);
    if (!client) return null;
    const now = new Date().toISOString();
    if (
      !client.lastSeenAt ||
      Date.parse(now) - Date.parse(client.lastSeenAt) > 60_000
    ) {
      client.lastSeenAt = now;
      this.save();
    }
    return client;
  }
  revokeClient(id) {
    const before = this.data.clients.length;
    this.data.clients = this.data.clients.filter((item) => item.id !== id);
    if (this.data.clients.length !== before) this.save();
    return this.data.clients.length !== before;
  }
  listClients() {
    return this.data.clients.map(publicClient);
  }
  get sync() {
    return this.data.sync;
  }
  updateSync(config, source) {
    this.data.sync = {
      revision: (this.data.sync.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      source,
      config,
    };
    this.save();
    return this.data.sync;
  }
  get settings() {
    return this.data.settings;
  }
  updateSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.data.settings;
  }
}

export function publicClient(client) {
  const { tokenHash: _hash, ...rest } = client;
  return rest;
}
