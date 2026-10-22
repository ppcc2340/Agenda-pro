import type { AppConfig } from "../load";
import type { Logger } from "../logger";
import { createSentryErrorTracker, parseSentryDsn } from "./sentry";

export { reportFatalErrors } from "./process";
export {
  createSentryErrorTracker,
  parseSentryDsn,
  parseStack,
  scrubText,
  SENTRY_CONTEXT_ALLOWLIST,
  type SentryDsn,
  type SentryErrorTracker,
  type SentryTrackerOptions,
} from "./sentry";

/**
 * Observability wrappers (P0-10, docs/12 §9). Without a DSN errors go to the logs only; with one they also go to
 * Sentry through the envelope endpoint (D-118, docs/blockers/observability.md). Tracing stays a no-op (debt).
 */
export interface ErrorTracker {
  captureException(error: unknown, context?: Record<string, unknown>): void;
  flush(): Promise<void>;
}

export interface Tracer {
  /** Wraps an async operation in a span; attributes must never contain personal data. */
  span<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: () => Promise<T>,
  ): Promise<T>;
}

export interface Observability {
  errors: ErrorTracker;
  tracer: Tracer;
  enabled: { sentry: boolean; otel: boolean };
  shutdown(): Promise<void>;
}

export interface ObservabilityOptions {
  service: string;
  sentryDsn?: string | undefined;
  otelEndpoint?: string | undefined;
  /** Sentry `environment` (APP_ENV, else NODE_ENV). */
  environment?: string | undefined;
  /** Sentry `release`, e.g. the image's git sha. */
  release?: string | undefined;
  logger: Logger;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

export const noopErrorTracker: ErrorTracker = { captureException: () => {}, flush: () => Promise.resolve() };
export const noopTracer: Tracer = { span: (_name, _attributes, fn) => fn() };

/** Logger-backed tracker used in dev/test: errors are visible in logs with the trace context. */
export function loggerErrorTracker(logger: Logger): ErrorTracker {
  return {
    captureException: (error, context) => {
      logger.error({ err: error, ...context }, "captured exception");
    },
    flush: () => Promise.resolve(),
  };
}

export function createObservability(options: ObservabilityOptions): Observability {
  const otel = Boolean(options.otelEndpoint);
  if (otel)
    options.logger.warn(
      "OTEL_EXPORTER_OTLP_ENDPOINT is set but tracing export is not wired yet (debt, D-118)",
    );
  const dsn = options.sentryDsn ? parseSentryDsn(options.sentryDsn) : null;
  // resolveModes rejects a malformed DSN at startup; this guard keeps a direct caller from failing open silently.
  if (options.sentryDsn && !dsn) options.logger.error("SENTRY_DSN is malformed; errors go to the logs only");
  const errors = dsn
    ? createSentryErrorTracker({
        dsn,
        service: options.service,
        environment: options.environment ?? "development",
        release: options.release,
        logger: options.logger,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })
    : loggerErrorTracker(options.logger);
  return {
    errors,
    tracer: noopTracer,
    enabled: { sentry: dsn !== null, otel },
    shutdown: () => errors.flush(),
  };
}

/**
 * The options every service builds from its configuration. Sentry is on only with ANALYTICS_MODE=live, the
 * switch of the observability blocker, so a DSN copied into a dev `.env` never reports local errors.
 */
export function observabilityOptions(
  config: AppConfig,
  service: string,
  logger: Logger,
): ObservabilityOptions {
  const live = config.modes.analytics === "live";
  return {
    service,
    logger,
    sentryDsn: live ? config.env.SENTRY_DSN : undefined,
    otelEndpoint: config.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    environment: config.env.APP_ENV ?? config.env.NODE_ENV,
    release: config.env.SENTRY_RELEASE,
  };
}
