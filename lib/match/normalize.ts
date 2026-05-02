import { fuzzy } from "fast-fuzzy";
import type { MatchResult, NormalizedTrack } from "@/lib/types";

const PARENS_NOISE = new RegExp(
  "\\s*[\\(\\[][^\\)\\]]*\\b(" +
    [
      "remaster(ed)?",
      "remastered\\s+\\d{4}",
      "\\d{4}\\s+remaster",
      "deluxe",
      "bonus(\\s+track)?",
      "mono",
      "stereo",
      "live(\\s+at\\s+[^\\)\\]]+)?",
      "acoustic",
      "version",
      "edit",
      "remix",
      "radio\\s+edit",
      "extended(\\s+(mix|version))?",
      "single\\s+version",
      "album\\s+version",
      "explicit",
      "clean",
      // YouTube-side noise commonly attached to music video titles
      "official(\\s+(music\\s+)?video|\\s+audio)?",
      "music\\s+video",
      "lyric(s)?\\s+video",
      "lyrics?",
      "audio",
      "video",
      "hd",
      "4k",
      "hq",
      "visualizer",
    ].join("|") +
    ")\\b[^\\)\\]]*[\\)\\]]",
  "gi",
);

const TRAILING_DASH_NOISE = new RegExp(
  "\\s+-\\s+(remaster(ed)?(\\s+\\d{4})?|\\d{4}\\s+remaster|live(\\s+at\\s+.+)?|acoustic|radio\\s+edit|single\\s+version|album\\s+version|extended(\\s+(mix|version))?|deluxe(\\s+edition)?)$",
  "i",
);

const FEAT_SPLIT = /\s*[\(\[]?\s*(?:feat\.?|ft\.?|featuring|with)\s+/i;

export function normalizeTitle(raw: string): string {
  let s = raw.normalize("NFKD").replace(/\p{M}/gu, "");
  s = s.toLowerCase();
  s = s.replace(/[‐-―−]/g, "-");
  s = s.replace(/[‘’ʼ]/g, "'");
  s = s.replace(/[“”]/g, '"');
  s = s.replace(PARENS_NOISE, "");
  s = s.replace(TRAILING_DASH_NOISE, "");
  s = s.replace(/[^\p{L}\p{N}\s\-']/gu, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// YouTube channels commonly suffix artist names. Stripped before comparison.
const YT_CHANNEL_SUFFIX = /\s*-?\s*(vevo|topic|official|music|records|tv)\s*$/i;

export function normalizeArtists(raw: string[]): string[] {
  const out = new Set<string>();
  for (const a of raw) {
    if (!a) continue;
    let s = a.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    s = s.replace(/[‘’ʼ]/g, "'");
    s = s.replace(/[^\p{L}\p{N}\s\-']/gu, " ").replace(/\s+/g, " ").trim();
    // Apply channel-suffix stripping repeatedly: "Beyoncé Official VEVO" -> "beyonce"
    let prev = "";
    while (prev !== s) {
      prev = s;
      s = s.replace(YT_CHANNEL_SUFFIX, "").trim();
    }
    if (s) out.add(s);
  }
  return [...out];
}

export function extractFeatured(rawTitle: string): {
  title: string;
  featured: string[];
} {
  const idx = rawTitle.search(FEAT_SPLIT);
  if (idx < 0) return { title: rawTitle, featured: [] };
  const head = rawTitle.slice(0, idx);
  const tail = rawTitle.slice(idx).replace(FEAT_SPLIT, "");
  const cleanTail = tail.replace(/[\)\]]+$/, "");
  const featured = cleanTail
    .split(/\s*(?:,|&|×|\s+x\s+|\s+and\s+)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return { title: head.trim(), featured };
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

function tokenizeTitle(s: string): string[] {
  return s
    .split(/[\s\-]+/u)
    .map((t) => t.trim())
    .filter(Boolean);
}

// Token-set Jaccard for titles, after splitting on whitespace AND hyphens
// (so "jay-z" and "jay z" tokenize the same way).
export function titleTokenJaccard(a: string, b: string): number {
  return jaccard(tokenizeTitle(a), tokenizeTitle(b));
}

// "Is the shorter title contained inside the longer one?" Useful for the
// common YouTube pattern where the title repeats the artist ("Beyoncé - Halo")
// but the Spotify title is just "Halo". Single-token titles ("Halo") match
// any longer title containing them; false-positive risk is held in check by
// the artist-Jaccard and duration components of the composite score.
export function titleContainment(a: string, b: string): number {
  const ta = new Set(tokenizeTitle(a));
  const tb = new Set(tokenizeTitle(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  const smaller = ta.size <= tb.size ? ta : tb;
  const larger = ta.size <= tb.size ? tb : ta;
  let inter = 0;
  for (const t of smaller) if (larger.has(t)) inter++;
  return inter / smaller.size;
}

export function titleSimilarity(a: string, b: string): number {
  return Math.max(
    fuzzy(a, b) as number,
    titleTokenJaccard(a, b),
    titleContainment(a, b),
  );
}

export function durationScore(aMs: number, bMs: number): number {
  const diff = Math.abs(aMs - bMs) / 1000;
  if (diff <= 3) return 1;
  if (diff <= 10) return 0.7;
  if (diff <= 15) return 0.4;
  return 0;
}

export type ScoredCandidate = {
  videoId: string;
  score: number;
  titleSim: number;
  artistJac: number;
  durationScore: number;
};

export function scoreCandidate(
  spotify: NormalizedTrack,
  candidate: NormalizedTrack,
): ScoredCandidate {
  // Don't run extractFeatured here — YouTube title formats vary wildly
  // ("Artist - Song", "Artist feat. X - Song", "Song (Official Video)")
  // and a structural extraction corrupts more cases than it helps. Trust
  // the artists arrays as authoritative; let fast-fuzzy substring-match
  // the normalized titles.
  const titleSim = titleSimilarity(
    normalizeTitle(spotify.title),
    normalizeTitle(candidate.title),
  );
  const sArtists = normalizeArtists(spotify.artists);
  const cArtists = normalizeArtists(candidate.artists);
  const artistJac = jaccard(sArtists, cArtists);
  const durScore = durationScore(spotify.durationMs, candidate.durationMs);
  const score = 0.5 * titleSim + 0.3 * artistJac + 0.2 * durScore;
  return {
    videoId: candidate.sourceTrackId,
    score,
    titleSim,
    artistJac,
    durationScore: durScore,
  };
}

export const AUTO_ACCEPT_THRESHOLD = 0.75;

// Generic two-side matcher. The forward and reverse helpers below are thin
// wrappers that just name the parameters semantically.
function pickMatch(
  query: NormalizedTrack,
  candidates: NormalizedTrack[],
  knownIsrcMap?: Map<string, string>,
): {
  best: ScoredCandidate | null;
  topN: ScoredCandidate[];
  result: MatchResult | null;
} {
  if (query.isrc && knownIsrcMap?.has(query.isrc)) {
    const matchedId = knownIsrcMap.get(query.isrc)!;
    return {
      best: null,
      topN: [],
      result: { videoId: matchedId, confidence: 1, method: "isrc" },
    };
  }

  if (candidates.length === 0) {
    return { best: null, topN: [], result: null };
  }

  const scored = candidates
    .map((c) => scoreCandidate(query, c))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const topN = scored.slice(0, 3);
  if (best.score >= AUTO_ACCEPT_THRESHOLD) {
    return {
      best,
      topN,
      result: {
        videoId: best.videoId,
        confidence: best.score,
        method: best.score >= 0.9 ? "fuzzy_high" : "fuzzy_low",
      },
    };
  }
  return { best, topN, result: null };
}

export function matchSpotifyToYouTube(
  spotify: NormalizedTrack,
  candidates: NormalizedTrack[],
  knownIsrcMap?: Map<string, string>,
): {
  best: ScoredCandidate | null;
  topN: ScoredCandidate[];
  result: MatchResult | null;
} {
  return pickMatch(spotify, candidates, knownIsrcMap);
}

// Reverse direction: given a YouTube track, find the best Spotify candidate.
// Reuses the same scoring (it's symmetric — title+artist+duration doesn't care
// which side a track came from). MatchResult.videoId is misleadingly named —
// for this direction it's a Spotify trackId.
export function matchYouTubeToSpotify(
  youtube: NormalizedTrack,
  candidates: NormalizedTrack[],
  knownIsrcMap?: Map<string, string>,
): {
  best: ScoredCandidate | null;
  topN: ScoredCandidate[];
  result: MatchResult | null;
} {
  return pickMatch(youtube, candidates, knownIsrcMap);
}

