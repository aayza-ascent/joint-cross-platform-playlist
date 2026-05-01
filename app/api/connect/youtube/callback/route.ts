import { NextResponse, type NextRequest } from "next/server";
import { appUrl, takeOauthCookie } from "@/lib/auth/oauth";
import { withSession } from "@/lib/auth/session";
import { persistConnection } from "@/lib/auth/tokens";

export async function GET(req: NextRequest) {
  return withSession(async ({ userId }) => {
    const { searchParams } = req.nextUrl;
    const error = searchParams.get("error");
    if (error) {
      return NextResponse.redirect(
        appUrl(`/dashboard?connect=youtube&error=${encodeURIComponent(error)}`),
      );
    }
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const storedState = await takeOauthCookie("youtube_state");
    if (!code || !state || !storedState || state !== storedState) {
      return NextResponse.json({ error: "invalid_state" }, { status: 400 });
    }

    const clientId = process.env.YOUTUBE_CLIENT_ID;
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return NextResponse.json(
        { error: "youtube_oauth_not_configured" },
        { status: 500 },
      );
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: appUrl("/api/connect/youtube/callback"),
      client_id: clientId,
      client_secret: clientSecret,
    });
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return NextResponse.json(
        { error: "youtube_token_exchange_failed", detail: text.slice(0, 500) },
        { status: 502 },
      );
    }
    const json = (await tokenRes.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };
    await persistConnection({
      userId,
      provider: "youtube",
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresInSec: json.expires_in,
      scope: json.scope,
    });
    return NextResponse.redirect(appUrl("/dashboard?connect=youtube&ok=1"));
  });
}
