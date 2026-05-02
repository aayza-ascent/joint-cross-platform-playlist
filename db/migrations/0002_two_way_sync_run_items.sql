ALTER TABLE "sync_run_items" DROP CONSTRAINT "sync_run_items_run_id_spotify_track_id_pk";--> statement-breakpoint
ALTER TABLE "sync_run_items" ALTER COLUMN "spotify_track_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_run_items" ADD COLUMN "id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_run_items" ADD COLUMN "youtube_playlist_item_id" text;--> statement-breakpoint
CREATE INDEX "sync_run_items_run_status_idx" ON "sync_run_items" USING btree ("run_id","status");