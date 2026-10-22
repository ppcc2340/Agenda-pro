import { createLogger, createObservability, observabilityOptions, type ErrorTracker } from "@meri/config";
import { getServerConfig } from "./config";

let tracker: ErrorTracker | null = null;

/** The web server's tracker (D-118), built on first use so `next build` never evaluates the configuration. */
function webErrors(): ErrorTracker {
  if (!tracker) {
    const config = getServerConfig();
    const logger = createLogger({ name: "web", level: config.env.LOG_LEVEL });
    tracker = createObservability(observabilityOptions(config, "web", logger)).errors;
  }
  return tracker;
}

export interface RequestErrorInfo {
  method: string;
  routePath: string;
  routeType: string;
}

/**
 * Reports a server render, route handler, action or middleware error. Only the route template, the method and
 * Next's digest leave the process: never the URL (it may carry a query), headers or cookies.
 */
export function reportRequestError(
  error: unknown,
  info: RequestErrorInfo,
  errors: () => ErrorTracker = webErrors,
): void {
  const digest =
    typeof error === "object" && error !== null && "digest" in error && typeof error.digest === "string"
      ? error.digest
      : undefined;
  errors().captureException(error, {
    source: `next.${info.routeType}`,
    route: info.routePath,
    method: info.method,
    ...(digest ? { digest } : {}),
  });
}
