import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/session";
import { getValidAccessToken } from "@/lib/auth/tokens";

// Diagnostic endpoint. Calls Spotify directly with the user's stored token
// and returns the raw status + body for /me, /me/playlists, and a one-track
// read of the first user-owned playlist. Lets us see exactly what Spotify is
// complaining about instead of falling through our friendly 422 message.
//
// Available in production too because the user is hitting the bug in prod and
// needs to share output. Output excludes anything sensitive (no tokens).
export async function GET() {
  return withSession(async ({ userId }) => {
    let accessToken: string;
    try {
      accessToken = await getValidAccessToken(userId, "spotify");
    } catch (err) {
      return NextResponse.json(
        { error: "no_spotify_token", detail: errMsg(err) },
        { status: 200 },
      );
    }

    const out: Record<string, unknown> = {};

    out.me = await rawCall(
      "GET",
      "https://api.spotify.com/v1/me",
      accessToken,
    );

    out.mePlaylists = await rawCall(
      "GET",
      "https://api.spotify.com/v1/me/playlists?limit=10",
      accessToken,
    );

    // Try a tracks read on the first user-owned non-collab playlist we find.
    const mePlaylistsBody = (out.mePlaylists as { body?: unknown }).body;
    let firstId: string | undefined;
    let firstName: string | undefined;
    let firstOwner: string | undefined;
    if (mePlaylistsBody && typeof mePlaylistsBody === "object") {
      const items = (mePlaylistsBody as { items?: unknown[] }).items ?? [];
      for (const it of items) {
        if (!it || typeof it !== "object") continue;
        const item = it as {
          id?: string;
          name?: string;
          owner?: { id?: string };
        };
        if (item.id && item.owner?.id !== "spotify") {
          firstId = item.id;
          firstName = item.name;
          firstOwner = item.owner?.id;
          break;
        }
      }
    }

    if (firstId) {
      const enc = encodeURIComponent(firstId);
      // Try several variants to figure out which combination Spotify accepts.
      // /items vs /tracks: Spotify's /me/playlists summary now references
      // /items as the canonical endpoint; /tracks is older and may be
      // restricted. market=from_token: some Spotify dev-mode 403s clear when
      // an explicit market is provided. We log all four so we can see which
      // succeed.
      out.firstPlaylistAttempt = {
        playlistId: firstId,
        playlistName: firstName,
        ownerId: firstOwner,
        playlistDetails: await rawCall(
          "GET",
          `https://api.spotify.com/v1/playlists/${enc}`,
          accessToken,
        ),
        tracksNoMarket: await rawCall(
          "GET",
          `https://api.spotify.com/v1/playlists/${enc}/tracks?limit=1`,
          accessToken,
        ),
        tracksWithMarket: await rawCall(
          "GET",
          `https://api.spotify.com/v1/playlists/${enc}/tracks?limit=1&market=from_token`,
          accessToken,
        ),
        itemsNoMarket: await rawCall(
          "GET",
          `https://api.spotify.com/v1/playlists/${enc}/items?limit=1`,
          accessToken,
        ),
        itemsWithMarket: await rawCall(
          "GET",
          `https://api.spotify.com/v1/playlists/${enc}/items?limit=1&market=from_token`,
          accessToken,
        ),
      };
    } else {
      out.firstPlaylistAttempt = { skipped: "no user-owned playlists found" };
    }

    return NextResponse.json(out);
  });
}

async function rawCall(
  method: string,
  url: string,
  token: string,
): Promise<{ status: number; body: unknown }> {
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, body: parsed };
  } catch (err) {
    return { status: 0, body: { error: errMsg(err) } };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
