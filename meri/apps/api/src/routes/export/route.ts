import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit, getMe, type Db } from "@meri/db";
import { ApiError } from "../../errors";
import { requireSession, sessionOf } from "../../plugins/session";
import { AccountExportV1, buildAccountExport } from "../account-export";
import { exportFiles, zipStore } from "./zip";

/**
 * F-16 export (D-050/D-055, ADR 0007): `json` is the `meri-export/1` document; `zip` adds one CSV per collection
 * next to it. Both are parsed through the AccountExportV1 schema (which drops any key it does not declare), sent as
 * an attachment, never cached, rate limited and audited with the format.
 */
export function accountExportRoutes(
  app: FastifyInstance,
  options: { db: Db; now: () => Date },
  done: () => void,
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get(
    "/v1/account/export",
    {
      preHandler: requireSession,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags: ["account"],
        querystring: z.object({ format: z.enum(["json", "zip"]).default("json") }),
        description: "JSON (meri-export/1) or ZIP (export.json + one CSV per collection).",
      },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const now = options.now();
      const me = await getMe(options.db, session.userId, session.workspaceId);
      if (!me) throw new ApiError("UNAUTHENTICATED", "This account no longer exists.");
      const format = request.query.format;
      const document = await request.withWorkspace(async (tx) => {
        const doc = AccountExportV1.parse(
          await buildAccountExport(tx, {
            workspaceId: session.workspaceId,
            now,
            me: { email: me.user.email, name: me.user.name, locale: me.user.locale },
            workspace: { name: me.workspace.name, vertical: me.workspace.vertical },
          }),
        );
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: "account.exported",
            entityType: "workspace",
            entityId: session.workspaceId,
            after: { format: doc.format, file: format, truncated: doc.truncated },
          },
        );
        return doc;
      });
      const day = now.toISOString().slice(0, 10);
      void reply.header("cache-control", "no-store");
      if (format === "zip") {
        void reply.header("content-disposition", `attachment; filename="meri-export-${day}.zip"`);
        return reply.type("application/zip").send(zipStore(exportFiles(document), now));
      }
      void reply.header("content-disposition", `attachment; filename="meri-export-${day}.json"`);
      return reply.type("application/json; charset=utf-8").send(JSON.stringify(document));
    },
  );
  done();
}
