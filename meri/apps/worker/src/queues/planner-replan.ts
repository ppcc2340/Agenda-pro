import { PlannerReplanJob, runReplan, type HandlerDeps } from "@meri/jobs";
import type { WorkspaceId } from "@meri/db";
import type { JobDefinition } from "../registry";

export function plannerReplanJob(
  deps: Omit<HandlerDeps, "logger">,
): JobDefinition<typeof PlannerReplanJob.schema> {
  return {
    name: PlannerReplanJob.name,
    schema: PlannerReplanJob.schema,
    // One replan per workspace at a time; the planner is CPU-bound and deterministic.
    concurrency: 2,
    attempts: 3,
    async handler(ctx) {
      const result = await runReplan({ ...deps, logger: ctx.log }, ctx.workspaceId as WorkspaceId, {
        reason: ctx.payload.reason,
      });
      ctx.log.info({ ...result, reason: ctx.payload.reason }, "replan finished");
    },
  };
}
