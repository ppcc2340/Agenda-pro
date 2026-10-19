import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { pingDb, type Db } from "@meri/db";

export function healthRoutes(app: FastifyInstance, options: { db: Db }, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get("/health", { schema: { tags: ["system"], response: { 200: z.object({ status: z.literal("ok") }) } } }, () => ({ status: "ok" as const }));
  r.get(
    "/ready",
    { schema: { tags: ["system"], response: { 200: z.object({ status: z.literal("ready"), db: z.literal("ok") }), 503: z.object({ status: z.literal("not_ready"), db: z.string() }) } } },
    async (_request, reply) => {
      try {
        await pingDb(options.db);
        return { status: "ready" as const, db: "ok" as const };
      } catch (err) {
        app.log.warn({ err }, "readiness: database unreachable");
        return reply.status(503).send({ status: "not_ready" as const, db: "unreachable" });
      }
    },
  );
  done();
}
