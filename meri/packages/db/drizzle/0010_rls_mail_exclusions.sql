-- RLS for mail_exclusions (same policy as 0001).
ALTER TABLE mail_exclusions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE mail_exclusions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS ws_isolation ON mail_exclusions;--> statement-breakpoint
CREATE POLICY ws_isolation ON mail_exclusions USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON mail_exclusions TO meri_app;
