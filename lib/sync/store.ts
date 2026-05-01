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

export type SyncMode = "spotify_to_youtube";

export type SyncItemAction = "add" | "remove" | "skip";
export type SyncItemStatus = "pending" | "done" | "failed";

export type PairRef = {
  id: string;
  userId: string;
  spotifyPlaylistId: string;
  youtubePlaylistId: string;
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
  runId: string;
  spotifyTrackId: string;
  action: SyncItemAction;
  status: SyncItemStatus;
  youtubeVideoId: string | null;
  error: string | null;
};

export interface SyncStore {
  getPair(pairId: string, userId: string): Promise<PairRef | null>;

  getMappingsByTrackIds(
    userId: string,
    trackIds: string[],
  ): Promise<Map<string, Mapping>>;

  getMappingsByIsrcs(
    userId: string,
    isrcs: string[],
  ): Promise<Map<string, Mapping>>;

  createSyncRun(args: {
    pairId: string;
    userId: string;
    mode: SyncMode;
  }): Promise<string>;

  insertSyncRunItems(
    items: Array<Omit<SyncItemRow, "status" | "error">>,
  ): Promise<void>;

  getSyncRun(runId: string): Promise<SyncRunRow | null>;

  getPendingItems(runId: string, limit: number): Promise<SyncItemRow[]>;

  updateSyncRunItem(
    runId: string,
    trackId: string,
    patch: Partial<Pick<SyncItemRow, "status" | "youtubeVideoId" | "error">>,
  ): Promise<void>;

  updateSyncRun(
    runId: string,
    patch: {
      status?: SyncRunStatus;
      addedDelta?: number;
      removedDelta?: number;
      failedDelta?: number;
      quotaDelta?: number;
      finished?: boolean;
      error?: string | null;
    },
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

  async insertSyncRunItems(
    items: Array<Omit<SyncItemRow, "status" | "error">>,
  ): Promise<void> {
    if (items.length === 0) return;
    await this.db.insert(syncRunItems).values(
      items.map((it) => ({
        runId: it.runId,
        spotifyTrackId: it.spotifyTrackId,
        action: it.action,
        status: "pending" as SyncItemStatus,
        youtubeVideoId: it.youtubeVideoId,
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
      runId: r.runId,
      spotifyTrackId: r.spotifyTrackId,
      action: r.action as SyncItemAction,
      status: r.status as SyncItemStatus,
      youtubeVideoId: r.youtubeVideoId,
      error: r.error,
    }));
  }

  async updateSyncRunItem(
    runId: string,
    trackId: string,
    patch: Partial<Pick<SyncItemRow, "status" | "youtubeVideoId" | "error">>,
  ): Promise<void> {
    await this.db
      .update(syncRunItems)
      .set(patch)
      .where(
        and(
          eq(syncRunItems.runId, runId),
          eq(syncRunItems.spotifyTrackId, trackId),
        ),
      );
  }

  async updateSyncRun(
    runId: string,
    patch: {
      status?: SyncRunStatus;
      addedDelta?: number;
      removedDelta?: number;
      failedDelta?: number;
      quotaDelta?: number;
      finished?: boolean;
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
        ...(patch.finished && { finishedAt: new Date() }),
        ...(patch.error !== undefined && { error: patch.error }),
      })
      .where(eq(syncRuns.id, runId));
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
  mappings = new Map<string, Mapping & { userId: string }>();
  unmatched: Array<{
    userId: string;
    spotifyTrackId: string;
    candidates: unknown;
    runId: string;
  }> = [];
  runs = new Map<string, SyncRunRow>();
  items = new Map<string, SyncItemRow[]>();
  private seq = 0;

  private mappingKey(userId: string, trackId: string) {
    return `${userId}|${trackId}`;
  }

  async getPair(pairId: string, userId: string) {
    const p = this.pairs.get(pairId);
    if (!p || p.userId !== userId) return null;
    return p;
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

  async insertSyncRunItems(
    rows: Array<Omit<SyncItemRow, "status" | "error">>,
  ) {
    for (const r of rows) {
      const arr = this.items.get(r.runId);
      if (!arr) throw new Error("unknown runId");
      arr.push({ ...r, status: "pending", error: null });
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
    runId: string,
    trackId: string,
    patch: Partial<Pick<SyncItemRow, "status" | "youtubeVideoId" | "error">>,
  ) {
    const arr = this.items.get(runId) ?? [];
    const idx = arr.findIndex((it) => it.spotifyTrackId === trackId);
    if (idx >= 0) arr[idx] = { ...arr[idx], ...patch };
  }

  async updateSyncRun(
    runId: string,
    patch: {
      status?: SyncRunStatus;
      addedDelta?: number;
      removedDelta?: number;
      failedDelta?: number;
      quotaDelta?: number;
      finished?: boolean;
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
