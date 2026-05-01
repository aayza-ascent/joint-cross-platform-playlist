import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/session";
import { spotifyForUser } from "@/lib/clients";
import { NotConnectedError } from "@/lib/auth/tokens";

export async function GET() {
  return withSession(async ({ userId }) => {
    try {
      const playlists = await spotifyForUser(userId).getPlaylists();
      return NextResponse.json({ playlists });
    } catch (err) {
      if (err instanceof NotConnectedError) {
        return NextResponse.json(
          { error: "not_connected", provider: "spotify" },
          { status: 409 },
        );
      }
      throw err;
    }
  });
}
