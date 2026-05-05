import { describe, expect, it, vi } from "vitest";
import { SpotifyApiError, SpotifyClient } from "./client";

type MockResponse = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

function mockFetch(seq: MockResponse[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const r = seq[Math.min(i, seq.length - 1)];
    i++;
    const body = r.body === undefined ? "" : JSON.stringify(r.body);
    return new Response(body, {
      status: r.status,
      headers: {
        "content-type": "application/json",
        ...(r.headers ?? {}),
      },
    });
  });
  return { fn, calls };
}

const tokenProvider = () => Promise.resolve("BQ-test-token");

describe("SpotifyClient", () => {
  it("paginates getPlaylists across multiple pages", async () => {
    const { fn } = mockFetch([
      {
        status: 200,
        body: {
          next: "https://api.spotify.com/v1/me/playlists?limit=50&offset=50",
          items: [
            { id: "p1", name: "First", tracks: { total: 10 } },
            { id: "p2", name: "Second", tracks: { total: 20 } },
          ],
        },
      },
      {
        status: 200,
        body: {
          next: null,
          items: [{ id: "p3", name: "Third", tracks: { total: 5 } }],
        },
      },
    ]);
    const c = new SpotifyClient(tokenProvider, fn);
    const playlists = await c.getPlaylists();
    expect(playlists).toEqual([
      { id: "p1", name: "First", trackCount: 10 },
      { id: "p2", name: "Second", trackCount: 20 },
      { id: "p3", name: "Third", trackCount: 5 },
    ]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("getPlaylists filters out Spotify-owned curated playlists", async () => {
    // Discover Weekly / Daily Mix / Top 50 — Global are owned by 'spotify' and
    // 403 on /tracks for apps in Development Mode. Don't surface them in the
    // picker so the user can't pick one and get a confusing failure later.
    const { fn } = mockFetch([
      {
        status: 200,
        body: {
          next: null,
          items: [
            {
              id: "p-mine",
              name: "My Mix",
              tracks: { total: 30 },
              owner: { id: "user123" },
            },
            {
              id: "p-discover",
              name: "Discover Weekly",
              tracks: { total: 30 },
              owner: { id: "spotify" },
            },
            {
              id: "p-top50",
              name: "Top 50 - Global",
              tracks: { total: 50 },
              owner: { id: "spotify" },
            },
          ],
        },
      },
    ]);
    const c = new SpotifyClient(tokenProvider, fn);
    const playlists = await c.getPlaylists();
    expect(playlists.map((p) => p.id)).toEqual(["p-mine"]);
  });

  it("getPlaylists tolerates missing/null fields on curated playlists", async () => {
    // Spotify returns malformed entries for some algorithmic playlists
    // (Daily Mix, Discover Weekly): tracks/name can be absent or null.
    const { fn } = mockFetch([
      {
        status: 200,
        body: {
          next: null,
          items: [
            { id: "p1", name: "Real", tracks: { total: 12 } },
            { id: "p-no-tracks", name: "Curated" }, // no tracks field
            { id: "p-null-tracks", name: "Other", tracks: null },
            null, // entire item null
            { id: "p-no-name" }, // missing name
            {}, // missing id — must be skipped, not crash
          ],
        },
      },
    ]);
    const c = new SpotifyClient(tokenProvider, fn);
    const playlists = await c.getPlaylists();
    expect(playlists).toEqual([
      { id: "p1", name: "Real", trackCount: 12 },
      { id: "p-no-tracks", name: "Curated", trackCount: 0 },
      { id: "p-null-tracks", name: "Other", trackCount: 0 },
      { id: "p-no-name", name: "(untitled)", trackCount: 0 },
    ]);
  });

  it("normalizes playlist tracks and skips local/non-track items", async () => {
    // /items uses `item` per row, not `track` (the old /tracks shape).
    const { fn, calls } = mockFetch([
      {
        status: 200,
        body: {
          next: null,
          items: [
            {
              item: {
                id: "t1",
                name: "Halo",
                duration_ms: 261_000,
                type: "track",
                is_local: false,
                artists: [{ name: "Beyoncé" }],
                external_ids: { isrc: "USRC10800001" },
              },
            },
            { item: null },
            {
              item: {
                id: "tlocal",
                name: "Local file",
                duration_ms: 0,
                type: "track",
                is_local: true,
                artists: [{ name: "x" }],
              },
            },
            {
              item: {
                id: "tep",
                name: "Episode",
                duration_ms: 1000,
                type: "episode",
                is_local: false,
                artists: [],
              },
            },
          ],
        },
      },
    ]);
    const c = new SpotifyClient(tokenProvider, fn);
    const tracks = await c.getPlaylistTracks("plist");
    // Confirm we hit /items, not the deprecated /tracks endpoint.
    expect(calls[0].url).toContain("/playlists/plist/items");
    expect(calls[0].url).not.toContain("/playlists/plist/tracks");
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      source: "spotify",
      sourceTrackId: "t1",
      title: "Halo",
      artists: ["Beyoncé"],
      durationMs: 261_000,
      isrc: "USRC10800001",
    });
  });

  it("retries on 429 honoring Retry-After", async () => {
    const { fn } = mockFetch([
      { status: 429, headers: { "retry-after": "0" } },
      { status: 200, body: { next: null, items: [] } },
    ]);
    const c = new SpotifyClient(tokenProvider, fn);
    const r = await c.getPlaylists();
    expect(r).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries once on 401", async () => {
    const { fn } = mockFetch([
      { status: 401 },
      { status: 200, body: { next: null, items: [] } },
    ]);
    const c = new SpotifyClient(tokenProvider, fn);
    await c.getPlaylists();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws SpotifyApiError on 4xx (non-retryable)", async () => {
    const { fn } = mockFetch([
      { status: 404, body: { error: { message: "Not found" } } },
    ]);
    const c = new SpotifyClient(tokenProvider, fn);
    await expect(c.getPlaylistTracks("missing")).rejects.toBeInstanceOf(
      SpotifyApiError,
    );
  });

  it("addTracks chunks at 100 URIs per call", async () => {
    const { fn, calls } = mockFetch([
      { status: 201, body: { snapshot_id: "s1" } },
      { status: 201, body: { snapshot_id: "s2" } },
      { status: 201, body: { snapshot_id: "s3" } },
    ]);
    const c = new SpotifyClient(tokenProvider, fn);
    const uris = Array.from({ length: 250 }, (_, i) => `spotify:track:t${i}`);
    await c.addTracks("p", uris);
    expect(fn).toHaveBeenCalledTimes(3);
    const bodies = calls.map((c) => JSON.parse(c.init?.body as string).uris);
    expect(bodies[0]).toHaveLength(100);
    expect(bodies[1]).toHaveLength(100);
    expect(bodies[2]).toHaveLength(50);
  });

  it("addTracks no-ops on empty input", async () => {
    const { fn } = mockFetch([{ status: 200, body: {} }]);
    const c = new SpotifyClient(tokenProvider, fn);
    await c.addTracks("p", []);
    expect(fn).toHaveBeenCalledTimes(0);
  });

  it("searchTracks normalizes hits and filters local/non-track", async () => {
    const { fn, calls } = mockFetch([
      {
        status: 200,
        body: {
          tracks: {
            items: [
              {
                id: "t1",
                name: "Halo",
                duration_ms: 261_000,
                type: "track",
                is_local: false,
                artists: [{ name: "Beyoncé" }],
                external_ids: { isrc: "USRC10800001" },
              },
              {
                id: "tlocal",
                name: "Local",
                duration_ms: 0,
                type: "track",
                is_local: true,
                artists: [{ name: "x" }],
              },
              {
                id: "tep",
                name: "Show",
                duration_ms: 1000,
                type: "episode",
                is_local: false,
                artists: [],
              },
            ],
          },
        },
      },
    ]);
    const c = new SpotifyClient(tokenProvider, fn);
    const r = await c.searchTracks("Beyoncé Halo");
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      source: "spotify",
      sourceTrackId: "t1",
      title: "Halo",
      artists: ["Beyoncé"],
      durationMs: 261_000,
      isrc: "USRC10800001",
    });
    const url = calls[0].url;
    expect(url).toContain("/v1/search");
    expect(url).toMatch(/[?&]type=track\b/);
    // URLSearchParams encodes spaces as '+', not '%20'.
    expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain(
      "q=Beyoncé Halo",
    );
  });

  it("searchTracks defaults to limit=5 and clamps to [1, 50]", async () => {
    const { fn, calls } = mockFetch([
      { status: 200, body: { tracks: { items: [] } } },
      { status: 200, body: { tracks: { items: [] } } },
      { status: 200, body: { tracks: { items: [] } } },
    ]);
    const c = new SpotifyClient(tokenProvider, fn);
    await c.searchTracks("a");
    await c.searchTracks("b", 9999);
    await c.searchTracks("c", -3);
    expect(calls[0].url).toMatch(/[?&]limit=5\b/);
    expect(calls[1].url).toMatch(/[?&]limit=50\b/);
    expect(calls[2].url).toMatch(/[?&]limit=1\b/);
  });

  it("createPlaylist POSTs to /me/playlists with the given body", async () => {
    const { fn, calls } = mockFetch([
      { status: 201, body: { id: "new-playlist-id" } },
    ]);
    const c = new SpotifyClient(tokenProvider, fn);
    const id = await c.createPlaylist("Test Sync", {
      description: "made by app",
    });
    expect(id).toBe("new-playlist-id");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toContain("/v1/me/playlists");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toMatchObject({
      name: "Test Sync",
      public: false,
      description: "made by app",
    });
  });

  it("createPlaylist defaults to private and omits description if not given", async () => {
    const { fn, calls } = mockFetch([
      { status: 201, body: { id: "p-x" } },
    ]);
    const c = new SpotifyClient(tokenProvider, fn);
    await c.createPlaylist("X");
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({ name: "X", public: false });
  });

  it("searchTracks retries on 429 honoring Retry-After", async () => {
    const { fn } = mockFetch([
      { status: 429, headers: { "retry-after": "0" } },
      { status: 200, body: { tracks: { items: [] } } },
    ]);
    const c = new SpotifyClient(tokenProvider, fn);
    const r = await c.searchTracks("anything");
    expect(r).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
