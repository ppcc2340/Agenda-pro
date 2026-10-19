import { and, desc, eq } from "drizzle-orm";
import { planRuns } from "../schema";
import type { WorkspaceTx } from "../workspace";
import { newId, type WorkspaceId } from "../ids";

export interface PlanRunView {
  id: string;
  planVersion: number;
  horizonStart: Date;
  horizonEnd: Date;
  risks: { taskId: string; slackHours: number; cause: string }[];
  conflicts: {
    code: string;
    taskIds: string[];
    details: Record<string, string | number>;
    alternatives: string[];
  }[];
  unscheduled: { taskId: string; reason: string }[];
  outcome: string;
  proposalId: string | null;
  createdAt: Date;
}

type Row = typeof planRuns.$inferSelect;
const toView = (r: Row): PlanRunView => {
  const { workspaceId: _ws, ...rest } = r;
  return rest;
};

export async function insertPlanRun(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: Omit<PlanRunView, "id" | "createdAt">,
  now: Date,
): Promise<PlanRunView> {
  const [row] = await tx
    .insert(planRuns)
    .values({ id: newId(), workspaceId, ...input, createdAt: now })
    .returning();
  if (!row) throw new Error("plan run insert returned no row");
  return toView(row);
}

export async function latestPlanRun(tx: WorkspaceTx, workspaceId: WorkspaceId): Promise<PlanRunView | null> {
  const row = await tx.query.planRuns.findFirst({
    where: and(eq(planRuns.workspaceId, workspaceId)),
    orderBy: [desc(planRuns.id)],
  });
  return row ? toView(row) : null;
}
