/**
 * One-click email unsubscribe (D-116, RFC 8058). Mail servers POST here from the `List-Unsubscribe` header without
 * a cookie, an Origin or our CSRF header: the signed token is the only authorization, and the action can only reduce
 * what we send. The answer is the same whether or not the workspace was already unsubscribed. A GET never
 * unsubscribes (link scanners open URLs); the web page `/correo/baja` asks for a click and calls this route.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { verifyUnsubscribeToken } from "@meri/config/crypto";
import {
  audit,
  getPreferences,
  updatePreferences,
  withWorkspace,
  workspaceEmailRecipient,
  type Db,
  type UserId,
  type WorkspaceId,
} from "@meri/db";
import { ApiError } from "../errors";

export function emailRoutes(
  app: FastifyInstance,
  options: { db: Db; now: () => Date; authSecret: string },
  done: () => void,
): void {
  // RFC 8058 bodies are `List-Unsubscribe=One-Click`, form-encoded or multipart. Nothing in them matters.
  app.addContentTypeParser(
    ["application/x-www-form-urlencoded", "multipart/form-data"],
    { parseAs: "string", bodyLimit: 1024 },
    (_request, _body, parsed) => {
      parsed(null, {});
    },
  );
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post(
    "/v1/email/unsubscribe",
    {
      config: { public: true, signedToken: true, rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: {
        tags: ["notifications"],
        querystring: z.object({ t: z.string().min(1).max(200) }),
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    async (request) => {
      const workspaceId = verifyUnsubscribeToken(options.authSecret, request.query.t);
      if (!workspaceId) throw new ApiError("VALIDATION_FAILED", "This unsubscribe link is not valid.");
      const ws = workspaceId as WorkspaceId;
      const now = options.now();
      await withWorkspace(options.db, ws, async (tx) => {
        const before = await getPreferences(tx, ws);
        if (!before || before.emailNotifications === "off") return;
        await updatePreferences(tx, ws, { emailNotifications: "off" }, { now });
        const owner = await workspaceEmailRecipient(tx, ws);
        await audit(
          tx,
          { workspaceId: ws, actor: "user", actorUserId: (owner?.userId ?? null) as UserId | null },
          {
            action: "notifications.email_unsubscribed",
            entityType: "preferences",
            before: { emailNotifications: before.emailNotifications },
            after: { emailNotifications: "off" },
          },
        );
      });
      return { ok: true as const };
    },
  );
  done();
}
