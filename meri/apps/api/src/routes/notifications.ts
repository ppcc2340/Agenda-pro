import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { listNotifications, markNotificationRead, type NotificationView } from "@meri/db";
import { ApiError } from "../errors";
import { requireSession, sessionOf } from "../plugins/session";
import { boolParam } from "./tasks";

const NotificationJson = z.object({
  id: z.string(),
  kind: z.enum(["digest", "risk", "proposals", "plan", "integration"]),
  title: z.string(),
  body: z.string(),
  template: z.string(),
  params: z.record(z.union([z.string(), z.number()])),
  refs: z.array(z.object({ type: z.string(), id: z.string() })),
  day: z.string(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
const serialize = (n: NotificationView) => ({
  ...n,
  readAt: n.readAt ? n.readAt.toISOString() : null,
  createdAt: n.createdAt.toISOString(),
});

/** In-app notification inbox (F-13 AC2: grouped, capped per day). */
export function notificationRoutes(
  app: FastifyInstance,
  options: { now: () => Date },
  done: () => void,
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    "/v1/notifications",
    {
      preHandler: requireSession,
      schema: {
        tags: ["control"],
        querystring: z.object({
          cursor: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
          unreadOnly: boolParam,
        }),
        response: { 200: z.object({ items: z.array(NotificationJson), nextCursor: z.string().nullable() }) },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const page = await request.withWorkspace((tx) =>
        listNotifications(tx, session.workspaceId, {
          limit: request.query.limit,
          cursor: request.query.cursor,
          unreadOnly: request.query.unreadOnly,
        }),
      );
      return { items: page.items.map(serialize), nextCursor: page.nextCursor };
    },
  );
  r.post(
    "/v1/notifications/:id/read",
    {
      preHandler: requireSession,
      schema: {
        tags: ["control"],
        params: z.object({ id: z.string().uuid() }),
        response: { 200: NotificationJson },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const n = await request.withWorkspace((tx) =>
        markNotificationRead(tx, session.workspaceId, request.params.id, options.now()),
      );
      if (!n) throw new ApiError("NOT_FOUND", "Notification not found.");
      return serialize(n);
    },
  );
  done();
}
