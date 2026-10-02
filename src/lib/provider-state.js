/**
 * Provider state kept between the rounds of a page-composed tool turn
 * (SPEC 5.4). Anthropic's signed thinking, Gemini's thought signatures, and
 * the Responses API's encrypted reasoning have to go back with the assistant
 * message that produced them, and a page's own loop never sees any of it, so
 * the extension holds it here and reattaches it when the page sends that
 * message back with the same tool-call ids.
 *
 * One IndexedDB database in the extension's own origin, one object store,
 * keyed `[origin, conversationKey, callIdsKey]`. Indexes put `lastUsed` and
 * `bytes` in the index key, so expiry, the per-origin and total caps, and LRU
 * eviction read keys only and never load a stored state they do not return.
 *
 * Losing state is always allowed: a round without it is what the page path
 * did before. So every failure here (no IndexedDB, quota, eviction, a hung
 * transaction) reads as "nothing stored" and never fails a round.
 */
import { LIMITS } from "./constants.js";

export const PROVIDER_STATE = Object.freeze({
  idleMs: 2 * 86_400_000,
  originBytes: 5_000_000,
  totalBytes: 50_000_000,
  entryBytes: LIMITS.providerStateBytes,
  // Expired entries are swept on access, but at most this often.
  sweepMs: 60_000,
  // A storage call that has not settled by now is treated as a failure.
  operationMs: 5_000,
});
const DATABASE = "arjunah";
const STORE = "providerState";

/** Tool-call ids as one key part: order matters, since it is the message's. */
export function callIdsKey(callIds) {
  return JSON.stringify(callIds);
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/**
 * The store's logic over a backend of primitive reads and writes. Operations
 * run one at a time in call order, so a release queued behind a write always
 * sees that write, and a lookup queued behind a release sees nothing.
 */
export function createProviderStateStore({ backend, now = Date.now } = {}) {
  let queue = Promise.resolve();
  let sweptAt = 0;
  let stamp = 0;
  // Strictly increasing, so two writes in one millisecond still have an order.
  const touch = () => (stamp = Math.max(now(), stamp + 1));
  const serial = (operation, fallback) => {
    const result = queue.then(async () => {
      if (!backend) return fallback;
      let timer;
      try {
        return await Promise.race([
          operation(),
          new Promise((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error("timeout")),
              PROVIDER_STATE.operationMs,
            );
          }),
        ]);
      } catch {
        return fallback;
      } finally {
        clearTimeout(timer);
      }
    });
    queue = result;
    return result;
  };
  async function sweep(force = false) {
    const at = now();
    if (!force && at - sweptAt < PROVIDER_STATE.sweepMs) return;
    sweptAt = at;
    const keys = await backend.expired(at - PROVIDER_STATE.idleMs);
    if (keys.length) await backend.remove(keys);
  }
  async function enforceCaps(origin) {
    const own = await backend.originEntries(origin);
    let size = own.reduce((sum, entry) => sum + entry.bytes, 0);
    const evicted = [];
    for (const entry of own) {
      if (size <= PROVIDER_STATE.originBytes) break;
      evicted.push(entry.key);
      size -= entry.bytes;
    }
    if (evicted.length) await backend.remove(evicted);
    const all = await backend.allEntries();
    size = all.reduce((sum, entry) => sum + entry.bytes, 0);
    evicted.length = 0;
    for (const entry of all) {
      if (size <= PROVIDER_STATE.totalBytes) break;
      evicted.push(entry.key);
      size -= entry.bytes;
    }
    if (evicted.length) await backend.remove(evicted);
  }
  async function removeConversation(origin, conversationKey) {
    const keys = await backend.conversationKeys(origin, conversationKey);
    if (keys.length) await backend.remove(keys);
  }
  return {
    /**
     * Stored state for the assistant messages of a turn, as a Map from each
     * message's `index` to its state. An entry answered by another model or
     * another provider configuration is deleted rather than returned.
     */
    lookup(origin, conversationKey, messages, { model, providerId, revision }) {
      return serial(async () => {
        await sweep();
        const found = new Map();
        const stale = [];
        for (const { index, callIds } of messages) {
          const key = [origin, conversationKey, callIdsKey(callIds)];
          const record = await backend.get(key);
          if (!record) continue;
          if (
            record.lastUsed <= now() - PROVIDER_STATE.idleMs ||
            record.model !== model ||
            record.providerId !== providerId ||
            record.revision !== revision
          ) {
            stale.push(key);
            continue;
          }
          found.set(index, record.state);
          await backend.put({ ...record, lastUsed: touch() });
        }
        if (stale.length) await backend.remove(stale);
        return found;
      }, new Map());
    },
    /**
     * Keeps one round's state. `keep` lists the tool-call ids of the assistant
     * messages of the request's current turn; every other entry of this
     * conversation belongs to an earlier turn or an abandoned branch and goes.
     * A round whose `signal` was aborted (revocation, navigation) stores
     * nothing, even when it was queued before the abort.
     */
    store(entry, { keep = [], signal } = {}) {
      return serial(async () => {
        if (signal?.aborted) return false;
        const bytes = byteLength(entry.state);
        if (bytes > PROVIDER_STATE.entryBytes) return false;
        await sweep();
        const record = {
          origin: entry.origin,
          conversationKey: entry.conversationKey,
          callIdsKey: callIdsKey(entry.callIds),
          callIds: entry.callIds,
          model: entry.model,
          providerId: entry.providerId,
          revision: entry.revision,
          state: entry.state,
          bytes,
          lastUsed: touch(),
        };
        const wanted = new Set([
          record.callIdsKey,
          ...keep.map((callIds) => callIdsKey(callIds)),
        ]);
        const outdated = (
          await backend.conversationKeys(record.origin, record.conversationKey)
        ).filter((key) => !wanted.has(key[2]));
        if (outdated.length) await backend.remove(outdated);
        await backend.put(record);
        await enforceCaps(record.origin);
        return true;
      }, false);
    },
    /** Ends one conversation: a final round, its release, a closed document. */
    release(origin, conversationKey) {
      return serial(() => removeConversation(origin, conversationKey), false);
    },
    /** Everything one origin left behind, on revocation. */
    clearOrigin(origin) {
      return serial(async () => {
        const keys = (await backend.originEntries(origin)).map(
          (entry) => entry.key,
        );
        if (keys.length) await backend.remove(keys);
      }, false);
    },
    clearAll() {
      return serial(() => backend.clear(), false);
    },
    /** The startup sweep, which does not wait for the access throttle. */
    sweep() {
      return serial(() => sweep(true), false);
    },
  };
}

/**
 * Plain IndexedDB, opened lazily and reopened after a failure or a close, so
 * one bad moment (an eviction, a quota error) is not remembered forever.
 */
export function indexedDbBackend(factory = globalThis.indexedDB) {
  let opening = null;
  const open = () =>
    (opening ??= new Promise((resolve, reject) => {
      const request = factory.open(DATABASE, 1);
      const fail = (error) => {
        opening = null;
        reject(error ?? new Error("IndexedDB is unavailable."));
      };
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, {
          keyPath: ["origin", "conversationKey", "callIdsKey"],
        });
        store.createIndex("conversation", ["origin", "conversationKey"]);
        store.createIndex("origin", ["origin", "lastUsed", "bytes"]);
        store.createIndex("lastUsed", ["lastUsed", "bytes"]);
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        db.onclose = () => {
          opening = null;
        };
        resolve(db);
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () => fail();
    }));
  /** One transaction; `work` reports its answer through `done`. */
  async function run(mode, work) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let answer;
      let transaction;
      try {
        transaction = db.transaction(STORE, mode);
      } catch (error) {
        opening = null;
        reject(error);
        return;
      }
      transaction.oncomplete = () => resolve(answer);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("IndexedDB aborted."));
      work(transaction.objectStore(STORE), (value) => {
        answer = value;
      });
    });
  }
  /** Keys only, in index order; values are never read. */
  function keyCursor(source, range, map, done) {
    const out = [];
    const request = source.openKeyCursor(range);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return done(out);
      out.push(map(cursor));
      cursor.continue();
    };
  }
  const sized = (offset) => (cursor) => ({
    key: cursor.primaryKey,
    lastUsed: cursor.key[offset],
    bytes: cursor.key[offset + 1],
  });
  return {
    get: (key) =>
      run("readonly", (store, done) => {
        const request = store.get(key);
        request.onsuccess = () => done(request.result);
      }),
    put: (record) => run("readwrite", (store) => store.put(record)),
    remove: (keys) =>
      run("readwrite", (store) => {
        for (const key of keys) store.delete(key);
      }),
    conversationKeys: (origin, conversationKey) =>
      run("readonly", (store, done) =>
        keyCursor(
          store.index("conversation"),
          IDBKeyRange.only([origin, conversationKey]),
          (cursor) => cursor.primaryKey,
          done,
        ),
      ),
    // `[origin, []]` sorts after every `[origin, number, number]`.
    originEntries: (origin) =>
      run("readonly", (store, done) =>
        keyCursor(
          store.index("origin"),
          IDBKeyRange.bound([origin], [origin, []]),
          sized(1),
          done,
        ),
      ),
    allEntries: () =>
      run("readonly", (store, done) =>
        keyCursor(store.index("lastUsed"), null, sized(0), done),
      ),
    expired: (before) =>
      run("readonly", (store, done) =>
        keyCursor(
          store.index("lastUsed"),
          IDBKeyRange.upperBound([before, Infinity]),
          (cursor) => cursor.primaryKey,
          done,
        ),
      ),
    clear: () => run("readwrite", (store) => store.clear()),
  };
}

/**
 * The same backend contract in memory, ordered the way the IndexedDB indexes
 * are. Node has no IndexedDB, so unit tests run the store on this.
 */
export function memoryBackend() {
  const records = new Map();
  const id = (key) => JSON.stringify(key);
  const byAge = (a, b) =>
    a.lastUsed - b.lastUsed ||
    a.bytes - b.bytes ||
    (id(a.key) < id(b.key) ? -1 : 1);
  const entries = (filter) =>
    [...records.values()]
      .filter(filter)
      .map((record) => ({
        key: [record.origin, record.conversationKey, record.callIdsKey],
        lastUsed: record.lastUsed,
        bytes: record.bytes,
      }))
      .sort(byAge);
  return {
    records,
    async get(key) {
      const record = records.get(id(key));
      return record ? structuredClone(record) : undefined;
    },
    async put(record) {
      records.set(
        id([record.origin, record.conversationKey, record.callIdsKey]),
        structuredClone(record),
      );
    },
    async remove(keys) {
      for (const key of keys) records.delete(id(key));
    },
    async conversationKeys(origin, conversationKey) {
      return entries(
        (record) =>
          record.origin === origin &&
          record.conversationKey === conversationKey,
      ).map((entry) => entry.key);
    },
    async originEntries(origin) {
      return entries((record) => record.origin === origin);
    },
    async allEntries() {
      return entries(() => true);
    },
    async expired(before) {
      return entries((record) => record.lastUsed <= before).map(
        (entry) => entry.key,
      );
    },
    async clear() {
      records.clear();
    },
  };
}

let shared = null;
/** The extension's one store: IndexedDB when the browser offers it, else none. */
export function providerStateStore() {
  return (shared ??= createProviderStateStore({
    backend:
      typeof indexedDB === "object" && indexedDB ? indexedDbBackend() : null,
  }));
}
/** Node has no IndexedDB: unit tests install a store on `memoryBackend()`. */
export function installProviderStateStore(store) {
  shared = store;
}
