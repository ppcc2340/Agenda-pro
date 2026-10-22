import type { Logger } from "../logger";
import type { ErrorTracker } from "./index";

/**
 * Reports a crash before the process dies (D-118). Node's default for both events is to exit; this keeps that
 * (the orchestrator restarts the container) and only adds the report, flushed with a bound.
 */
export function reportFatalErrors(
  errors: ErrorTracker,
  logger: Logger,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  let exiting = false;
  const fatal = (source: "uncaughtException" | "unhandledRejection") => (error: unknown) => {
    logger.fatal({ err: error, source }, "process crashed");
    errors.captureException(error, { source });
    if (exiting) return;
    exiting = true;
    void errors.flush().finally(() => {
      exit(1);
    });
  };
  const onException = fatal("uncaughtException");
  const onRejection = fatal("unhandledRejection");
  process.on("uncaughtException", onException);
  process.on("unhandledRejection", onRejection);
  return () => {
    process.off("uncaughtException", onException);
    process.off("unhandledRejection", onRejection);
  };
}
