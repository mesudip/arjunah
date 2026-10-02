// SPDX-License-Identifier: MIT
const CODES = new Set([
  "INVALID_REQUEST",
  "NOT_SUPPORTED",
  "NOT_CONFIGURED",
  "PERMISSION_REQUIRED",
  "USER_DENIED",
  "PROVIDER_ERROR",
  "TOOL_ERROR",
  "TIMEOUT",
  "INTERNAL_ERROR",
  "ABORTED",
  "CONTEXT_TOO_LONG",
  "RATE_LIMITED",
  "MODEL_UNAVAILABLE",
]);
// Codes whose failure is transient on the extension's or the provider's side,
// so the same request sent again later may succeed unchanged (SPEC 9). Any
// other code is retryable only when the error itself says so, as a provider's
// 5xx answer or a dropped connection does.
const RETRYABLE = new Set(["TIMEOUT", "RATE_LIMITED"]);

export class BrokerError extends Error {
  constructor(code, message, details, { retryable } = {}) {
    super(message);
    this.name = "AIError";
    this.code = CODES.has(code) ? code : "INTERNAL_ERROR";
    if (details !== undefined) this.details = details;
    if (typeof retryable === "boolean") this.retryable = retryable;
  }
}

export function isRetryable(code) {
  return RETRYABLE.has(code);
}

/**
 * The page-visible form of an error. `details` is always an object: whatever
 * members the error already carried (an invalid `field`, the missing
 * `capabilities`, `retryAfterMs`) plus `retryable`. The content script adds
 * `requestId`, the bridge id that only it knows.
 */
export function publicError(error) {
  const safe =
    error instanceof BrokerError
      ? error
      : new BrokerError(
          "INTERNAL_ERROR",
          "The AI broker could not complete the request.",
        );
  const own =
    safe.details &&
    typeof safe.details === "object" &&
    !Array.isArray(safe.details)
      ? safe.details
      : {};
  return {
    name: "AIError",
    code: safe.code,
    message: safe.message,
    details: {
      ...own,
      retryable:
        typeof safe.retryable === "boolean"
          ? safe.retryable
          : isRetryable(safe.code),
    },
  };
}
