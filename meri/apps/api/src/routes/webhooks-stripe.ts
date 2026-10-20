/**
 * POST /webhooks/stripe (D-060, [H1]): no session, no CSRF (no cookie), raw body for the `t=…,v1=` signature.
 * Registered as its own encapsulated plugin so the raw-string parser never applies to any other route.
 * 400 bad signature or body; 200 for every verified event (applied, duplicate or ignored); 5xx on transient errors
 * so the provider retries.
 */
import type { FastifyInstance } from "fastify";
import type { Logger } from "@meri/config";
import type { Db } from "@meri/db";
import { IntegrationError, type Analytics, type BillingProvider } from "@meri/integrations";
import { processBillingEvent } from "@meri/jobs";
import { ApiError } from "../errors";

export const STRIPE_WEBHOOK_BODY_LIMIT = 64 * 1024;

export interface StripeWebhookOptions {
  db: Db;
  billing: BillingProvider;
  analytics: Analytics;
  logger: Logger;
  now: () => Date;
}

export function stripeWebhookRoutes(
  app: FastifyInstance,
  options: StripeWebhookOptions,
  done: () => void,
): void {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "string", bodyLimit: STRIPE_WEBHOOK_BODY_LIMIT },
    (_req, body, next) => {
      next(null, body);
    },
  );

  app.post(
    "/webhooks/stripe",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } }, schema: { hide: true } },
    async (request, reply) => {
      const signature = request.headers["stripe-signature"];
      const rawBody = typeof request.body === "string" ? request.body : "";
      if (typeof signature !== "string" || rawBody === "")
        throw new ApiError("VALIDATION_FAILED", "Missing signature or body.");
      let event;
      try {
        event = await options.billing.parseWebhook(rawBody, signature);
      } catch (err) {
        if (err instanceof IntegrationError || err instanceof SyntaxError) {
          request.log.warn({ reason: err.message }, "stripe webhook rejected");
          throw new ApiError("VALIDATION_FAILED", "Invalid webhook signature or payload.");
        }
        throw err;
      }
      const outcome = await processBillingEvent(
        {
          db: options.db,
          billing: options.billing,
          analytics: options.analytics,
          logger: options.logger,
          now: options.now,
        },
        event,
      );
      return reply.status(200).send({ received: true, status: outcome.status });
    },
  );
  done();
}
