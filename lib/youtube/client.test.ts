import { describe, expect, it, vi } from "vitest";
import {
  parseIso8601Duration,
  QuotaExceededError,
  YouTubeApiError,
  YouTubeClient,
  YouTubeRateLimitError,
} from "./client";
import { InMemoryQuotaAccounter, pacificDate } from "./quota";

type MockResponse = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  rawBody?: string;
};

function mockFetch(seq: MockResponse[]) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let i = 0;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const r = seq[Math.min(i, seq.length - 1)];
    i++;
    const noBodyStatus = r.status === 204 || r.status === 205 || r.status === 304;
    const body = noBodyStatus
      ? null
      : r.rawBody !== undefined
        ? r.rawBody
        : r.body === undefined
          ? ""
          : JSON.stringify(r.body);
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

const token = () => Promise.resolve("ya29.test");

describe("parseIso8601Duration", () => {
  it("handles minutes/seconds", () => {
    expect(parseIso8601Duration("PT4M13S")).toBe(253_000);
  });
  it("handles hours", () => {
    expect(parseIso8601Duration("PT1H2M3S")).toBe(3_723_000);
  });
  it("handles seconds-only", () => {
    expect(parseIso8601Duration("PT45S")).toBe(45_000);
  });
  it("returns 0 on garbage", () => {
    expect(parseIso8601Duration("nope")).toBe(0);
  });
});

describe("pacificDate", () => {
  it("formats YYYY-MM-DD", () => {
    expect(pacificDate(new Date("2026-05-02T03:00:00Z"))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});

describe("YouTubeClient.getPlaylistItems", () => {
  it("paginates and captures playlistItemId + videoId", async () => {
    const { fn } = mockFetch([
      {
        status: 200,
        body: {
          nextPageToken: "n2",
          items: [
            {
              id: "pi1",
              snippet: {
                title: "Halo",
                videoOwnerChannelTitle: "BeyoncéVEVO",
                resourceId: { videoId: "v1" },
              },
              contentDetails: { videoId: "v1" },
            },
          ],
        },
      },
      {
        status: 200,
        body: {
          items: [
            {
              id: "pi2",
              snippet: {
                title: "Single Ladies",
                channelTitle: "BeyoncéVEVO",
                resourceId: { videoId: "v2" },
              },
              contentDetails: { videoId: "v2" },
            },
          ],
        },
      },
    ]);
    const q = new InMemoryQuotaAccounter();
    const c = new YouTubeClient(token, q, fn);
    const items = await c.getPlaylistItems("PL123");
    expect(items).toHaveLength(2);
    expect(items[0].playlistItemId).toBe("pi1");
    expect(items[0].videoId).toBe("v1");
    expect(items[1].playlistItemId).toBe("pi2");
    expect(q.used).toBe(2); // 1 unit/page × 2 pages
  });
});

describe("YouTubeClient.searchVideos", () => {
  it("charges 100 quota units and returns normalized hits", async () => {
    const { fn } = mockFetch([
      {
        status: 200,
        body: {
          items: [
            {
              id: { videoId: "v1" },
              snippet: { title: "Halo - Beyoncé", channelTitle: "BeyoncéVEVO" },
            },
            {
              id: { videoId: "v2" },
              snippet: { title: "Halo (Cover)", channelTitle: "Cover Channel" },
            },
          ],
        },
      },
    ]);
    const q = new InMemoryQuotaAccounter();
    const c = new YouTubeClient(token, q, fn);
    const r = await c.searchVideos("Halo Beyoncé");
    expect(r).toHaveLength(2);
    expect(q.used).toBe(100);
  });
});

describe("YouTubeClient quota and error handling", () => {
  it("throws QuotaExceededError on 403 quotaExceeded and does NOT charge units", async () => {
    const { fn } = mockFetch([
      {
        status: 403,
        body: { error: { errors: [{ reason: "quotaExceeded" }] } },
      },
    ]);
    const q = new InMemoryQuotaAccounter();
    const c = new YouTubeClient(token, q, fn);
    await expect(c.searchVideos("anything")).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    expect(q.used).toBe(0);
  });

  it("retries on 403 rateLimitExceeded then succeeds", async () => {
    const { fn } = mockFetch([
      {
        status: 403,
        body: { error: { errors: [{ reason: "rateLimitExceeded" }] } },
      },
      { status: 200, body: { items: [] } },
    ]);
    const q = new InMemoryQuotaAccounter();
    const c = new YouTubeClient(token, q, fn);
    const r = await c.searchVideos("x");
    expect(r).toEqual([]);
    expect(q.used).toBe(100);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("eventually throws YouTubeRateLimitError if rate limit persists", async () => {
    const { fn } = mockFetch([
      { status: 403, body: { error: { errors: [{ reason: "rateLimitExceeded" }] } } },
      { status: 403, body: { error: { errors: [{ reason: "rateLimitExceeded" }] } } },
      { status: 403, body: { error: { errors: [{ reason: "rateLimitExceeded" }] } } },
    ]);
    const q = new InMemoryQuotaAccounter();
    const c = new YouTubeClient(token, q, fn);
    await expect(c.searchVideos("x")).rejects.toBeInstanceOf(
      YouTubeRateLimitError,
    );
  });

  it("addToPlaylist charges 50 units on success", async () => {
    const { fn } = mockFetch([
      { status: 200, body: { id: "newPlaylistItemId" } },
    ]);
    const q = new InMemoryQuotaAccounter();
    const c = new YouTubeClient(token, q, fn);
    const id = await c.addToPlaylist("PL123", "vid1");
    expect(id).toBe("newPlaylistItemId");
    expect(q.used).toBe(50);
  });

  it("removeFromPlaylist sends DELETE with id and charges 50 units", async () => {
    const { fn, calls } = mockFetch([{ status: 204 }]);
    const q = new InMemoryQuotaAccounter();
    const c = new YouTubeClient(token, q, fn);
    await c.removeFromPlaylist("pi-99");
    expect(calls[0].url).toContain("id=pi-99");
    expect(calls[0].init?.method).toBe("DELETE");
    expect(q.used).toBe(50);
  });

  it("getVideosByIds batches at 50 IDs/call (1 unit each)", async () => {
    const { fn, calls } = mockFetch([
      {
        status: 200,
        body: {
          items: Array.from({ length: 50 }, (_, i) => ({
            id: `v${i}`,
            snippet: { title: `t${i}`, channelTitle: "ch" },
            contentDetails: { duration: "PT3M0S" },
          })),
        },
      },
      {
        status: 200,
        body: {
          items: Array.from({ length: 25 }, (_, i) => ({
            id: `v${50 + i}`,
            snippet: { title: `t${50 + i}`, channelTitle: "ch" },
            contentDetails: { duration: "PT2M30S" },
          })),
        },
      },
    ]);
    const q = new InMemoryQuotaAccounter();
    const c = new YouTubeClient(token, q, fn);
    const ids = Array.from({ length: 75 }, (_, i) => `v${i}`);
    const map = await c.getVideosByIds(ids);
    expect(map.size).toBe(75);
    expect(map.get("v0")?.durationMs).toBe(180_000);
    expect(map.get("v50")?.durationMs).toBe(150_000);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(calls[0].url).toMatch(/id=v0(?:%2C|,)v1/);
    expect(q.used).toBe(2);
  });

  it("non-quota 4xx throws YouTubeApiError", async () => {
    const { fn } = mockFetch([
      { status: 400, body: { error: { message: "bad" } } },
    ]);
    const q = new InMemoryQuotaAccounter();
    const c = new YouTubeClient(token, q, fn);
    await expect(c.getPlaylistItems("PLx")).rejects.toBeInstanceOf(
      YouTubeApiError,
    );
  });
});
