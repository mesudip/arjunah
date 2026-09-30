import { LIMITS } from "./constants.js";

/**
 * Merges a round's streamed thinking before it crosses to the widget. Every
 * provider token would otherwise be its own extension message, each with a
 * full activity envelope around a word or two of text.
 *
 * Text waits at most `reasoningBatchMs` and `reasoningBatchChars`. Any other
 * progress item sends the pending text first, so the order the provider
 * produced is the order the widget draws. The renderer splits what arrives
 * into chunks of at most fifty words.
 */
export function reasoningBatcher(send) {
  let pending = "";
  let timer = 0;
  const flush = () => {
    clearTimeout(timer);
    timer = 0;
    if (!pending) return;
    const text = pending;
    pending = "";
    send({ type: "reasoning_delta", text });
  };
  return {
    push(step) {
      if (step?.type !== "reasoning_delta") {
        flush();
        send(step);
        return;
      }
      pending += String(step.text ?? "");
      if (pending.length >= LIMITS.reasoningBatchChars) flush();
      else if (!timer) timer = setTimeout(flush, LIMITS.reasoningBatchMs);
    },
    flush,
  };
}
