// Run: ENCRYPTION_SECRET=<32+ chars> deno test --allow-env --allow-read --allow-ffi --deny-net test/
// Timers are intercepted before the app is imported so startup is covered too.
const armed: string[] = [];
const pendingTimeouts = new Set<unknown>();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
globalThis.setTimeout = ((...a: unknown[]) => {
  const id = (realSetTimeout as any)(...a);
  pendingTimeouts.add(id);
  return id;
}) as any;
globalThis.clearTimeout = ((id: unknown) => (pendingTimeouts.delete(id), (realClearTimeout as any)(id))) as any;
globalThis.setInterval = ((...a: unknown[]) => (armed.push("interval"), (realSetInterval as any)(...a))) as any;

const { createApp } = await import("../src/server/app.ts");
const { tokenStore } = await import("../src/auth/token-store.ts");
const { SingleResponseTransport } = await import("../src/transport/mcp-transport.ts");

const future = Date.now() + 3_600_000;
const users: Record<string, { googleAccessToken: string; googleRefreshToken: string; expiresAt: number }> = {
  alice: { googleAccessToken: "g-alice", googleRefreshToken: "r", expiresAt: future },
  bob: { googleAccessToken: "g-bob", googleRefreshToken: "r", expiresAt: future },
  expired: { googleAccessToken: "g-old", googleRefreshToken: "r", expiresAt: 0 },
};
(tokenStore as any).getTokens = (t: string) => Promise.resolve(users[t] ?? null);
(tokenStore as any).isValid = (t: string) => Promise.resolve(t in users && t !== "expired");

const app = createApp({
  oauthConfig: { clientId: "x", clientSecret: "y", redirectUri: "http://localhost/cb" },
});
const STARTUP_TIMERS = armed.length + pendingTimeouts.size;
Deno.env.set("MCP_REQUEST_TIMEOUT_MS", "300");

const H = (token: string, accept = "application/json, text/event-stream") => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  Accept: accept,
});
const post = (body: unknown, token = "alice", accept?: string) =>
  app.request("/mcp", {
    method: "POST",
    headers: H(token, accept),
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// Fake Google: echoes which Google token made the call; optionally huge.
function fakeGoogle(big = false) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
    const title = big ? "x".repeat(2_000_000) : auth;
    return Promise.resolve(new Response(JSON.stringify({ items: [{ id: "l1", title }] })));
  }) as any;
  return () => (globalThis.fetch = realFetch);
}

const call = (id: number, name = "list_task_lists") => ({
  jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} },
});

Deno.test("GET /mcp answers 405 with Allow: POST", async () => {
  const res = await app.request("/mcp", { method: "GET", headers: H("alice") });
  assert(res.status === 405 && res.headers.get("allow") === "POST", `status ${res.status}`);
});

Deno.test("invalid and expired bearers get 401", async () => {
  for (const t of ["nobody", "expired"]) {
    const res = await post(call(1), t);
    assert(res.status === 401, `${t} gave ${res.status}`);
    await res.text();
  }
});

Deno.test("two users each reach only their own Google credentials", async () => {
  const restore = fakeGoogle();
  try {
    for (const [token, google] of [["alice", "g-alice"], ["bob", "g-bob"]]) {
      const res = await post(call(7), token);
      const text = (await res.json()).result.content[0].text as string;
      assert(text.includes(`Bearer ${google}`), `${token} did not use ${google}`);
      const other = google === "g-alice" ? "g-bob" : "g-alice";
      assert(!text.includes(other), `${token} saw ${other}`);
    }
  } finally {
    restore();
  }
});

Deno.test("initialize, initialized, tools/list, tools/call sequence", async () => {
  const restore = fakeGoogle();
  try {
    const init = await post({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    assert(init.headers.get("content-type") === "application/json", "init not JSON");
    assert((await init.json()).result.serverInfo.name === "google-tasks-mcp", "bad init");
    const ack = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    assert(ack.status === 202, `ack ${ack.status}`);
    const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert((await list.json()).result.tools.length > 0, "no tools");
    const res = await post(call(3));
    const body = await res.json();
    assert(body.id === 3 && body.result.content[0].text.includes("l1"), "bad call");
  } finally {
    restore();
  }
});

Deno.test("Talos direct tools/call shape, parsed the way talos-tasks parses it", async () => {
  const restore = fakeGoogle();
  try {
    const res = await post(call(1));
    const txt = await res.text();
    let data: string | null = null;
    for (const line of txt.split("\n")) if (line.startsWith("data:")) data = line.slice(5).trim();
    if (data === null && txt.trim().startsWith("{")) data = txt;
    assert(!!data && !!JSON.parse(data).result.content[0].text, "talos parse failed");
  } finally {
    restore();
  }
});

Deno.test("SSE-only clients get a finite one-event body", async () => {
  const res = await post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, "alice", "text/event-stream");
  assert(res.headers.get("content-type") === "text/event-stream", "not SSE");
  assert((await res.text()).includes("data: {"), "no data line");
});

Deno.test("large tool result is delivered completely", async () => {
  const restore = fakeGoogle(true);
  try {
    const res = await post(call(9));
    const body = JSON.parse(await res.text());
    assert(body.result.content[0].text.length > 2_000_000, "truncated");
  } finally {
    restore();
  }
});

Deno.test("malformed bodies get 400, never 500 or a hang", async () => {
  for (const body of ["null", "42", '"str"', "{}", "not json", '{"jsonrpc":"1.0","id":1,"method":"x"}']) {
    const res = await post(body);
    const json = await res.json();
    assert(res.status === 400, `${body} gave ${res.status}`);
    assert(json.jsonrpc === "2.0" && typeof json.error.code === "number", `${body} no envelope`);
  }
});

Deno.test("batch gets 400", async () => {
  const res = await post([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
  assert(res.status === 400, `status ${res.status}`);
  assert((await res.json()).error.code === -32600, "wrong code");
});

Deno.test("SDK onerror and close end the reply instead of hanging", async () => {
  const a = new SingleResponseTransport();
  a.fail(new Error("boom"));
  let failed = false;
  await a.reply.catch(() => (failed = true));
  assert(failed, "onerror did not reject");

  const b = new SingleResponseTransport();
  await b.close();
  failed = false;
  await b.reply.catch(() => (failed = true));
  assert(failed, "close did not reject");
});

Deno.test("invalid envelopes get 400 promptly (real SDK schema)", async () => {
  const bad = [
    { jsonrpc: "2.0", id: null, method: "tools/list" },
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: [] },
    { jsonrpc: "2.0", id: 1, method: "tools/list", extra: true },
    { jsonrpc: "2.0", id: 1, result: {} },
    { jsonrpc: "2.0", result: 42 },
    { jsonrpc: "2.0", id: 1, error: { code: 1, message: "m" } },
  ];
  for (const body of bad) {
    const res = await Promise.race([
      post(body),
      new Promise<Response>((_, rej) => realSetTimeout(() => rej(new Error("hang")), 2000)),
    ]);
    assert(res.status === 400, `${JSON.stringify(body)} gave ${res.status}`);
    await res.text();
  }
});

Deno.test("SDK error after a real connect fails the reply without recursion", async () => {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const server = new McpServer({ name: "t", version: "0" }, { capabilities: { tools: {} } });
  const transport = new SingleResponseTransport();
  server.server.onerror = (e: Error) => transport.fail(e);
  await server.connect(transport);
  transport.onerror?.(new Error("probe")); // SDK wrapper: no stack overflow
  let failed = false;
  await transport.reply.catch(() => (failed = true));
  assert(failed, "reply not rejected");
  await server.close();
});

Deno.test("a stalled handler gets 504 at the bound and leaves no timer", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => new Promise(() => {})) as any;
  try {
    const started = Date.now();
    const res = await post(call(11));
    assert(res.status === 504, `status ${res.status}`);
    assert((await res.json()).error.code === -32603, "bad envelope");
    assert(Date.now() - started < 3000, "too slow");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert(pendingTimeouts.size === 0, "timer left behind");
});

Deno.test("no interval ever, no timer pending after requests, none at startup", async () => {
  await post({ jsonrpc: "2.0", id: 5, method: "tools/list" });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert(STARTUP_TIMERS === 0, `startup armed ${STARTUP_TIMERS}`);
  assert(armed.length === 0, `intervals armed: ${armed.join(",")}`);
  assert(pendingTimeouts.size === 0, "timer pending after requests");
});
