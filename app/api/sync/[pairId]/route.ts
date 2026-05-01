import { NextResponse } from "next/server";
import { withSession } from "@/lib/auth/session";
import { spotifyForUser, youtubeForUser } from "@/lib/clients";
import { SyncEngine } from "@/lib/sync/engine";
import { DrizzleSyncStore } from "@/lib/sync/store";
import { NotConnectedError } from "@/lib/auth/tokens";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ pairId: string }> },
) {
  const { pairId } = await ctx.params;
  return withSession(async ({ userId }) => {
    try {
      const yt = youtubeForUser(userId);
      const engine = new SyncEngine({
        store: new DrizzleSyncStore(),
        spotify: spotifyForUser(userId),
        youtube: yt.client,
        quota: yt.quota,
        userId,
      });
      const result = await engine.planRun(pairId, "spotify_to_youtube");
      return NextResponse.json(result);
    } catch (err) {
      if (err instanceof NotConnectedError) {
        return NextResponse.json(
          { error: "not_connected", provider: err.provider },
          { status: 409 },
        );
      }
      const msg = err instanceof Error ? err.message : "unknown";
      if (/not found/i.test(msg)) {
        return NextResponse.json({ error: "pair_not_found" }, { status: 404 });
      }
      return NextResponse.json(
        { error: "plan_failed", detail: msg.slice(0, 500) },
        { status: 500 },
      );
    }
  });
}
