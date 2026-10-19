CREATE TYPE "public"."mail_exclusion_kind" AS ENUM('sender', 'domain', 'label');--> statement-breakpoint
CREATE TABLE "mail_exclusions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "mail_exclusion_kind" NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "followups_muted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "gmail_autoconfirm" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "followup_days" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "retention_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_exclusions" ADD CONSTRAINT "mail_exclusions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mail_exclusions_uq" ON "mail_exclusions" USING btree ("workspace_id","kind","value");