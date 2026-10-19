import { ExtractCommitmentsJob, extractThreadCommitments, type HandlerDeps } from "@meri/jobs";
import type { WorkspaceId } from "@meri/db";
import type { JobDefinition } from "../registry";

export function extractCommitmentsJob(
  deps: Omit<HandlerDeps, "logger"> & { costCapUsd: number },
): JobDefinition<typeof ExtractCommitmentsJob.schema> {
  return {
    name: ExtractCommitmentsJob.name,
    schema: ExtractCommitmentsJob.schema,
    concurrency: 3,
    attempts: 3,
    async handler(ctx) {
      const result = await extractThreadCommitments(
        { ...deps, logger: ctx.log },
        ctx.workspaceId as WorkspaceId,
        {
          threadId: ctx.payload.threadId,
          messageIds: ctx.payload.messageIds,
          costCapUsd: deps.costCapUsd,
        },
      );
      ctx.log.info({ ...result, threadId: ctx.payload.threadId }, "commitments extracted");
    },
  };
}
