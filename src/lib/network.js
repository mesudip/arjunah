import { BrokerError } from "./errors.js";
import { LIMITS } from "./constants.js";

/**
 * The signal a remote call runs under. The deadline covers the whole exchange,
 * body included, so a streamed answer that outlives it dies mid-flight with
 * bytes still arriving. Generation passes `null` for exactly that reason: a
 * round is bounded by the visitor's stop button and by `LIMITS.stallNoticeMs`
 * telling them the model is slow, not by a clock that cannot tell a hung
 * socket from a model that is thinking.
 */
export function requestSignal(signal, timeoutMs = LIMITS.timeoutMs) {
  if (timeoutMs == null) return signal ?? undefined;
  const timeout = AbortSignal.timeout(timeoutMs);
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
