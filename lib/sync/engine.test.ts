import { describe, expect, it } from "vitest";
import { ActiveRunExistsError, SyncEngine } from "./engine";
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

// ---- fakes ----

class FakeSpotify {
  calls = {
    getPlaylistTracks: 0,
    addTracks: 0,
    removeTracks: 0,
    searchTracks: 0,
  };
  inserts: Array<{ playlistId: string; uris: string[] }> = [];
  removes: Array<{ playlistId: string; tracks: any[] }> = [];
  constructor(
    public tracksByPlaylist: Record<string, NormalizedTrack[]>,
    public searchResults: Record<string, NormalizedTrack[]> = {},
  ) {}
  async getPlaylists(): Promise<SpotifyPlaylistRef[]> {
    return [];
  }
  async getPlaylistTracks(id: string): Promise<NormalizedTrack[]> {
    this.calls.getPlaylistTracks++;
    return this.tracksByPlaylist[id] ?? [];
  }
  async addTracks(playlistId: string, uris: string[]) {
    this.calls.addTracks++;
    this.inserts.push({ playlistId, uris });
  }
  async removeTracks(playlistId: string, tracks: any[]) {
    this.calls.removeTracks++;
    this.removes.push({ playlistId, tracks });
    // Reflect removal in the in-memory playlist for end-of-run baseline snapshot.
    const arr = this.tracksByPlaylist[playlistId] ?? [];
    const removeIds = new Set(
      tracks.map((t) => t.uri.replace("spotify:track:", "")),
    );
    this.tracksByPlaylist[playlistId] = arr.filter(
      (t) => !removeIds.has(t.sourceTrackId),
    );
  }
  async searchTracks(query: string): Promise<NormalizedTrack[]> {
    this.calls.searchTracks++;
    return findFuzzy(this.searchResults, query);
  }
}

class FakeYouTube {
  calls = {
    getPlaylistItems: 0,
    searchVideos: 0,
    getVideosByIds: 0,
    addToPlaylist: 0,
    removeFromPlaylist: 0,
  };
  inserts: Array<{ playlistId: string; videoId: string }> = [];
  removes: string[] = [];
  private failNextSearchAs?: "quota";
  constructor(
    public itemsByPlaylist: Record<string, YouTubePlaylistItem[]>,
    public quota: QuotaAccounter,
    opts?: {
      searchByQuery?: Record<string, YouTubeSearchResult[]>;
      videosById?: Record<
        string,
        { durationMs: number; title: string; channelTitle: string }
      >;
      failSearchOnceAs?: "quota";
    },
  ) {
    this.searchByQuery = opts?.searchByQuery ?? {};
    this.videosById = opts?.videosById ?? {};
    this.failNextSearchAs = opts?.failSearchOnceAs;
  }
  searchByQuery: Record<string, YouTubeSearchResult[]>;
  videosById: Record<
    string,
    { durationMs: number; title: string; channelTitle: string }
  >;
  async getPlaylists() {
    return [];
  }
  async getPlaylistItems(id: string): Promise<YouTubePlaylistItem[]> {
    this.calls.getPlaylistItems++;
    await this.quota.spend(1);
    return this.itemsByPlaylist[id] ?? [];
  }
  async searchVideos(q: string): Promise<YouTubeSearchResult[]> {
    this.calls.searchVideos++;
    if (this.failNextSearchAs === "quota") {
      this.failNextSearchAs = undefined;
      throw new QuotaExceededError();
    }
    await this.quota.spend(100);
    return findFuzzy(this.searchByQuery, q);
  }
  async getVideosByIds(ids: string[]) {
    this.calls.getVideosByIds++;
    await this.quota.spend(Math.max(1, Math.ceil(ids.length / 50)));
    const m = new Map<
      string,
      { durationMs: number; title: string; channelTitle: string }
    >();
    for (const id of ids) {
      const meta = this.videosById[id];
      if (meta) m.set(id, meta);
    }
    return m;
  }
  async addToPlaylist(playlistId: string, videoId: string): Promise<string> {
    this.calls.addToPlaylist++;
    this.inserts.push({ playlistId, videoId });
    await this.quota.spend(50);
    // Reflect insert in the in-memory playlist for end-of-run snapshot.
    const arr = this.itemsByPlaylist[playlistId] ?? [];
    const piid = `pi-${videoId}`;
    arr.push({
      playlistItemId: piid,
      videoId,
      videoTitle: "",
      channelTitle: "",
    });
    this.itemsByPlaylist[playlistId] = arr;
    return piid;
  }
  async removeFromPlaylist(playlistItemId: string) {
    this.calls.removeFromPlaylist++;
    this.removes.push(playlistItemId);
    await this.quota.spend(50);
    for (const [pid, arr] of Object.entries(this.itemsByPlaylist)) {
      this.itemsByPlaylist[pid] = arr.filter(
        (i) => i.playlistItemId !== playlistItemId,
      );
    }
  }
}

function findFuzzy<T>(table: Record<string, T[]>, q: string): T[] {
  for (const [k, v] of Object.entries(table)) {
    if (q.includes(k) || k.includes(q)) return v;
  }
  return [];
}

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
  baseline?: {
    spotifyTrackIds: string[];
    youtubeItems: { videoId: string; playlistItemId: string }[];
  };
  preMappings?: Array<{
    spotifyTrackId: string;
    youtubeVideoId: string;
    isrc?: string;
  }>;
  searchByQuery?: Record<string, YouTubeSearchResult[]>;
  videosById?: Record<
    string,
    { durationMs: number; title: string; channelTitle: string }
  >;
  spotifySearchByQuery?: Record<string, NormalizedTrack[]>;
  preQuotaUsed?: number;
  failYtSearchOnce?: boolean;
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
  if (args.baseline) {
    store.baselines.set(pairId, {
      ...args.baseline,
      syncedAt: new Date(2026, 0, 1),
    });
  }
  for (const m of args.preMappings ?? []) {
    store.mappings.set(`${userId}|${m.spotifyTrackId}`, {
      ...m,
      isrc: m.isrc,
      userId,
    });
  }

  const quota = new InMemoryQuotaAccounter();
  if (args.preQuotaUsed) quota.used = args.preQuotaUsed;

  const fakeSpotify = new FakeSpotify(
    { [spId]: args.spTracks },
    args.spotifySearchByQuery,
  );
  const fakeYoutube = new FakeYouTube(
    { [ytId]: args.ytItems ?? [] },
    quota,
    {
      searchByQuery: args.searchByQuery,
      videosById: args.videosById,
      ...(args.failYtSearchOnce && { failSearchOnceAs: "quota" as const }),
    },
  );

  const engine = new SyncEngine({
    store,
    spotify: fakeSpotify as unknown as SpotifyClient,
    youtube: fakeYoutube as unknown as YouTubeClient,
    quota,
    userId,
    itemsPerStep: args.itemsPerStep ?? 5,
  });

  return {
    engine,
    store,
    quota,
    spotify: fakeSpotify,
    youtube: fakeYoutube,
    userId,
    pairId,
  };
}

describe("InMemorySyncStore reverse mapping", () => {
  it("getMappingsByVideoIds returns only this user's mappings keyed by videoId", async () => {
    const s = new InMemorySyncStore();
    await s.upsertMapping({
      userId: "u1",
      spotifyTrackId: "t1",
      youtubeVideoId: "v1",
      isrc: null,
      confidence: 1,
      matchMethod: "manual",
    });
    await s.upsertMapping({
      userId: "u1",
      spotifyTrackId: "t2",
      youtubeVideoId: "v2",
      isrc: null,
      confidence: 1,
      matchMethod: "manual",
    });
    await s.upsertMapping({
      userId: "u-other",
      spotifyTrackId: "t-other",
      youtubeVideoId: "v1",
      isrc: null,
      confidence: 1,
      matchMethod: "manual",
    });
    const m = await s.getMappingsByVideoIds("u1", ["v1", "v2", "v-missing"]);
    expect(m.size).toBe(2);
    expect(m.get("v1")?.spotifyTrackId).toBe("t1");
    expect(m.get("v2")?.spotifyTrackId).toBe("t2");
    expect(m.has("v-missing")).toBe(false);
  });
});

describe("planRun: first sync (no baseline)", () => {
  it("treats every track as added on its side and produces add_to_yt + add_to_sp", async () => {
    const { engine, store, pairId } = makeEngine({
      spTracks: [
        sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 }),
        sp({ id: "t2", title: "B", artists: ["Y"], durationMs: 200 }),
      ],
      ytItems: [
        {
          playlistItemId: "pi-v1",
          videoId: "v1",
          videoTitle: "Y1",
          channelTitle: "Ch1",
        },
      ],
    });
    const r = await engine.planRun(pairId);
    expect(r.isFirstSync).toBe(true);
    expect(r.plannedAddYt).toBe(2);
    expect(r.plannedAddSp).toBe(1);
    expect(r.plannedRemoveYt).toBe(0);
    expect(r.plannedRemoveSp).toBe(0);
    expect(r.totalItems).toBe(3);
    const items = store.items.get(r.runId)!;
    expect(items.filter((i) => i.action === "add_to_yt").length).toBe(2);
    expect(items.filter((i) => i.action === "add_to_sp").length).toBe(1);
  });

  it("first-sync skips when a cached mapping says the track is already in YT playlist", async () => {
    const { engine, pairId } = makeEngine({
      spTracks: [sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 })],
      preMappings: [{ spotifyTrackId: "t1", youtubeVideoId: "v-cached" }],
      ytItems: [
        {
          playlistItemId: "pi-cached",
          videoId: "v-cached",
          videoTitle: "A",
          channelTitle: "X",
        },
      ],
    });
    const r = await engine.planRun(pairId);
    expect(r.plannedSkips).toBe(1);
    expect(r.plannedAddYt).toBe(0);
  });
});

describe("planRun: subsequent sync with baseline", () => {
  it("emits remove_from_yt for tracks that disappeared on Spotify", async () => {
    const { engine, store, pairId } = makeEngine({
      spTracks: [], // empty now — both gone
      ytItems: [
        {
          playlistItemId: "pi-v1",
          videoId: "v1",
          videoTitle: "T1",
          channelTitle: "C",
        },
        {
          playlistItemId: "pi-v2",
          videoId: "v2",
          videoTitle: "T2",
          channelTitle: "C",
        },
      ],
      baseline: {
        spotifyTrackIds: ["t1", "t2"],
        youtubeItems: [
          { videoId: "v1", playlistItemId: "pi-v1" },
          { videoId: "v2", playlistItemId: "pi-v2" },
        ],
      },
      preMappings: [
        { spotifyTrackId: "t1", youtubeVideoId: "v1" },
        { spotifyTrackId: "t2", youtubeVideoId: "v2" },
      ],
    });
    const r = await engine.planRun(pairId);
    expect(r.plannedRemoveYt).toBe(2);
    expect(r.plannedAddYt).toBe(0);
    expect(r.plannedAddSp).toBe(0);
    const items = store.items.get(r.runId)!;
    expect(items.every((i) => i.action === "remove_from_yt")).toBe(true);
    expect(items[0].youtubePlaylistItemId).toBe("pi-v1");
  });

  it("emits remove_from_sp for tracks that disappeared on YouTube", async () => {
    const { engine, store, pairId } = makeEngine({
      spTracks: [
        sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 }),
        sp({ id: "t2", title: "B", artists: ["Y"], durationMs: 200 }),
      ],
      ytItems: [], // both gone on YT
      baseline: {
        spotifyTrackIds: ["t1", "t2"],
        youtubeItems: [
          { videoId: "v1", playlistItemId: "pi-v1" },
          { videoId: "v2", playlistItemId: "pi-v2" },
        ],
      },
      preMappings: [
        { spotifyTrackId: "t1", youtubeVideoId: "v1" },
        { spotifyTrackId: "t2", youtubeVideoId: "v2" },
      ],
    });
    const r = await engine.planRun(pairId);
    expect(r.plannedRemoveSp).toBe(2);
    const items = store.items.get(r.runId)!;
    expect(items.every((i) => i.action === "remove_from_sp")).toBe(true);
    expect(new Set(items.map((i) => i.spotifyTrackId))).toEqual(
      new Set(["t1", "t2"]),
    );
  });

  it("conflict: track removed on SP but added on YT (per mapping) → preserved on both", async () => {
    // Baseline says t1 was on SP and v1 was on YT.
    // Now: t1 removed from SP. v-other now on YT (was v1 before, but YT user
    // re-added the same video → mapping says v1↔t1, so this is the conflict).
    // Wait — easier scenario: SP removed t1, YT also still has v1 (no change)
    // — that's a pure remove. The conflict scenario is SP removed t1 AND YT
    // *added* the same video v1 since baseline. Tricky to simulate cleanly.
    // Construct: baseline SP={t1}, YT={}. Now: SP={}, YT={v1}. Mapping t1↔v1.
    const { engine, pairId } = makeEngine({
      spTracks: [], // user removed t1
      ytItems: [
        {
          playlistItemId: "pi-v1",
          videoId: "v1",
          videoTitle: "A",
          channelTitle: "X",
        },
      ],
      baseline: {
        spotifyTrackIds: ["t1"],
        youtubeItems: [], // v1 was NOT on YT at last sync
      },
      preMappings: [{ spotifyTrackId: "t1", youtubeVideoId: "v1" }],
    });
    const r = await engine.planRun(pairId);
    expect(r.plannedRemoveYt).toBe(0); // suppressed by conflict resolution
    expect(r.plannedAddSp).toBe(0); // suppressed
    expect(r.totalItems).toBe(0);
  });
});

describe("planRun guards", () => {
  it("refuses to start when an active run already exists for the pair", async () => {
    const { engine, pairId, store, userId } = makeEngine({ spTracks: [] });
    await store.createSyncRun({ pairId, userId, mode: "two_way" });
    await expect(engine.planRun(pairId)).rejects.toBeInstanceOf(
      ActiveRunExistsError,
    );
  });

  it("rejects unknown pair", async () => {
    const { engine } = makeEngine({ spTracks: [] });
    await expect(engine.planRun("nope")).rejects.toThrow(/not found/);
  });
});

describe("stepRun: dispatch and idempotency", () => {
  it("processes add_to_yt with cached videoId then commits baseline on done", async () => {
    const { engine, store, pairId, youtube } = makeEngine({
      spTracks: [sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 })],
      preMappings: [{ spotifyTrackId: "t1", youtubeVideoId: "v1" }],
    });
    const plan = await engine.planRun(pairId);
    const step = await engine.stepRun(plan.runId);
    expect(step.status).toBe("done");
    expect(youtube.inserts).toEqual([{ playlistId: "yt-pl", videoId: "v1" }]);
    expect(store.baselines.has(pairId)).toBe(true);
    expect(store.baselineCommits).toHaveLength(1);
    expect(store.baselines.get(pairId)?.spotifyTrackIds).toEqual(["t1"]);
    expect(store.baselines.get(pairId)?.youtubeItems[0]?.videoId).toBe("v1");
  });

  it("processes remove_from_yt using playlistItemId from baseline", async () => {
    const { engine, pairId, youtube, store } = makeEngine({
      spTracks: [],
      ytItems: [
        {
          playlistItemId: "pi-v1",
          videoId: "v1",
          videoTitle: "A",
          channelTitle: "X",
        },
      ],
      baseline: {
        spotifyTrackIds: ["t1"],
        youtubeItems: [{ videoId: "v1", playlistItemId: "pi-v1" }],
      },
      preMappings: [{ spotifyTrackId: "t1", youtubeVideoId: "v1" }],
    });
    const plan = await engine.planRun(pairId);
    expect(plan.plannedRemoveYt).toBe(1);
    const step = await engine.stepRun(plan.runId);
    expect(step.status).toBe("done");
    expect(youtube.removes).toEqual(["pi-v1"]);
    // After done, baseline reflects empty YT playlist (we removed the only item).
    expect(store.baselines.get(pairId)?.youtubeItems).toEqual([]);
  });

  it("processes remove_from_sp using spotify_track_id", async () => {
    const { engine, pairId, spotify, store } = makeEngine({
      spTracks: [sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 })],
      ytItems: [],
      baseline: {
        spotifyTrackIds: ["t1"],
        youtubeItems: [{ videoId: "v1", playlistItemId: "pi-v1" }],
      },
      preMappings: [{ spotifyTrackId: "t1", youtubeVideoId: "v1" }],
    });
    const plan = await engine.planRun(pairId);
    expect(plan.plannedRemoveSp).toBe(1);
    const step = await engine.stepRun(plan.runId);
    expect(step.status).toBe("done");
    expect(spotify.removes).toHaveLength(1);
    expect(spotify.removes[0].tracks[0].uri).toBe("spotify:track:t1");
    // Baseline now reflects empty SP playlist.
    expect(store.baselines.get(pairId)?.spotifyTrackIds).toEqual([]);
  });

  it("processes add_to_sp via cached reverse mapping", async () => {
    const { engine, pairId, spotify } = makeEngine({
      spTracks: [],
      ytItems: [
        {
          playlistItemId: "pi-v1",
          videoId: "v1",
          videoTitle: "A",
          channelTitle: "BeyoncéVEVO",
        },
      ],
      preMappings: [{ spotifyTrackId: "sp-A", youtubeVideoId: "v1" }],
    });
    // No baseline → first sync → yt_added has v1, mapping says sp-A.
    const plan = await engine.planRun(pairId);
    expect(plan.plannedAddSp).toBe(1);
    const step = await engine.stepRun(plan.runId);
    expect(step.status).toBe("done");
    expect(spotify.inserts).toEqual([
      { playlistId: "sp-pl", uris: ["spotify:track:sp-A"] },
    ]);
  });

  it("processes add_to_sp via Spotify search when no mapping", async () => {
    const { engine, pairId, spotify, store, userId } = makeEngine({
      spTracks: [],
      ytItems: [
        {
          playlistItemId: "pi-v1",
          videoId: "v1",
          videoTitle: "Beyoncé - Halo",
          channelTitle: "BeyoncéVEVO",
        },
      ],
      videosById: {
        v1: {
          durationMs: 261_000,
          title: "Beyoncé - Halo (Official Music Video)",
          channelTitle: "BeyoncéVEVO",
        },
      },
      spotifySearchByQuery: {
        Halo: [
          {
            source: "spotify",
            sourceTrackId: "sp-halo",
            title: "Halo",
            artists: ["Beyoncé"],
            durationMs: 261_000,
            isrc: "USRC10800001",
          },
        ],
      },
    });
    const plan = await engine.planRun(pairId);
    expect(plan.plannedAddSp).toBe(1);
    const step = await engine.stepRun(plan.runId);
    expect(step.status).toBe("done");
    expect(spotify.inserts).toEqual([
      { playlistId: "sp-pl", uris: ["spotify:track:sp-halo"] },
    ]);
    expect(store.mappings.get(`${userId}|sp-halo`)?.youtubeVideoId).toBe("v1");
  });

  it("pauses on QuotaExceededError without committing baseline", async () => {
    const { engine, pairId, store } = makeEngine({
      spTracks: [
        sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 }),
      ],
      failYtSearchOnce: true,
    });
    const plan = await engine.planRun(pairId);
    const step = await engine.stepRun(plan.runId);
    expect(step.status).toBe("paused_quota");
    expect(store.runs.get(plan.runId)!.status).toBe("paused_quota");
    expect(store.baselines.has(pairId)).toBe(false); // critical: baseline NOT written
    expect(store.baselineCommits).toHaveLength(0);
  });

  it("idempotent across two stepRun calls when run is already done", async () => {
    const { engine, pairId } = makeEngine({
      spTracks: [sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 })],
      preMappings: [{ spotifyTrackId: "t1", youtubeVideoId: "v1" }],
    });
    const plan = await engine.planRun(pairId);
    const a = await engine.stepRun(plan.runId);
    const b = await engine.stepRun(plan.runId);
    expect(a.status).toBe("done");
    expect(b.status).toBe("done");
  });

  it("does not duplicate inserts when same videoId would be added twice in the batch", async () => {
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
    const plan = await engine.planRun(pairId);
    const step = await engine.stepRun(plan.runId);
    expect(step.status).toBe("done");
    expect(youtube.inserts.filter((i) => i.videoId === "vDup")).toHaveLength(1);
  });

  it("rejects stepRun for a run owned by another user", async () => {
    const { engine, pairId, store, userId } = makeEngine({
      spTracks: [sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 })],
    });
    const plan = await engine.planRun(pairId);
    const otherEngine = new SyncEngine({
      ...((engine as unknown) as { deps: any }).deps,
      userId: "different-user",
    });
    await expect(otherEngine.stepRun(plan.runId)).rejects.toThrow(
      /does not belong/,
    );
  });

  it("refuses to start a step when remaining quota < 100 and search is needed", async () => {
    const { engine, pairId, store } = makeEngine({
      spTracks: [sp({ id: "t1", title: "A", artists: ["X"], durationMs: 100 })],
      preQuotaUsed: 9990,
    });
    const plan = await engine.planRun(pairId);
    const step = await engine.stepRun(plan.runId);
    expect(step.status).toBe("paused_quota");
    expect(store.runs.get(plan.runId)!.status).toBe("paused_quota");
    expect(store.baselines.has(pairId)).toBe(false);
  });
});
