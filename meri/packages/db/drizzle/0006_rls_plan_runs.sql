ALTER TABLE plan_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE plan_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ws_isolation ON plan_runs USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON plan_runs TO meri_app;
