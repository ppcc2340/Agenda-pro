import { TimeInferJob, type TimeInferPayload } from "./definitions";
import type { JobDispatcher } from "./dispatcher";

/** Collapses bursts (a calendar sync, several completed blocks) into one inference per minute per workspace. */
export const TIME_INFER_DEBOUNCE_MS = 60_000;

export function enqueueTimeInfer(
  dispatcher: JobDispatcher,
  input: { workspaceId: string; traceId: string; reason: TimeInferPayload["reason"] },
): Promise<{ id: string }> {
  // Wall clock on purpose (same reasoning as the replan trigger: the injected clock may be frozen).
  const bucket = Math.floor(Date.now() / TIME_INFER_DEBOUNCE_MS);
  return dispatcher.enqueue(
    TimeInferJob,
    { workspaceId: input.workspaceId, traceId: input.traceId, reason: input.reason },
    { jobId: `time.infer_${input.workspaceId}_${String(bucket)}`, delay: 2_000 },
  );
}
