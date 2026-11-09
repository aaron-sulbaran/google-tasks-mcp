import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

// One transport per POST. It captures the single reply the server produces so
// the HTTP handler can return it in the same response. There is no stream, no
// session map and no timer, so nothing keeps the isolate awake after the reply.
export class SingleResponseTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  private resolveReply!: (message: JSONRPCMessage) => void;
  readonly reply = new Promise<JSONRPCMessage>((resolve) => {
    this.resolveReply = resolve;
  });

  start(): Promise<void> {
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    this.resolveReply(message);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.onclose?.();
    return Promise.resolve();
  }
}
