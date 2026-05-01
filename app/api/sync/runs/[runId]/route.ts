import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { syncRunItems, syncRuns } from "@/db/schema";
import { withSession } from "@/lib/auth/session";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;
  return withSession(async ({ userId }) => {
    const run = await db.query.syncRuns.findFirst({
      where: eq(syncRuns.id, runId),
    });
    if (!run || run.userId !== userId) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const items = await db
      .select({
        spotifyTrackId: syncRunItems.spotifyTrackId,
        action: syncRunItems.action,
        status: syncRunItems.status,
        error: syncRunItems.error,
      })
      .from(syncRunItems)
      .where(eq(syncRunItems.runId, runId));
    const counts = items.reduce(
      (acc, it) => {
        acc.total++;
        if (it.status === "pending") acc.pending++;
        if (it.status === "done") acc.done++;
        if (it.status === "failed") acc.failed++;
        return acc;
      },
      { total: 0, pending: 0, done: 0, failed: 0 },
    );
    return NextResponse.json({ run, counts });
  });
}
