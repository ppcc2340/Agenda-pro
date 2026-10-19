/** `GET /v1/search?q=&clientId=` (ADR 0005, F-09 AC2): tasks, commitments and clients, scoped to a client on demand. */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { searchWorkspace } from "@meri/db";
import { requireSession, sessionOf } from "../plugins/session";

const HitJson = z.object({
  type: z.enum(["task", "commitment", "client"]),
  id: z.string(),
  title: z.string(),
  clientId: z.string().nullable(),
  status: z.string().nullable(),
  date: z.string().datetime().nullable(),
});

export function searchRoutes(app: FastifyInstance, _options: Record<string, never>, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    "/v1/search",
    {
      preHandler: requireSession,
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        tags: ["search"],
        querystring: z.object({ q: z.string().trim().min(2).max(100), clientId: z.string().uuid().optional() }),
        response: { 200: z.object({ items: z.array(HitJson) }) },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const hits = await request.withWorkspace((tx) =>
        searchWorkspace(tx, session.workspaceId, request.query.q, { clientId: request.query.clientId }),
      );
      return { items: hits.map((h) => ({ ...h, date: h.date ? h.date.toISOString() : null })) };
    },
  );
  done();
}
