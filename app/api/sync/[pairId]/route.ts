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
        return NextResponse.json(
          {
            error: "spotify_forbidden",
            detail:
              "Spotify rejected the read with 403 Forbidden. If you've already disconnected and reconnected Spotify, the most likely remaining cause is that your Spotify account isn't on this app's User Management list. Open developer.spotify.com → your app → User Management → Add new user → enter the email of the Spotify account you signed in with, then retry. (Apps in Development Mode can only be used by explicitly listed users — including the developer.) See /api/debug/spotify for the raw Spotify response.",
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
