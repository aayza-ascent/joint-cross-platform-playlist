import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
  primaryKey,
  uniqueIndex,
  index,
  jsonb,
  customType,
  date,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("emailVerified", { mode: "date" }),
  image: text("image"),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerAccountId] }),
  ],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("sessionToken").primaryKey(),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { mode: "date" }).notNull(),
});

export const verificationTokens = pgTable(
  "verificationTokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { mode: "date" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

export const connectedAccounts = pgTable(
  "connected_accounts",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    accessTokenCiphertext: bytea("access_token_ciphertext").notNull(),
    accessTokenNonce: bytea("access_token_nonce").notNull(),
    refreshTokenCiphertext: bytea("refresh_token_ciphertext"),
    refreshTokenNonce: bytea("refresh_token_nonce"),
    expiry: timestamp("expiry", { withTimezone: true }),
    scope: text("scope"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("connected_accounts_user_provider_key").on(
      t.userId,
      t.provider,
    ),
  ],
);

export type YoutubeBaselineItem = {
  videoId: string;
  playlistItemId: string;
};

export const playlistPairs = pgTable("playlist_pairs", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  spotifyPlaylistId: text("spotify_playlist_id").notNull(),
  youtubePlaylistId: text("youtube_playlist_id").notNull(),
  broken: boolean("broken").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  // Baseline written atomically with sync_runs.status='done'. NULL until the
  // first successful sync. Required for two-way delta detection — without it
  // we cannot tell "added since last sync" from "removed on the other side."
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastKnownSpotifyTrackIds: jsonb("last_known_spotify_track_ids").$type<string[]>(),
  lastKnownYoutubeItems: jsonb(
    "last_known_youtube_items",
  ).$type<YoutubeBaselineItem[]>(),
});

export const trackMappings = pgTable(
  "track_mappings",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    spotifyTrackId: text("spotify_track_id").notNull(),
    youtubeVideoId: text("youtube_video_id").notNull(),
    isrc: text("isrc"),
    confidence: numeric("confidence", { precision: 4, scale: 3 }),
    matchMethod: text("match_method").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.spotifyTrackId] }),
    index("track_mappings_user_isrc_idx").on(t.userId, t.isrc),
    // Reverse lookup: 'given a YouTube videoId, do I have a Spotify track for it?'
    // Used by two-way sync's reverse matching path. Without this index, the
    // lookup degrades to a per-row scan.
    index("track_mappings_user_video_idx").on(t.userId, t.youtubeVideoId),
  ],
);

export const syncRuns = pgTable("sync_runs", {
  id: text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  pairId: text("pair_id")
    .notNull()
    .references(() => playlistPairs.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  addedCount: integer("added_count").notNull().default(0),
  removedCount: integer("removed_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  quotaUnitsSpent: integer("quota_units_spent").notNull().default(0),
  error: text("error"),
});

export const syncRunItems = pgTable(
  "sync_run_items",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    runId: text("run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "cascade" }),
    // Either spotifyTrackId or youtubeVideoId is present at plan time,
    // depending on which side originated the op. Both can be present
    // once the op is resolved (search succeeded or mapping was hit).
    spotifyTrackId: text("spotify_track_id"),
    youtubeVideoId: text("youtube_video_id"),
    // Required for remove_from_yt; YouTube removes by playlistItem.id, not videoId.
    youtubePlaylistItemId: text("youtube_playlist_item_id"),
    action: text("action").notNull(),
    status: text("status").notNull(),
    error: text("error"),
  },
  (t) => [
    index("sync_run_items_run_status_idx").on(t.runId, t.status),
  ],
);

export const unmatchedTracks = pgTable(
  "unmatched_tracks",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    spotifyTrackId: text("spotify_track_id").notNull(),
    candidates: jsonb("candidates_jsonb").notNull(),
    lastSeenRunId: text("last_seen_run_id").references(() => syncRuns.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.spotifyTrackId] })],
);

export const quotaUsage = pgTable("quota_usage", {
  date: date("date").primaryKey(),
  unitsUsed: integer("units_used").notNull().default(0),
});
