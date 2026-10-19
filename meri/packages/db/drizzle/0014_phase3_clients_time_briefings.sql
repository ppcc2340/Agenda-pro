CREATE TABLE "briefings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"event_id" uuid,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_hash" text NOT NULL,
	"source" text DEFAULT 'rules' NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "vertical_tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "vertical" text DEFAULT 'generic' NOT NULL;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "briefing_before_meetings" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefings" ADD CONSTRAINT "briefings_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "briefings_ws_client_uq" ON "briefings" USING btree ("workspace_id","client_id") WHERE "briefings"."event_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "briefings_ws_client_event_uq" ON "briefings" USING btree ("workspace_id","client_id","event_id") WHERE "briefings"."event_id" is not null;--> statement-breakpoint
CREATE INDEX "cal_events_ws_client_start_idx" ON "calendar_events" USING btree ("workspace_id","client_id","starts_at");--> statement-breakpoint
CREATE INDEX "threads_ws_client_last_idx" ON "threads_index" USING btree ("workspace_id","client_id","last_message_at");--> statement-breakpoint
CREATE INDEX "time_ws_client_day_idx" ON "time_entries" USING btree ("workspace_id","client_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "time_entries_source_uq" ON "time_entries" USING btree ("workspace_id","source_type","source_id") WHERE "time_entries"."source_id" is not null;--> statement-breakpoint
-- RLS for briefings (tenant policy + admin read context, same as 0013).
ALTER TABLE briefings ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE briefings FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY ws_isolation ON briefings USING (workspace_id = CASE WHEN coalesce(current_setting('app.workspace_id', true), '') IN ('', '*') THEN NULL ELSE current_setting('app.workspace_id', true)::uuid END) WITH CHECK (workspace_id = CASE WHEN coalesce(current_setting('app.workspace_id', true), '') IN ('', '*') THEN NULL ELSE current_setting('app.workspace_id', true)::uuid END);--> statement-breakpoint
CREATE POLICY ws_admin_read ON briefings FOR SELECT USING (current_user <> 'meri_app' AND current_setting('app.workspace_id', true) = '*');--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON briefings TO meri_app;
