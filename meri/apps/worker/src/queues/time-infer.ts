import { TimeInferJob, inferTime, type HandlerDeps } from "@meri/jobs";
import type { WorkspaceId } from "@meri/db";
import type { JobDefinition } from "../registry";

export function timeInferJob(deps: Omit<HandlerDeps, "logger">): JobDefinition<typeof TimeInferJob.schema> {
  return {
    name: TimeInferJob.name,
    schema: TimeInferJob.schema,
    concurrency: 2,
    attempts: 3,
    async handler(ctx) {
      const result = await inferTime({ ...deps, logger: ctx.log }, ctx.workspaceId as WorkspaceId);
      ctx.log.info({ ...result, reason: ctx.payload.reason }, "time inferred");
    },
  };
}
