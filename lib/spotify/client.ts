import pLimit from "p-limit";
import type { NormalizedTrack } from "@/lib/types";

export type SpotifyPlaylistRef = {
  id: string;
  name: string;
  trackCount: number;
};

export type FetchImpl = typeof fetch;

const SPOTIFY_API = "https://api.spotify.com/v1";
const CONCURRENCY = 4;
const MAX_RETRIES = 3;

export class SpotifyClient {
  private limit = pLimit(CONCURRENCY);

  constructor(
    private getToken: () => Promise<string>,
    private fetchImpl: FetchImpl = globalThis.fetch.bind(globalThis),
  ) {}

  async getPlaylists(): Promise<SpotifyPlaylistRef[]> {
    const out: SpotifyPlaylistRef[] = [];
    let url: string | null = `${SPOTIFY_API}/me/playlists?limit=50`;
    while (url) {
      const json: PagedPlaylists = await this.request("GET", url);
      for (const p of json.items) {
        out.push({ id: p.id, name: p.name, trackCount: p.tracks.total });
      }
      url = json.next ?? null;
    }
    return out;
  }

  async getPlaylistTracks(playlistId: string): Promise<NormalizedTrack[]> {
    const out: NormalizedTrack[] = [];
    let url: string | null =
      `${SPOTIFY_API}/playlists/${encodeURIComponent(
        playlistId,
      )}/tracks?limit=100&fields=next,items(track(id,name,duration_ms,artists(name),external_ids(isrc),is_local,type))`;
    while (url) {
      const json: PagedPlaylistTracks = await this.request("GET", url);
      for (const it of json.items) {
        const t = it.track;
        if (!t || t.is_local || t.type !== "track" || !t.id) continue;
        out.push({
          source: "spotify",
          sourceTrackId: t.id,
          title: t.name,
          artists: t.artists.map((a) => a.name),
          durationMs: t.duration_ms,
          isrc: t.external_ids?.isrc,
        });
      }
      url = json.next ?? null;
    }
    return out;
  }

  async searchTracks(query: string, limit = 5): Promise<NormalizedTrack[]> {
    const url = new URL(`${SPOTIFY_API}/search`);
    url.searchParams.set("q", query);
    url.searchParams.set("type", "track");
    url.searchParams.set("limit", String(Math.min(50, Math.max(1, limit))));
    const json: SearchTracksResponse = await this.request("GET", url.toString());
    return json.tracks.items
      .filter((t) => t && !t.is_local && t.type === "track" && t.id)
      .map((t) => ({
        source: "spotify" as const,
        sourceTrackId: t.id,
        title: t.name,
        artists: t.artists.map((a) => a.name),
        durationMs: t.duration_ms,
        ...(t.external_ids?.isrc && { isrc: t.external_ids.isrc }),
      }));
  }

  async addTracks(playlistId: string, uris: string[]): Promise<void> {
    if (uris.length === 0) return;
    const calls: Array<Promise<unknown>> = [];
    for (let i = 0; i < uris.length; i += 100) {
      const batch = uris.slice(i, i + 100);
      calls.push(
        this.limit(() =>
          this.request(
            "POST",
            `${SPOTIFY_API}/playlists/${encodeURIComponent(playlistId)}/tracks`,
            { uris: batch },
          ),
        ),
      );
    }
    await Promise.all(calls);
  }

  async removeTracks(
    playlistId: string,
    items: Array<{ uri: string; positions?: number[] }>,
  ): Promise<void> {
    if (items.length === 0) return;
    const calls: Array<Promise<unknown>> = [];
    for (let i = 0; i < items.length; i += 100) {
      const batch = items.slice(i, i + 100);
      calls.push(
        this.limit(() =>
          this.request(
            "DELETE",
            `${SPOTIFY_API}/playlists/${encodeURIComponent(playlistId)}/tracks`,
            { tracks: batch },
          ),
        ),
      );
    }
    await Promise.all(calls);
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    url: string,
    body?: unknown,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const token = await this.getToken();
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      };
      const res = await this.fetchImpl(url, init);
      if (res.status === 429) {
        const retry = Number(res.headers.get("retry-after") ?? "1");
        await sleep(Math.min(retry, 30) * 1000);
        continue;
      }
      if (res.status === 401 && attempt === 0) {
        // Token may have rotated since we read it; re-fetch and retry once.
        continue;
      }
      if (!res.ok) {
        const text = await safeText(res);
        throw new SpotifyApiError(res.status, text);
      }
      if (res.status === 204) return undefined as T;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("json")) return undefined as T;
      return (await res.json()) as T;
    }
    throw lastErr ?? new Error("spotify: exhausted retries");
  }
}

export class SpotifyApiError extends Error {
  constructor(public status: number, body: string) {
    super(`spotify ${status}: ${body.slice(0, 200)}`);
  }
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

type PagedPlaylists = {
  next: string | null;
  items: Array<{
    id: string;
    name: string;
    tracks: { total: number };
  }>;
};

type PagedPlaylistTracks = {
  next: string | null;
  items: Array<{
    track: SpotifyTrack | null;
  }>;
};

type SpotifyTrack = {
  id: string;
  name: string;
  duration_ms: number;
  type: string;
  is_local: boolean;
  artists: Array<{ name: string }>;
  external_ids?: { isrc?: string };
};

type SearchTracksResponse = {
  tracks: { items: SpotifyTrack[] };
};
