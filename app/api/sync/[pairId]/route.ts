import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/session";
import { spotifyForUser, youtubeForUser } from "@/lib/clients";
import { BrokenPairError, SyncEngine } from "@/lib/sync/engine";
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
          {
            error: "not_connected",
            provider: err.provider,
            detail: `Connect your ${err.provider} account first (Provider connections card on the dashboard).`,
          },
          { status: 409 },
        );
      }
      if (err instanceof BrokenPairError) {
        return NextResponse.json(
          {
            error: "broken_pair",
            detail:
              "This pair is broken — one of the playlists no longer exists or you've lost access to it. Delete and recreate the pair.",
          },
          { status: 422 },
        );
      }
      if (err instanceof SpotifyApiError && err.status === 403) {
        return NextResponse.json(
          {
            error: "spotify_forbidden",
            detail:
              "Spotify returned 403 Forbidden. Most often: disconnect Spotify in the dashboard and reconnect (a token issued before the latest scope set keeps 403'ing). If that doesn't fix it, hit /api/debug/spotify-write (GET) and confirm `spotifyEmailOnAccount` matches the email row at https://developer.spotify.com/dashboard → User Management exactly.",
            spotifyBody: err.body.slice(0, 500),
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
