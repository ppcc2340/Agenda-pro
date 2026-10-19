import { FollowupsScanJob, scanFollowups, type HandlerDeps } from "@meri/jobs";
import type { WorkspaceId } from "@meri/db";
import type { JobDefinition } from "../registry";

export function followupsScanJob(
  deps: Omit<HandlerDeps, "logger">,
): JobDefinition<typeof FollowupsScanJob.schema> {
  return {
    name: FollowupsScanJob.name,
    schema: FollowupsScanJob.schema,
    concurrency: 2,
    attempts: 3,
    async handler(ctx) {
      const result = await scanFollowups({ ...deps, logger: ctx.log }, ctx.workspaceId as WorkspaceId);
      ctx.log.info({ ...result, date: ctx.payload.date }, "followups scanned");
    },
  };
}
