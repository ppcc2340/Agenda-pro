/** Shared by the trackers and the crash reporter; kept apart from `index.ts` so none of them imports it back. */
export interface ErrorTracker {
  /** `fatal`: the process is about to exit; the report bypasses deduplication and the per-minute cap. */
  captureException(error: unknown, context?: Record<string, unknown>, options?: CaptureOptions): void;
  /** Waits for pending reports, at most `timeoutMs` (the tracker's own bound when omitted). */
  flush(timeoutMs?: number): Promise<void>;
}

export interface CaptureOptions {
  fatal?: boolean;
}
