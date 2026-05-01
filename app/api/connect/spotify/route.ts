import { NextResponse } from "next/server";
import {
  appUrl,
  pkcePair,
  randomUrlSafe,
  setOauthCookie,
} from "@/lib/auth/oauth";
import { withSession } from "@/lib/auth/session";

const SCOPES = ["playlist-read-private", "playlist-modify-private"];

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
    return NextResponse.redirect(url.toString());
  });
}
