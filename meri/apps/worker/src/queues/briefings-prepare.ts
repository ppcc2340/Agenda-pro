import { BriefingsPrepareJob, prepareBriefings, type HandlerDeps } from "@meri/jobs";
import type { WorkspaceId } from "@meri/db";
import type { JobDefinition } from "../registry";

export function briefingsPrepareJob(
  deps: Omit<HandlerDeps, "logger">,
): JobDefinition<typeof BriefingsPrepareJob.schema> {
  return {
    name: BriefingsPrepareJob.name,
    schema: BriefingsPrepareJob.schema,
    concurrency: 2,
    attempts: 3,
    async handler(ctx) {
      const result = await prepareBriefings({ ...deps, logger: ctx.log }, ctx.workspaceId as WorkspaceId);
      ctx.log.info({ ...result, date: ctx.payload.date }, "briefings prepared");
    },
  };
}
