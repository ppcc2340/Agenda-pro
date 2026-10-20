/** D-062 margin rollup per workspace and month: computed by `billing.usage_rollup`, read by `pnpm report:margins`. */
import { and, asc, eq, sql } from "drizzle-orm";
import { aiUsage, billingRollups } from "../schema";
import type { Db } from "../client";
import type { WorkspaceTx } from "../workspace";
import { newId, type WorkspaceId } from "../ids";

export interface RollupInput {
  period: string;
  plan: string;
  charged: boolean;
  creditsUsed: number;
  aiCostMicroUsd: number;
  revenueMicroUsd: number;
  infraCostMicroUsd: number;
  paymentFeeMicroUsd: number;
  grossMarginPct: number | null;
  marginAlarm: boolean;
}

export interface RollupRow extends RollupInput {
  workspaceId: string;
  computedAt: Date;
}

/** AI usage of a period in one pass (credits and real cost). */
export async function periodAiTotals(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  period: string,
): Promise<{ credits: number; costMicroUsd: number }> {
  const [row] = await tx
    .select({
      credits: sql<string>`coalesce(sum(${aiUsage.credits}), 0)`,
      cost: sql<string>`coalesce(sum(${aiUsage.costMicroUsd}), 0)::bigint`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), eq(aiUsage.period, period)));
  return { credits: Number(row?.credits ?? 0), costMicroUsd: Number(row?.cost ?? 0) };
}

/** Upsert: re-running the rollup for a period replaces its figures. */
export async function upsertRollup(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: RollupInput,
  now: Date,
): Promise<void> {
  await tx
    .insert(billingRollups)
    .values({ id: newId(), workspaceId, ...input, computedAt: now })
    .onConflictDoUpdate({
      target: [billingRollups.workspaceId, billingRollups.period],
      set: { ...input, computedAt: now },
    });
}

export async function getRollup(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  period: string,
): Promise<RollupRow | null> {
  const [row] = await tx
    .select()
    .from(billingRollups)
    .where(and(eq(billingRollups.workspaceId, workspaceId), eq(billingRollups.period, period)))
    .limit(1);
  if (!row) return null;
  const { id: _id, ...rest } = row;
  return rest;
}

/** Every workspace's rollup of a period. Needs the admin read context (D-037): operator report only. */
export async function listRollupsForPeriod(db: Db, period: string): Promise<RollupRow[]> {
  const rows = await db
    .select()
    .from(billingRollups)
    .where(eq(billingRollups.period, period))
    .orderBy(asc(billingRollups.workspaceId));
  return rows.map(({ id: _id, ...rest }) => rest);
}
