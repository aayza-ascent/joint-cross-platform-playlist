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
              "Spotify returned 403 Forbidden. In Development Mode, an app can only act on data of users explicitly listed in the dashboard's User Management section. Two checks: (1) Open /api/debug/spotify-write (GET) and confirm `spotifyEmailOnAccount` matches the email row at https://developer.spotify.com/dashboard → your app → Settings → User Management exactly (case, whitespace, plus-aliases, dots all matter). The Spotify account email may differ from the Google sign-in email — see https://www.spotify.com/account/profile/. (2) Even if the email is correct, a token issued before the User Management entry was added will keep 403'ing — disconnect Spotify in this app and reconnect to mint a fresh token. Then retry.",
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
