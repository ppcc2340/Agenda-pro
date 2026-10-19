-- NULLIF: after a SET LOCAL ends, current_setting returns '' (not NULL) for the rest of the session; '' must mean "no tenant" (zero rows), not an error.
-- Custom migration: application role, grants and Row Level Security (docs/03 §Reglas, docs/06 §3, docs/12 §4).
-- Not reversible by design: removing RLS would expose tenant data. Roll back by restoring a backup.

-- 1. Application role: no SUPERUSER, no BYPASSRLS. LOGIN/password are set by ops (scripts/db-roles.sql in dev/CI).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meri_app') THEN
    CREATE ROLE meri_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO meri_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO meri_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO meri_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO meri_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO meri_app;
--> statement-breakpoint
-- 2. Row Level Security on every table with workspace_id. Each request/job runs set_config('app.workspace_id', ..., true).
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
      'CREATE POLICY ws_isolation ON %I USING (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid) WITH CHECK (workspace_id = NULLIF(current_setting(''app.workspace_id'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;
--> statement-breakpoint
-- 3. audit_log is append-only for the application role (owner keeps UPDATE/DELETE for legal purges).
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON audit_log FROM meri_app;
--> statement-breakpoint
-- undo is modelled as a new row (undone_at is written by a compensating entry), never as an UPDATE by the app role.
-- 4. feature_flags has a nullable workspace_id (global flags) and is read-only for the app.
REVOKE INSERT, UPDATE, DELETE ON feature_flags FROM meri_app;
