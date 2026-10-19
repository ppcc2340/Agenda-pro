import {
  ExtractCommitmentsJob,
  GmailSyncJob,
  syncMailAccount,
  type HandlerDeps,
  type JobDispatcher,
} from "@meri/jobs";
import type { WorkspaceId } from "@meri/db";
import type { JobDefinition } from "../registry";

export function gmailSyncJob(
  deps: Omit<HandlerDeps, "logger">,
  dispatcher: JobDispatcher,
): JobDefinition<typeof GmailSyncJob.schema> {
  return {
    name: GmailSyncJob.name,
    schema: GmailSyncJob.schema,
    // Gmail quotas are per user: one sync per account at a time (docs/12 §5).
    concurrency: 2,
    attempts: 5,
    async handler(ctx) {
      const result = await syncMailAccount(
        { ...deps, logger: ctx.log },
        ctx.workspaceId as WorkspaceId,
        ctx.payload.integrationAccountId,
      );
      ctx.log.info(
        {
          status: result.status,
          seen: result.seen,
          discarded: result.discarded,
          changed: result.changed.length,
          reason: ctx.payload.reason,
        },
        "mail synced",
      );
      // One extraction job per changed thread, deduplicated by thread + newest message (ADR 0004 §3).
      for (const t of result.changed) {
        await dispatcher.enqueue(
          ExtractCommitmentsJob,
          {
            workspaceId: ctx.workspaceId,
            traceId: ctx.traceId,
            threadId: t.threadId,
            messageIds: t.messageIds,
          },
          { jobId: `extract:${t.threadId}:${t.messageIds[t.messageIds.length - 1] ?? ""}` },
        );
      }
    },
  };
}
