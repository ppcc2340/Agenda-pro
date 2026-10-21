import { NotifyEmailJob, runNotifyEmail, type NotifyEmailDeps } from "@meri/jobs";
import type { WorkspaceId } from "@meri/db";
import type { JobDefinition } from "../registry";

/** D-115: one email copy per notification; transient SMTP errors retry with backoff, permanent ones are recorded. */
export function notifyEmailJob(
  deps: Omit<NotifyEmailDeps, "logger">,
): JobDefinition<typeof NotifyEmailJob.schema> {
  return {
    name: NotifyEmailJob.name,
    schema: NotifyEmailJob.schema,
    concurrency: 4,
    attempts: 5,
    async handler(ctx) {
      const result = await runNotifyEmail({ ...deps, logger: ctx.log }, ctx.workspaceId as WorkspaceId, {
        notificationId: ctx.payload.notificationId,
      });
      ctx.log.info({ ...result, notificationId: ctx.payload.notificationId }, "email copy finished");
    },
  };
}
