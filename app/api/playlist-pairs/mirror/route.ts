import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db/client";
import { playlistPairs } from "@/db/schema";
import { withSession } from "@/lib/auth/session";
import { spotifyForUser, youtubeForUser } from "@/lib/clients";
import { NotConnectedError } from "@/lib/auth/tokens";
import { SpotifyApiError } from "@/lib/spotify/client";
import {
  QuotaExceededError,
  YouTubeRateLimitError,
} from "@/lib/youtube/client";

const PostBody = z.object({
  name: z.string().min(1).max(80),
});

export async function POST(req: NextRequest) {
  return withSession(async ({ userId }) => {
    const json = await req.json().catch(() => null);
    const parsed = PostBody.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_body", detail: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { name } = parsed.data;

    try {
      const sp = spotifyForUser(userId);
      const yt = youtubeForUser(userId);

      const [spotifyPlaylistId, youtubePlaylistId] = await Promise.all([
        sp.createPlaylist(name, {
          description: "Created by joint-cross-platform-playlist",
        }),
        yt.client.createPlaylist(name),
      ]);

      const [row] = await db
        .insert(playlistPairs)
        .values({
          userId,
          spotifyPlaylistId,
          youtubePlaylistId,
        })
        .returning();

      return NextResponse.json({ pair: row }, { status: 201 });
    } catch (err) {
      if (err instanceof NotConnectedError) {
        return NextResponse.json(
          { error: "not_connected", provider: err.provider },
          { status: 409 },
        );
      }
      if (err instanceof QuotaExceededError) {
        return NextResponse.json({ error: "quota_exceeded" }, { status: 429 });
      }
      if (err instanceof YouTubeRateLimitError) {
        return NextResponse.json({ error: "rate_limited" }, { status: 429 });
      }
      if (err instanceof SpotifyApiError && err.status === 403) {
        return NextResponse.json(
          {
            error: "spotify_forbidden",
            detail:
              "Spotify returned 403 Forbidden on the create. In Development Mode, an app can only act on data of users explicitly listed in the dashboard's User Management section. Two checks: (1) Open /api/debug/spotify-write (GET) and confirm `spotifyEmailOnAccount` matches the email row at https://developer.spotify.com/dashboard → your app → Settings → User Management exactly (case, whitespace, plus-aliases, dots all matter). The Spotify account email may differ from the Google sign-in email — see https://www.spotify.com/account/profile/. (2) Even if the email is correct, a token issued before the User Management entry was added will keep 403'ing — disconnect Spotify in this app and reconnect to mint a fresh token. Then retry.",
            spotifyBody: err.body.slice(0, 500),
          },
          { status: 422 },
        );
      }
      const msg = err instanceof Error ? err.message : "unknown";
      console.error("[playlist-pairs/mirror] error:", err);
      return NextResponse.json(
        { error: "create_failed", detail: msg.slice(0, 500) },
        { status: 500 },
      );
    }
  });
}
