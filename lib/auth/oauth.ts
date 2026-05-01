import { cookies } from "next/headers";
import { createHash, randomBytes } from "node:crypto";
import { open as openSealed, seal as sealValue } from "@/lib/auth/crypto";

const COOKIE_PREFIX = "__oauth_";
const COOKIE_MAX_AGE = 600; // 10 minutes — long enough for the user to consent

export type OauthCookieName = "spotify_state" | "spotify_verifier" | "youtube_state";

export function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomUrlSafe(48); // 64 chars after base64url
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// Cookie payload is encrypted with the same TOKEN_ENCRYPTION_KEY so a stolen
// cookie alone can't be replayed (the attacker would also need the key, which
// only the server has).
export async function setOauthCookie(name: OauthCookieName, value: string) {
  const sealed = await sealValue(value);
  const payload = `${sealed.nonce.toString("base64url")}.${sealed.ciphertext.toString(
    "base64url",
  )}`;
  const jar = await cookies();
  jar.set(`${COOKIE_PREFIX}${name}`, payload, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });
}

export async function takeOauthCookie(
  name: OauthCookieName,
): Promise<string | null> {
  const jar = await cookies();
  const v = jar.get(`${COOKIE_PREFIX}${name}`)?.value;
  jar.delete(`${COOKIE_PREFIX}${name}`);
  if (!v) return null;
  const [nonceB64, ctB64] = v.split(".");
  if (!nonceB64 || !ctB64) return null;
  try {
    return await openSealed({
      nonce: Buffer.from(nonceB64, "base64url"),
      ciphertext: Buffer.from(ctB64, "base64url"),
    });
  } catch {
    return null;
  }
}

export function appUrl(path = ""): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://127.0.0.1:3000";
  return `${base}${path}`;
}
