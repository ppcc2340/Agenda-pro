import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getIntegrationAccount } from "@meri/db";
import { hasGmailScopes } from "@meri/integrations";
import { GmailSyncJob, type JobDispatcher } from "@meri/jobs";
import { ApiError } from "../errors";
import { requireSession, sessionOf } from "../plugins/session";

const IdParams = z.object({ id: z.string().uuid() });

export interface MailRoutesOptions {
  now: () => Date;
  dispatcher: JobDispatcher;
  /** Shared Google push channel token (ADR 0004 §1: same secret as Calendar in the MVP). */
  channelToken: string;
}

const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/** Mail-specific integration routes (ADR 0004): manual sync and the Gmail push webhook. */
export function mailRoutes(app: FastifyInstance, options: MailRoutesOptions, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    "/v1/integrations/:id/mail/sync",
    {
      preHandler: requireSession,
      schema: {
        tags: ["integrations"],
        params: IdParams,
        response: { 202: z.object({ queued: z.boolean() }) },
      },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const current = await request.withWorkspace((tx) =>
        getIntegrationAccount(tx, session.workspaceId, request.params.id),
      );
      if (!current) throw new ApiError("NOT_FOUND", "Integration not found.");
      if (!hasGmailScopes(current.scopes))
        throw new ApiError("VALIDATION_FAILED", "This account has no Gmail scopes.");
      await options.dispatcher.enqueue(
        GmailSyncJob,
        {
          workspaceId: session.workspaceId,
          traceId: request.id,
          integrationAccountId: current.id,
          reason: "manual",
        },
        { jobId: `gmail.sync_${current.id}_manual_${String(Math.floor(Date.now() / 5_000))}` },
      );
      return reply.status(202).send({ queued: true });
    },
  );

  /** Gmail push (Pub/Sub) lands here in `live`; the fake flow relies on polling. Token-verified, no body trusted. */
  r.post(
    "/webhooks/google/gmail",
    {
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
      schema: { tags: ["webhooks"], hide: true, response: { 204: z.null() } },
    },
    async (request, reply) => {
      const token = request.headers["x-goog-channel-token"];
      const channelId = request.headers["x-goog-channel-id"];
      if (typeof token !== "string" || !safeEqual(token, options.channelToken))
        throw new ApiError("FORBIDDEN", "Invalid channel token.");
      const [workspaceId, accountId] = typeof channelId === "string" ? channelId.split(":") : [];
      const parsed = z
        .object({ workspaceId: z.string().uuid(), accountId: z.string().uuid() })
        .safeParse({ workspaceId, accountId });
      if (parsed.success) {
        await options.dispatcher.enqueue(
          GmailSyncJob,
          {
            workspaceId: parsed.data.workspaceId,
            traceId: request.id,
            integrationAccountId: parsed.data.accountId,
            reason: "webhook",
          },
          { jobId: `gmail.sync_${parsed.data.accountId}_webhook_${String(Math.floor(Date.now() / 15_000))}` },
        );
      }
      return reply.status(204).send(null);
    },
  );
  done();
}
