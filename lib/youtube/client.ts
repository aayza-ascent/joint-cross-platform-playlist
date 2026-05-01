import pLimit from "p-limit";
import type { NormalizedTrack } from "@/lib/types";
import { type QuotaAccounter } from "@/lib/youtube/quota";

const YT_API = "https://www.googleapis.com/youtube/v3";
const CONCURRENCY = 4;
const MAX_RETRIES = 3;

export type YouTubePlaylistRef = {
  id: string;
  title: string;
  itemCount: number;
};

export type YouTubePlaylistItem = {
  playlistItemId: string;
  videoId: string;
  videoTitle: string;
  channelTitle: string;
  durationMs?: number;
};

export type YouTubeSearchResult = {
  videoId: string;
  title: string;
  channelTitle: string;
};

export type FetchImpl = typeof fetch;

export class QuotaExceededError extends Error {
  constructor() {
    super("YouTube daily quota exceeded");
  }
}

export class YouTubeRateLimitError extends Error {
  constructor() {
    super("YouTube short-window rate limit");
  }
}

export class YouTubeApiError extends Error {
  constructor(public status: number, body: string) {
    super(`youtube ${status}: ${body.slice(0, 200)}`);
  }
}

export class YouTubeClient {
  private limit = pLimit(CONCURRENCY);

  constructor(
    private getToken: () => Promise<string>,
    private quota: QuotaAccounter,
    private fetchImpl: FetchImpl = globalThis.fetch.bind(globalThis),
  ) {}

  async getPlaylists(): Promise<YouTubePlaylistRef[]> {
    const out: YouTubePlaylistRef[] = [];
    let pageToken: string | null = null;
    do {
      const url = buildUrl(`${YT_API}/playlists`, {
        part: "snippet,contentDetails",
        mine: "true",
        maxResults: "50",
        ...(pageToken && { pageToken }),
      });
      const json: PagedPlaylists = await this.request("GET", url, undefined, 1);
      for (const p of json.items) {
        out.push({
          id: p.id,
          title: p.snippet.title,
          itemCount: p.contentDetails?.itemCount ?? 0,
        });
      }
      pageToken = json.nextPageToken ?? null;
    } while (pageToken);
    return out;
  }

  async getPlaylistItems(playlistId: string): Promise<YouTubePlaylistItem[]> {
    const out: YouTubePlaylistItem[] = [];
    let pageToken: string | null = null;
    do {
      const url = buildUrl(`${YT_API}/playlistItems`, {
        part: "snippet,contentDetails",
        playlistId,
        maxResults: "50",
        ...(pageToken && { pageToken }),
      });
      const json: PagedPlaylistItems = await this.request(
        "GET",
        url,
        undefined,
        1,
      );
      for (const it of json.items) {
        const videoId = it.contentDetails?.videoId ?? it.snippet?.resourceId?.videoId;
        if (!videoId) continue;
        out.push({
          playlistItemId: it.id,
          videoId,
          videoTitle: it.snippet?.title ?? "",
          channelTitle: it.snippet?.videoOwnerChannelTitle ?? it.snippet?.channelTitle ?? "",
        });
      }
      pageToken = json.nextPageToken ?? null;
    } while (pageToken);
    return out;
  }

  async addToPlaylist(playlistId: string, videoId: string): Promise<string> {
    const url = buildUrl(`${YT_API}/playlistItems`, { part: "snippet" });
    const json: { id: string } = await this.request(
      "POST",
      url,
      {
        snippet: {
          playlistId,
          resourceId: { kind: "youtube#video", videoId },
        },
      },
      50,
    );
    return json.id;
  }

  async removeFromPlaylist(playlistItemId: string): Promise<void> {
    const url = buildUrl(`${YT_API}/playlistItems`, { id: playlistItemId });
    await this.request("DELETE", url, undefined, 50);
  }

  async searchVideos(
    query: string,
    maxResults = 5,
  ): Promise<YouTubeSearchResult[]> {
    const url = buildUrl(`${YT_API}/search`, {
      part: "snippet",
      type: "video",
      maxResults: String(maxResults),
      q: query,
    });
    const json: SearchResponse = await this.request("GET", url, undefined, 100);
    return json.items.map((it) => ({
      videoId: it.id.videoId,
      title: it.snippet.title,
      channelTitle: it.snippet.channelTitle,
    }));
  }

  async getVideosByIds(
    ids: string[],
  ): Promise<Map<string, { durationMs: number; title: string; channelTitle: string }>> {
    const out = new Map<
      string,
      { durationMs: number; title: string; channelTitle: string }
    >();
    if (ids.length === 0) return out;
    const calls: Array<Promise<void>> = [];
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      calls.push(
        this.limit(async () => {
          const url = buildUrl(`${YT_API}/videos`, {
            part: "snippet,contentDetails",
            id: batch.join(","),
            maxResults: "50",
          });
          const json: VideosResponse = await this.request(
            "GET",
            url,
            undefined,
            1,
          );
          for (const v of json.items) {
            out.set(v.id, {
              durationMs: parseIso8601Duration(v.contentDetails.duration),
              title: v.snippet.title,
              channelTitle: v.snippet.channelTitle,
            });
          }
        }),
      );
    }
    await Promise.all(calls);
    return out;
  }

  toCandidate(
    sr: YouTubeSearchResult,
    extra?: { durationMs?: number },
  ): NormalizedTrack {
    return {
      source: "youtube",
      sourceTrackId: sr.videoId,
      title: sr.title,
      artists: [sr.channelTitle].filter(Boolean),
      durationMs: extra?.durationMs ?? 0,
    };
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "DELETE",
    url: string,
    body: unknown | undefined,
    quotaCost: number,
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

      if (res.status === 401 && attempt === 0) continue;

      if (res.status === 429) {
        await sleep(backoffMs(attempt));
        continue;
      }

      if (res.status === 403) {
        const text = await safeText(res);
        const reason = extractReason(text);
        if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
          throw new QuotaExceededError();
        }
        if (
          reason === "rateLimitExceeded" ||
          reason === "userRateLimitExceeded"
        ) {
          if (attempt < MAX_RETRIES - 1) {
            await sleep(backoffMs(attempt));
            continue;
          }
          throw new YouTubeRateLimitError();
        }
        throw new YouTubeApiError(res.status, text);
      }

      if (!res.ok) {
        const text = await safeText(res);
        throw new YouTubeApiError(res.status, text);
      }

      // Successful call — account for quota cost.
      await this.quota.spend(quotaCost);

      if (res.status === 204) return undefined as T;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("json")) return undefined as T;
      return (await res.json()) as T;
    }
    throw lastErr ?? new Error("youtube: exhausted retries");
  }
}

function buildUrl(base: string, params: Record<string, string>) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function backoffMs(attempt: number) {
  return 500 * 2 ** attempt + Math.random() * 200;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function extractReason(body: string): string | null {
  try {
    const json = JSON.parse(body);
    return json?.error?.errors?.[0]?.reason ?? null;
  } catch {
    return null;
  }
}

// "PT4M13S" -> 253000ms
export function parseIso8601Duration(d: string): number {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d);
  if (!m) return 0;
  const [, h, mn, s] = m;
  return (
    (Number(h ?? 0) * 3600 + Number(mn ?? 0) * 60 + Number(s ?? 0)) * 1000
  );
}

type PagedPlaylists = {
  nextPageToken?: string;
  items: Array<{
    id: string;
    snippet: { title: string };
    contentDetails?: { itemCount: number };
  }>;
};

type PagedPlaylistItems = {
  nextPageToken?: string;
  items: Array<{
    id: string;
    snippet?: {
      title?: string;
      channelTitle?: string;
      videoOwnerChannelTitle?: string;
      resourceId?: { videoId?: string };
    };
    contentDetails?: { videoId?: string };
  }>;
};

type SearchResponse = {
  items: Array<{
    id: { videoId: string };
    snippet: { title: string; channelTitle: string };
  }>;
};

type VideosResponse = {
  items: Array<{
    id: string;
    snippet: { title: string; channelTitle: string };
    contentDetails: { duration: string };
  }>;
};
