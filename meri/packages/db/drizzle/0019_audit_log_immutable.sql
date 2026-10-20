-- Custom SQL migration file, put your code below! --
-- ADR 0007 (plan review SA-H2): the audit trail is append-only for EVERY role. UPDATE is always refused; a DELETE is
-- only accepted inside a referential cascade (pg_trigger_depth() > 1), i.e. when purge_workspace() erases a whole
-- workspace. No session variable can open it (any role may set app.* settings). The table owner can still disable
-- the trigger: residual risk recorded in docs/threat-model.md.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'P0001';
  END IF;
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'audit_log rows are only removed with their workspace (purge_workspace)' USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log;
--> statement-breakpoint
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
