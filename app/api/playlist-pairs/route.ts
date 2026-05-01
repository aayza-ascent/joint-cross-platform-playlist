import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { playlistPairs } from "@/db/schema";
import { withSession } from "@/lib/auth/session";

const PostBody = z.object({
  spotifyPlaylistId: z.string().min(1).max(64),
  youtubePlaylistId: z.string().min(1).max(64),
});

export async function GET() {
  return withSession(async ({ userId }) => {
    const rows = await db.query.playlistPairs.findMany({
      where: eq(playlistPairs.userId, userId),
      orderBy: [desc(playlistPairs.createdAt)],
    });
    return NextResponse.json({ pairs: rows });
  });
}

export async function POST(req: NextRequest) {
  return withSession(async ({ userId }) => {
    const json = await req.json().catch(() => null);
    const parsed = PostBody.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_body", detail: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const existing = await db.query.playlistPairs.findFirst({
      where: and(
        eq(playlistPairs.userId, userId),
        eq(playlistPairs.spotifyPlaylistId, parsed.data.spotifyPlaylistId),
        eq(playlistPairs.youtubePlaylistId, parsed.data.youtubePlaylistId),
      ),
    });
    if (existing) {
      return NextResponse.json({ pair: existing, alreadyExists: true });
    }
    const [row] = await db
      .insert(playlistPairs)
      .values({
        userId,
        spotifyPlaylistId: parsed.data.spotifyPlaylistId,
        youtubePlaylistId: parsed.data.youtubePlaylistId,
      })
      .returning();
    return NextResponse.json({ pair: row }, { status: 201 });
  });
}
