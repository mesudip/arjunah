// Turns the broker's OpenAI-style message list into a system prompt plus a
// single prompt for CLI agents that accept one user message per run.

const PROMPT_LIMIT = 200_000;

// Image attachments travel beside the flattened text, because a CLI agent takes
// one prompt on stdin and cannot be handed a content-part array. Each adapter
// decides how to deliver them (a base64 block for Claude Code, a scratch file
// for Codex); the bounds here match the browser-side ones in src/lib/constants.js.
export const IMAGE_MEDIA_TYPES = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
export const IMAGE_LIMITS = Object.freeze({
  perMessage: 4,
  perPrompt: 8,
  dataChars: 2_000_000,
});

/**
 * The images carried by the messages that make up one prompt, in order. A
 * replayed conversation can hold more than one turn's worth, so the most recent
 * survive: they are the ones the final user message is asking about.
 */
export function collectImages(messages, limit = IMAGE_LIMITS.perPrompt) {
  const images = [];
  for (const message of messages)
    for (const image of message.images ?? []) images.push(image);
  return images.slice(-limit);
}

function toolCallText(call) {
  return `[assistant requested tool "${call.function.name}" (id ${call.id}) with arguments ${call.function.arguments}]`;
}

export function splitMessages(messages) {
  const system = [];
  const rest = [];
  for (const message of messages)
    (message.role === "system" ? system : rest).push(message);
  return {
    systemPrompt: system.map((item) => item.content).join("\n\n"),
    conversation: rest,
  };
}

export function buildPrompt(messages) {
  const { systemPrompt, conversation } = splitMessages(messages);
  const last = conversation.at(-1);
  if (conversation.length === 1 && last.role === "user" && !last.tool_calls)
    return { systemPrompt, prompt: last.content, transcript: false };
  const lines = [
    "The following is the conversation so far between the user and you (the assistant). Lines are prefixed with the speaker role. Continue the conversation by replying to the final message as the assistant. Output only your reply.",
    "",
  ];
  for (const message of conversation) {
    if (message.role === "tool") {
      lines.push(`tool (${message.tool_call_id}): ${message.content}`);
      continue;
    }
    const parts = [];
    if (message.content) parts.push(message.content);
    for (const call of message.tool_calls ?? []) parts.push(toolCallText(call));
    lines.push(`${message.role}: ${parts.join("\n")}`);
  }
  if (last.role === "tool")
    lines.push(
      "",
      "The tool results above are now available. Reply to the user as the assistant.",
    );
  let prompt = lines.join("\n");
  if (prompt.length > PROMPT_LIMIT)
    prompt = `${lines[0]}\n\n[earlier conversation truncated]\n${prompt.slice(-PROMPT_LIMIT)}`;
  return { systemPrompt, prompt, transcript: true };
}

/** Tool results that follow the final assistant tool_calls message, or null. */
export function trailingToolResults(messages) {
  const results = [];
  const imageFollowups = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    // Section 7.4 represents an image returned by a tool as a user image
    // message after the textual tool result. A subscription agent is still
    // suspended inside its MCP call at this point, so keep recognizing the
    // result and return the images through that open call instead of launching
    // a second writer for the persisted agent thread.
    if (
      message.role === "user" &&
      Array.isArray(message.images) &&
      message.images.length
    ) {
      imageFollowups.unshift(message);
      continue;
    }
    if (message.role === "tool") {
      results.unshift({ id: message.tool_call_id, content: message.content });
      continue;
    }
    if (
      message.role === "assistant" &&
      message.tool_calls?.length &&
      results.length
    ) {
      const ids = new Set(message.tool_calls.map((call) => call.id));
      if (!results.every((item) => ids.has(item.id))) return null;
      if (imageFollowups.length) {
        // Tool calls in one round are returned as one batch. Attach the
        // provider-neutral follow-up images to the final result in that batch;
        // their bounded labels still identify the originating tool.
        const target = results.at(-1);
        target.content = [
          target.content,
          ...imageFollowups.map((item) => item.content),
        ]
          .filter(Boolean)
          .join("\n\n");
        target.images = imageFollowups.flatMap((item) => item.images);
      }
      return results;
    }
    return null;
  }
  return null;
}

/**
 * The prompt for a resumed agent thread: only the conversation the thread has
 * not seen yet. A single new user message is sent verbatim; anything more is
 * sent as a short transcript so the agent keeps the roles straight.
 */
export function buildContinuation(newMessages) {
  if (
    newMessages.length === 1 &&
    newMessages[0].role === "user" &&
    !newMessages[0].tool_calls
  )
    return newMessages[0].content;
  const lines = [
    "The conversation continued. Lines are prefixed with the speaker role. Reply to the final message as the assistant. Output only your reply.",
    "",
  ];
  for (const message of newMessages) {
    if (message.role === "tool") {
      lines.push(`tool (${message.tool_call_id}): ${message.content}`);
      continue;
    }
    const parts = [];
    if (message.content) parts.push(message.content);
    for (const call of message.tool_calls ?? []) parts.push(toolCallText(call));
    lines.push(`${message.role}: ${parts.join("\n")}`);
  }
  return lines.join("\n").slice(-PROMPT_LIMIT);
}
