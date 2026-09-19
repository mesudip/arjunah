/**
 * अर्जुनः (Arjunah) SDK: a thin, typed layer over the page API that the
 * browser extension injects at `window.ai.arjunah`.
 *
 * The extension is the source of truth; this package only finds it, waits
 * for it, and types it. Nothing here talks to a model or holds a credential.
 */
import type {
  AIAccessRequest,
  AIErrorCode,
  AISession,
  AISiteManifest,
  Arjunah,
} from "./types.js";

export * from "./types.js";

/** The protocol version this SDK was written against. */
export const PROTOCOL_VERSION = "1.0.0";
/** Dispatched on `window` once `window.ai.arjunah` is installed. */
export const READY_EVENT = "arjunah:ready";
/** Dispatched on `window` when another actor already owns the namespace. */
export const CONFLICT_EVENT = "arjunah:conflict";

declare global {
  interface Window {
    /** Shared namespace; अर्जुनः owns only `window.ai.arjunah`. */
    readonly ai?: { readonly arjunah?: Arjunah };
  }
}

/** The error shape every rejected page API promise carries. */
export interface AIError extends Error {
  name: "AIError";
  /** SPEC section 9 codes, plus `NOT_INSTALLED` raised by this SDK. */
  code: AIErrorCode | "NOT_INSTALLED";
  details?: unknown;
}

export function isAIError(error: unknown): error is AIError {
  return (
    error instanceof Error &&
    error.name === "AIError" &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

function notInstalled(): AIError {
  const error = new Error(
    "अर्जुनः is not installed in this browser.",
  ) as AIError;
  error.name = "AIError";
  error.code = "NOT_INSTALLED";
  return error;
}

/** The injected API, or `undefined` when the extension is absent or not yet injected. */
export function getArjunah(): Arjunah | undefined {
  return typeof window === "undefined" ? undefined : window.ai?.arjunah;
}

/** True once the extension has injected the API into this page. */
export function isInstalled(): boolean {
  return getArjunah() !== undefined;
}

export interface WaitOptions {
  /** How long to wait for `arjunah:ready` before rejecting with `NOT_INSTALLED`. Default 3000. */
  timeoutMs?: number;
}

/**
 * Resolves with the API as soon as it is present. The extension injects at
 * document start, so this usually resolves immediately; the event listener
 * covers pages whose script ran first.
 */
export function waitForArjunah({
  timeoutMs = 3000,
}: WaitOptions = {}): Promise<Arjunah> {
  const present = getArjunah();
  if (present) return Promise.resolve(present);
  if (typeof window === "undefined") return Promise.reject(notInstalled());
  return new Promise((resolve, reject) => {
    const onReady = () => {
      const api = getArjunah();
      if (!api) return;
      clearTimeout(timer);
      window.removeEventListener(READY_EVENT, onReady);
      resolve(api);
    };
    const timer = setTimeout(() => {
      window.removeEventListener(READY_EVENT, onReady);
      reject(notInstalled());
    }, timeoutMs);
    window.addEventListener(READY_EVENT, onReady);
  });
}

/** Whether this origin already holds level 1 or 2 access. */
export async function isEnabled(options?: WaitOptions): Promise<boolean> {
  return (await waitForArjunah(options)).isEnabled();
}

/**
 * Wallet-style connect: asks for level 1 (`completion`) unless the request
 * says otherwise and resolves to the session carrying `models`, `providers`,
 * `context`, and `permissions`. Does not prompt when the access is already held.
 */
export async function enable(
  request?: AIAccessRequest,
  options?: WaitOptions,
): Promise<AISession> {
  return (await waitForArjunah(options)).enable(request);
}

/** Hands the origin's whole grant back. */
export async function disable(options?: WaitOptions): Promise<true> {
  return (await waitForArjunah(options)).disable();
}

/** Level 0: publish the assistant contract the extension hosts. Needs no grant. */
export async function registerSite(
  manifest: AISiteManifest,
  options?: WaitOptions,
): Promise<{ id: string; unregister(): Promise<boolean> }> {
  return (await waitForArjunah(options)).site.register(manifest);
}

/** Opens the extension-hosted chat panel for the registered assistant. */
export async function openChat(options?: WaitOptions): Promise<true> {
  return (await waitForArjunah(options)).chat.open();
}
