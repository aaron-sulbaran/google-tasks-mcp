// Run: ENCRYPTION_SECRET=<32+ chars> deno test --allow-env --allow-read --allow-ffi test/
import { createApp } from "../src/server/app.ts";
import { tokenStore } from "../src/auth/token-store.ts";

const BEARER = { Authorization: "Bearer test-token" };
const JSON_HEADERS = {
  ...BEARER,
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

(tokenStore as any).isValid = () => Promise.resolve(true);
(tokenStore as any).getTokens = () =>
  Promise.resolve({
    googleAccessToken: "fake",
    googleRefreshToken: "fake",
    expiresAt: Date.now() + 3_600_000,
  });

const app = createApp({
  oauthConfig: { clientId: "x", clientSecret: "y", redirectUri: "http://localhost/cb" },
});

const post = (body: unknown, headers: Record<string, string> = JSON_HEADERS) =>
  app.request("/mcp", { method: "POST", headers, body: JSON.stringify(body) });

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

Deno.test("GET /mcp answers 405 with Allow: POST", async () => {
  const res = await app.request("/mcp", { method: "GET", headers: BEARER });
  assert(res.status === 405, `status ${res.status}`);
  assert(res.headers.get("allow") === "POST", "missing Allow header");
});

Deno.test("initialize, tools/list and tools/call each return one JSON response", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response(JSON.stringify({ items: [{ id: "l1", title: "Fake" }] })));
  try {
    const init = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    assert(init.status === 200, `initialize ${init.status}`);
    assert(init.headers.get("content-type") === "application/json", "initialize not JSON");
    assert((await init.json()).result.serverInfo.name === "google-tasks-mcp", "bad initialize");

    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert(list.headers.get("content-type") === "application/json", "tools/list not JSON");
    assert((await list.json()).result.tools.length > 0, "no tools");

    const call = await post({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_task_lists", arguments: {} },
    });
    assert(call.headers.get("content-type") === "application/json", "tools/call not JSON");
    const body = await call.json();
    assert(body.id === 3 && body.result.content[0].text.includes("Fake"), "bad tools/call");
  } finally {
    globalThis.fetch = realFetch;
  }
});

Deno.test("SSE-only clients get a finite one-event body", async () => {
  const res = await post(
    { jsonrpc: "2.0", id: 4, method: "tools/list" },
    { ...BEARER, "Content-Type": "application/json", Accept: "text/event-stream" },
  );
  assert(res.headers.get("content-type") === "text/event-stream", "not SSE");
  const text = await res.text(); // resolves only if the body ends
  assert(text.includes("data: {"), "no data line");
});

Deno.test("notification gets 202", async () => {
  const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert(res.status === 202, `status ${res.status}`);
});

Deno.test("no timers are armed by a request", async () => {
  const armed: string[] = [];
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  globalThis.setTimeout = ((...a: unknown[]) => (armed.push("timeout"), (realSetTimeout as any)(...a))) as any;
  globalThis.setInterval = ((...a: unknown[]) => (armed.push("interval"), (realSetInterval as any)(...a))) as any;
  try {
    await post({ jsonrpc: "2.0", id: 5, method: "tools/list" });
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.setInterval = realSetInterval;
  }
  assert(armed.length === 0, `timers armed: ${armed.join(",")}`);
});
