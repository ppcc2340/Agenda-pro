import { BillingUsageRollupJob, runUsageRollup, type HandlerDeps } from "@meri/jobs";
import type { WorkspaceId } from "@meri/db";
import type { JobDefinition } from "../registry";

export function billingUsageRollupJob(
  deps: Omit<HandlerDeps, "logger"> & { infraCostUsdPerUser: number },
): JobDefinition<typeof BillingUsageRollupJob.schema> {
  return {
    name: BillingUsageRollupJob.name,
    schema: BillingUsageRollupJob.schema,
    concurrency: 2,
    attempts: 3,
    async handler(ctx) {
      const result = await runUsageRollup(
        { ...deps, logger: ctx.log },
        ctx.workspaceId as WorkspaceId,
        ctx.payload.period,
      );
      ctx.log.info({ ...result }, "usage rollup computed");
    },
  };
}
