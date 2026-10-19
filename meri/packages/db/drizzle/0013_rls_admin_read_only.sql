-- D-037 (security review): the admin context may READ every workspace but never write or delete across tenants.
-- A single FOR ALL policy applied its USING clause to DELETE as well, so '*' allowed cross-tenant deletes.
-- Now: ws_isolation (FOR ALL) is tenant-only for every command, and ws_admin_read (FOR SELECT) adds the wildcard
-- for non-application roles. Policies are permissive, so SELECT passes with either; DELETE/UPDATE need ws_isolation.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT DISTINCT tablename FROM pg_policies WHERE policyname IN ('ws_isolation', 'ws_admin_read') AND schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS ws_isolation ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS ws_admin_read ON %I', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I USING (workspace_id = CASE WHEN coalesce(current_setting(''app.workspace_id'', true), '''') IN ('''', ''*'') THEN NULL ELSE current_setting(''app.workspace_id'', true)::uuid END) WITH CHECK (workspace_id = CASE WHEN coalesce(current_setting(''app.workspace_id'', true), '''') IN ('''', ''*'') THEN NULL ELSE current_setting(''app.workspace_id'', true)::uuid END)',
      t
    );
    EXECUTE format(
      'CREATE POLICY ws_admin_read ON %I FOR SELECT USING (current_user <> ''meri_app'' AND current_setting(''app.workspace_id'', true) = ''*'')',
      t
    );
  END LOOP;
END $$;
