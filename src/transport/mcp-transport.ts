import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

// One transport per POST. It captures the single reply the server produces so
// the HTTP handler can return it in the same response. There is no stream, no
// session map and no timer, so nothing keeps the isolate awake after the reply.
export class SingleResponseTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  private sdkOnError?: (error: Error) => void;
  private resolveReply!: (message: JSONRPCMessage) => void;
  private rejectReply!: (error: Error) => void;
  readonly reply = new Promise<JSONRPCMessage>((resolve, reject) => {
    this.resolveReply = resolve;
    this.rejectReply = reject;
  });

  constructor() {
    this.reply.catch(() => {}); // notifications never await the reply
  }

  // The SDK reports protocol errors here. Route them to the reply so a POST
  // always ends (no later reply can arrive once an error is reported).
  set onerror(handler: ((error: Error) => void) | undefined) {
    this.sdkOnError = handler;
  }
  get onerror(): (error: Error) => void {
    return (error) => {
      this.rejectReply(error);
      this.sdkOnError?.(error);
    };
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    this.resolveReply(message);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.rejectReply(new Error("Transport closed before a reply"));
    this.onclose?.();
    return Promise.resolve();
  }
}
