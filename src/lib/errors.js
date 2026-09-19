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
]);

export class BrokerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "AIError";
    this.code = CODES.has(code) ? code : "INTERNAL_ERROR";
    if (details !== undefined) this.details = details;
  }
}

export function publicError(error) {
  const safe =
    error instanceof BrokerError
      ? error
      : new BrokerError(
          "INTERNAL_ERROR",
          "The AI broker could not complete the request.",
        );
  return {
    name: "AIError",
    code: safe.code,
    message: safe.message,
    details: safe.details,
  };
}
