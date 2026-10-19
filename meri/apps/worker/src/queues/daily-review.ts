import { DailyReviewJob, runDailyReview, type HandlerDeps } from "@meri/jobs";
import type { WorkspaceId } from "@meri/db";
import type { JobDefinition } from "../registry";

export function dailyReviewJob(
  deps: Omit<HandlerDeps, "logger">,
): JobDefinition<typeof DailyReviewJob.schema> {
  return {
    name: DailyReviewJob.name,
    schema: DailyReviewJob.schema,
    concurrency: 4,
    attempts: 3,
    async handler(ctx) {
      const result = await runDailyReview({ ...deps, logger: ctx.log }, ctx.workspaceId as WorkspaceId, {
        date: ctx.payload.date,
      });
      ctx.log.info({ ...result, date: ctx.payload.date }, "daily review finished");
    },
  };
}
