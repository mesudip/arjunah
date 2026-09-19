import test from "node:test";
import assert from "node:assert/strict";
import { callMcpTool, clearMcpSessions, listMcpTools } from "../src/lib/mcp.js";

test("MCP client performs initialization, discovery, and calls with a session", async () => {
  clearMcpSessions();
  const methods = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    methods.push({
      method: request.method,
      session: init.headers["Mcp-Session-Id"],
    });
    if (request.method === "notifications/initialized")
      return new Response("", { status: 202 });
    const result =
      request.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: {},
            serverInfo: { name: "test", version: "1" },
          }
        : request.method === "tools/list"
          ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
          : { content: [{ type: "text", text: "ok" }] };
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
      {
        status: 200,
        headers:
          request.method === "initialize"
            ? {
                "Mcp-Session-Id": "session-1",
                "Content-Type": "application/json",
              }
            : { "Content-Type": "application/json" },
      },
    );
  };
  try {
    const server = {
      id: "demo",
      name: "Demo",
      url: "https://mcp.test/rpc",
      headers: {},
    };
    assert.equal((await listMcpTools(server))[0].name, "echo");
    await callMcpTool(server, "echo", { value: 1 });
    assert.deepEqual(
      methods.map((item) => item.method),
      ["initialize", "notifications/initialized", "tools/list", "tools/call"],
    );
    assert.equal(methods[2].session, "session-1");
  } finally {
    globalThis.fetch = originalFetch;
    clearMcpSessions();
  }
});

for (const mode of ["multiline", "notifications", "open-stream"]) {
  test(`MCP SSE parses ${mode} and returns the matching response without waiting for EOF`, async (t) => {
    clearMcpSessions();
    const originalFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = originalFetch;
      clearMcpSessions();
    });
    let cancelled = false;
    globalThis.fetch = async (_url, init) => {
      const req = JSON.parse(init.body);
      if (req.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (req.method === "initialize")
        return Response.json({
          jsonrpc: "2.0",
          id: req.id,
          result: { protocolVersion: "2025-03-26" },
        });
      const result = { tools: [{ name: "echo" }] };
      const event =
        mode === "multiline"
          ? `data: {"jsonrpc":"2.0",\r\ndata: "id":${req.id},"result":${JSON.stringify(result)}}\r\n\r\n`
          : `data: ${JSON.stringify({ jsonrpc: "2.0", id: req.id, result })}\n\n`;
      const prefix =
        mode === "notifications"
          ? 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'
          : "";
      return new Response(
        new ReadableStream({
          start(c) {
            for (const char of prefix + event)
              c.enqueue(new TextEncoder().encode(char));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };
    assert.equal(
      (await listMcpTools({ url: "https://mcp.test", headers: {} }))[0].name,
      "echo",
    );
    assert.equal(cancelled, true);
  });
}

test("MCP rejects mismatched IDs and malformed envelopes without exposing response bodies", async (t) => {
  clearMcpSessions();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearMcpSessions();
  });
  globalThis.fetch = async () =>
    Response.json({
      jsonrpc: "2.0",
      id: 999,
      result: { secret: "sensitive-server-body" },
    });
  await assert.rejects(
    listMcpTools({ url: "https://mcp.test" }),
    (error) =>
      error.code === "TOOL_ERROR" &&
      !error.message.includes("sensitive-server-body"),
  );
});

test("MCP renews an expired session once and discovers all bounded pages", async (t) => {
  clearMcpSessions();
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    clearMcpSessions();
  });
  let initialized = 0,
    expired = false;
  const methods = [];
  globalThis.fetch = async (_url, init) => {
    const req = JSON.parse(init.body);
    methods.push(req.method);
    if (req.method === "notifications/initialized")
      return new Response(null, { status: 202 });
    if (req.method === "initialize") {
      initialized++;
      assert.equal(init.headers["Mcp-Session-Id"], undefined);
      return Response.json(
        {
          jsonrpc: "2.0",
          id: req.id,
          result: { protocolVersion: "2025-03-26" },
        },
        { headers: { "Mcp-Session-Id": `session-${initialized}` } },
      );
    }
    if (!expired) {
      expired = true;
      return new Response(null, { status: 404 });
    }
    const result = req.params.cursor
      ? { tools: [{ name: "second" }] }
      : { tools: [{ name: "first" }], nextCursor: "next" };
    return Response.json({ jsonrpc: "2.0", id: req.id, result });
  };
  assert.deepEqual(
    (await listMcpTools({ url: "https://mcp.test" })).map((tool) => tool.name),
    ["first", "second"],
  );
  assert.equal(initialized, 2);
  assert.equal(methods.filter((m) => m === "tools/list").length, 3);
});
