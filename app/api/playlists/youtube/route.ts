import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/session";
import { youtubeForUser } from "@/lib/clients";
import { NotConnectedError } from "@/lib/auth/tokens";
import {
  QuotaExceededError,
  YouTubeRateLimitError,
} from "@/lib/youtube/client";

export async function GET() {
  return withSession(async ({ userId }) => {
    try {
      const { client } = youtubeForUser(userId);
      const playlists = await client.getPlaylists();
      return NextResponse.json({ playlists });
    } catch (err) {
      if (err instanceof NotConnectedError) {
        return NextResponse.json(
          { error: "not_connected", provider: "youtube" },
          { status: 409 },
        );
      }
      if (err instanceof QuotaExceededError) {
        return NextResponse.json(
          { error: "quota_exceeded" },
          { status: 429 },
        );
      }
      if (err instanceof YouTubeRateLimitError) {
        return NextResponse.json(
          { error: "rate_limited" },
          { status: 429 },
        );
      }
      throw err;
    }
  });
}
