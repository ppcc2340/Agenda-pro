import { DataRetentionJob, applyMailRetention, type HandlerDeps } from "@meri/jobs";
import type { WorkspaceId } from "@meri/db";
import type { JobDefinition } from "../registry";

export function dataRetentionJob(
  deps: Omit<HandlerDeps, "logger"> & { maxRetentionDays: number },
): JobDefinition<typeof DataRetentionJob.schema> {
  return {
    name: DataRetentionJob.name,
    schema: DataRetentionJob.schema,
    concurrency: 1,
    attempts: 3,
    async handler(ctx) {
      const result = await applyMailRetention({ ...deps, logger: ctx.log }, ctx.workspaceId as WorkspaceId, {
        maxRetentionDays: deps.maxRetentionDays,
      });
      ctx.log.info({ ...result, date: ctx.payload.date }, "mail retention applied");
    },
  };
}
