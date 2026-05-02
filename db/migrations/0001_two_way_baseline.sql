ALTER TABLE "playlist_pairs" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "playlist_pairs" ADD COLUMN "last_known_spotify_track_ids" jsonb;--> statement-breakpoint
ALTER TABLE "playlist_pairs" ADD COLUMN "last_known_youtube_items" jsonb;--> statement-breakpoint
CREATE INDEX "track_mappings_user_video_idx" ON "track_mappings" USING btree ("user_id","youtube_video_id");