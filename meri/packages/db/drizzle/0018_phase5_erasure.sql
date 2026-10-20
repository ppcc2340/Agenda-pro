CREATE TABLE "deletion_receipts" (
	"subject_hash" text PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	"purged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rows_deleted" integer NOT NULL,
	"users_deleted" integer NOT NULL
);
--> statement-breakpoint
-- F-16 / ADR 0007 (plan review SA-H2): the application role can no longer delete workspaces or users. Deleting a
-- workspace cascades into its audit trail, so it may only happen through purge_workspace() below.
REVOKE DELETE, TRUNCATE ON workspaces, users FROM meri_app;
--> statement-breakpoint
REVOKE ALL ON deletion_receipts FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON deletion_receipts FROM meri_app;
--> statement-breakpoint
-- Physical erasure of a workspace logically deleted more than 30 days ago (SECURITY DEFINER, owned by the table
-- owner; plan review SA-H3: the worker never holds owner credentials). Idempotent: an already purged workspace
-- returns 0. Users that kept no membership and were themselves deleted go too. A receipt without personal data
-- (salted-by-domain hash of the id) proves the erasure and lets a restore re-apply it.
CREATE OR REPLACE FUNCTION purge_workspace(target uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ws record;
  t text;
  n integer;
  removed integer := 0;
  members uuid[];
  users_removed integer := 0;
BEGIN
  SELECT id, deleted_at INTO ws FROM workspaces WHERE id = target FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  IF ws.deleted_at IS NULL OR ws.deleted_at > now() - interval '30 days' THEN
    RAISE EXCEPTION 'workspace is not eligible for purge (not deleted, or deleted less than 30 days ago)'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('app.workspace_id', target::text, true);
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
    WHERE c.table_schema = 'public' AND c.column_name = 'workspace_id' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE workspace_id = $1', t) INTO n USING target;
    removed := removed + n;
  END LOOP;
  SELECT coalesce(array_agg(user_id), '{}') INTO members FROM memberships WHERE workspace_id = target;
  DELETE FROM feature_flags WHERE workspace_id = target;
  DELETE FROM workspaces WHERE id = target;
  -- Remaining memberships of those users live in other workspaces: read them with the admin read context.
  PERFORM set_config('app.workspace_id', '*', true);
  WITH gone AS (
    DELETE FROM users u
    WHERE u.id = ANY (members) AND u.deleted_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id = u.id)
    RETURNING 1
  )
  SELECT count(*) INTO users_removed FROM gone;
  INSERT INTO deletion_receipts (subject_hash, deleted_at, rows_deleted, users_deleted)
  VALUES (encode(sha256(convert_to('meri-deletion-v1:' || target::text, 'UTF8')), 'hex'), ws.deleted_at, removed, users_removed)
  ON CONFLICT (subject_hash) DO NOTHING;
  RETURN removed;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_workspace(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_workspace(uuid) TO meri_app;
