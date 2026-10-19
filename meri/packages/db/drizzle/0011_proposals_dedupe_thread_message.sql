ALTER TABLE "proposals" ADD COLUMN "dedupe_hash" text;--> statement-breakpoint
ALTER TABLE "threads_index" ADD COLUMN "last_external_message_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_pending_dedupe_uq" ON "proposals" USING btree ("workspace_id","dedupe_hash") WHERE "proposals"."status" = 'pending' and "proposals"."dedupe_hash" is not null;