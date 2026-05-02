import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb } from "@/db/client";
import {
  playlistPairs,
  syncRunItems,
  syncRuns,
  trackMappings,
  unmatchedTracks,
} from "@/db/schema";

export type SyncRunStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "paused_quota";

export type SyncMode = "spotify_to_youtube" | "two_way";

// Action vocabulary for two-way: each item names exactly one operation on one
// provider. Legacy 'add' / 'remove' are kept as readable values so older rows
// in the DB don't trip type guards if anyone reads history.
export type SyncItemAction =
  | "add_to_yt"
  | "add_to_sp"
  | "remove_from_yt"
  | "remove_from_sp"
  | "skip"
  | "add"
  | "remove";
export type SyncItemStatus = "pending" | "done" | "failed";

export type PairRef = {
  id: string;
  userId: string;
  spotifyPlaylistId: string;
  youtubePlaylistId: string;
};

export type YoutubeBaselineItem = { videoId: string; playlistItemId: string };

export type PairBaseline = {
  spotifyTrackIds: string[];
  youtubeItems: YoutubeBaselineItem[];
  syncedAt: Date;
};

export type Mapping = {
  spotifyTrackId: string;
  youtubeVideoId: string;
  isrc?: string;
};

export type SyncRunRow = {
  id: string;
  pairId: string;
  userId: string;
  mode: SyncMode;
  status: SyncRunStatus;
  addedCount: number;
  removedCount: number;
  failedCount: number;
  quotaUnitsSpent: number;
  error: string | null;
};

export type SyncItemRow = {
  id: string;
  runId: string;
  action: SyncItemAction;
  status: SyncItemStatus;
  spotifyTrackId: string | null;
  youtubeVideoId: string | null;
  youtubePlaylistItemId: string | null;
  error: string | null;
};

export type NewSyncItem = Omit<SyncItemRow, "id" | "status" | "error">;

export interface SyncStore {
  getPair(pairId: string, userId: string): Promise<PairRef | null>;

  // Returns null when the pair has never had a successful sync.
  getPairBaseline(
    pairId: string,
    userId: string,
  ): Promise<PairBaseline | null>;

  // Are there any non-terminal runs for this pair? Two-way refuses to start
  // a new run if one is already in flight; otherwise the second planRun would
  // see a baseline that doesn't reflect the in-flight run's effects.
  hasActiveRun(pairId: string, userId: string): Promise<boolean>;

  getMappingsByTrackIds(
    userId: string,
    trackIds: string[],
  ): Promise<Map<string, Mapping>>;

  getMappingsByIsrcs(
    userId: string,
    isrcs: string[],
  ): Promise<Map<string, Mapping>>;

  // Reverse lookup keyed by youtube_video_id.
  getMappingsByVideoIds(
    userId: string,
    videoIds: string[],
  ): Promise<Map<string, Mapping>>;

  createSyncRun(args: {
    pairId: string;
    userId: string;
    mode: SyncMode;
  }): Promise<string>;

  insertSyncRunItems(items: NewSyncItem[]): Promise<void>;

  getSyncRun(runId: string): Promise<SyncRunRow | null>;

  getPendingItems(runId: string, limit: number): Promise<SyncItemRow[]>;

  updateSyncRunItem(
    itemId: string,
    patch: Partial<
      Pick<
        SyncItemRow,
        | "status"
        | "spotifyTrackId"
        | "youtubeVideoId"
        | "youtubePlaylistItemId"
        | "error"
      >
    >,
  ): Promise<void>;

  updateSyncRun(
    runId: string,
    patch: {
      status?: SyncRunStatus;
      addedDelta?: number;
      removedDelta?: number;
      failedDelta?: number;
      quotaDelta?: number;
      error?: string | null;
    },
  ): Promise<void>;

  // Commits status='done', finishedAt, AND writes the new baseline atomically.
  // Critical: paused_quota and failed runs MUST NOT call this — the baseline
  // staying put is what makes a re-run resume from the same reference point.
  commitRunDoneAndBaseline(
    runId: string,
    pairId: string,
    baseline: PairBaseline,
  ): Promise<void>;

  upsertMapping(args: {
    userId: string;
    spotifyTrackId: string;
    youtubeVideoId: string;
    isrc: string | null;
    confidence: number;
    matchMethod: string;
  }): Promise<void>;

  upsertUnmatched(args: {
    userId: string;
    spotifyTrackId: string;
    candidates: unknown;
    runId: string;
  }): Promise<void>;
}

// ---- Drizzle-backed production implementation ----

export class DrizzleSyncStore implements SyncStore {
  constructor(private db = defaultDb) {}

  async getPair(pairId: string, userId: string): Promise<PairRef | null> {
    const row = await this.db.query.playlistPairs.findFirst({
      where: and(eq(playlistPairs.id, pairId), eq(playlistPairs.userId, userId)),
    });
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      spotifyPlaylistId: row.spotifyPlaylistId,
      youtubePlaylistId: row.youtubePlaylistId,
    };
  }

  async getPairBaseline(
    pairId: string,
    userId: string,
  ): Promise<PairBaseline | null> {
    const row = await this.db.query.playlistPairs.findFirst({
      where: and(eq(playlistPairs.id, pairId), eq(playlistPairs.userId, userId)),
    });
    if (!row || !row.lastSyncedAt) return null;
    return {
      spotifyTrackIds: row.lastKnownSpotifyTrackIds ?? [],
      youtubeItems: row.lastKnownYoutubeItems ?? [],
      syncedAt: row.lastSyncedAt,
    };
  }

  async hasActiveRun(pairId: string, userId: string): Promise<boolean> {
    const row = await this.db
      .select({ id: syncRuns.id })
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.pairId, pairId),
          eq(syncRuns.userId, userId),
          inArray(syncRuns.status, ["pending", "running", "paused_quota"]),
        ),
      )
      .limit(1);
    return row.length > 0;
  }

  async getMappingsByTrackIds(
    userId: string,
    trackIds: string[],
  ): Promise<Map<string, Mapping>> {
    if (trackIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(trackMappings)
      .where(
        and(
          eq(trackMappings.userId, userId),
          inArray(trackMappings.spotifyTrackId, trackIds),
        ),
      );
    const out = new Map<string, Mapping>();
    for (const r of rows) {
      out.set(r.spotifyTrackId, {
        spotifyTrackId: r.spotifyTrackId,
        youtubeVideoId: r.youtubeVideoId,
        isrc: r.isrc ?? undefined,
      });
    }
    return out;
  }

  async getMappingsByIsrcs(
    userId: string,
    isrcs: string[],
  ): Promise<Map<string, Mapping>> {
    if (isrcs.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(trackMappings)
      .where(
        and(
          eq(trackMappings.userId, userId),
          inArray(trackMappings.isrc, isrcs),
        ),
      );
    const out = new Map<string, Mapping>();
    for (const r of rows) {
      if (r.isrc && !out.has(r.isrc)) {
        out.set(r.isrc, {
          spotifyTrackId: r.spotifyTrackId,
          youtubeVideoId: r.youtubeVideoId,
          isrc: r.isrc,
        });
      }
    }
    return out;
  }

  async getMappingsByVideoIds(
    userId: string,
    videoIds: string[],
  ): Promise<Map<string, Mapping>> {
    if (videoIds.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(trackMappings)
      .where(
        and(
          eq(trackMappings.userId, userId),
          inArray(trackMappings.youtubeVideoId, videoIds),
        ),
      );
    const out = new Map<string, Mapping>();
    for (const r of rows) {
      if (!out.has(r.youtubeVideoId)) {
        out.set(r.youtubeVideoId, {
          spotifyTrackId: r.spotifyTrackId,
          youtubeVideoId: r.youtubeVideoId,
          isrc: r.isrc ?? undefined,
        });
      }
    }
    return out;
  }

  async createSyncRun(args: {
    pairId: string;
    userId: string;
    mode: SyncMode;
  }): Promise<string> {
    const [row] = await this.db
      .insert(syncRuns)
      .values({
        pairId: args.pairId,
        userId: args.userId,
        mode: args.mode,
        status: "pending",
      })
      .returning({ id: syncRuns.id });
    return row.id;
  }

  async insertSyncRunItems(items: NewSyncItem[]): Promise<void> {
    if (items.length === 0) return;
    await this.db.insert(syncRunItems).values(
      items.map((it) => ({
        runId: it.runId,
        action: it.action,
        status: "pending" as SyncItemStatus,
        spotifyTrackId: it.spotifyTrackId,
        youtubeVideoId: it.youtubeVideoId,
        youtubePlaylistItemId: it.youtubePlaylistItemId,
      })),
    );
  }

  async getSyncRun(runId: string): Promise<SyncRunRow | null> {
    const r = await this.db.query.syncRuns.findFirst({
      where: eq(syncRuns.id, runId),
    });
    if (!r) return null;
    return {
      id: r.id,
      pairId: r.pairId,
      userId: r.userId,
      mode: r.mode as SyncMode,
      status: r.status as SyncRunStatus,
      addedCount: r.addedCount,
      removedCount: r.removedCount,
      failedCount: r.failedCount,
      quotaUnitsSpent: r.quotaUnitsSpent,
      error: r.error,
    };
  }

  async getPendingItems(
    runId: string,
    limit: number,
  ): Promise<SyncItemRow[]> {
    const rows = await this.db
      .select()
      .from(syncRunItems)
      .where(and(eq(syncRunItems.runId, runId), eq(syncRunItems.status, "pending")))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      runId: r.runId,
      action: r.action as SyncItemAction,
      status: r.status as SyncItemStatus,
      spotifyTrackId: r.spotifyTrackId,
      youtubeVideoId: r.youtubeVideoId,
      youtubePlaylistItemId: r.youtubePlaylistItemId,
      error: r.error,
    }));
  }

  async updateSyncRunItem(
    itemId: string,
    patch: Partial<
      Pick<
        SyncItemRow,
        | "status"
        | "spotifyTrackId"
        | "youtubeVideoId"
        | "youtubePlaylistItemId"
        | "error"
      >
    >,
  ): Promise<void> {
    await this.db
      .update(syncRunItems)
      .set(patch)
      .where(eq(syncRunItems.id, itemId));
  }

  async updateSyncRun(
    runId: string,
    patch: {
      status?: SyncRunStatus;
      addedDelta?: number;
      removedDelta?: number;
      failedDelta?: number;
      quotaDelta?: number;
      error?: string | null;
    },
  ): Promise<void> {
    const cur = await this.db.query.syncRuns.findFirst({
      where: eq(syncRuns.id, runId),
    });
    if (!cur) return;
    await this.db
      .update(syncRuns)
      .set({
        ...(patch.status && { status: patch.status }),
        addedCount: cur.addedCount + (patch.addedDelta ?? 0),
        removedCount: cur.removedCount + (patch.removedDelta ?? 0),
        failedCount: cur.failedCount + (patch.failedDelta ?? 0),
        quotaUnitsSpent: cur.quotaUnitsSpent + (patch.quotaDelta ?? 0),
        ...(patch.error !== undefined && { error: patch.error }),
      })
      .where(eq(syncRuns.id, runId));
  }

  async commitRunDoneAndBaseline(
    runId: string,
    pairId: string,
    baseline: PairBaseline,
  ): Promise<void> {
    // Neon HTTP doesn't support transactions over a single round-trip, so we
    // rely on conditional updates instead. The two writes happen back-to-back;
    // the run-status update is the visible 'commit point' for callers polling
    // /runs. If the baseline write fails after the run flips to done, the next
    // sync will treat the playlist as if it had no baseline (worst case: a
    // duplicate union sync). That's a less bad failure mode than the inverse:
    // baseline written but run still 'running' would mark recovered tracks as
    // already-baseline-known.
    await this.db
      .update(syncRuns)
      .set({ status: "done", finishedAt: new Date() })
      .where(eq(syncRuns.id, runId));
    await this.db
      .update(playlistPairs)
      .set({
        lastSyncedAt: baseline.syncedAt,
        lastKnownSpotifyTrackIds: baseline.spotifyTrackIds,
        lastKnownYoutubeItems: baseline.youtubeItems,
      })
      .where(eq(playlistPairs.id, pairId));
  }

  async upsertMapping(args: {
    userId: string;
    spotifyTrackId: string;
    youtubeVideoId: string;
    isrc: string | null;
    confidence: number;
    matchMethod: string;
  }): Promise<void> {
    await this.db
      .insert(trackMappings)
      .values({
        userId: args.userId,
        spotifyTrackId: args.spotifyTrackId,
        youtubeVideoId: args.youtubeVideoId,
        isrc: args.isrc,
        confidence: args.confidence.toString(),
        matchMethod: args.matchMethod,
      })
      .onConflictDoUpdate({
        target: [trackMappings.userId, trackMappings.spotifyTrackId],
        set: {
          youtubeVideoId: args.youtubeVideoId,
          isrc: args.isrc,
          confidence: args.confidence.toString(),
          matchMethod: args.matchMethod,
        },
      });
  }

  async upsertUnmatched(args: {
    userId: string;
    spotifyTrackId: string;
    candidates: unknown;
    runId: string;
  }): Promise<void> {
    await this.db
      .insert(unmatchedTracks)
      .values({
        userId: args.userId,
        spotifyTrackId: args.spotifyTrackId,
        candidates: args.candidates,
        lastSeenRunId: args.runId,
      })
      .onConflictDoUpdate({
        target: [unmatchedTracks.userId, unmatchedTracks.spotifyTrackId],
        set: {
          candidates: args.candidates,
          lastSeenRunId: args.runId,
          updatedAt: new Date(),
        },
      });
  }
}

// ---- In-memory store for tests ----

export class InMemorySyncStore implements SyncStore {
  pairs = new Map<string, PairRef>();
  baselines = new Map<string, PairBaseline>();
  mappings = new Map<string, Mapping & { userId: string }>();
  unmatched: Array<{
    userId: string;
    spotifyTrackId: string;
    candidates: unknown;
    runId: string;
  }> = [];
  runs = new Map<string, SyncRunRow>();
  items = new Map<string, SyncItemRow[]>();
  baselineCommits: Array<{ runId: string; pairId: string; baseline: PairBaseline }> = [];
  private seq = 0;

  private mappingKey(userId: string, trackId: string) {
    return `${userId}|${trackId}`;
  }

  async getPair(pairId: string, userId: string) {
    const p = this.pairs.get(pairId);
    if (!p || p.userId !== userId) return null;
    return p;
  }

  async getPairBaseline(pairId: string, userId: string) {
    const p = this.pairs.get(pairId);
    if (!p || p.userId !== userId) return null;
    return this.baselines.get(pairId) ?? null;
  }

  async hasActiveRun(pairId: string, userId: string) {
    for (const r of this.runs.values()) {
      if (
        r.pairId === pairId &&
        r.userId === userId &&
        (r.status === "pending" ||
          r.status === "running" ||
          r.status === "paused_quota")
      ) {
        return true;
      }
    }
    return false;
  }

  async getMappingsByTrackIds(userId: string, trackIds: string[]) {
    const out = new Map<string, Mapping>();
    for (const tid of trackIds) {
      const m = this.mappings.get(this.mappingKey(userId, tid));
      if (m) out.set(tid, m);
    }
    return out;
  }

  async getMappingsByIsrcs(userId: string, isrcs: string[]) {
    const out = new Map<string, Mapping>();
    for (const m of this.mappings.values()) {
      if (m.userId !== userId) continue;
      if (m.isrc && isrcs.includes(m.isrc) && !out.has(m.isrc)) {
        out.set(m.isrc, m);
      }
    }
    return out;
  }

  async getMappingsByVideoIds(userId: string, videoIds: string[]) {
    const out = new Map<string, Mapping>();
    if (videoIds.length === 0) return out;
    const set = new Set(videoIds);
    for (const m of this.mappings.values()) {
      if (m.userId !== userId) continue;
      if (set.has(m.youtubeVideoId) && !out.has(m.youtubeVideoId)) {
        out.set(m.youtubeVideoId, m);
      }
    }
    return out;
  }

  async createSyncRun(args: {
    pairId: string;
    userId: string;
    mode: SyncMode;
  }) {
    const id = `run_${++this.seq}`;
    this.runs.set(id, {
      id,
      pairId: args.pairId,
      userId: args.userId,
      mode: args.mode,
      status: "pending",
      addedCount: 0,
      removedCount: 0,
      failedCount: 0,
      quotaUnitsSpent: 0,
      error: null,
    });
    this.items.set(id, []);
    return id;
  }

  async insertSyncRunItems(rows: NewSyncItem[]) {
    for (const r of rows) {
      const arr = this.items.get(r.runId);
      if (!arr) throw new Error("unknown runId");
      arr.push({
        ...r,
        id: `item_${++this.seq}`,
        status: "pending",
        error: null,
      });
    }
  }

  async getSyncRun(runId: string) {
    return this.runs.get(runId) ?? null;
  }

  async getPendingItems(runId: string, limit: number) {
    return (this.items.get(runId) ?? [])
      .filter((it) => it.status === "pending")
      .slice(0, limit);
  }

  async updateSyncRunItem(
    itemId: string,
    patch: Partial<
      Pick<
        SyncItemRow,
        | "status"
        | "spotifyTrackId"
        | "youtubeVideoId"
        | "youtubePlaylistItemId"
        | "error"
      >
    >,
  ) {
    for (const arr of this.items.values()) {
      const idx = arr.findIndex((it) => it.id === itemId);
      if (idx >= 0) {
        arr[idx] = { ...arr[idx], ...patch };
        return;
      }
    }
  }

  async updateSyncRun(
    runId: string,
    patch: {
      status?: SyncRunStatus;
      addedDelta?: number;
      removedDelta?: number;
      failedDelta?: number;
      quotaDelta?: number;
      error?: string | null;
    },
  ) {
    const r = this.runs.get(runId);
    if (!r) return;
    if (patch.status) r.status = patch.status;
    r.addedCount += patch.addedDelta ?? 0;
    r.removedCount += patch.removedDelta ?? 0;
    r.failedCount += patch.failedDelta ?? 0;
    r.quotaUnitsSpent += patch.quotaDelta ?? 0;
    if (patch.error !== undefined) r.error = patch.error;
  }

  async commitRunDoneAndBaseline(
    runId: string,
    pairId: string,
    baseline: PairBaseline,
  ) {
    const r = this.runs.get(runId);
    if (r) r.status = "done";
    this.baselines.set(pairId, baseline);
    this.baselineCommits.push({ runId, pairId, baseline });
  }

  async upsertMapping(args: {
    userId: string;
    spotifyTrackId: string;
    youtubeVideoId: string;
    isrc: string | null;
    confidence: number;
    matchMethod: string;
  }) {
    this.mappings.set(this.mappingKey(args.userId, args.spotifyTrackId), {
      userId: args.userId,
      spotifyTrackId: args.spotifyTrackId,
      youtubeVideoId: args.youtubeVideoId,
      isrc: args.isrc ?? undefined,
    });
  }

  async upsertUnmatched(args: {
    userId: string;
    spotifyTrackId: string;
    candidates: unknown;
    runId: string;
  }) {
    this.unmatched.push(args);
  }
}
