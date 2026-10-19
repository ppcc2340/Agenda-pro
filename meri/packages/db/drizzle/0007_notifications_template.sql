ALTER TABLE "notifications" ADD COLUMN "template" text DEFAULT 'generic' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "params" jsonb DEFAULT '{}'::jsonb NOT NULL;