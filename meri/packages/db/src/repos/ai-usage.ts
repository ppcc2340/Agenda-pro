import { and, eq, sql } from "drizzle-orm";
import { CREDIT_COSTS, creditOperationOf } from "@meri/core";
import { aiUsage } from "../schema";
import type { WorkspaceTx } from "../workspace";
import { newId, type WorkspaceId } from "../ids";

export interface UsageInput {
  operation: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costMicroUsd: number;
  /**
   * Credits charged for this call. Defaults to the catalogue cost of the operation (D-061); pass 0 for the extra
   * calls of one operation unit so a unit is charged once ([H3]).
   */
  credits?: number;
}

export const periodOf = (date: Date): string => date.toISOString().slice(0, 7);

/** Catalogue credits of one call of a request operation (unknown operations cost nothing). */
export function creditsFor(requestOperation: string): number {
  const op = creditOperationOf(requestOperation);
  return op ? CREDIT_COSTS[op] : 0;
}

/** docs/05 §5: every AI call is measured (tokens + cost) per workspace and month. */
export async function recordAiUsage(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: UsageInput,
  now: Date,
): Promise<void> {
  await tx.insert(aiUsage).values({
    id: newId(),
    workspaceId,
    operation: input.operation,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cachedTokens: input.cachedTokens,
    costMicroUsd: input.costMicroUsd,
    credits: input.credits ?? creditsFor(input.operation),
    period: periodOf(now),
    createdAt: now,
  });
}

export async function monthlyAiCostMicroUsd(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  period: string,
): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${aiUsage.costMicroUsd}), 0)::bigint` })
    .from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), eq(aiUsage.period, period)));
  return Number(row?.total ?? 0);
}
