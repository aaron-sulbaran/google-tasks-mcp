import { Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import process from "node:process";
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
  const idOf = (body as { id?: unknown } | null)?.id;
  // The SDK's own schema decides what is a valid envelope; anything it would
  // reject during dispatch must be refused here instead. A client-sent
  // response (result or error, no method) is not a request or notification.
  const parsed = JSONRPCMessageSchema.safeParse(body);
  if (!parsed.success || !("method" in parsed.data)) {
    return rpcError(c, 400, idOf, -32600, "Invalid JSON-RPC message");
  }
  const message = parsed.data;
  const msg = { id: idOf };

  const server = new McpServer(
    { name: "google-tasks-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerAllTools(server, mcpToken);
  const transport = new SingleResponseTransport();
  server.server.onerror = (error) => transport.fail(error);
  // Backstop for a handler that never answers; armed only while a request is
  // in flight and cleared in finally, so it never holds an idle isolate awake.
  const limitMs = Number(process.env.MCP_REQUEST_TIMEOUT_MS) || 25000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("MCP_TIMEOUT")), limitMs);
  });
  try {
    await server.connect(transport);

    // Notifications and responses carry no id and produce no reply: ack with 202.
    const isRequest = "method" in message && "id" in message;
    if (!isRequest) {
      transport.onmessage?.(message);
      return c.body(null, 202);
    }

    transport.onmessage?.(message);
    const reply = JSON.stringify(await Promise.race([transport.reply, timedOut]));

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
    if (String(error).includes("MCP_TIMEOUT")) {
      return c.json({ jsonrpc: "2.0", id: idOf ?? null, error: { code: -32603, message: "Request timed out" } }, 504);
    }
    return rpcError(c, 500, msg.id, -32603, "Internal error");
  } finally {
    clearTimeout(timer);
    timedOut.catch(() => {});
    server.close().catch(() => {});
  }
}
