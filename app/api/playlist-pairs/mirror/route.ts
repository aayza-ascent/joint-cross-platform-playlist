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
              "Spotify rejected the create with 403 Forbidden. This usually means your Spotify connection was authorized before we added a needed scope. Disconnect Spotify under Provider connections, then click Connect Spotify to grant the updated permissions, then retry.",
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
