import type { SpotifyClient } from "@/lib/spotify/client";
import type { YouTubeClient } from "@/lib/youtube/client";
import { QuotaExceededError } from "@/lib/youtube/client";
import type { QuotaAccounter } from "@/lib/youtube/quota";
import {
  AUTO_ACCEPT_THRESHOLD,
  matchSpotifyToYouTube,
  scoreCandidate,
} from "@/lib/match/normalize";
import type { NormalizedTrack } from "@/lib/types";
import {
  type SyncMode,
  type SyncStore,
} from "./store";

const STEP_ITEMS_DEFAULT = 5;
const STEP_WALL_BUDGET_MS = 8_000;
const QUOTA_GUARD_FOR_SEARCH = 100; // a single search.list call

export type PlanResult = {
  runId: string;
  totalItems: number;
  plannedAdds: number;
  plannedSkips: number;
  plannedQuotaUnits: number; // pessimistic estimate
};

export type StepResult = {
  processed: number;
  remaining: number;
  status: "running" | "done" | "failed" | "paused_quota";
  quotaRemainingToday: number;
};

export type EngineDeps = {
  store: SyncStore;
  spotify: SpotifyClient;
  youtube: YouTubeClient;
  quota: QuotaAccounter;
  // userId is the authenticated user owning the run; tied to deps because
  // the provider clients are already bound to that user's tokens.
  userId: string;
  now?: () => Date;
  itemsPerStep?: number;
};

export class SyncEngine {
  private now: () => Date;
  private itemsPerStep: number;

  constructor(private deps: EngineDeps) {
    this.now = deps.now ?? (() => new Date());
    this.itemsPerStep = deps.itemsPerStep ?? STEP_ITEMS_DEFAULT;
  }

  async planRun(pairId: string, mode: SyncMode): Promise<PlanResult> {
    const { store, spotify, youtube, userId } = this.deps;
    const pair = await store.getPair(pairId, userId);
    if (!pair) throw new Error(`pair ${pairId} not found for user`);

    const [spTracks, ytItems] = await Promise.all([
      spotify.getPlaylistTracks(pair.spotifyPlaylistId),
      youtube.getPlaylistItems(pair.youtubePlaylistId),
    ]);

    const existingYtIds = new Set(ytItems.map((it) => it.videoId));

    const trackIds = spTracks.map((t) => t.sourceTrackId);
    const isrcs = spTracks.map((t) => t.isrc).filter((x): x is string => !!x);

    const [byTrack, byIsrc] = await Promise.all([
      store.getMappingsByTrackIds(userId, trackIds),
      store.getMappingsByIsrcs(userId, isrcs),
    ]);

    const runId = await store.createSyncRun({
      pairId,
      userId,
      mode,
    });

    type Item = {
      runId: string;
      spotifyTrackId: string;
      action: "add" | "skip";
      youtubeVideoId: string | null;
    };
    const items: Item[] = [];
    let plannedAdds = 0;
    let plannedSkips = 0;
    let needsSearch = 0;

    for (const t of spTracks) {
      const direct = byTrack.get(t.sourceTrackId);
      const viaIsrc = t.isrc ? byIsrc.get(t.isrc) : undefined;
      const knownVideoId = direct?.youtubeVideoId ?? viaIsrc?.youtubeVideoId ?? null;

      if (knownVideoId && existingYtIds.has(knownVideoId)) {
        items.push({
          runId,
          spotifyTrackId: t.sourceTrackId,
          action: "skip",
          youtubeVideoId: knownVideoId,
        });
        plannedSkips++;
      } else {
        items.push({
          runId,
          spotifyTrackId: t.sourceTrackId,
          action: "add",
          youtubeVideoId: knownVideoId,
        });
        plannedAdds++;
        if (!knownVideoId) needsSearch++;
      }
    }

    await store.insertSyncRunItems(items);

    // Pessimistic quota estimate:
    //   - each search-needed track: 100 (search) + 1 (videos.list) ≈ 101
    //   - each known-videoId add:   50 (insert)
    //   - skips: 0
    const plannedQuotaUnits =
      needsSearch * 101 + (plannedAdds - needsSearch) * 50;

    return {
      runId,
      totalItems: items.length,
      plannedAdds,
      plannedSkips,
      plannedQuotaUnits,
    };
  }

  async stepRun(runId: string): Promise<StepResult> {
    const { store, spotify, youtube, userId } = this.deps;
    const run = await store.getSyncRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.userId !== userId) throw new Error("run does not belong to user");

    if (run.status === "done" || run.status === "failed") {
      return {
        processed: 0,
        remaining: 0,
        status: run.status,
        quotaRemainingToday: await this.deps.quota.remaining(),
      };
    }

    if (run.status === "pending") {
      await store.updateSyncRun(runId, { status: "running" });
    }

    const items = await store.getPendingItems(runId, this.itemsPerStep);
    if (items.length === 0) {
      await store.updateSyncRun(runId, { status: "done", finished: true });
      return {
        processed: 0,
        remaining: 0,
        status: "done",
        quotaRemainingToday: await this.deps.quota.remaining(),
      };
    }

    // Quota guard: if any items still need a search and we don't have headroom
    // for at least one search call, pause.
    const needsSearchCount = items.filter(
      (it) => it.action === "add" && !it.youtubeVideoId,
    ).length;
    const remainingQuota = await this.deps.quota.remaining();
    if (needsSearchCount > 0 && remainingQuota < QUOTA_GUARD_FOR_SEARCH) {
      await store.updateSyncRun(runId, { status: "paused_quota" });
      return {
        processed: 0,
        remaining: items.length,
        status: "paused_quota",
        quotaRemainingToday: remainingQuota,
      };
    }

    const deadline = this.now().getTime() + STEP_WALL_BUDGET_MS;
    const beforeQuota = remainingQuota;
    let processed = 0;
    let added = 0;
    let failed = 0;
    let pausedQuota = false;

    // Build current YT membership set from known-videoIds in this batch +
    // anything we're about to add. Belt-and-braces idempotency: if the same
    // videoId appears twice in pending items, only insert once.
    const localPlaylistMembership = new Set<string>();

    const pair = await store.getPair(run.pairId, userId);
    if (!pair) throw new Error("pair vanished mid-run");

    for (const item of items) {
      if (this.now().getTime() >= deadline) break;

      try {
        if (item.action === "skip") {
          await store.updateSyncRunItem(runId, item.spotifyTrackId, {
            status: "done",
          });
          processed++;
          continue;
        }

        let videoId = item.youtubeVideoId;
        let confidence = 1;
        let matchMethod = "manual";

        if (!videoId) {
          // Resolve via search → score
          const spTrack = await this.fetchSpotifyTrackForItem(
            pair.spotifyPlaylistId,
            item.spotifyTrackId,
          );
          if (!spTrack) {
            await store.updateSyncRunItem(runId, item.spotifyTrackId, {
              status: "failed",
              error: "spotify_track_missing",
            });
            failed++;
            processed++;
            continue;
          }

          const query = `${spTrack.title} ${spTrack.artists.join(" ")}`.slice(0, 200);
          const hits = await youtube.searchVideos(query, 5);
          if (hits.length === 0) {
            await store.upsertUnmatched({
              userId,
              spotifyTrackId: item.spotifyTrackId,
              candidates: [],
              runId,
            });
            await store.updateSyncRunItem(runId, item.spotifyTrackId, {
              status: "failed",
              error: "no_results",
            });
            failed++;
            processed++;
            continue;
          }

          const detail = await youtube.getVideosByIds(hits.map((h) => h.videoId));
          const candidates: NormalizedTrack[] = hits.map((h) => {
            const d = detail.get(h.videoId);
            return {
              source: "youtube",
              sourceTrackId: h.videoId,
              title: h.title,
              artists: [h.channelTitle].filter(Boolean),
              durationMs: d?.durationMs ?? 0,
            };
          });

          const matched = matchSpotifyToYouTube(spTrack, candidates);
          if (!matched.result) {
            await store.upsertUnmatched({
              userId,
              spotifyTrackId: item.spotifyTrackId,
              candidates: candidates.slice(0, 3).map((c, i) => ({
                videoId: c.sourceTrackId,
                title: c.title,
                channelTitle: c.artists[0] ?? "",
                durationMs: c.durationMs,
                score: matched.topN[i]?.score ?? 0,
              })),
              runId,
            });
            await store.updateSyncRunItem(runId, item.spotifyTrackId, {
              status: "failed",
              error: "low_confidence",
            });
            failed++;
            processed++;
            continue;
          }

          videoId = matched.result.videoId;
          confidence = matched.result.confidence;
          matchMethod = matched.result.method;

          await store.upsertMapping({
            userId,
            spotifyTrackId: item.spotifyTrackId,
            youtubeVideoId: videoId,
            isrc: spTrack.isrc ?? null,
            confidence,
            matchMethod,
          });
        }

        // Idempotent insert: skip if we're about to add a videoId we've
        // just added this batch.
        if (localPlaylistMembership.has(videoId)) {
          await store.updateSyncRunItem(runId, item.spotifyTrackId, {
            status: "done",
            youtubeVideoId: videoId,
          });
          processed++;
          continue;
        }

        await youtube.addToPlaylist(pair.youtubePlaylistId, videoId);
        localPlaylistMembership.add(videoId);

        await store.updateSyncRunItem(runId, item.spotifyTrackId, {
          status: "done",
          youtubeVideoId: videoId,
        });
        added++;
        processed++;
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          pausedQuota = true;
          break;
        }
        const msg =
          err instanceof Error ? err.message.slice(0, 500) : "unknown";
        await store.updateSyncRunItem(runId, item.spotifyTrackId, {
          status: "failed",
          error: msg,
        });
        failed++;
        processed++;
      }
    }

    const afterQuota = await this.deps.quota.remaining();
    const quotaSpent = Math.max(0, beforeQuota - afterQuota);

    await store.updateSyncRun(runId, {
      addedDelta: added,
      failedDelta: failed,
      quotaDelta: quotaSpent,
    });

    if (pausedQuota) {
      await store.updateSyncRun(runId, { status: "paused_quota" });
      return {
        processed,
        remaining: items.length - processed,
        status: "paused_quota",
        quotaRemainingToday: afterQuota,
      };
    }

    // Did we drain the queue?
    const stillPending = await store.getPendingItems(runId, 1);
    if (stillPending.length === 0) {
      await store.updateSyncRun(runId, { status: "done", finished: true });
      return {
        processed,
        remaining: 0,
        status: "done",
        quotaRemainingToday: afterQuota,
      };
    }

    return {
      processed,
      remaining: stillPending.length, // only proves at least one remains
      status: "running",
      quotaRemainingToday: afterQuota,
    };
  }

  // Re-fetch a single Spotify track when we need to score it. In a future
  // optimization we'd snapshot the planned tracks at planRun time so step
  // doesn't pay a round-trip per item, but for the MVP this is fine.
  private async fetchSpotifyTrackForItem(
    playlistId: string,
    trackId: string,
  ): Promise<NormalizedTrack | null> {
    const all = await this.deps.spotify.getPlaylistTracks(playlistId);
    return all.find((t) => t.sourceTrackId === trackId) ?? null;
  }
}

// Re-export for convenience.
export { scoreCandidate, AUTO_ACCEPT_THRESHOLD };
