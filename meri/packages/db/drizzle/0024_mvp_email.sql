ALTER TABLE "notifications" ADD COLUMN "email_state" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "emailed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "email_notifications" text DEFAULT 'digest' NOT NULL;--> statement-breakpoint
CREATE INDEX "notifications_email_pending_idx" ON "notifications" USING btree ("created_at") WHERE "notifications"."email_state" is null;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_email_notifications_ck" CHECK (email_notifications IN ('off', 'digest', 'all'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_email_state_ck" CHECK (email_state IS NULL OR email_state IN ('sent', 'skipped', 'failed'));
