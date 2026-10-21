CREATE UNIQUE INDEX "survey_one_answer_uq" ON "survey_responses" USING btree ("workspace_id","kind") WHERE "survey_responses"."answer" is not null;--> statement-breakpoint
-- meri:destructive-approved phase 6 close review: drops the unused SECURITY DEFINER is_invited() and narrows grants.
-- Existing paid subscriptions were billed at the published prices: fix their cohort to A so the price experiment can
-- never re-price them (review M4).
UPDATE subscriptions SET price_cohort = 'A' WHERE price_cohort IS NULL AND stripe_subscription_id IS NOT NULL;--> statement-breakpoint
-- Nothing calls is_invited() (the bootstrap uses consume_beta_email): one less lookup the app role could make.
DROP FUNCTION IF EXISTS is_invited(text);--> statement-breakpoint
-- The waitlist retention runs from the worker's owner connection: the app role does not need it.
REVOKE EXECUTE ON FUNCTION prune_waitlist() FROM meri_app;
