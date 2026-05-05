import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { connectedAccounts } from "@/db/schema";
import { withSession } from "@/lib/auth/session";
import { getValidAccessToken } from "@/lib/auth/tokens";

// Write-side diagnostic. Reads work; writes 403. The user is already in
// the Spotify dashboard's User Management list, so the obvious "not in
// User Management" theory is ruled out. This endpoint isolates the write
// path so we can capture the exact 403 body and verify the email/user the
// token belongs to actually matches the User Management entry.
//
// GET (safe, no writes):
//   - calls /me, returns the email + user_id + product + country so the
//     user can compare against the email in User Management
//
// POST (will create a private test playlist named "diagnostic-DELETE-ME"):
//   - tries POST /users/{id}/playlists (the failing create path)
//   - if create succeeds, tries POST /playlists/{newId}/tracks with a
//     known-public track to isolate whether create works but add-tracks
//     doesn't, or both fail
//   - the playlist is private and named for easy manual cleanup
export async function GET() {
  return withSession(async ({ userId }) => {
    const row = await db.query.connectedAccounts.findFirst({
      where: and(
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.provider, "spotify"),
      ),
    });

    let token: string;
    try {
      token = await getValidAccessToken(userId, "spotify");
    } catch (err) {
      return NextResponse.json(
        {
          error: "no_spotify_token",
          detail: errMsg(err),
          grantedScopeOnStoredToken: row?.scope ?? null,
        },
        { status: 200 },
      );
    }
    const me = await rawCall("GET", "https://api.spotify.com/v1/me", token);
    const meBody = me.body as
      | {
          id?: string;
          email?: string;
          product?: string;
          country?: string;
          display_name?: string;
        }
      | null;
    return NextResponse.json({
      me,
      summary: {
        spotifyUserId: meBody?.id ?? null,
        spotifyEmailOnAccount: meBody?.email ?? null,
        spotifyDisplayName: meBody?.display_name ?? null,
        spotifyProduct: meBody?.product ?? null,
        country: meBody?.country ?? null,
        userManagementMustMatchThisEmail: meBody?.email ?? null,
        grantedScopeOnStoredToken: row?.scope ?? null,
        tokenIssuedAt: row?.createdAt ?? null,
        tokenLastRefreshedAt: row?.updatedAt ?? null,
        howToCheck:
          "Two things must be true: (a) `grantedScopeOnStoredToken` contains `playlist-modify-public` AND `playlist-modify-private` — if either is missing, disconnect Spotify in this app and reconnect to mint a fresh token. (b) `spotifyEmailOnAccount` matches the email in https://developer.spotify.com/dashboard → your app → Settings → User Management exactly.",
      },
    });
  });
}

export async function POST() {
  return withSession(async ({ userId }) => {
    const row = await db.query.connectedAccounts.findFirst({
      where: and(
        eq(connectedAccounts.userId, userId),
        eq(connectedAccounts.provider, "spotify"),
      ),
    });

    let token: string;
    try {
      token = await getValidAccessToken(userId, "spotify");
    } catch (err) {
      return NextResponse.json(
        {
          error: "no_spotify_token",
          detail: errMsg(err),
          grantedScopeOnStoredToken: row?.scope ?? null,
        },
        { status: 200 },
      );
    }
    const out: Record<string, unknown> = {};
    const me = await rawCall("GET", "https://api.spotify.com/v1/me", token);
    out.me = me;
    const meBody = me.body as { id?: string; email?: string } | null;
    const myId = meBody?.id;
    if (!myId) {
      out.fatal = "could_not_resolve_user_id_from_me";
      return NextResponse.json(out);
    }
    out.summary = {
      spotifyUserId: myId,
      spotifyEmailOnAccount: meBody?.email ?? null,
      grantedScopeOnStoredToken: row?.scope ?? null,
    };

    // 1. Probe: create against /me/playlists (the canonical endpoint and the
    // one lib/spotify/client.ts uses).
    const create = await rawCall(
      "POST",
      "https://api.spotify.com/v1/me/playlists",
      token,
      { name: "diagnostic-DELETE-ME", public: false, description: "test" },
    );
    out.createPlaylistAttempt = create;

    if (create.status !== 201) {
      // Create failed — capture all headers Spotify returned for clues
      out.note =
        "Create failed. The body is Spotify's verbatim 403 message. If body is just {status:403,message:Forbidden} with no detail, this is the dev-mode write block (User Management mismatch or app state issue).";
      return NextResponse.json(out);
    }

    const newPlaylistId = (create.body as { id?: string }).id;
    out.newPlaylistId = newPlaylistId;
    if (!newPlaylistId) {
      return NextResponse.json(out);
    }

    // 2. Probe: add a known-public track to the new playlist
    // Using a stable, well-known popular track (Beyoncé - Halo).
    out.addTrackAttempt = await rawCall(
      "POST",
      `https://api.spotify.com/v1/playlists/${encodeURIComponent(newPlaylistId)}/tracks`,
      token,
      { uris: ["spotify:track:4JehYebiI9JE8sR8MisGVb"] },
    );

    out.cleanupNote =
      "Created a private test playlist. Spotify has no DELETE for playlists; unfollow it manually in your Spotify app under Library if you'd like to clean up.";
    return NextResponse.json(out);
  });
}

async function rawCall(
  method: "GET" | "POST",
  url: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  try {
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    };
    const res = await fetch(url, init);
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    return { status: res.status, body: parsed, headers };
  } catch (err) {
    return { status: 0, body: { error: errMsg(err) }, headers: {} };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
