import { CalendarSyncJob, syncCalendarAccount, type HandlerDeps } from "@meri/jobs";
import type { WorkspaceId } from "@meri/db";
import type { JobDefinition } from "../registry";

export function calendarSyncJob(
  deps: Omit<HandlerDeps, "logger">,
): JobDefinition<typeof CalendarSyncJob.schema> {
  return {
    name: CalendarSyncJob.name,
    schema: CalendarSyncJob.schema,
    // One account at a time per worker keeps Google quotas safe (docs/12 §5).
    concurrency: 2,
    attempts: 5,
    async handler(ctx) {
      const result = await syncCalendarAccount(
        { ...deps, logger: ctx.log },
        ctx.workspaceId as WorkspaceId,
        ctx.payload.integrationAccountId,
      );
      ctx.log.info({ ...result, reason: ctx.payload.reason }, "calendar synced");
    },
  };
}
