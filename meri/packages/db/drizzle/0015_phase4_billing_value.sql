CREATE TABLE "billing_rollups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"period" text NOT NULL,
	"plan" text NOT NULL,
	"charged" boolean NOT NULL,
	"credits_used" real DEFAULT 0 NOT NULL,
	"ai_cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"revenue_micro_usd" bigint DEFAULT 0 NOT NULL,
	"infra_cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"payment_fee_micro_usd" bigint DEFAULT 0 NOT NULL,
	"gross_margin_pct" real,
	"margin_alarm" boolean DEFAULT false NOT NULL,
	"computed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cancellation_feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"credits" integer NOT NULL,
	"period" text NOT NULL,
	"pack" text NOT NULL,
	"source_event_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entitlements" ALTER COLUMN "max_clients" SET DEFAULT 25;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "previous_retention_days" integer;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "retention_grace_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "shown_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "price_interval" text;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "has_payment_method" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "last_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_rollups" ADD CONSTRAINT "billing_rollups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cancellation_feedback" ADD CONSTRAINT "cancellation_feedback_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_rollups_ws_period_uq" ON "billing_rollups" USING btree ("workspace_id","period");--> statement-breakpoint
CREATE INDEX "cancel_feedback_ws_idx" ON "cancellation_feedback" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grants_source_uq" ON "credit_grants" USING btree ("source_event_id");--> statement-breakpoint
CREATE INDEX "credit_grants_ws_period_idx" ON "credit_grants" USING btree ("workspace_id","period");--> statement-breakpoint
-- Keep the oldest value event per (workspace, type, entity) before the unique index (D-063).
DELETE FROM value_events v USING value_events w WHERE v.entity_id IS NOT NULL AND v.workspace_id = w.workspace_id AND v.type = w.type AND v.entity_id = w.entity_id AND (v.created_at, v.id) > (w.created_at, w.id);--> statement-breakpoint
CREATE UNIQUE INDEX "value_ws_type_entity_uq" ON "value_events" USING btree ("workspace_id","type","entity_id") WHERE "value_events"."entity_id" is not null;--> statement-breakpoint
-- RLS for the phase 4 tenant tables (tenant policy + admin read context, same as 0013/0014).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['credit_grants','billing_rollups','cancellation_feedback']
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
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO meri_app', t);
  END LOOP;
END $$;
--> statement-breakpoint
-- [L14] ai_usage.credits held the USD cost until now: recompute it from the credit catalogue (@meri/core CREDIT_COSTS).
UPDATE ai_usage SET credits = CASE operation
  WHEN 'extract_commitments' THEN 1
  WHEN 'capture_parse' THEN 0.2
  WHEN 'capture.parse' THEN 0.2
  WHEN 'followup_draft' THEN 3
  WHEN 'brief_client' THEN 5
  WHEN 'summary' THEN 1
  ELSE 0 END;
--> statement-breakpoint
-- [L14] entitlements from each subscription's plan (@meri/core PLANS; trial = Pro limits with 300 credits, [H2]).
UPDATE entitlements e SET
  max_clients = CASE s.plan WHEN 'pro_plus' THEN 100 ELSE 25 END,
  ai_credits_monthly = CASE s.plan WHEN 'pro_plus' THEN 5000 WHEN 'pro' THEN 1500 ELSE 300 END,
  retention_days = CASE s.plan WHEN 'pro_plus' THEN 365 ELSE 90 END,
  features = CASE s.plan WHEN 'pro_plus' THEN '["briefings_unlimited","advanced_exports"]'::jsonb ELSE '[]'::jsonb END,
  updated_at = now()
FROM subscriptions s WHERE s.workspace_id = e.workspace_id;
