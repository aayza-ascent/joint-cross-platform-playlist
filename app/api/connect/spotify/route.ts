import { NextResponse } from "next/server";
import {
  appUrl,
  pkcePair,
  randomUrlSafe,
  setOauthCookie,
} from "@/lib/auth/oauth";
import { withSession } from "@/lib/auth/session";

const SCOPES = [
  "playlist-read-private",
  // Required to read tracks of any playlist marked Collaborative — including
  // the user's own. Without this scope, GET /v1/playlists/{id}/tracks 403s on
  // collaborative entries even though /me/playlists happily lists them.
  "playlist-read-collaborative",
  "playlist-modify-private",
];

export async function GET() {
  return withSession(async () => {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    if (!clientId) {
      return NextResponse.json(
        { error: "SPOTIFY_CLIENT_ID is not set" },
        { status: 500 },
      );
    }
    const state = randomUrlSafe(32);
    const { verifier, challenge } = pkcePair();
    await setOauthCookie("spotify_state", state);
    await setOauthCookie("spotify_verifier", verifier);

    const url = new URL("https://accounts.spotify.com/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", appUrl("/api/connect/spotify/callback"));
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("code_challenge", challenge);
    // Force Spotify to re-show the consent screen so any user that previously
    // connected with a smaller scope set re-grants with the current scopes.
    // Without this, Spotify silently re-issues a token whose grants don't
    // include any newly-added scope.
    url.searchParams.set("show_dialog", "true");
    return NextResponse.redirect(url.toString());
  });
}
