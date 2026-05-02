import { describe, expect, it } from "vitest";
import {
  AUTO_ACCEPT_THRESHOLD,
  durationScore,
  extractFeatured,
  jaccard,
  matchSpotifyToYouTube,
  matchYouTubeToSpotify,
  normalizeArtists,
  normalizeTitle,
  scoreCandidate,
} from "./normalize";
import type { NormalizedTrack } from "@/lib/types";

const sp = (
  o: Partial<NormalizedTrack> & {
    title: string;
    artists: string[];
    durationMs: number;
  },
): NormalizedTrack => ({
  source: "spotify",
  sourceTrackId: "sp_" + o.title.slice(0, 8),
  ...o,
});

const yt = (
  o: Partial<NormalizedTrack> & {
    title: string;
    artists: string[];
    durationMs: number;
  },
): NormalizedTrack => ({
  source: "youtube",
  sourceTrackId: "yt_" + o.title.slice(0, 8),
  ...o,
});

describe("normalizeTitle", () => {
  it("strips diacritics", () => {
    expect(normalizeTitle("Beyoncé — Halo")).toContain("beyonce");
    expect(normalizeTitle("Beyoncé — Halo")).not.toContain("é");
  });

  it("strips parenthetical remaster noise", () => {
    expect(normalizeTitle("Imagine (Remastered 2010)")).toBe("imagine");
    expect(normalizeTitle("Bohemian Rhapsody (2011 Remaster)")).toBe(
      "bohemian rhapsody",
    );
    expect(normalizeTitle("Money (Remastered)")).toBe("money");
  });

  it("strips trailing dash remaster noise", () => {
    expect(normalizeTitle("Imagine - Remastered 2010")).toBe("imagine");
    expect(normalizeTitle("Bohemian Rhapsody - 2011 Remaster")).toBe(
      "bohemian rhapsody",
    );
  });

  it("strips live/acoustic/radio-edit markers", () => {
    expect(normalizeTitle("Wonderwall (Live at Wembley)")).toBe("wonderwall");
    expect(normalizeTitle("Wonderwall - Live at Wembley")).toBe("wonderwall");
    expect(normalizeTitle("Hey Jude (Acoustic)")).toBe("hey jude");
    expect(normalizeTitle("Whatever (Radio Edit)")).toBe("whatever");
  });

  it("preserves the substantive title", () => {
    expect(normalizeTitle("Don't Stop Me Now")).toBe("don't stop me now");
    expect(normalizeTitle("99 Luftballons")).toBe("99 luftballons");
  });

  it("normalizes smart quotes and dashes", () => {
    expect(normalizeTitle("Don’t Stop—Now")).toContain("don't stop");
  });
});

describe("normalizeArtists", () => {
  it("collapses to a deduped lowercased set", () => {
    expect(normalizeArtists(["Beyoncé", "JAY-Z", "Beyoncé"])).toEqual([
      "beyonce",
      "jay-z",
    ]);
  });

  it("drops empty entries", () => {
    expect(normalizeArtists(["", "Drake", ""])).toEqual(["drake"]);
  });

  it("strips YouTube channel suffixes", () => {
    expect(normalizeArtists(["BeyoncéVEVO"])).toEqual(["beyonce"]);
    expect(normalizeArtists(["Drake - Topic"])).toEqual(["drake"]);
    expect(normalizeArtists(["Queen Official"])).toEqual(["queen"]);
    expect(normalizeArtists(["Beyoncé Official VEVO"])).toEqual(["beyonce"]);
  });
});

describe("extractFeatured", () => {
  it("pulls feat artists out of parentheses", () => {
    const r = extractFeatured("Levitating (feat. DaBaby)");
    expect(r.title).toBe("Levitating");
    expect(r.featured).toEqual(["DaBaby"]);
  });

  it("pulls ft. inline", () => {
    const r = extractFeatured("Forever ft. Drake");
    expect(r.title).toBe("Forever");
    expect(r.featured).toEqual(["Drake"]);
  });

  it("splits multiple featured artists on ampersand and comma", () => {
    const r = extractFeatured("Song (feat. Artist A, Artist B & Artist C)");
    expect(r.title).toBe("Song");
    expect(r.featured.sort()).toEqual(["Artist A", "Artist B", "Artist C"]);
  });

  it("does not split on x inside a word", () => {
    const r = extractFeatured("Hits (feat. Roxette)");
    expect(r.featured).toEqual(["Roxette"]);
  });

  it("returns empty featured when none present", () => {
    const r = extractFeatured("Plain Old Title");
    expect(r.featured).toEqual([]);
    expect(r.title).toBe("Plain Old Title");
  });
});

describe("jaccard", () => {
  it("returns 1 for identical sets", () => {
    expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
  });
  it("returns 0 for disjoint", () => {
    expect(jaccard(["a"], ["b"])).toBe(0);
  });
  it("handles partial overlap", () => {
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3);
  });
});

describe("durationScore", () => {
  it("rewards near-equal durations", () => {
    expect(durationScore(180000, 181000)).toBe(1);
    expect(durationScore(180000, 188000)).toBe(0.7);
    expect(durationScore(180000, 193000)).toBe(0.4);
    expect(durationScore(180000, 220000)).toBe(0);
  });
});

describe("scoreCandidate end-to-end", () => {
  it("scores an exact match very high", () => {
    const s = sp({
      title: "Halo",
      artists: ["Beyoncé"],
      durationMs: 261_000,
    });
    const c = yt({
      title: "Halo",
      artists: ["Beyoncé"],
      durationMs: 261_000,
    });
    const r = scoreCandidate(s, c);
    expect(r.score).toBeGreaterThan(0.95);
  });

  it("scores a noisy YouTube title above threshold", () => {
    const s = sp({
      title: "Halo",
      artists: ["Beyoncé"],
      durationMs: 261_000,
    });
    const c = yt({
      title: "Beyoncé - Halo (Official Music Video)",
      artists: ["Beyoncé"],
      durationMs: 264_000,
    });
    const r = scoreCandidate(s, c);
    expect(r.score).toBeGreaterThan(AUTO_ACCEPT_THRESHOLD);
  });

  it("matches across feat./diacritic/remaster mix", () => {
    // Spotify exposes both primary and featured artists in the artists array
    const s = sp({
      title: "Crazy In Love (feat. JAY-Z)",
      artists: ["Beyoncé", "JAY-Z"],
      durationMs: 236_000,
    });
    const c = yt({
      title: "Beyoncé feat. Jay Z - Crazy In Love (Remastered 2011)",
      artists: ["BeyoncéVEVO"],
      durationMs: 235_000,
    });
    const r = scoreCandidate(s, c);
    expect(r.score).toBeGreaterThan(AUTO_ACCEPT_THRESHOLD);
  });

  it("rejects unrelated track at top score", () => {
    const s = sp({
      title: "Halo",
      artists: ["Beyoncé"],
      durationMs: 261_000,
    });
    const c = yt({
      title: "Bohemian Rhapsody",
      artists: ["Queen"],
      durationMs: 354_000,
    });
    const r = scoreCandidate(s, c);
    expect(r.score).toBeLessThan(AUTO_ACCEPT_THRESHOLD);
  });
});

describe("matchSpotifyToYouTube", () => {
  it("ISRC short-circuits to the cached videoId", () => {
    const s = sp({
      title: "anything",
      artists: ["X"],
      durationMs: 0,
      isrc: "USRC11400001",
    });
    const cached = new Map([["USRC11400001", "VID-123"]]);
    const r = matchSpotifyToYouTube(s, [], cached);
    expect(r.result).toEqual({
      videoId: "VID-123",
      confidence: 1,
      method: "isrc",
    });
  });

  it("prefers ISRC over candidates", () => {
    const s = sp({
      title: "Halo",
      artists: ["Beyoncé"],
      durationMs: 261_000,
      isrc: "USRC10800001",
    });
    const cached = new Map([["USRC10800001", "ISRC-VID"]]);
    const c = yt({
      title: "Beyoncé - Halo",
      artists: ["Beyoncé"],
      durationMs: 261_000,
    });
    const r = matchSpotifyToYouTube(s, [c], cached);
    expect(r.result?.videoId).toBe("ISRC-VID");
    expect(r.result?.method).toBe("isrc");
  });

  it("returns null when no candidate clears the threshold", () => {
    const s = sp({
      title: "Some Obscure Track",
      artists: ["Niche Artist"],
      durationMs: 200_000,
    });
    const c = yt({
      title: "A Totally Different Song",
      artists: ["Completely Different Artist"],
      durationMs: 350_000,
    });
    const r = matchSpotifyToYouTube(s, [c]);
    expect(r.result).toBeNull();
    expect(r.topN.length).toBe(1);
    expect(r.best).not.toBeNull();
  });

  it("returns top-3 sorted descending", () => {
    const s = sp({
      title: "Halo",
      artists: ["Beyoncé"],
      durationMs: 261_000,
    });
    const candidates = [
      yt({
        title: "Halo",
        artists: ["Beyoncé"],
        durationMs: 261_000,
        sourceTrackId: "best",
      }),
      yt({
        title: "Halo (Cover)",
        artists: ["RandomCoverArtist"],
        durationMs: 230_000,
        sourceTrackId: "ok",
      }),
      yt({
        title: "Bohemian Rhapsody",
        artists: ["Queen"],
        durationMs: 354_000,
        sourceTrackId: "bad",
      }),
      yt({
        title: "Garbage",
        artists: ["Nobody"],
        durationMs: 60_000,
        sourceTrackId: "worse",
      }),
    ];
    const r = matchSpotifyToYouTube(s, candidates);
    expect(r.topN.length).toBe(3);
    expect(r.topN[0].videoId).toBe("best");
    expect(r.topN[0].score).toBeGreaterThanOrEqual(r.topN[1].score);
    expect(r.topN[1].score).toBeGreaterThanOrEqual(r.topN[2].score);
  });

  it("returns null result and empty topN with no candidates", () => {
    const s = sp({
      title: "x",
      artists: ["y"],
      durationMs: 1,
    });
    const r = matchSpotifyToYouTube(s, []);
    expect(r.result).toBeNull();
    expect(r.topN).toEqual([]);
    expect(r.best).toBeNull();
  });
});

describe("matchYouTubeToSpotify (reverse direction)", () => {
  it("matches a clean YouTube video to a Spotify track via fuzzy", () => {
    // The query is a YouTube track; candidates are Spotify tracks.
    const yt: NormalizedTrack = {
      source: "youtube",
      sourceTrackId: "v-yt",
      title: "Beyoncé - Halo (Official Music Video)",
      artists: ["BeyoncéVEVO"],
      durationMs: 264_000,
    };
    const candidates: NormalizedTrack[] = [
      {
        source: "spotify",
        sourceTrackId: "sp-halo",
        title: "Halo",
        artists: ["Beyoncé"],
        durationMs: 261_000,
        isrc: "USRC10800001",
      },
      {
        source: "spotify",
        sourceTrackId: "sp-other",
        title: "Bohemian Rhapsody",
        artists: ["Queen"],
        durationMs: 354_000,
      },
    ];
    const r = matchYouTubeToSpotify(yt, candidates);
    expect(r.result).not.toBeNull();
    expect(r.result?.videoId).toBe("sp-halo"); // field name carries trackId in reverse direction
    expect(r.result?.confidence).toBeGreaterThan(AUTO_ACCEPT_THRESHOLD);
  });

  it("single-word containment alone is not enough — wrong artist+duration rejects", () => {
    // "Love" appears as a token in the YT title, but the artist is unrelated
    // and the duration is wildly off. The composite score must reject this.
    const yt: NormalizedTrack = {
      source: "youtube",
      sourceTrackId: "v-yt",
      title: "I Love My Cat (Vlog Episode 47)",
      artists: ["Random Vlogger"],
      durationMs: 600_000,
    };
    const sp: NormalizedTrack = {
      source: "spotify",
      sourceTrackId: "sp-love",
      title: "Love",
      artists: ["Lana Del Rey"],
      durationMs: 264_000,
    };
    const r = matchYouTubeToSpotify(yt, [sp]);
    expect(r.result).toBeNull();
  });

  it("returns null when no Spotify candidate clears threshold", () => {
    const yt: NormalizedTrack = {
      source: "youtube",
      sourceTrackId: "v-yt",
      title: "Some Random Channel Daily Vlog",
      artists: ["Random Vlogger"],
      durationMs: 600_000,
    };
    const r = matchYouTubeToSpotify(yt, [
      {
        source: "spotify",
        sourceTrackId: "sp-completely-unrelated",
        title: "Toxic",
        artists: ["Britney Spears"],
        durationMs: 198_000,
      },
    ]);
    expect(r.result).toBeNull();
  });
});
