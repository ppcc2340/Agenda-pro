-- Row Level Security (apply after Drizzle migrations).
-- Each request/job must run: SET LOCAL app.workspace_id = '<uuid>';
-- The application role must NOT be a superuser and must NOT have BYPASSRLS.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships','preferences','clients','projects','contacts','tasks','task_dependencies',
    'calendar_events','schedule_blocks','threads_index','commitments','proposals','time_entries',
    'integration_accounts','sync_state','audit_log','ai_usage','value_events','subscriptions','entitlements'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS ws_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY ws_isolation ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)::uuid) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true)::uuid)',
      t
    );
  END LOOP;
END $$;

-- audit_log is append-only
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
