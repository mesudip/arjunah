import { BrokerError } from "./errors.js";
import { LIMITS } from "./constants.js";

export function requestSignal(signal) {
  const timeout = AbortSignal.timeout(LIMITS.timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function networkError(error, code, label) {
  if (error instanceof BrokerError) return error;
  if (["AbortError", "TimeoutError"].includes(error?.name))
    return new BrokerError(
      "TIMEOUT",
      `${label} request was cancelled or timed out.`,
    );
  return new BrokerError(code, `${label} request failed.`);
}

export async function* responseChunks(response, limit, code) {
  if (!response.body)
    throw new BrokerError(code, "The remote response had no body.");
  if (Number(response.headers.get("content-length")) > limit) {
    void response.body.cancel().catch(() => {});
    throw new BrokerError(code, "The remote response was too large.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit)
        throw new BrokerError(code, "The remote response was too large.");
      yield decoder.decode(value, { stream: true });
    }
    yield decoder.decode();
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function readJson(response, limit, code) {
  let text = "";
  for await (const chunk of responseChunks(response, limit, code))
    text += chunk;
  try {
    return JSON.parse(text);
  } catch {
    throw new BrokerError(code, "The remote response was invalid JSON.");
  }
}
