export type Provider = "spotify" | "youtube";

export type NormalizedTrack = {
  title: string;
  artists: string[];
  durationMs: number;
  isrc?: string;
  source: Provider;
  sourceTrackId: string;
  sourcePlaylistItemId?: string;
};

export type MatchResult = {
  videoId: string;
  confidence: number;
  method: "isrc" | "fuzzy_high" | "fuzzy_low" | "manual";
};
