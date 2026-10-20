import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AccountDeletedError, IdentityMismatchError, TRIAL_DAYS, bootstrapAccount, type Db } from "@meri/db";
import type { Analytics } from "@meri/integrations";
import { track } from "@meri/jobs";
import { ApiError } from "../errors";
import { requireInternalSecret } from "../plugins/internal";

export const BootstrapBody = z.object({
  email: z.string().email().max(320),
  /** Provider identity: `google:<sub>` (verified email only) or `dev:<email>` in development (ADR 0007). */
  subject: z.string().regex(/^(google|dev):\S{1,320}$/),
  name: z.string().max(200).nullable().optional(),
  image: z.string().url().max(2000).nullable().optional(),
  locale: z.enum(["es", "en"]).optional(),
});

/** ADR 0001: called by apps/web on every sign-in. Idempotent. Hidden from OpenAPI. */
export function internalRoutes(
  app: FastifyInstance,
  options: { db: Db; secret: string; now: () => Date; analytics: Analytics },
  done: () => void,
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post(
    "/internal/auth/bootstrap",
    {
      onRequest: requireInternalSecret(options.secret),
      // Exempt from the global per-IP bucket (one web server serves every login) but limited per email once the
      // body is parsed (preHandler): a stolen internal secret cannot hammer one account (ADR 0007).
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
          hook: "preHandler",
          allowList: () => false,
          keyGenerator: (request) => {
            const body = request.body as { email?: unknown } | undefined;
            return `bootstrap:${typeof body?.email === "string" ? body.email.trim().toLowerCase() : request.ip}`;
          },
        },
      },
      schema: {
        hide: true,
        body: BootstrapBody,
        response: {
          200: z.object({
            userId: z.string(),
            workspaceId: z.string(),
            email: z.string(),
            name: z.string().nullable(),
            locale: z.string(),
            created: z.boolean(),
          }),
        },
      },
    },
    async (request) => {
      const account = await bootstrapAccount(options.db, { ...request.body, now: options.now() }).catch(
        (err: unknown) => {
          // D-054: a logically deleted account cannot sign in again until the purge job removes it.
          if (err instanceof AccountDeletedError)
            throw new ApiError("CONFLICT", "This account was deleted and is pending purge.");
          // A recycled address (same email, another provider identity) never inherits the old account.
          if (err instanceof IdentityMismatchError)
            throw new ApiError("CONFLICT", "This email belongs to another sign-in identity.");
          throw err;
        },
      );
      if (account.created) {
        track(options.analytics, "signup", account.workspaceId, {});
        track(options.analytics, "trial_started", account.workspaceId, { trialDays: TRIAL_DAYS });
      }
      return account;
    },
  );
  done();
}
