DROP INDEX "cal_events_ext_uq";--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "calendar_id" text DEFAULT 'primary' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_accounts" ADD COLUMN "meri_calendar_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "cal_events_ext_uq" ON "calendar_events" USING btree ("workspace_id","integration_account_id","calendar_id","external_id");