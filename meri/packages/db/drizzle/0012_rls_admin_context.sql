-- D-037: explicit admin context for cross-tenant dispatchers (worker crons). The owner/admin role is subject to
-- FORCE ROW LEVEL SECURITY like everyone else, so without BYPASSRLS (only superusers have it in CI) no poll, digest
-- or follow-up scan could ever enumerate accounts. A connection that sets app.workspace_id = '*' AND is not the
-- application role may READ every workspace; writes stay tenant-scoped (WITH CHECK unchanged). The app role
-- (meri_app) can set the GUC but the policy ignores it, so API and job handlers can never widen their scope.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT tablename FROM pg_policies WHERE policyname = 'ws_isolation' AND schemaname = 'public'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS ws_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I USING ((current_user <> ''meri_app'' AND current_setting(''app.workspace_id'', true) = ''*'') OR workspace_id = CASE WHEN coalesce(current_setting(''app.workspace_id'', true), '''') IN ('''', ''*'') THEN NULL ELSE current_setting(''app.workspace_id'', true)::uuid END) WITH CHECK (workspace_id = CASE WHEN coalesce(current_setting(''app.workspace_id'', true), '''') IN ('''', ''*'') THEN NULL ELSE current_setting(''app.workspace_id'', true)::uuid END)',
      t
    );
  END LOOP;
END $$;
