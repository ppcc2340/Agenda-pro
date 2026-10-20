import { DataDeleteAccountJob, purgeDeletedAccount, type HandlerDeps } from "@meri/jobs";
import type { WorkspaceId } from "@meri/db";
import type { JobDefinition } from "../registry";

/** F-16 / ADR 0007: one purge per job; retries and the DLQ follow the standard options (docs/12 §5). */
export function dataDeleteAccountJob(deps: Omit<HandlerDeps, "logger">): JobDefinition<typeof DataDeleteAccountJob.schema> {
  return {
    name: DataDeleteAccountJob.name,
    schema: DataDeleteAccountJob.schema,
    concurrency: 1,
    attempts: 5,
    async handler(ctx) {
      const result = await purgeDeletedAccount({ ...deps, logger: ctx.log }, ctx.workspaceId as WorkspaceId);
      ctx.log.info({ ...result }, "account purge job done");
    },
  };
}
