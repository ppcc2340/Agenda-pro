"use client";

import { clientApi } from "@/lib/client-api";
import { idempotencyKey, keys, useApiMutation } from "@/lib/hooks/use-api";
import type { Block, Task } from "@/lib/types";

/** Everything that changes the plan invalidates plan, tasks, audit and notifications. */
export const PLAN_INVALIDATE = [
  keys.plan,
  ["tasks"] as const,
  keys.audit,
  keys.notifications,
  ["events"] as const,
];

export function usePinBlock() {
  return useApiMutation(
    (vars: { id: string; pinned: boolean }) =>
      clientApi<Block>(`/v1/plan/blocks/${vars.id}/pin`, { method: "POST", json: { pinned: vars.pinned } }),
    PLAN_INVALIDATE,
  );
}

export function useCompleteBlock() {
  return useApiMutation(
    (vars: { id: string; taskDone: boolean }) =>
      clientApi<{ block: Block; task: Task | null }>(`/v1/plan/blocks/${vars.id}/complete`, {
        method: "POST",
        json: { taskDone: vars.taskDone },
      }),
    PLAN_INVALIDATE,
  );
}

export interface ReplanResult {
  outcome: "applied" | "proposed" | "noop" | "skipped" | "invalid";
  proposalId: string | null;
  applied: { added: number; removed: number } | null;
}

export function useReplan() {
  return useApiMutation(
    () => clientApi<ReplanResult>("/v1/plan/replan", { method: "POST", json: {} }),
    PLAN_INVALIDATE,
  );
}

export function useAcceptProposal() {
  return useApiMutation(
    (vars: { proposalId: string }) =>
      clientApi<{ planVersion: number; added: number; removed: number; auditId: string }>("/v1/plan/accept", {
        method: "POST",
        json: { proposalId: vars.proposalId },
        headers: { "idempotency-key": idempotencyKey() },
      }),
    [...PLAN_INVALIDATE, keys.proposals],
  );
}

export function useUndo() {
  return useApiMutation(
    (vars: { auditId: string }) =>
      clientApi<{ auditId: string; action: string }>(`/v1/audit/${vars.auditId}/undo`, {
        method: "POST",
        json: {},
      }),
    [...PLAN_INVALIDATE, keys.proposals],
  );
}
