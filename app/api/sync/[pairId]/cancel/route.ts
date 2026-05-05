import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { syncRuns } from "@/db/schema";
import { withSession } from "@/lib/auth/session";

// Marks any active (pending/running/paused_quota) run for this pair as
// failed with error='cancelled'. With auto-resume on Sync Now, a paused
// run is otherwise impossible to abandon — pressing Sync Now would
// resume it. This is the escape hatch.
//
// The conditional `inArray` on status guards against clobbering a run that
// finished racingly (e.g. step.commitDone wrote 'done' between the user's
// click and this handler).
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ pairId: string }> },
) {
  const { pairId } = await ctx.params;
  return withSession(async ({ userId }) => {
    const result = await db
      .update(syncRuns)
      .set({ status: "failed", error: "cancelled", finishedAt: new Date() })
      .where(
        and(
          eq(syncRuns.pairId, pairId),
          eq(syncRuns.userId, userId),
          inArray(syncRuns.status, ["pending", "running", "paused_quota"]),
        ),
      )
      .returning({ id: syncRuns.id });
    return NextResponse.json({
      cancelled: result.length,
      runIds: result.map((r) => r.id),
    });
  });
}
