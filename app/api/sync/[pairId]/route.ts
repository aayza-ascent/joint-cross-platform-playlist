import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/session";
import { spotifyForUser, youtubeForUser } from "@/lib/clients";
import { ActiveRunExistsError, SyncEngine } from "@/lib/sync/engine";
import { DrizzleSyncStore } from "@/lib/sync/store";
import { NotConnectedError } from "@/lib/auth/tokens";
import { SpotifyApiError } from "@/lib/spotify/client";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ pairId: string }> },
) {
  const { pairId } = await ctx.params;
  return withSession(async ({ userId }) => {
    try {
      const yt = youtubeForUser(userId);
      const engine = new SyncEngine({
        store: new DrizzleSyncStore(),
        spotify: spotifyForUser(userId),
        youtube: yt.client,
        quota: yt.quota,
        userId,
      });
      const result = await engine.planRun(pairId);
      return NextResponse.json(result);
    } catch (err) {
      if (err instanceof NotConnectedError) {
        return NextResponse.json(
          { error: "not_connected", provider: err.provider },
          { status: 409 },
        );
      }
      if (err instanceof ActiveRunExistsError) {
        return NextResponse.json(
          { error: "active_run_exists" },
          { status: 409 },
        );
      }
      if (err instanceof SpotifyApiError && err.status === 403) {
        // Most common cause: Spotify-owned editorial / algorithmic playlist
        // (Discover Weekly, Daily Mix, Top 50 — Global) which Spotify
        // restricts for apps in Development Mode. We filter these from the
        // picker, but if one slips through (or a collaborative playlist
        // without playlist-read-collaborative scope hits this), surface a
        // clear message instead of a stack-y 500.
        return NextResponse.json(
          {
            error: "spotify_forbidden",
            detail:
              "Spotify rejected the read with 403 Forbidden. This usually means the playlist is one of Spotify's curated/editorial playlists (e.g. Discover Weekly), which apps in Development Mode cannot access. Pick a playlist you own.",
          },
          { status: 422 },
        );
      }
      const msg = err instanceof Error ? err.message : "unknown";
      if (/not found/i.test(msg)) {
        return NextResponse.json({ error: "pair_not_found" }, { status: 404 });
      }
      console.error("[sync/plan] error:", err);
      return NextResponse.json(
        { error: "plan_failed", detail: msg.slice(0, 500) },
        { status: 500 },
      );
    }
  });
}
