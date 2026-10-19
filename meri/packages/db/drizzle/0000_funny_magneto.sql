CREATE TYPE "public"."audit_actor" AS ENUM('user', 'system', 'ai');--> statement-breakpoint
CREATE TYPE "public"."autonomy_level" AS ENUM('suggest_only', 'auto_low_risk');--> statement-breakpoint
CREATE TYPE "public"."block_origin" AS ENUM('meri', 'external');--> statement-breakpoint
CREATE TYPE "public"."commitment_direction" AS ENUM('owed_by_me', 'owed_to_me');--> statement-breakpoint
CREATE TYPE "public"."commitment_kind" AS ENUM('explicit', 'inferred', 'suggested');--> statement-breakpoint
CREATE TYPE "public"."commitment_status" AS ENUM('proposed', 'confirmed', 'fulfilled', 'at_risk', 'broken', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."connection_status" AS ENUM('healthy', 'needs_reauth', 'degraded', 'paused', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."deadline_type" AS ENUM('soft', 'hard');--> statement-breakpoint
CREATE TYPE "public"."origin" AS ENUM('user', 'ai_confirmed', 'system', 'integration');--> statement-breakpoint
CREATE TYPE "public"."proposal_kind" AS ENUM('capture', 'commitment', 'followup', 'reschedule', 'time_entry', 'client_link');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'confirmed', 'edited', 'dismissed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('google', 'microsoft', 'notion', 'slack');--> statement-breakpoint
CREATE TYPE "public"."task_kind" AS ENUM('deep', 'shallow');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'scheduled', 'in_progress', 'blocked', 'waiting_on_third_party', 'at_risk', 'completed');--> statement-breakpoint
CREATE TYPE "public"."time_entry_status" AS ENUM('suggested', 'approved', 'rejected', 'exported');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micro_usd" integer DEFAULT 0 NOT NULL,
	"credits" real DEFAULT 0 NOT NULL,
	"period" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor" "audit_actor" NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"undone_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calendar_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_account_id" uuid,
	"external_id" text NOT NULL,
	"etag" text,
	"title" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"attendees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"client_id" uuid,
	"origin" "block_origin" DEFAULT 'external' NOT NULL,
	"busy" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"color" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commitments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"client_id" uuid,
	"direction" "commitment_direction" NOT NULL,
	"kind" "commitment_kind" NOT NULL,
	"status" "commitment_status" DEFAULT 'proposed' NOT NULL,
	"counterparty_email" text,
	"action" text NOT NULL,
	"due_at" timestamp with time zone,
	"due_text" text,
	"confidence" real,
	"evidence" text,
	"thread_id" uuid,
	"external_message_id" text,
	"dedupe_hash" text NOT NULL,
	"task_id" uuid,
	"origin" "origin" DEFAULT 'ai_confirmed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"client_id" uuid,
	"email" text NOT NULL,
	"name" text,
	"muted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entitlements" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"max_clients" integer DEFAULT 10 NOT NULL,
	"ai_credits_monthly" integer DEFAULT 300 NOT NULL,
	"retention_days" integer DEFAULT 90 NOT NULL,
	"features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feature_flags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"workspace_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" "provider" NOT NULL,
	"external_account_id" text NOT NULL,
	"email" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "connection_status" DEFAULT 'healthy' NOT NULL,
	"encrypted_tokens" text NOT NULL,
	"key_id" text NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memberships" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "preferences" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"work_start" text DEFAULT '09:00' NOT NULL,
	"work_end" text DEFAULT '18:00' NOT NULL,
	"work_days" jsonb DEFAULT '[1,2,3,4,5]'::jsonb NOT NULL,
	"deep_work_windows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"min_block_minutes" integer DEFAULT 30 NOT NULL,
	"min_deep_block_minutes" integer DEFAULT 90 NOT NULL,
	"buffer_minutes" integer DEFAULT 10 NOT NULL,
	"contingency_pct" integer DEFAULT 20 NOT NULL,
	"risk_threshold_hours" integer DEFAULT 4 NOT NULL,
	"max_alerts_per_day" integer DEFAULT 5 NOT NULL,
	"autonomy" "autonomy_level" DEFAULT 'suggest_only' NOT NULL,
	"time_rounding_minutes" integer DEFAULT 6 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"client_id" uuid,
	"name" text NOT NULL,
	"due_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "proposal_kind" NOT NULL,
	"status" "proposal_status" DEFAULT 'pending' NOT NULL,
	"payload" jsonb NOT NULL,
	"confidence" real,
	"explanation" text,
	"source_ref" jsonb,
	"resolution" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "schedule_blocks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"reason" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"calendar_event_id" uuid,
	"plan_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"plan" text DEFAULT 'trial' NOT NULL,
	"status" text DEFAULT 'trialing' NOT NULL,
	"trial_ends_at" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_state" (
	"workspace_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"cursor" text,
	"channel_id" text,
	"channel_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_state_integration_account_id_resource_pk" PRIMARY KEY("integration_account_id","resource")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_dependencies" (
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"blocked_by_task_id" uuid NOT NULL,
	CONSTRAINT "task_dependencies_task_id_blocked_by_task_id_pk" PRIMARY KEY("task_id","blocked_by_task_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"client_id" uuid,
	"project_id" uuid,
	"parent_id" uuid,
	"title" text NOT NULL,
	"notes" text,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"kind" "task_kind" DEFAULT 'shallow' NOT NULL,
	"priority" integer DEFAULT 3 NOT NULL,
	"due_at" timestamp with time zone,
	"deadline_type" "deadline_type" DEFAULT 'soft' NOT NULL,
	"estimate_minutes" integer,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"origin" "origin" DEFAULT 'user' NOT NULL,
	"source_commitment_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "threads_index" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_account_id" uuid NOT NULL,
	"external_thread_id" text NOT NULL,
	"subject" text,
	"participants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"client_id" uuid,
	"last_message_at" timestamp with time zone,
	"last_message_from_me" boolean,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "time_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"client_id" uuid,
	"project_id" uuid,
	"task_id" uuid,
	"day" date NOT NULL,
	"minutes" integer NOT NULL,
	"description" text,
	"status" time_entry_status DEFAULT 'suggested' NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"image" text,
	"locale" text DEFAULT 'es' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "value_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"quantity" real,
	"unit" text,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"vertical" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clients" ADD CONSTRAINT "clients_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commitments" ADD CONSTRAINT "commitments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commitments" ADD CONSTRAINT "commitments_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "commitments" ADD CONSTRAINT "commitments_thread_id_threads_index_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads_index"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contacts" ADD CONSTRAINT "contacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contacts" ADD CONSTRAINT "contacts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_accounts" ADD CONSTRAINT "integration_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "preferences" ADD CONSTRAINT "preferences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "proposals" ADD CONSTRAINT "proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_integration_account_id_integration_accounts_id_fk" FOREIGN KEY ("integration_account_id") REFERENCES "public"."integration_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_blocked_by_task_id_tasks_id_fk" FOREIGN KEY ("blocked_by_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "threads_index" ADD CONSTRAINT "threads_index_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "threads_index" ADD CONSTRAINT "threads_index_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "value_events" ADD CONSTRAINT "value_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_usage_ws_period_idx" ON "ai_usage" USING btree ("workspace_id","period");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_ws_created_idx" ON "audit_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cal_events_ext_uq" ON "calendar_events" USING btree ("workspace_id","integration_account_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cal_events_ws_start_idx" ON "calendar_events" USING btree ("workspace_id","starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clients_ws_idx" ON "clients" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commitments_dedupe_uq" ON "commitments" USING btree ("workspace_id","dedupe_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commitments_ws_dir_status_idx" ON "commitments" USING btree ("workspace_id","direction","status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "contacts_ws_email_uq" ON "contacts" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "flags_key_ws_uq" ON "feature_flags" USING btree ("key","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integ_ws_provider_acct_uq" ON "integration_accounts" USING btree ("workspace_id","provider","external_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "projects_ws_client_idx" ON "projects" USING btree ("workspace_id","client_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "proposals_ws_status_idx" ON "proposals" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blocks_ws_start_idx" ON "schedule_blocks" USING btree ("workspace_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subs_ws_uq" ON "subscriptions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_ws_status_due_idx" ON "tasks" USING btree ("workspace_id","status","due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_ws_client_idx" ON "tasks" USING btree ("workspace_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "threads_ext_uq" ON "threads_index" USING btree ("workspace_id","integration_account_id","external_thread_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_ws_day_idx" ON "time_entries" USING btree ("workspace_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "value_ws_type_idx" ON "value_events" USING btree ("workspace_id","type","created_at");