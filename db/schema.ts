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
    runId: text("run_id")
      .notNull()
      .references(() => syncRuns.id, { onDelete: "cascade" }),
    spotifyTrackId: text("spotify_track_id").notNull(),
    action: text("action").notNull(),
    status: text("status").notNull(),
    youtubeVideoId: text("youtube_video_id"),
    error: text("error"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.spotifyTrackId] })],
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
