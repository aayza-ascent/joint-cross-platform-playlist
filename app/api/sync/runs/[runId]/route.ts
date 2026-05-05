import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { syncRunItems, syncRuns, unmatchedTracks } from "@/db/schema";
import { withSession } from "@/lib/auth/session";

type FailurePayload = {
  action: string;
  error: string | null;
  spotifyTrackId: string | null;
  youtubeVideoId: string | null;
  spotifyTitle: string | null;
  spotifyArtists: string[] | null;
  candidates: Array<{
    videoId: string;
    title: string;
    channelTitle: string;
    durationMs: number;
    score: number;
  }> | null;
};

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
        spotifyTrackId: syncRunItems.spotifyTrackId,
        youtubeVideoId: syncRunItems.youtubeVideoId,
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
    const failedItems: typeof items = [];
    for (const it of items) {
      c.total++;
      if (it.status === "pending") c.pending++;
      if (it.status === "done") c.done++;
      if (it.status === "failed") {
        c.failed++;
        failedItems.push(it);
      }
      if (it.status === "done") {
        if (it.action === "add_to_yt" || it.action === "add") c.addedYt++;
        else if (it.action === "add_to_sp") c.addedSp++;
        else if (it.action === "remove_from_yt" || it.action === "remove")
          c.removedYt++;
        else if (it.action === "remove_from_sp") c.removedSp++;
        else if (it.action === "skip") c.skipped++;
      }
    }

    // For low_confidence / no_results failures we wrote a row to
    // unmatched_tracks at step time with the Spotify metadata and the top-3
    // candidates. Join on (userId, spotifyTrackId) so the dashboard can show
    // the actual track name and clickable candidate links.
    const trackIds = failedItems
      .map((f) => f.spotifyTrackId)
      .filter((x): x is string => Boolean(x));
    const unmatchedByTrackId = new Map<string, UnmatchedPayload>();
    if (trackIds.length > 0) {
      const rows = await db
        .select()
        .from(unmatchedTracks)
        .where(
          and(
            eq(unmatchedTracks.userId, userId),
            inArray(unmatchedTracks.spotifyTrackId, trackIds),
          ),
        );
      for (const r of rows) {
        unmatchedByTrackId.set(
          r.spotifyTrackId,
          coerceUnmatched(r.candidates),
        );
      }
    }

    const failures: FailurePayload[] = failedItems.map((it) => {
      const u = it.spotifyTrackId
        ? unmatchedByTrackId.get(it.spotifyTrackId)
        : null;
      return {
        action: it.action,
        error: it.error,
        spotifyTrackId: it.spotifyTrackId,
        youtubeVideoId: it.youtubeVideoId,
        spotifyTitle: u?.spotifyTitle ?? null,
        spotifyArtists: u?.spotifyArtists ?? null,
        candidates: u?.candidates ?? null,
      };
    });

    return NextResponse.json({ run, counts: c, failures });
  });
}

type UnmatchedPayload = {
  spotifyTitle: string | null;
  spotifyArtists: string[] | null;
  candidates: FailurePayload["candidates"];
};

// The unmatched_tracks.candidates JSONB is either the new shape (object with
// spotifyTitle/spotifyArtists/candidates) or the legacy shape (bare array of
// candidates) from rows written before the engine started persisting metadata.
function coerceUnmatched(raw: unknown): UnmatchedPayload {
  if (Array.isArray(raw)) {
    return {
      spotifyTitle: null,
      spotifyArtists: null,
      candidates: raw as FailurePayload["candidates"],
    };
  }
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    return {
      spotifyTitle: typeof r.spotifyTitle === "string" ? r.spotifyTitle : null,
      spotifyArtists: Array.isArray(r.spotifyArtists)
        ? (r.spotifyArtists as string[])
        : null,
      candidates: Array.isArray(r.candidates)
        ? (r.candidates as FailurePayload["candidates"])
        : null,
    };
  }
  return { spotifyTitle: null, spotifyArtists: null, candidates: null };
}
