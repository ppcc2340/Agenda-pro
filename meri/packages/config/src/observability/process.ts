import type { ErrorTracker } from "./types";

/** Longest a crashed process keeps running to deliver its report. */
export const FATAL_FLUSH_MS = 2_000;

/**
 * Reports a crash before the process dies (D-118). Node's default for both events is to exit; this keeps that
 * (the orchestrator restarts the container) and only adds the report. The process is in an undefined state while
 * it flushes, so the wait is short.
 */
export function reportFatalErrors(
  errors: ErrorTracker,
  exit: (code: number) => void = (code) => process.exit(code),
  proc: Pick<NodeJS.Process, "on" | "off"> = process,
): () => void {
  let exiting = false;
  const fatal = (source: "uncaughtException" | "unhandledRejection") => (error: unknown) => {
    // The tracker logs it at fatal level too, so the crash is in the logs even when Sentry is off.
    errors.captureException(error, { source }, { fatal: true });
    if (exiting) return;
    exiting = true;
    void errors.flush(FATAL_FLUSH_MS).finally(() => {
      exit(1);
    });
  };
  const onException = fatal("uncaughtException");
  const onRejection = fatal("unhandledRejection");
  proc.on("uncaughtException", onException);
  proc.on("unhandledRejection", onRejection);
  return () => {
    proc.off("uncaughtException", onException);
    proc.off("unhandledRejection", onRejection);
  };
}
