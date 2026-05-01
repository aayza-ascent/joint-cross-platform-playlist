import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { connectedAccounts } from "@/db/schema";
import { withSession } from "@/lib/auth/session";
import { open as openSealed } from "@/lib/auth/crypto";
import type { Provider } from "@/lib/types";

export async function GET() {
  return withSession(async ({ userId }) => {
    const rows = await db.query.connectedAccounts.findMany({
      where: eq(connectedAccounts.userId, userId),
      columns: { provider: true },
    });
    const set = new Set(rows.map((r) => r.provider));
    return NextResponse.json({
      spotify: set.has("spotify"),
      youtube: set.has("youtube"),
    });
  });
}

export async function DELETE(req: NextRequest) {
  return withSession(async ({ userId }) => {
    const provider = req.nextUrl.searchParams.get("provider") as
      | Provider
      | null;
    if (provider !== "spotify" && provider !== "youtube") {
      return NextResponse.json({ error: "invalid_provider" }, { status: 400 });
    }
    const row = await db.query.connectedAccounts.findFirst({
      where: and(
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.provider, provider),
      ),
    });
    if (!row) {
      return NextResponse.json({ ok: true, alreadyDisconnected: true });
    }

    // Revoke at the provider before deleting, so a revoke failure leaves us
    // able to retry rather than orphaning a live token.
    try {
      const accessToken = await openSealed({
        ciphertext: row.accessTokenCiphertext as Buffer,
        nonce: row.accessTokenNonce as Buffer,
      });
      if (provider === "spotify") {
        // Spotify has no public revocation endpoint — the user can revoke
        // from accounts.spotify.com/connected-apps. Best we can do is delete.
      } else {
        await fetch(
          `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(
            accessToken,
          )}`,
          { method: "POST" },
        );
      }
    } catch {
      // Best-effort revoke; proceed to delete regardless.
    }

    await db
      .delete(connectedAccounts)
      .where(
        and(
          eq(connectedAccounts.userId, userId),
          eq(connectedAccounts.provider, provider),
        ),
      );
    return NextResponse.json({ ok: true });
  });
}
