import { ClientsScanJob, scanClients, type HandlerDeps } from "@meri/jobs";
import type { WorkspaceId } from "@meri/db";
import type { JobDefinition } from "../registry";

export function clientsScanJob(deps: Omit<HandlerDeps, "logger">): JobDefinition<typeof ClientsScanJob.schema> {
  return {
    name: ClientsScanJob.name,
    schema: ClientsScanJob.schema,
    concurrency: 2,
    attempts: 3,
    async handler(ctx) {
      const result = await scanClients({ ...deps, logger: ctx.log }, ctx.workspaceId as WorkspaceId);
      ctx.log.info({ ...result, date: ctx.payload.date }, "clients scanned");
    },
  };
}
