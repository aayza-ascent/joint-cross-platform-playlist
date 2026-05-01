import { describe, expect, it } from "vitest";
import { SyncEngine } from "./engine";
import { InMemorySyncStore } from "./store";
import type {
  SpotifyClient,
  SpotifyPlaylistRef,
} from "@/lib/spotify/client";
import type {
  YouTubeClient,
  YouTubePlaylistItem,
  YouTubeSearchResult,
} from "@/lib/youtube/client";
import {
  InMemoryQuotaAccounter,
  type QuotaAccounter,
} from "@/lib/youtube/quota";
import { QuotaExceededError } from "@/lib/youtube/client";
import type { NormalizedTrack } from "@/lib/types";

// ---- fake providers (only the methods the engine actually calls) ----

type FakeSpotifyOpts = {
  tracksByPlaylist: Record<string, NormalizedTrack[]>;
};

class FakeSpotify {
  calls = { getPlaylistTracks: 0 };
  constructor(private opts: FakeSpotifyOpts) {}
  async getPlaylists(): Promise<SpotifyPlaylistRef[]> {
    return [];
  }
  async getPlaylistTracks(playlistId: string): Promise<NormalizedTrack[]> {
    this.calls.getPlaylistTracks++;
    return this.opts.tracksByPlaylist[playlistId] ?? [];
  }
  async addTracks() {}
  async removeTracks() {}
}

type FakeYouTubeOpts = {
  itemsByPlaylist: Record<string, YouTubePlaylistItem[]>;
  searchByQuery?: Record<string, YouTubeSearchResult[]>;
  videosById?: Record<
    string,
    { durationMs: number; title: string; channelTitle: string }
  >;
  failSearchOnce?: "quota";
};

class FakeYouTube {
  calls = {
    getPlaylistItems: 0,
    searchVideos: 0,
    getVideosByIds: 0,
    addToPlaylist: [] as Array<{ playlistId: string; videoId: string }>,
  };
  insertedItems: Array<{ playlistId: string; videoId: string }> = [];
  private failSearchOnce?: "quota";
  constructor(
    private opts: FakeYouTubeOpts,
    public quota: QuotaAccounter,
  ) {
    this.failSearchOnce = opts.failSearchOnce;
  }
  async getPlaylists() {
    return [];
  }
  async getPlaylistItems(id: string): Promise<YouTubePlaylistItem[]> {
    this.calls.getPlaylistItems++;
    await this.quota.spend(1);
    return this.opts.itemsByPlaylist[id] ?? [];
  }
  async searchVideos(q: string): Promise<YouTubeSearchResult[]> {
    this.calls.searchVideos++;
    if (this.failSearchOnce === "quota") {
      this.failSearchOnce = undefined;
      throw new QuotaExceededError();
    }
    await this.quota.spend(100);
    return this.opts.searchByQuery?.[q] ?? findFuzzy(this.opts.searchByQuery ?? {}, q);
  }
  async getVideosByIds(ids: string[]) {
    this.calls.getVideosByIds++;
    await this.quota.spend(Math.max(1, Math.ceil(ids.length / 50)));
    const m = new Map();
    for (const id of ids) {
      const meta = this.opts.videosById?.[id];
      if (meta) m.set(id, meta);
    }
    return m;
  }
  async addToPlaylist(playlistId: string, videoId: string): Promise<string> {
    this.calls.addToPlaylist.push({ playlistId, videoId });
    this.insertedItems.push({ playlistId, videoId });
    await this.quota.spend(50);
    return `pi-${videoId}`;
  }
  async removeFromPlaylist() {}
  toCandidate() {
    throw new Error("unused in tests");
  }
}

// Utility: lookup search results loosely so tests can key by the same query
// strings the engine builds ("title artists...").
function findFuzzy(
  table: Record<string, YouTubeSearchResult[]>,
  q: string,
): YouTubeSearchResult[] {
  for (const [k, v] of Object.entries(table)) {
    if (q.includes(k) || k.includes(q)) return v;
  }
  return [];
}

// ---- helpers ----

const sp = (
  o: { id: string; title: string; artists: string[]; durationMs: number; isrc?: string },
): NormalizedTrack => ({
  source: "spotify",
  sourceTrackId: o.id,
  title: o.title,
  artists: o.artists,
  durationMs: o.durationMs,
  ...(o.isrc !== undefined && { isrc: o.isrc }),
});

function makeEngine(args: {
  userId?: string;
  pairId?: string;
  spPlaylistId?: string;
  ytPlaylistId?: string;
  spTracks: NormalizedTrack[];
  ytItems?: YouTubePlaylistItem[];
  searchByQuery?: Record<string, YouTubeSearchResult[]>;
  videosById?: Record<
    string,
    { durationMs: number; title: string; channelTitle: string }
  >;
  preMappings?: Array<{
    spotifyTrackId: string;
    youtubeVideoId: string;
    isrc?: string;
  }>;
  preQuotaUsed?: number;
  failSearchOnce?: "quota";
  itemsPerStep?: number;
}) {
  const userId = args.userId ?? "user-1";
  const pairId = args.pairId ?? "pair-1";
  const spId = args.spPlaylistId ?? "sp-pl";
  const ytId = args.ytPlaylistId ?? "yt-pl";

  const store = new InMemorySyncStore();
  store.pairs.set(pairId, {
    id: pairId,
    userId,
    spotifyPlaylistId: spId,
    youtubePlaylistId: ytId,
  });
  for (const m of args.preMappings ?? []) {
    store.mappings.set(`${userId}|${m.spotifyTrackId}`, {
      ...m,
      isrc: m.isrc,
      userId,
    });
  }

  const quota = new InMemoryQuotaAccounter();
  if (args.preQuotaUsed) quota.used = args.preQuotaUsed;

  const spotify = new FakeSpotify({
    tracksByPlaylist: { [spId]: args.spTracks },
  }) as unknown as SpotifyClient;
  const youtube = new FakeYouTube(
    {
      itemsByPlaylist: { [ytId]: args.ytItems ?? [] },
      searchByQuery: args.searchByQuery,
      videosById: args.videosById,
      failSearchOnce: args.failSearchOnce,
    },
    quota,
  ) as unknown as YouTubeClient & { calls: FakeYouTube["calls"]; insertedItems: FakeYouTube["insertedItems"] };

  const engine = new SyncEngine({
    store,
    spotify,
    youtube,
    quota,
    userId,
    itemsPerStep: args.itemsPerStep ?? 5,
  });

  return { engine, store, quota, spotify, youtube, userId, pairId };
}

// ---- tests ----

describe("planRun", () => {
  it("creates a sync_runs row plus one item per Spotify track", async () => {
    const { engine, store, pairId } = makeEngine({
      spTracks: [
        sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 }),
        sp({ id: "t2", title: "B", artists: ["Y"], durationMs: 200 }),
      ],
    });
    const r = await engine.planRun(pairId, "spotify_to_youtube");
    expect(r.totalItems).toBe(2);
    expect(r.plannedAdds).toBe(2);
    expect(r.plannedSkips).toBe(0);
    expect(r.plannedQuotaUnits).toBe(202); // 2 search-needed × 101
    const items = store.items.get(r.runId)!;
    expect(items.map((i) => i.spotifyTrackId)).toEqual(["t1", "t2"]);
    expect(items.every((i) => i.action === "add")).toBe(true);
  });

  it("uses cached track_mappings to avoid search", async () => {
    const { engine, pairId } = makeEngine({
      spTracks: [sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 })],
      preMappings: [{ spotifyTrackId: "t1", youtubeVideoId: "v-cached" }],
      ytItems: [],
    });
    const r = await engine.planRun(pairId, "spotify_to_youtube");
    expect(r.plannedAdds).toBe(1);
    expect(r.plannedQuotaUnits).toBe(50); // known videoId → just an insert
  });

  it("marks track as skip when cached videoId is already in YT playlist", async () => {
    const { engine, store, pairId } = makeEngine({
      spTracks: [sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 })],
      preMappings: [{ spotifyTrackId: "t1", youtubeVideoId: "v-cached" }],
      ytItems: [
        { playlistItemId: "pi1", videoId: "v-cached", videoTitle: "A", channelTitle: "X" },
      ],
    });
    const r = await engine.planRun(pairId, "spotify_to_youtube");
    expect(r.plannedSkips).toBe(1);
    expect(r.plannedAdds).toBe(0);
    expect(r.plannedQuotaUnits).toBe(0);
    expect(store.items.get(r.runId)![0].action).toBe("skip");
  });

  it("falls back to ISRC mapping when track-id mapping is absent", async () => {
    const { engine, pairId } = makeEngine({
      spTracks: [
        sp({
          id: "t-new",
          title: "A",
          artists: ["X"],
          durationMs: 100,
          isrc: "ABCD12345678",
        }),
      ],
      preMappings: [
        {
          spotifyTrackId: "t-other",
          youtubeVideoId: "v-from-isrc",
          isrc: "ABCD12345678",
        },
      ],
    });
    const r = await engine.planRun(pairId, "spotify_to_youtube");
    expect(r.plannedQuotaUnits).toBe(50);
  });
});

describe("stepRun", () => {
  it("processes a known-videoId add and reaches done", async () => {
    const { engine, pairId, youtube, quota } = makeEngine({
      spTracks: [sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 })],
      preMappings: [{ spotifyTrackId: "t1", youtubeVideoId: "v1" }],
    });
    const plan = await engine.planRun(pairId, "spotify_to_youtube");
    const step = await engine.stepRun(plan.runId);
    expect(step.status).toBe("done");
    expect(step.processed).toBe(1);
    expect((youtube as any).insertedItems).toEqual([
      { playlistId: "yt-pl", videoId: "v1" },
    ]);
    expect(quota.used).toBeGreaterThanOrEqual(50);
  });

  it("skip items don't call YouTube (no extra quota)", async () => {
    const { engine, pairId, youtube } = makeEngine({
      spTracks: [sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 })],
      preMappings: [{ spotifyTrackId: "t1", youtubeVideoId: "v-cached" }],
      ytItems: [
        { playlistItemId: "pi", videoId: "v-cached", videoTitle: "A", channelTitle: "X" },
      ],
    });
    const plan = await engine.planRun(pairId, "spotify_to_youtube");
    const step = await engine.stepRun(plan.runId);
    expect(step.status).toBe("done");
    expect((youtube as any).calls.addToPlaylist).toEqual([]);
  });

  it("resolves an unmapped track via search → score → add and persists mapping", async () => {
    const { engine, store, pairId, userId, youtube, quota } = makeEngine({
      spTracks: [
        sp({
          id: "t1",
          title: "Halo",
          artists: ["Beyoncé"],
          durationMs: 261_000,
          isrc: "USRC10800001",
        }),
      ],
      searchByQuery: {
        "Halo Beyoncé": [
          { videoId: "v-good", title: "Beyoncé - Halo", channelTitle: "BeyoncéVEVO" },
          { videoId: "v-bad", title: "Garbage", channelTitle: "Nobody" },
        ],
      },
      videosById: {
        "v-good": { durationMs: 262_000, title: "Beyoncé - Halo", channelTitle: "BeyoncéVEVO" },
        "v-bad": { durationMs: 60_000, title: "Garbage", channelTitle: "Nobody" },
      },
    });
    const plan = await engine.planRun(pairId, "spotify_to_youtube");
    const step = await engine.stepRun(plan.runId);
    expect(step.status).toBe("done");
    expect((youtube as any).insertedItems).toEqual([
      { playlistId: "yt-pl", videoId: "v-good" },
    ]);
    const m = store.mappings.get(`${userId}|t1`);
    expect(m?.youtubeVideoId).toBe("v-good");
    // search(100) + videos.list(1) + insert(50) + planRun's playlistItems(1)
    expect(quota.used).toBeGreaterThanOrEqual(151);
  });

  it("writes to unmatched_tracks and marks failed when no candidate clears threshold", async () => {
    const { engine, store, pairId, userId } = makeEngine({
      spTracks: [
        sp({ id: "tobs", title: "Obscure", artists: ["NicheBand"], durationMs: 200_000 }),
      ],
      searchByQuery: {
        "Obscure NicheBand": [
          { videoId: "vNot1", title: "Totally Unrelated", channelTitle: "Random" },
          { videoId: "vNot2", title: "Also Different", channelTitle: "Other" },
        ],
      },
      videosById: {
        vNot1: { durationMs: 60_000, title: "Totally Unrelated", channelTitle: "Random" },
        vNot2: { durationMs: 90_000, title: "Also Different", channelTitle: "Other" },
      },
    });
    const plan = await engine.planRun(pairId, "spotify_to_youtube");
    const step = await engine.stepRun(plan.runId);
    expect(step.status).toBe("done");
    expect(store.unmatched).toHaveLength(1);
    expect(store.unmatched[0].userId).toBe(userId);
    const item = store.items.get(plan.runId)![0];
    expect(item.status).toBe("failed");
    expect(item.error).toBe("low_confidence");
  });

  it("pauses the run on QuotaExceededError mid-step", async () => {
    const { engine, store, pairId } = makeEngine({
      spTracks: [
        sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 }),
        sp({ id: "t2", title: "B", artists: ["Y"], durationMs: 200 }),
      ],
      failSearchOnce: "quota",
    });
    const plan = await engine.planRun(pairId, "spotify_to_youtube");
    const step = await engine.stepRun(plan.runId);
    expect(step.status).toBe("paused_quota");
    const run = store.runs.get(plan.runId)!;
    expect(run.status).toBe("paused_quota");
  });

  it("refuses to start a step when remaining quota < 100 and search is needed", async () => {
    const { engine, pairId, store } = makeEngine({
      spTracks: [sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 })],
      preQuotaUsed: 9990, // 10 units left < 100 guard
    });
    const plan = await engine.planRun(pairId, "spotify_to_youtube");
    const step = await engine.stepRun(plan.runId);
    expect(step.status).toBe("paused_quota");
    expect(step.processed).toBe(0);
    expect(store.runs.get(plan.runId)!.status).toBe("paused_quota");
  });

  it("is idempotent across two stepRun calls when run is already done", async () => {
    const { engine, pairId } = makeEngine({
      spTracks: [sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 })],
      preMappings: [{ spotifyTrackId: "t1", youtubeVideoId: "v1" }],
    });
    const plan = await engine.planRun(pairId, "spotify_to_youtube");
    const a = await engine.stepRun(plan.runId);
    const b = await engine.stepRun(plan.runId);
    expect(a.status).toBe("done");
    expect(b.status).toBe("done");
    expect(b.processed).toBe(0);
  });

  it("does not duplicate inserts when same videoId would be added twice", async () => {
    const { engine, pairId, youtube } = makeEngine({
      spTracks: [
        sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 }),
        sp({ id: "t2", title: "A", artists: ["X"], durationMs: 100 }),
      ],
      preMappings: [
        { spotifyTrackId: "t1", youtubeVideoId: "vDup" },
        { spotifyTrackId: "t2", youtubeVideoId: "vDup" },
      ],
    });
    const plan = await engine.planRun(pairId, "spotify_to_youtube");
    const step = await engine.stepRun(plan.runId);
    expect(step.status).toBe("done");
    expect((youtube as any).insertedItems).toEqual([
      { playlistId: "yt-pl", videoId: "vDup" },
    ]);
  });

  it("rejects stepRun for a run owned by another user", async () => {
    const { engine, pairId } = makeEngine({
      spTracks: [sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 })],
    });
    const plan = await engine.planRun(pairId, "spotify_to_youtube");
    // Build a second engine with a different userId pointing at the same store/run.
    const other = new SyncEngine({
      ...(engine as unknown as { deps: { store: any; spotify: any; youtube: any; quota: any; userId: string } }).deps,
      userId: "different-user",
    });
    await expect(other.stepRun(plan.runId)).rejects.toThrow(/does not belong/);
  });
});
