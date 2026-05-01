import { NextResponse, type NextRequest } from "next/server";
import { withSession } from "@/lib/auth/session";
import { spotifyForUser, youtubeForUser } from "@/lib/clients";
import { SyncEngine } from "@/lib/sync/engine";
import { DrizzleSyncStore } from "@/lib/sync/store";

export async function POST(
  req: NextRequest,
  _ctx: { params: Promise<{ pairId: string }> },
) {
  return withSession(async ({ userId }) => {
    const runId = req.nextUrl.searchParams.get("runId");
    if (!runId) {
      return NextResponse.json({ error: "missing_runId" }, { status: 400 });
    }
    const yt = youtubeForUser(userId);
    const engine = new SyncEngine({
      store: new DrizzleSyncStore(),
      spotify: spotifyForUser(userId),
      youtube: yt.client,
      quota: yt.quota,
      userId,
    });
    try {
      const result = await engine.stepRun(runId);
      return NextResponse.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      if (/does not belong/.test(msg)) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
      if (/not found/i.test(msg)) {
        return NextResponse.json({ error: "run_not_found" }, { status: 404 });
      }
      return NextResponse.json(
        { error: "step_failed", detail: msg.slice(0, 500) },
        { status: 500 },
      );
    }
  });
}
