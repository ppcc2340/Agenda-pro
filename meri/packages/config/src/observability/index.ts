import type { Logger } from "../logger";

/**
 * Observability wrappers (P0-10, docs/12 §9). Without keys everything is a no-op; with keys the live SDKs are
 * loaded lazily so the dependency only matters when ANALYTICS_MODE=live (docs/blockers/observability.md).
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
  logger: Logger;
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
  const sentry = Boolean(options.sentryDsn);
  const otel = Boolean(options.otelEndpoint);
  if (sentry || otel) {
    // Live SDK wiring (Sentry / OpenTelemetry exporters) is connected with the observability blocker (phase 4+).
    options.logger.warn(
      { sentry, otel },
      "observability keys present but live SDKs are wired in a later phase; using logger-backed tracker",
    );
  }
  return {
    errors: loggerErrorTracker(options.logger),
    tracer: noopTracer,
    enabled: { sentry, otel },
    shutdown: () => Promise.resolve(),
  };
}
