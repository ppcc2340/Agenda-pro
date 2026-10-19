DROP INDEX "plan_runs_ws_created_idx";--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "plan_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "plan_runs_ws_id_idx" ON "plan_runs" USING btree ("workspace_id","id");