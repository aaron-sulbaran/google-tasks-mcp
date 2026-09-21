#!/usr/bin/env node

import process from "node:process";
import { initOAuthStore } from "./auth/oauth.ts";
import { tokenStore } from "./auth/token-store.ts";
import { createApp } from "./server/app.ts";
import { setOAuthConfig } from "./config.ts";
import { initRateLimiter } from "./server/rate-limiter.ts";

await tokenStore.init();
await initOAuthStore();
await initRateLimiter();

const oauthConfig = {
  clientId: process.env.GOOGLE_CLIENT_ID || "",
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  redirectUri: process.env.GOOGLE_REDIRECT_URI || "http://localhost:3000/callback",
};

setOAuthConfig(oauthConfig);

const app = createApp({ oauthConfig });

// The current Deno Deploy (console.deno.com) no longer auto-serves a default
// { fetch } export the way Deploy Classic did; the app must listen itself.
// Node hosts and Classic-style runners still get the default export below.
const deno = (globalThis as any).Deno;
if (deno?.serve) {
  const port = Number(process.env.PORT) || 8000;
  deno.serve({ port }, app.fetch);
}

export default {
  fetch: app.fetch,
};
