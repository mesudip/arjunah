import { BrokerError } from "./errors.js";
import { LIMITS, VERSION } from "./constants.js";
import { cloneJson } from "./validation.js";
import { validateSchema } from "./schema.js";
import {
  readJson,
  responseChunks,
  requestSignal,
  networkError,
} from "./network.js";

const sessions = new Map();
const protocolVersion = "2025-03-26";
const sessionKey = (server) =>
  `${server.sessionScope ?? "global"}\n${server.url}\n${JSON.stringify(server.headers ?? {})}`;
class ExpiredSession extends Error {}

function rpcResult(payload, id, ignoreUnrelated = false) {
  if (!payload || payload.jsonrpc !== "2.0")
    throw new BrokerError("TOOL_ERROR", "Invalid MCP response envelope.");
  if (payload.id !== id) {
    if (ignoreUnrelated) return { matched: false };
    throw new BrokerError(
      "TOOL_ERROR",
      "MCP response ID did not match the request.",
    );
  }
  if (payload.error)
    throw new BrokerError("TOOL_ERROR", "The MCP server reported an error.");
  if (!Object.hasOwn(payload, "result"))
    throw new BrokerError(
      "TOOL_ERROR",
      "The MCP response did not contain a result.",
    );
  return { matched: true, value: payload.result };
}

async function readRpc(response, id) {
  if (!response.headers.get("content-type")?.includes("text/event-stream"))
    return rpcResult(
      await readJson(response, LIMITS.mcpResponseBytes, "TOOL_ERROR"),
      id,
    ).value;
  let buffer = "",
    data = [];
  for await (const chunk of responseChunks(
    response,
    LIMITS.mcpResponseBytes,
    "TOOL_ERROR",
  )) {
    buffer += chunk;
    while (true) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (!match || (match[0] === "\r" && match.index === buffer.length - 1))
        break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (line === "" && data.length) {
        let payload;
        try {
          payload = JSON.parse(data.join("\n"));
        } catch {
          throw new BrokerError(
            "TOOL_ERROR",
            "The MCP server returned invalid event data.",
          );
        }
        data = [];
        for (const item of Array.isArray(payload) ? payload : [payload]) {
          const result = rpcResult(item, id, true);
          if (result.matched) return result.value;
        }
      } else if (line.startsWith("data:"))
        data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  throw new BrokerError(
    "TOOL_ERROR",
    "The MCP stream ended without a matching response.",
  );
}

async function rpc(
  server,
  state,
  method,
  params,
  signal,
  notification = false,
) {
  const id = notification ? undefined : state.nextId++;
  const body = {
    jsonrpc: "2.0",
    method,
    ...(id == null ? {} : { id }),
    ...(params == null ? {} : { params }),
  };
  const headers = {
    ...server.headers,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (state.sessionId) headers["Mcp-Session-Id"] = state.sessionId;
  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: requestSignal(signal),
      redirect: "error",
      credentials: "omit",
    });
    if (response.status === 404 && state.sessionId) {
      void response.body?.cancel().catch(() => {});
      throw new ExpiredSession();
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new BrokerError(
        "TOOL_ERROR",
        `MCP server rejected the request (${response.status}).`,
      );
    }
    if (notification) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    const result = await readRpc(response, id);
    if (method === "initialize") {
      const sessionId = response.headers.get("Mcp-Session-Id");
      if (
        sessionId &&
        (!/^[\x21-\x7e]+$/.test(sessionId) || sessionId.length > 1000)
      )
        throw new BrokerError("TOOL_ERROR", "Invalid MCP session identifier.");
      state.sessionId = sessionId;
    }
    return result;
  } catch (error) {
    if (error instanceof ExpiredSession) throw error;
    throw networkError(error, "TOOL_ERROR", "MCP");
  }
}

async function initialize(server, signal) {
  const key = sessionKey(server);
  let state = sessions.get(key);
  if (!state) {
    if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
    state = { nextId: 1, sessionId: null };
    sessions.set(key, state);
    state.ready = (async () => {
      const result = await rpc(
        server,
        state,
        "initialize",
        {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "arjunah", version: VERSION },
        },
        signal,
      );
      if (result?.protocolVersion !== protocolVersion)
        throw new BrokerError(
          "TOOL_ERROR",
          "Unsupported MCP protocol version.",
        );
      await rpc(
        server,
        state,
        "notifications/initialized",
        undefined,
        signal,
        true,
      );
    })();
  }
  try {
    await state.ready;
    return state;
  } catch (error) {
    if (sessions.get(key) === state) sessions.delete(key);
    throw error;
  }
}

async function request(server, method, params, signal) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const state = await initialize(server, signal);
    try {
      return await rpc(server, state, method, params, signal);
    } catch (error) {
      if (!(error instanceof ExpiredSession)) throw error;
      if (sessions.get(sessionKey(server)) === state)
        sessions.delete(sessionKey(server));
    }
  }
  throw new BrokerError("TOOL_ERROR", "The MCP session expired repeatedly.");
}

export async function listMcpTools(server, signal) {
  const tools = [],
    names = new Set(),
    cursors = new Set();
  let cursor;
  do {
    const result = await request(
      server,
      "tools/list",
      cursor ? { cursor } : {},
      signal,
    );
    if (!Array.isArray(result?.tools))
      throw new BrokerError("TOOL_ERROR", "Invalid MCP tool list.");
    for (const tool of result.tools) {
      if (
        tools.length >= LIMITS.tools ||
        typeof tool?.name !== "string" ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) ||
        names.has(tool.name)
      )
        throw new BrokerError(
          "TOOL_ERROR",
          "MCP tools exceed limits or contain invalid/duplicate names.",
        );
      let inputSchema;
      try {
        inputSchema = validateSchema(
          cloneJson(
            tool.inputSchema ?? { type: "object" },
            "MCP schema",
            LIMITS.schemaBytes,
          ),
        );
      } catch {
        throw new BrokerError(
          "TOOL_ERROR",
          "An MCP tool has an unsupported or invalid schema.",
        );
      }
      if (
        tool.description != null &&
        (typeof tool.description !== "string" || tool.description.length > 500)
      )
        throw new BrokerError(
          "TOOL_ERROR",
          "An MCP tool description exceeds the supported limit.",
        );
      tools.push({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema,
      });
      names.add(tool.name);
    }
    cursor = result.nextCursor;
    if (
      cursor != null &&
      (typeof cursor !== "string" ||
        !cursor ||
        cursor.length > 2000 ||
        cursors.has(cursor) ||
        cursors.size >= 16)
    )
      throw new BrokerError("TOOL_ERROR", "Invalid MCP pagination cursor.");
    cursors.add(cursor);
  } while (cursor != null);
  return tools;
}

export async function callMcpTool(server, name, args, signal, meta) {
  // `_meta` carries the extension-minted conversation id (SPEC 7.7) so a site
  // backend can correlate calls without the page taking part.
  return request(
    server,
    "tools/call",
    { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
    signal,
  );
}

export function clearMcpSessions(origin, session) {
  if (!origin) sessions.clear();
  else
    for (const key of sessions.keys())
      if (key.startsWith(`${origin}\n${session ? `${session}\n` : ""}`))
        sessions.delete(key);
}
