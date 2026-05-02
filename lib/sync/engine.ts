import type { SpotifyClient } from "@/lib/spotify/client";
import type { YouTubeClient } from "@/lib/youtube/client";
import { QuotaExceededError } from "@/lib/youtube/client";
import type { QuotaAccounter } from "@/lib/youtube/quota";
import {
  matchSpotifyToYouTube,
  matchYouTubeToSpotify,
} from "@/lib/match/normalize";
import type { NormalizedTrack } from "@/lib/types";
import {
  type NewSyncItem,
  type PairBaseline,
  type SyncItemRow,
  type SyncStore,
} from "./store";

const STEP_ITEMS_DEFAULT = 5;
const STEP_WALL_BUDGET_MS = 8_000;
const QUOTA_GUARD_FOR_SEARCH = 100; // a single search.list call

export class ActiveRunExistsError extends Error {
  constructor() {
    super(
      "another sync is already in progress for this pair; finish or cancel it first",
    );
  }
}

export type PlanResult = {
  runId: string;
  totalItems: number;
  plannedAddYt: number;
  plannedAddSp: number;
  plannedRemoveYt: number;
  plannedRemoveSp: number;
  plannedSkips: number;
  plannedQuotaUnits: number;
  isFirstSync: boolean;
};

export type StepStatus = "running" | "done" | "failed" | "paused_quota";

export type StepResult = {
  processed: number;
  remaining: number;
  status: StepStatus;
  quotaRemainingToday: number;
};

export type EngineDeps = {
  store: SyncStore;
  spotify: SpotifyClient;
  youtube: YouTubeClient;
  quota: QuotaAccounter;
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

  async planRun(pairId: string): Promise<PlanResult> {
    const { store, spotify, youtube, userId } = this.deps;
    const pair = await store.getPair(pairId, userId);
    if (!pair) throw new Error(`pair ${pairId} not found for user`);

    if (await store.hasActiveRun(pairId, userId)) {
      throw new ActiveRunExistsError();
    }

    const [baseline, spTracks, ytItems] = await Promise.all([
      store.getPairBaseline(pairId, userId),
      spotify.getPlaylistTracks(pair.spotifyPlaylistId),
      youtube.getPlaylistItems(pair.youtubePlaylistId),
    ]);

    const isFirstSync = baseline === null;

    // Snapshot of "now" — used both for delta math and for the baseline we'll
    // write at end-of-run. Crucially, the baseline reflects what we OBSERVED
    // at plan time, not a refetch later. If the user mutates the playlist
    // mid-run, those changes are picked up by the *next* sync, not silently
    // collapsed into this one.
    const sp_now = new Set<string>();
    for (const t of spTracks) sp_now.add(t.sourceTrackId);

    const yt_now = new Map<string, string>(); // videoId -> playlistItemId
    for (const it of ytItems) yt_now.set(it.videoId, it.playlistItemId);

    const sp_baseline = new Set(baseline?.spotifyTrackIds ?? []);
    const yt_baseline_videos = new Set(
      (baseline?.youtubeItems ?? []).map((i) => i.videoId),
    );

    // Per-side deltas vs baseline. First sync (no baseline): both baselines
    // are empty, so sp_added == sp_now and yt_added == yt_now (the union case).
    const sp_added: string[] = [];
    const sp_removed: string[] = [];
    const yt_added_video_ids: string[] = [];
    const yt_removed: Array<{ videoId: string; playlistItemId: string }> = [];

    for (const id of sp_now) {
      if (!sp_baseline.has(id)) sp_added.push(id);
    }
    for (const id of sp_baseline) {
      if (!sp_now.has(id)) sp_removed.push(id);
    }
    for (const [videoId] of yt_now) {
      if (!yt_baseline_videos.has(videoId)) yt_added_video_ids.push(videoId);
    }
    for (const baseItem of baseline?.youtubeItems ?? []) {
      if (!yt_now.has(baseItem.videoId)) yt_removed.push(baseItem);
    }

    // Look up mappings for the items we'll need to resolve at plan or step time.
    const [spAddedMappings, spIsrcMappings, ytAddedMappings, spRemovedMappings, ytRemovedMappings] =
      await Promise.all([
        store.getMappingsByTrackIds(userId, sp_added),
        store.getMappingsByIsrcs(
          userId,
          spTracks
            .filter((t) => sp_added.includes(t.sourceTrackId) && t.isrc)
            .map((t) => t.isrc!),
        ),
        store.getMappingsByVideoIds(userId, yt_added_video_ids),
        store.getMappingsByTrackIds(userId, sp_removed),
        store.getMappingsByVideoIds(
          userId,
          yt_removed.map((r) => r.videoId),
        ),
      ]);
    const isrcByTrackId = new Map<string, string>();
    for (const t of spTracks) if (t.isrc) isrcByTrackId.set(t.sourceTrackId, t.isrc);

    // Conflict resolution: adds win, removes lose. If a Spotify track was
    // both removed (per baseline) and would correspond to a YT video that
    // was added since baseline (via mapping), drop both — the track stays.
    const conflictedYtVideos = new Set<string>();
    const sp_removed_filtered: string[] = [];
    for (const tid of sp_removed) {
      const mapping = spRemovedMappings.get(tid);
      if (mapping && yt_added_video_ids.includes(mapping.youtubeVideoId)) {
        conflictedYtVideos.add(mapping.youtubeVideoId);
        continue; // user re-added on YT — preserve
      }
      sp_removed_filtered.push(tid);
    }
    const conflictedSpTracks = new Set<string>();
    const yt_removed_filtered: typeof yt_removed = [];
    for (const r of yt_removed) {
      const mapping = ytRemovedMappings.get(r.videoId);
      if (mapping && sp_added.includes(mapping.spotifyTrackId)) {
        conflictedSpTracks.add(mapping.spotifyTrackId);
        continue;
      }
      yt_removed_filtered.push(r);
    }
    const yt_added_filtered = yt_added_video_ids.filter(
      (v) => !conflictedYtVideos.has(v),
    );
    const sp_added_filtered = sp_added.filter(
      (t) => !conflictedSpTracks.has(t),
    );

    const runId = await store.createSyncRun({
      pairId,
      userId,
      mode: "two_way",
    });

    const items: NewSyncItem[] = [];
    let plannedAddYt = 0;
    let plannedAddSp = 0;
    let plannedRemoveYt = 0;
    let plannedRemoveSp = 0;
    let plannedSkips = 0;
    let needsYtSearch = 0;
    let needsSpSearch = 0;

    // Track videoIds covered by the SP-side loop, so the YT-side loop doesn't
    // re-emit a duplicate row for the same mapped pair when both ends already
    // have it (a common first-sync edge case with pre-existing mappings).
    const ytVideoIdsCoveredFromSpSide = new Set<string>();

    for (const tid of sp_added_filtered) {
      const direct = spAddedMappings.get(tid);
      const isrc = isrcByTrackId.get(tid);
      const viaIsrc = isrc ? spIsrcMappings.get(isrc) : undefined;
      const knownVideoId = direct?.youtubeVideoId ?? viaIsrc?.youtubeVideoId ?? null;
      if (knownVideoId && yt_now.has(knownVideoId)) {
        items.push({
          runId,
          action: "skip",
          spotifyTrackId: tid,
          youtubeVideoId: knownVideoId,
          youtubePlaylistItemId: yt_now.get(knownVideoId) ?? null,
        });
        plannedSkips++;
        ytVideoIdsCoveredFromSpSide.add(knownVideoId);
      } else {
        items.push({
          runId,
          action: "add_to_yt",
          spotifyTrackId: tid,
          youtubeVideoId: knownVideoId,
          youtubePlaylistItemId: null,
        });
        plannedAddYt++;
        if (!knownVideoId) needsYtSearch++;
      }
    }

    for (const videoId of yt_added_filtered) {
      if (ytVideoIdsCoveredFromSpSide.has(videoId)) continue;
      const mapping = ytAddedMappings.get(videoId);
      const knownTrackId = mapping?.spotifyTrackId ?? null;
      if (knownTrackId && sp_now.has(knownTrackId)) {
        items.push({
          runId,
          action: "skip",
          spotifyTrackId: knownTrackId,
          youtubeVideoId: videoId,
          youtubePlaylistItemId: yt_now.get(videoId) ?? null,
        });
        plannedSkips++;
      } else {
        items.push({
          runId,
          action: "add_to_sp",
          spotifyTrackId: knownTrackId,
          youtubeVideoId: videoId,
          youtubePlaylistItemId: yt_now.get(videoId) ?? null,
        });
        plannedAddSp++;
        if (!knownTrackId) needsSpSearch++;
      }
    }

    for (const tid of sp_removed_filtered) {
      const mapping = spRemovedMappings.get(tid);
      if (mapping && yt_now.has(mapping.youtubeVideoId)) {
        items.push({
          runId,
          action: "remove_from_yt",
          spotifyTrackId: tid,
          youtubeVideoId: mapping.youtubeVideoId,
          youtubePlaylistItemId: yt_now.get(mapping.youtubeVideoId) ?? null,
        });
        plannedRemoveYt++;
      } else {
        // No mapping or already gone — skip.
        items.push({
          runId,
          action: "skip",
          spotifyTrackId: tid,
          youtubeVideoId: mapping?.youtubeVideoId ?? null,
          youtubePlaylistItemId: null,
        });
        plannedSkips++;
      }
    }

    for (const r of yt_removed_filtered) {
      const mapping = ytRemovedMappings.get(r.videoId);
      if (mapping && sp_now.has(mapping.spotifyTrackId)) {
        items.push({
          runId,
          action: "remove_from_sp",
          spotifyTrackId: mapping.spotifyTrackId,
          youtubeVideoId: r.videoId,
          youtubePlaylistItemId: r.playlistItemId,
        });
        plannedRemoveSp++;
      } else {
        items.push({
          runId,
          action: "skip",
          spotifyTrackId: mapping?.spotifyTrackId ?? null,
          youtubeVideoId: r.videoId,
          youtubePlaylistItemId: r.playlistItemId,
        });
        plannedSkips++;
      }
    }

    await store.insertSyncRunItems(items);

    // Pessimistic quota estimate (YouTube only — Spotify side is free):
    //   add_to_yt unmapped:  101 (100 search + ~1 videos.list)
    //   add_to_yt mapped:     50 (insert)
    //   remove_from_yt:       50
    //   add_to_sp / remove_from_sp / skip:  0
    const plannedQuotaUnits =
      needsYtSearch * 101 +
      (plannedAddYt - needsYtSearch) * 50 +
      plannedRemoveYt * 50;

    return {
      runId,
      totalItems: items.length,
      plannedAddYt,
      plannedAddSp,
      plannedRemoveYt,
      plannedRemoveSp,
      plannedSkips,
      plannedQuotaUnits,
      isFirstSync,
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
      // Already drained — flip to done and write baseline.
      await this.commitDone(runId, run.pairId);
      return {
        processed: 0,
        remaining: 0,
        status: "done",
        quotaRemainingToday: await this.deps.quota.remaining(),
      };
    }

    // Quota guard — only matters for items that will hit the YouTube API.
    const ytCostingItems = items.filter(
      (it) => it.action === "add_to_yt" || it.action === "remove_from_yt",
    ).length;
    const remainingQuota = await this.deps.quota.remaining();
    if (ytCostingItems > 0 && remainingQuota < QUOTA_GUARD_FOR_SEARCH) {
      await store.updateSyncRun(runId, { status: "paused_quota" });
      return {
        processed: 0,
        remaining: items.length,
        status: "paused_quota",
        quotaRemainingToday: remainingQuota,
      };
    }

    const pair = await store.getPair(run.pairId, userId);
    if (!pair) throw new Error("pair vanished mid-run");

    const deadline = this.now().getTime() + STEP_WALL_BUDGET_MS;
    const beforeQuota = remainingQuota;
    let processed = 0;
    let added = 0;
    let removed = 0;
    let failed = 0;
    let pausedQuota = false;

    // Idempotent insert/delete tracking within this batch.
    const insertedYtVideos = new Set<string>();
    const insertedSpTracks = new Set<string>();
    const removedYtPlaylistItems = new Set<string>();
    const removedSpTracks = new Set<string>();

    for (const item of items) {
      if (this.now().getTime() >= deadline) break;
      try {
        if (item.action === "skip") {
          await store.updateSyncRunItem(item.id, { status: "done" });
          processed++;
          continue;
        }

        if (item.action === "add_to_yt") {
          const ok = await this.handleAddToYt(item, pair, insertedYtVideos);
          if (ok && !insertedYtVideos.has(ok.videoId)) {
            insertedYtVideos.add(ok.videoId);
            added++;
          }
          processed++;
          continue;
        }

        if (item.action === "remove_from_yt") {
          if (!item.youtubePlaylistItemId) {
            await store.updateSyncRunItem(item.id, {
              status: "failed",
              error: "missing_playlist_item_id",
            });
            failed++;
            processed++;
            continue;
          }
          if (!removedYtPlaylistItems.has(item.youtubePlaylistItemId)) {
            await youtube.removeFromPlaylist(item.youtubePlaylistItemId);
            removedYtPlaylistItems.add(item.youtubePlaylistItemId);
            removed++;
          }
          await store.updateSyncRunItem(item.id, { status: "done" });
          processed++;
          continue;
        }

        if (item.action === "add_to_sp") {
          const ok = await this.handleAddToSp(item, pair, insertedSpTracks);
          if (ok && !insertedSpTracks.has(ok.spotifyTrackId)) {
            insertedSpTracks.add(ok.spotifyTrackId);
            added++;
          }
          processed++;
          continue;
        }

        if (item.action === "remove_from_sp") {
          if (!item.spotifyTrackId) {
            await store.updateSyncRunItem(item.id, {
              status: "failed",
              error: "missing_spotify_track_id",
            });
            failed++;
            processed++;
            continue;
          }
          if (!removedSpTracks.has(item.spotifyTrackId)) {
            await spotify.removeTracks(pair.spotifyPlaylistId, [
              { uri: `spotify:track:${item.spotifyTrackId}` },
            ]);
            removedSpTracks.add(item.spotifyTrackId);
            removed++;
          }
          await store.updateSyncRunItem(item.id, { status: "done" });
          processed++;
          continue;
        }

        // Legacy actions (rows from a one-way run) — treat conservatively.
        if (item.action === "add" && item.youtubeVideoId) {
          await youtube.addToPlaylist(
            pair.youtubePlaylistId,
            item.youtubeVideoId,
          );
          await store.updateSyncRunItem(item.id, { status: "done" });
          added++;
          processed++;
          continue;
        }
        await store.updateSyncRunItem(item.id, {
          status: "failed",
          error: `unknown_action:${item.action}`,
        });
        failed++;
        processed++;
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          pausedQuota = true;
          break;
        }
        const msg = err instanceof Error ? err.message.slice(0, 500) : "unknown";
        await store.updateSyncRunItem(item.id, {
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
      removedDelta: removed,
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

    const stillPending = await store.getPendingItems(runId, 1);
    if (stillPending.length === 0) {
      await this.commitDone(runId, run.pairId);
      return {
        processed,
        remaining: 0,
        status: "done",
        quotaRemainingToday: afterQuota,
      };
    }

    return {
      processed,
      remaining: stillPending.length,
      status: "running",
      quotaRemainingToday: afterQuota,
    };
  }

  private async commitDone(runId: string, pairId: string) {
    const { store, spotify, youtube, userId } = this.deps;
    const pair = await store.getPair(pairId, userId);
    if (!pair) return;
    // Re-snapshot AFTER all step writes so the baseline reflects the end-state.
    const [spTracks, ytItems] = await Promise.all([
      spotify.getPlaylistTracks(pair.spotifyPlaylistId),
      youtube.getPlaylistItems(pair.youtubePlaylistId),
    ]);
    const baseline: PairBaseline = {
      spotifyTrackIds: spTracks.map((t) => t.sourceTrackId),
      youtubeItems: ytItems.map((i) => ({
        videoId: i.videoId,
        playlistItemId: i.playlistItemId,
      })),
      syncedAt: this.now(),
    };
    await store.commitRunDoneAndBaseline(runId, pairId, baseline);
  }

  private async handleAddToYt(
    item: SyncItemRow,
    pair: { spotifyPlaylistId: string; youtubePlaylistId: string },
    alreadyInserted: Set<string>,
  ): Promise<{ videoId: string } | null> {
    const { store, spotify, youtube, userId } = this.deps;
    let videoId = item.youtubeVideoId;
    let confidence = 1;
    let matchMethod: "manual" | "isrc" | "fuzzy_high" | "fuzzy_low" = "manual";

    if (!videoId) {
      const spTrack = await this.fetchSpotifyTrackForItem(
        pair.spotifyPlaylistId,
        item.spotifyTrackId!,
      );
      if (!spTrack) {
        await store.updateSyncRunItem(item.id, {
          status: "failed",
          error: "spotify_track_missing",
        });
        return null;
      }
      const query = `${spTrack.title} ${spTrack.artists.join(" ")}`.slice(
        0,
        200,
      );
      const hits = await youtube.searchVideos(query, 5);
      if (hits.length === 0) {
        await store.upsertUnmatched({
          userId,
          spotifyTrackId: item.spotifyTrackId!,
          candidates: [],
          runId: item.runId,
        });
        await store.updateSyncRunItem(item.id, {
          status: "failed",
          error: "no_results",
        });
        return null;
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
          spotifyTrackId: item.spotifyTrackId!,
          candidates: candidates.slice(0, 3).map((c, i) => ({
            videoId: c.sourceTrackId,
            title: c.title,
            channelTitle: c.artists[0] ?? "",
            durationMs: c.durationMs,
            score: matched.topN[i]?.score ?? 0,
          })),
          runId: item.runId,
        });
        await store.updateSyncRunItem(item.id, {
          status: "failed",
          error: "low_confidence",
        });
        return null;
      }
      videoId = matched.result.videoId;
      confidence = matched.result.confidence;
      matchMethod = matched.result.method;
      await store.upsertMapping({
        userId,
        spotifyTrackId: item.spotifyTrackId!,
        youtubeVideoId: videoId,
        isrc: spTrack.isrc ?? null,
        confidence,
        matchMethod,
      });
    }

    if (!alreadyInserted.has(videoId)) {
      await youtube.addToPlaylist(pair.youtubePlaylistId, videoId);
    }
    await store.updateSyncRunItem(item.id, {
      status: "done",
      youtubeVideoId: videoId,
    });
    return { videoId };
  }

  private async handleAddToSp(
    item: SyncItemRow,
    pair: { spotifyPlaylistId: string; youtubePlaylistId: string },
    alreadyInserted: Set<string>,
  ): Promise<{ spotifyTrackId: string } | null> {
    const { store, spotify, youtube, userId } = this.deps;
    let trackId = item.spotifyTrackId;
    let confidence = 1;
    let matchMethod: "manual" | "isrc" | "fuzzy_high" | "fuzzy_low" = "manual";

    if (!trackId) {
      if (!item.youtubeVideoId) {
        await store.updateSyncRunItem(item.id, {
          status: "failed",
          error: "missing_youtube_video_id",
        });
        return null;
      }
      const ytTrack = await this.fetchYoutubeTrackForItem(
        pair.youtubePlaylistId,
        item.youtubeVideoId,
      );
      if (!ytTrack) {
        await store.updateSyncRunItem(item.id, {
          status: "failed",
          error: "youtube_video_missing",
        });
        return null;
      }
      const query = `${ytTrack.title} ${ytTrack.artists.join(" ")}`.slice(
        0,
        200,
      );
      const hits = await spotify.searchTracks(query, 5);
      if (hits.length === 0) {
        await store.updateSyncRunItem(item.id, {
          status: "failed",
          error: "no_results",
        });
        return null;
      }
      const matched = matchYouTubeToSpotify(ytTrack, hits);
      if (!matched.result) {
        await store.updateSyncRunItem(item.id, {
          status: "failed",
          error: "low_confidence",
        });
        return null;
      }
      trackId = matched.result.videoId; // misleading field name — it's a Spotify trackId in this direction
      confidence = matched.result.confidence;
      matchMethod = matched.result.method;
      await store.upsertMapping({
        userId,
        spotifyTrackId: trackId,
        youtubeVideoId: item.youtubeVideoId,
        isrc: hits.find((h) => h.sourceTrackId === trackId)?.isrc ?? null,
        confidence,
        matchMethod,
      });
    }

    if (!alreadyInserted.has(trackId)) {
      await spotify.addTracks(pair.spotifyPlaylistId, [
        `spotify:track:${trackId}`,
      ]);
    }
    await store.updateSyncRunItem(item.id, {
      status: "done",
      spotifyTrackId: trackId,
    });
    return { spotifyTrackId: trackId };
  }

  private async fetchSpotifyTrackForItem(
    playlistId: string,
    trackId: string,
  ): Promise<NormalizedTrack | null> {
    const all = await this.deps.spotify.getPlaylistTracks(playlistId);
    return all.find((t) => t.sourceTrackId === trackId) ?? null;
  }

  private async fetchYoutubeTrackForItem(
    playlistId: string,
    videoId: string,
  ): Promise<NormalizedTrack | null> {
    // For unmapped YT-add items we need the video metadata to score against
    // Spotify candidates. videos.list (1 unit) is the right call here, not
    // re-listing the playlist.
    const detail = await this.deps.youtube.getVideosByIds([videoId]);
    const meta = detail.get(videoId);
    if (!meta) return null;
    return {
      source: "youtube",
      sourceTrackId: videoId,
      title: meta.title,
      artists: [meta.channelTitle].filter(Boolean),
      durationMs: meta.durationMs,
    };
  }
}
