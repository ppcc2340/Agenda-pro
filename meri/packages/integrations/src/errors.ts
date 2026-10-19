/** Typed connector errors (docs/12 §6). Each kind has a defined treatment in the worker. */
export type IntegrationErrorKind = "AuthExpired" | "RateLimited" | "Transient" | "Permanent";

export class IntegrationError extends Error {
  override readonly name = "IntegrationError";
  constructor(
    readonly kind: IntegrationErrorKind,
    readonly provider: string,
    message: string,
    readonly options: { retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
  }

  get retryable(): boolean {
    return this.kind === "RateLimited" || this.kind === "Transient";
  }
}

export type ConnectionStatus = "healthy" | "needs_reauth" | "degraded" | "paused" | "revoked";

export interface HealthReport {
  provider: string;
  mode: "fake" | "live";
  status: ConnectionStatus;
  detail?: string;
}
