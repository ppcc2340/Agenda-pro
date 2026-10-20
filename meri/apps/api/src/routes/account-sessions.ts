import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { revokeSessions, type Db } from "@meri/db";
import { requireSession, sessionOf } from "../plugins/session";

/**
 * «Sign out on all devices» (ADR 0007): every session authenticated before now is refused by the session guard,
 * the caller's included. Sessions are JWTs re-issued on each read, so the cut-off compares the sign-in instant
 * (`authTime`), never `iat`. Uses the wall clock, like `authTime` (DEMO_NOW only freezes the product clock).
 */
export function accountSessionRoutes(app: FastifyInstance, options: { db: Db }, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post(
    "/v1/account/sessions/revoke",
    {
      preHandler: requireSession,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: { tags: ["account"], response: { 204: z.null() } },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const at = new Date();
      await revokeSessions(options.db, { userId: session.userId, workspaceId: session.workspaceId }, at);
      app.accountGuard.markSessionsRevoked(session.userId, session.workspaceId, at);
      return reply.status(204).send(null);
    },
  );
  done();
}
