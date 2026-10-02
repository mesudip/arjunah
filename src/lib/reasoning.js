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

/**
 * The same merging for a page's own round stream (SPEC 5.3), where answer
 * text is batched as well as thinking: each delta would otherwise be one
 * extension message and one page bridge message.
 *
 * Adjacent text of one type is merged for at most `reasoningBatchMs` and sent
 * in pieces of at most `reasoningBatchChars`; a delta of the other type sends
 * the pending text first, so the page sees the provider's order. `caps` holds
 * each type's total for the round to the final result's bound, so the deltas
 * never carry more than the result may.
 */
export function roundBatcher(send, caps) {
  let pending = null;
  let timer = 0;
  const used = new Map();
  const drain = (all) => {
    while (
      pending &&
      (pending.text.length >= LIMITS.reasoningBatchChars ||
        (all && pending.text))
    ) {
      const text = pending.text.slice(0, LIMITS.reasoningBatchChars);
      pending.text = pending.text.slice(text.length);
      send({ type: pending.type, text });
    }
    if (pending && !pending.text) pending = null;
  };
  const flush = () => {
    clearTimeout(timer);
    timer = 0;
    drain(true);
  };
  return {
    push(type, value) {
      const room = (caps[type] ?? 0) - (used.get(type) ?? 0);
      const text = String(value ?? "").slice(0, Math.max(0, room));
      if (!text) return;
      used.set(type, (used.get(type) ?? 0) + text.length);
      if (pending && pending.type !== type) flush();
      pending ??= { type, text: "" };
      pending.text += text;
      drain(false);
      if (!pending) {
        clearTimeout(timer);
        timer = 0;
      } else if (!timer) timer = setTimeout(flush, LIMITS.reasoningBatchMs);
    },
    flush,
  };
}
