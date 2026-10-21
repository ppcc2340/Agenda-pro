CREATE TABLE "beta_invites" (
	"email" text PRIMARY KEY NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"page_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "survey_responses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"answer" text,
	"comment" text,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waitlist" (
	"email" text PRIMARY KEY NOT NULL,
	"locale" text DEFAULT 'es' NOT NULL,
	"consent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "eval_consent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "price_cohort" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_responses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_ws_idx" ON "feedback" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "survey_ws_kind_idx" ON "survey_responses" USING btree ("workspace_id","kind","created_at");--> statement-breakpoint
-- meri:destructive-approved phase 6 review (SEC-H3): SECURITY DEFINER functions are the only way the app role reaches the beta tables; purge_workspace gains the beta cleanup.
-- Value checks at the database edge (the API validates with Zod too).
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_kind_ck" CHECK (kind IN ('bug', 'idea', 'other'));--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_message_len_ck" CHECK (char_length(message) BETWEEN 1 AND 2000);--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_path_len_ck" CHECK (page_path IS NULL OR char_length(page_path) <= 200);--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_kind_ck" CHECK (kind IN ('sean_ellis'));--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_answer_ck" CHECK ((answer IS NULL) <> (dismissed_at IS NULL) AND (answer IS NULL OR answer IN ('very', 'somewhat', 'not', 'na')));--> statement-breakpoint
ALTER TABLE "survey_responses" ADD CONSTRAINT "survey_comment_len_ck" CHECK (comment IS NULL OR char_length(comment) <= 500);--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subs_price_cohort_ck" CHECK (price_cohort IS NULL OR price_cohort IN ('A', 'B'));--> statement-breakpoint
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_email_ck" CHECK (email = lower(email) AND char_length(email) <= 254);--> statement-breakpoint
ALTER TABLE "beta_invites" ADD CONSTRAINT "beta_invites_email_ck" CHECK (email = lower(email) AND char_length(email) <= 254);--> statement-breakpoint
-- RLS for the phase 6 tenant tables (tenant policy + admin read context, same as 0015).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['feedback','survey_responses']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
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
--> statement-breakpoint
-- Beta tables (SEC-H3): the app role may only add itself to the waitlist; invitations are invisible to it.
REVOKE ALL ON beta_invites, waitlist FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON beta_invites, waitlist FROM meri_app;--> statement-breakpoint
GRANT INSERT ON waitlist TO meri_app;--> statement-breakpoint
-- True when the address has an invitation. Lets the bootstrap answer without reading the table.
CREATE OR REPLACE FUNCTION is_invited(address text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM beta_invites WHERE email = lower(trim(address)))
$$;--> statement-breakpoint
-- Called in the bootstrap transaction: removes the invitation and the waitlist entry of the address that is
-- becoming an account (nothing personal stays in the beta tables) and says whether an invitation existed.
CREATE OR REPLACE FUNCTION consume_beta_email(address text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE invited integer;
BEGIN
  DELETE FROM beta_invites WHERE email = lower(trim(address));
  GET DIAGNOSTICS invited = ROW_COUNT;
  DELETE FROM waitlist WHERE email = lower(trim(address));
  RETURN invited > 0;
END $$;--> statement-breakpoint
-- Retention (SEC-M4): waitlist entries older than 180 days are removed by the daily retention job.
CREATE OR REPLACE FUNCTION prune_waitlist() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  DELETE FROM waitlist WHERE created_at < now() - interval '180 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION is_invited(text), consume_beta_email(text), prune_waitlist() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION is_invited(text), consume_beta_email(text), prune_waitlist() TO meri_app;--> statement-breakpoint
-- purge_workspace (0018) now also removes beta rows that name the purged members' addresses (SEC-H3).
CREATE OR REPLACE FUNCTION purge_workspace(target uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ws record;
  t text;
  n integer;
  removed integer := 0;
  members uuid[];
  member_emails text[];
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
  SELECT coalesce(array_agg(lower(email)), '{}') INTO member_emails FROM users WHERE id = ANY (members);
  DELETE FROM feature_flags WHERE workspace_id = target;
  DELETE FROM workspaces WHERE id = target;
  DELETE FROM beta_invites WHERE email = ANY (member_emails);
  DELETE FROM waitlist WHERE email = ANY (member_emails);
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
