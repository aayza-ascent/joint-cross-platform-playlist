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
// Two regexes: one for separator-prefixed suffixes ("Drake - Topic", "Queen Official"),
// one for suffixes glued onto the artist name ("BeyoncéVEVO", "ArianaTopic"). The
// glued variant is intentionally narrower (only the highest-precision platform
// markers) to avoid mauling real artist names like "Music" or "Records".
const YT_CHANNEL_SUFFIX_SPACED = /\s+-?\s*(vevo|topic|official|music|records|tv|channel|band)\s*$/i;
const YT_CHANNEL_SUFFIX_GLUED = /(vevo|topic|official)$/i;

export function normalizeArtists(raw: string[]): string[] {
  const out = new Set<string>();
  for (const a of raw) {
    if (!a) continue;
    let s = a.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    s = s.replace(/[‘’ʼ]/g, "'");
    s = s.replace(/[^\p{L}\p{N}\s\-']/gu, " ").replace(/\s+/g, " ").trim();
    // Apply channel-suffix stripping repeatedly: "Beyoncé Official VEVO" -> "beyonce".
    // First the spaced form (handles separator), then the glued form ("beyoncevevo").
    let prev = "";
    while (prev !== s) {
      prev = s;
      s = s.replace(YT_CHANNEL_SUFFIX_SPACED, "").trim();
      // Glued strip only when the remaining stem is long enough to not be the
      // suffix itself (avoids reducing the channel literally named "VEVO" to "").
      const glued = s.replace(YT_CHANNEL_SUFFIX_GLUED, "");
      if (glued.length >= 3 && glued !== s) s = glued.trim();
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

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strip Spotify artist tokens from a (already-normalized) candidate title. The
// common YouTube pattern is "Beyoncé - Halo (Official Video)" while Spotify
// has just "Halo"; without this strip, fast-fuzzy compares "beyonce halo"
// against "halo" and undershoots on shorter source titles. Multi-token artists
// ("the rolling stones") are escaped and matched as a phrase before falling
// back to per-token strips.
export function stripArtistsFromTitle(
  normalizedTitle: string,
  normalizedArtists: string[],
): string {
  if (normalizedArtists.length === 0) return normalizedTitle;
  let out = normalizedTitle;
  for (const a of normalizedArtists) {
    if (!a || a.length < 2) continue;
    const phraseRe = new RegExp(
      `(?:^|\\s|-)${escapeRegex(a)}(?=\\s|-|$)`,
      "g",
    );
    out = out.replace(phraseRe, " ");
  }
  return out.replace(/\s+/g, " ").trim();
}

// "Does any spotify artist appear inside the YT-side text?" — rescues the
// common case where the channelTitle Jaccard is 0 (e.g. "DailyMusic" channel,
// or "BeyoncéVEVO" before the suffix strip) but the artist is literally
// present in the YT title. Also accepts substring containment for length≥4
// tokens so "beyonce" inside an unstrippable glob still scores.
function artistTokenContainment(
  spArtists: string[],
  haystackText: string,
): number {
  if (spArtists.length === 0) return 0;
  const tokens = new Set(
    haystackText.split(/[\s\-]+/u).map((t) => t.trim()).filter(Boolean),
  );
  let hits = 0;
  for (const a of spArtists) {
    if (!a) continue;
    if (tokens.has(a)) {
      hits++;
      continue;
    }
    if (a.length >= 4 && haystackText.includes(a)) {
      hits++;
      continue;
    }
  }
  return hits / spArtists.length;
}

export function scoreCandidate(
  spotify: NormalizedTrack,
  candidate: NormalizedTrack,
): ScoredCandidate {
  // Don't run extractFeatured here — YouTube title formats vary wildly
  // ("Artist - Song", "Artist feat. X - Song", "Song (Official Video)")
  // and a structural extraction corrupts more cases than it helps. Trust
  // the artists arrays as authoritative; let fast-fuzzy substring-match
  // the normalized titles.
  const sArtists = normalizeArtists(spotify.artists);
  const cArtists = normalizeArtists(candidate.artists);

  const spTitleNorm = normalizeTitle(spotify.title);
  const ytTitleNorm = normalizeTitle(candidate.title);
  // Strip the Spotify artist out of the YT title before fuzzy-comparing, so
  // "beyonce halo" reduces to "halo" against a Spotify title of "halo".
  // Fall back to the original title when the strip leaves nothing.
  const ytTitleStripped = stripArtistsFromTitle(ytTitleNorm, sArtists) || ytTitleNorm;
  const titleSim = titleSimilarity(spTitleNorm, ytTitleStripped);

  // Artist signal: take the strongest of three signals.
  //  - Jaccard of normalized artist tokens (current behavior).
  //  - Containment in the channel text (catches "BeyoncéVEVO" cases the
  //    suffix-strip didn't fully reduce).
  //  - Containment in the YT title (catches fan-channel uploads where the
  //    artist appears in the title but the channel is unrelated).
  // Picking the max preserves bad-match rejection: an unrelated artist with
  // unrelated title still scores 0.
  const channelText = (candidate.artists[0] ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  const containInChannel = artistTokenContainment(sArtists, channelText);
  const containInTitle = artistTokenContainment(sArtists, ytTitleNorm);
  const artistJac = Math.max(
    jaccard(sArtists, cArtists),
    containInChannel,
    containInTitle,
  );

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

