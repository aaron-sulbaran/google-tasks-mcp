import { openKv } from "@deno/kv";
import { encrypt, decrypt } from "../utils/encryption.ts";

export interface TokenData {
  googleAccessToken: string;
  googleRefreshToken: string;
  expiresAt: number;
}

interface EncryptedTokenData {
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  expiresAt: number;
}

interface EncryptedRefreshData extends EncryptedTokenData {
  clientId?: string;
}

export const ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_TTL_MS = 365 * 24 * 60 * 60 * 1000;

class TokenStore {
  private kv: Awaited<ReturnType<typeof openKv>> | null = null;

  async init() {
    this.kv = await openKv();
  }

  async storeTokens(mcpToken: string, tokenData: TokenData): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

    const encryptedData: EncryptedTokenData = {
      encryptedAccessToken: encrypt(tokenData.googleAccessToken),
      encryptedRefreshToken: encrypt(tokenData.googleRefreshToken),
      expiresAt: tokenData.expiresAt,
    };

    await this.kv.set(["tokens", mcpToken], encryptedData, { expireIn: TTL_MS });
  }

  async getTokens(mcpToken: string): Promise<TokenData | null> {
    if (!this.kv) throw new Error("KV not initialized");
    const result = await this.kv.get<EncryptedTokenData>(["tokens", mcpToken]);

    if (!result.value) {
      return null;
    }

    return {
      googleAccessToken: decrypt(result.value.encryptedAccessToken),
      googleRefreshToken: decrypt(result.value.encryptedRefreshToken),
      expiresAt: result.value.expiresAt,
    };
  }

  async isValid(mcpToken: string): Promise<boolean> {
    const data = await this.getTokens(mcpToken);
    return data !== null;
  }

  async updateTokens(mcpToken: string, updates: Partial<TokenData>): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    const existing = await this.getTokens(mcpToken);
    if (!existing) throw new Error("Token not found");

    const updatedData: TokenData = {
      ...existing,
      ...updates,
    };

    const encryptedData: EncryptedTokenData = {
      encryptedAccessToken: encrypt(updatedData.googleAccessToken),
      encryptedRefreshToken: encrypt(updatedData.googleRefreshToken),
      expiresAt: updatedData.expiresAt,
    };

    const TTL_MS = 30 * 24 * 60 * 60 * 1000;
    await this.kv.set(["tokens", mcpToken], encryptedData, { expireIn: TTL_MS });
  }

  async deleteToken(mcpToken: string): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    await this.kv.delete(["tokens", mcpToken]);
  }

  // Refresh tokens carry the same Google credentials as an access token but
  // live a year and rotate on every use, so a client that refreshes at least
  // yearly never sends the user back through Google's consent screen.
  async storeRefreshToken(
    refreshToken: string,
    tokenData: TokenData,
    clientId?: string,
  ): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    const encryptedData: EncryptedRefreshData = {
      encryptedAccessToken: encrypt(tokenData.googleAccessToken),
      encryptedRefreshToken: encrypt(tokenData.googleRefreshToken),
      expiresAt: tokenData.expiresAt,
      clientId,
    };
    await this.kv.set(["refresh_tokens", refreshToken], encryptedData, {
      expireIn: REFRESH_TTL_MS,
    });
  }

  async getRefreshToken(
    refreshToken: string,
  ): Promise<{ tokenData: TokenData; clientId?: string } | null> {
    if (!this.kv) throw new Error("KV not initialized");
    const result = await this.kv.get<EncryptedRefreshData>([
      "refresh_tokens",
      refreshToken,
    ]);
    if (!result.value) {
      return null;
    }
    return {
      tokenData: {
        googleAccessToken: decrypt(result.value.encryptedAccessToken),
        googleRefreshToken: decrypt(result.value.encryptedRefreshToken),
        expiresAt: result.value.expiresAt,
      },
      clientId: result.value.clientId,
    };
  }

  async deleteRefreshToken(refreshToken: string): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    await this.kv.delete(["refresh_tokens", refreshToken]);
  }
}

export const tokenStore = new TokenStore();
