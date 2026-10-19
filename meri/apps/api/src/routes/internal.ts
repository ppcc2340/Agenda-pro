import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { AccountDeletedError, bootstrapAccount, type Db } from "@meri/db";
import { ApiError } from "../errors";
import { requireInternalSecret } from "../plugins/internal";

export const BootstrapBody = z.object({
  email: z.string().email().max(320),
  name: z.string().max(200).nullable().optional(),
  image: z.string().url().max(2000).nullable().optional(),
  locale: z.enum(["es", "en"]).optional(),
});

/** ADR 0001: called by apps/web on every sign-in. Idempotent. Hidden from OpenAPI. */
export function internalRoutes(
  app: FastifyInstance,
  options: { db: Db; secret: string; now: () => Date },
  done: () => void,
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post(
    "/internal/auth/bootstrap",
    {
      onRequest: requireInternalSecret(options.secret),
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
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
    (request) =>
      bootstrapAccount(options.db, { ...request.body, now: options.now() }).catch((err: unknown) => {
        // D-054: a logically deleted account cannot sign in again until the purge job removes it.
        if (err instanceof AccountDeletedError)
          throw new ApiError("CONFLICT", "This account was deleted and is pending purge.");
        throw err;
      }),
  );
  done();
}
