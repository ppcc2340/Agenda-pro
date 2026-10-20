import { DailyCloseJob, runDailyClose, type HandlerDeps } from "@meri/jobs";
import type { WorkspaceId } from "@meri/db";
import type { JobDefinition } from "../registry";

export function dailyCloseJob(deps: Omit<HandlerDeps, "logger">): JobDefinition<typeof DailyCloseJob.schema> {
  return {
    name: DailyCloseJob.name,
    schema: DailyCloseJob.schema,
    concurrency: 2,
    attempts: 3,
    async handler(ctx) {
      const result = await runDailyClose(
        { ...deps, logger: ctx.log },
        ctx.workspaceId as WorkspaceId,
        ctx.payload,
      );
      ctx.log.info({ ...result, date: ctx.payload.date }, "daily close");
    },
  };
}
