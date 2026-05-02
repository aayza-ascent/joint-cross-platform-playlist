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
        action: syncRunItems.action,
        status: syncRunItems.status,
        error: syncRunItems.error,
      })
      .from(syncRunItems)
      .where(eq(syncRunItems.runId, runId));

    // Per-direction counters split out of items.
    const c = {
      total: 0,
      pending: 0,
      done: 0,
      failed: 0,
      addedYt: 0,
      addedSp: 0,
      removedYt: 0,
      removedSp: 0,
      skipped: 0,
    };
    for (const it of items) {
      c.total++;
      if (it.status === "pending") c.pending++;
      if (it.status === "done") c.done++;
      if (it.status === "failed") c.failed++;
      if (it.status === "done") {
        if (it.action === "add_to_yt" || it.action === "add") c.addedYt++;
        else if (it.action === "add_to_sp") c.addedSp++;
        else if (it.action === "remove_from_yt" || it.action === "remove")
          c.removedYt++;
        else if (it.action === "remove_from_sp") c.removedSp++;
        else if (it.action === "skip") c.skipped++;
      }
    }
    return NextResponse.json({ run, counts: c });
  });
}
