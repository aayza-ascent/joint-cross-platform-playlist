import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { playlistPairs } from "@/db/schema";
import { withSession } from "@/lib/auth/session";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  return withSession(async ({ userId }) => {
    const result = await db
      .delete(playlistPairs)
      .where(and(eq(playlistPairs.id, id), eq(playlistPairs.userId, userId)))
      .returning({ id: playlistPairs.id });
    if (result.length === 0) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  });
}
