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

export async function handleMcpPost(c: Context) {
  const mcpToken = c.get("mcpToken") as string;

  let message: JSONRPCMessage;
  try {
    message = await c.req.json() as JSONRPCMessage;
  } catch {
    logger.error("Failed to parse incoming MCP message");
    return c.json({
      error: "invalid_request",
      error_description: "Request body is not valid JSON",
    }, 400);
  }

  const server = new McpServer(
    { name: "google-tasks-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerAllTools(server, mcpToken);
  const transport = new SingleResponseTransport();
  await server.connect(transport);

  // Notifications and responses carry no id and produce no reply: ack with 202.
  if (!("id" in message) || !("method" in message)) {
    try {
      transport.onmessage?.(message);
    } catch {
      logger.error("Failed to handle MCP notification via POST");
    }
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
}
