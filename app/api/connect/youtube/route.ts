import { NextResponse } from "next/server";
import { appUrl, randomUrlSafe, setOauthCookie } from "@/lib/auth/oauth";
import { withSession } from "@/lib/auth/session";

const SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";

export async function GET() {
  return withSession(async () => {
    const clientId = process.env.YOUTUBE_CLIENT_ID;
    if (!clientId) {
      return NextResponse.json(
        { error: "YOUTUBE_CLIENT_ID is not set" },
        { status: 500 },
      );
    }
    const state = randomUrlSafe(32);
    await setOauthCookie("youtube_state", state);

    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", appUrl("/api/connect/youtube/callback"));
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("state", state);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("include_granted_scopes", "true");
    return NextResponse.redirect(url.toString());
  });
}
