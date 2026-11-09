import { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { SingleResponseTransport } from "../transport/mcp-transport.ts";
import { registerAllTools } from "../tools/index.ts";
import { createLogger } from "../utils/logger.ts";

const logger = createLogger({ component: "mcp-endpoints" });

// Tools-only server: nothing is ever pushed to the client, so the optional
// server-to-client GET stream is declined (allowed by Streamable HTTP).
export function handleMcpGet(c: Context) {
  return c.body(null, 405, { Allow: "POST" });
}

function rpcError(c: Context, status: 400 | 500, id: unknown, code: number, message: string) {
  const validId = typeof id === "string" || typeof id === "number" ? id : null;
  return c.json({ jsonrpc: "2.0", id: validId, error: { code, message } }, status);
}

export async function handleMcpPost(c: Context) {
  const mcpToken = c.get("mcpToken") as string;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return rpcError(c, 400, null, -32700, "Request body is not valid JSON");
  }

  // JSON-RPC batches are rejected: no current client sends them, and later
  // MCP protocol versions require a single message per POST.
  if (Array.isArray(body)) {
    return rpcError(c, 400, null, -32600, "JSON-RPC batches are not supported");
  }
  const msg = body as Record<string, unknown> | null;
  if (
    typeof msg !== "object" || msg === null || msg.jsonrpc !== "2.0" ||
    (msg.method !== undefined && typeof msg.method !== "string") ||
    (msg.method === undefined && !("result" in msg || "error" in msg))
  ) {
    return rpcError(c, 400, msg?.id, -32600, "Invalid JSON-RPC message");
  }
  const message = msg as unknown as JSONRPCMessage;

  const server = new McpServer(
    { name: "google-tasks-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerAllTools(server, mcpToken);
  const transport = new SingleResponseTransport();
  try {
    await server.connect(transport);

    // Notifications and responses carry no id and produce no reply: ack with 202.
    const isRequest = "method" in message && "id" in message;
    if (!isRequest) {
      transport.onmessage?.(message);
      return c.body(null, 202);
    }

    transport.onmessage?.(message);
    const reply = JSON.stringify(await transport.reply);

    // Streamable HTTP clients accept JSON; only fall back to a one-event SSE
    // body (finite, closes with the response) when JSON is not accepted.
    const accept = c.req.header("accept") ?? "";
    if (accept.includes("text/event-stream") && !accept.includes("application/json")) {
      return c.body(`event: message\ndata: ${reply}\n\n`, 200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
    }
    return c.body(reply, 200, { "Content-Type": "application/json" });
  } catch (error) {
    logger.error("MCP request failed", { error: String(error) });
    return rpcError(c, 500, msg.id, -32603, "Internal error");
  } finally {
    server.close().catch(() => {});
  }
}
