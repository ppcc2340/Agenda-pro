-- Custom SQL migration file, put your code below! ---- Test review (phase 5, L1): the row trigger of 0019 does not fire on TRUNCATE, so the table owner could still empty
-- the audit trail in one statement. The application role has no TRUNCATE grant; this closes it for the owner too.
-- The purge never truncates (it deletes through the workspace cascade). Disabling triggers stays a residual risk.
CREATE OR REPLACE FUNCTION audit_log_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log cannot be truncated' USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_no_truncate();
