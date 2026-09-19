// Turns the broker's OpenAI-style message list into a system prompt plus a
// single prompt for CLI agents that accept one user message per run.

const PROMPT_LIMIT = 200_000;

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
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
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
      return results.every((item) => ids.has(item.id)) ? results : null;
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
