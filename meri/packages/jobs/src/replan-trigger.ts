import type { JobDispatcher } from "./dispatcher";
import { PlannerReplanJob, type PlannerReplanPayload } from "./definitions";

/** Debounce window: changes within the same window collapse into one replan (jobId dedup in BullMQ). */
export const REPLAN_DEBOUNCE_MS = 3_000;

/**
 * Enqueues a debounced `planner.replan` for a workspace. The jobId includes a time bucket so bursts of edits
 * yield a single run, while a job that already completed never blocks the next bucket.
 */
export function enqueueReplan(
  dispatcher: JobDispatcher,
  _now: () => Date,
  input: { workspaceId: string; traceId: string; reason: PlannerReplanPayload["reason"] },
): Promise<{ id: string }> {
  // Wall clock on purpose: the injected clock (DEMO_NOW) is frozen in demos and would collapse every replan
  // into one deduplicated job id.
  const bucket = Math.floor(Date.now() / REPLAN_DEBOUNCE_MS);
  return dispatcher.enqueue(
    PlannerReplanJob,
    { workspaceId: input.workspaceId, traceId: input.traceId, reason: input.reason },
    { jobId: `planner.replan:${input.workspaceId}:${String(bucket)}`, delay: REPLAN_DEBOUNCE_MS },
  );
}
