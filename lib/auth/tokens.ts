import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { connectedAccounts } from "@/db/schema";
import type { Provider } from "@/lib/types";
import { open, seal } from "@/lib/auth/crypto";

const REFRESH_SKEW_MS = 60_000;

type ProviderConfig = {
  tokenUrl: string;
  clientId: () => string;
  clientSecret: () => string;
  authHeader?: () => string;
};

const PROVIDERS: Record<Provider, ProviderConfig> = {
  spotify: {
    tokenUrl: "https://accounts.spotify.com/api/token",
    clientId: () => mustEnv("SPOTIFY_CLIENT_ID"),
    clientSecret: () => mustEnv("SPOTIFY_CLIENT_SECRET"),
    authHeader: () =>
      "Basic " +
      Buffer.from(
        `${mustEnv("SPOTIFY_CLIENT_ID")}:${mustEnv("SPOTIFY_CLIENT_SECRET")}`,
      ).toString("base64"),
  },
  youtube: {
    tokenUrl: "https://oauth2.googleapis.com/token",
    clientId: () => mustEnv("YOUTUBE_CLIENT_ID"),
    clientSecret: () => mustEnv("YOUTUBE_CLIENT_SECRET"),
  },
};

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export class NotConnectedError extends Error {
  constructor(public provider: Provider) {
    super(`User has no connected ${provider} account`);
  }
}

export async function getValidAccessToken(
  userId: string,
  provider: Provider,
): Promise<string> {
  const row = await db.query.connectedAccounts.findFirst({
    where: and(
      eq(connectedAccounts.userId, userId),
      eq(connectedAccounts.provider, provider),
    ),
  });
  if (!row) throw new NotConnectedError(provider);

  const expiry = row.expiry ? row.expiry.getTime() : 0;
  const fresh = expiry - Date.now() > REFRESH_SKEW_MS;
  if (fresh) {
    return open({
      ciphertext: row.accessTokenCiphertext as Buffer,
      nonce: row.accessTokenNonce as Buffer,
    });
  }

  if (!row.refreshTokenCiphertext || !row.refreshTokenNonce) {
    throw new Error(`No refresh token for ${provider}; user must reconnect`);
  }

  const refreshToken = await open({
    ciphertext: row.refreshTokenCiphertext as Buffer,
    nonce: row.refreshTokenNonce as Buffer,
  });

  const refreshed = await refreshAccessToken(provider, refreshToken);

  const sealedAccess = await seal(refreshed.accessToken);
  const sealedRefresh = refreshed.refreshToken
    ? await seal(refreshed.refreshToken)
    : null;

  await db
    .update(connectedAccounts)
    .set({
      accessTokenCiphertext: sealedAccess.ciphertext,
      accessTokenNonce: sealedAccess.nonce,
      ...(sealedRefresh && {
        refreshTokenCiphertext: sealedRefresh.ciphertext,
        refreshTokenNonce: sealedRefresh.nonce,
      }),
      expiry: new Date(Date.now() + refreshed.expiresInMs),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.provider, provider),
      ),
    );

  return refreshed.accessToken;
}

async function refreshAccessToken(
  provider: Provider,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresInMs: number }> {
  const cfg = PROVIDERS[provider];
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (cfg.authHeader) {
    headers.Authorization = cfg.authHeader();
  } else {
    body.set("client_id", cfg.clientId());
    body.set("client_secret", cfg.clientSecret());
  }

  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers,
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `${provider} refresh failed: ${res.status} ${text.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresInMs: json.expires_in * 1000,
  };
}

export async function persistConnection(args: {
  userId: string;
  provider: Provider;
  accessToken: string;
  refreshToken?: string;
  expiresInSec: number;
  scope?: string;
}) {
  const sealedAccess = await seal(args.accessToken);
  const sealedRefresh = args.refreshToken ? await seal(args.refreshToken) : null;
  const expiry = new Date(Date.now() + args.expiresInSec * 1000);

  await db
    .insert(connectedAccounts)
    .values({
      userId: args.userId,
      provider: args.provider,
      accessTokenCiphertext: sealedAccess.ciphertext,
      accessTokenNonce: sealedAccess.nonce,
      refreshTokenCiphertext: sealedRefresh?.ciphertext,
      refreshTokenNonce: sealedRefresh?.nonce,
      expiry,
      scope: args.scope,
    })
    .onConflictDoUpdate({
      target: [connectedAccounts.userId, connectedAccounts.provider],
      set: {
        accessTokenCiphertext: sealedAccess.ciphertext,
        accessTokenNonce: sealedAccess.nonce,
        ...(sealedRefresh && {
          refreshTokenCiphertext: sealedRefresh.ciphertext,
          refreshTokenNonce: sealedRefresh.nonce,
        }),
        expiry,
        scope: args.scope,
        updatedAt: new Date(),
      },
    });
}
