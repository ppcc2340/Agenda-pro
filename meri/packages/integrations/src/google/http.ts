import type { z } from "zod";
import { IntegrationError } from "../errors";

/**
 * Minimal Google REST client (ADR 0008, D-096): fetch with a timeout, bearer token from a supplier, every response
 * validated with Zod, and Google's errors mapped to the typed connector errors the worker knows how to treat:
 * 401 → AuthExpired; 429 and 403 rate-limit reasons → RateLimited (with Retry-After); 5xx and network → Transient;
 * any other 4xx → Permanent. Statuses a caller handles itself (410 Gone, 404, 412) are listed in `allow`.
 * Messages never contain tokens: they only travel in headers and form bodies.
 */
export interface GoogleHttpOptions {
  fetch?: typeof fetch;
  /** Per-request timeout (default 10 s, docs/12 §3). */
  timeoutMs?: number;
  /** Hosts this client may call (default: Google's). Anything else is refused before a request is made. */
  allowedHosts?: readonly string[];
  /** Largest response body accepted (default 15 MB: a full Gmail message is bounded by Google at 25 MB raw). */
  maxResponseBytes?: number;
}

export const GOOGLE_HOSTS = [
  "accounts.google.com",
  "oauth2.googleapis.com",
  "openidconnect.googleapis.com",
  "www.googleapis.com",
  "gmail.googleapis.com",
] as const;

/** Bearer token supplier; called again with `forceRefresh` once after a 401 (ADR 0008). */
export type TokenSupplier = (options?: { forceRefresh?: boolean }) => Promise<string>;

/** A 401 from Google (as opposed to `invalid_grant` while refreshing): worth one retry with a fresh token. */
export class GoogleUnauthorized extends IntegrationError {}

export interface GoogleRequest {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  /** Arrays become repeated parameters (`metadataHeaders=From&metadataHeaders=To`). */
  query?: Record<string, string | number | boolean | readonly string[] | undefined | null>;
  token?: TokenSupplier;
  json?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
  /** Non-2xx statuses returned to the caller instead of thrown. */
  allow?: readonly number[];
}

export interface GoogleResponse<T> {
  status: number;
  /** Parsed body for 2xx responses with content; null for 204, empty bodies and allowed error statuses. */
  body: T | null;
}

const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "backendError"]);

interface GoogleErrorBody {
  reasons: string[];
}

function readError(json: unknown): GoogleErrorBody {
  const fallback: GoogleErrorBody = { reasons: [] };
  if (typeof json !== "object" || json === null) return fallback;
  const record = json as Record<string, unknown>;
  // OAuth endpoints: { error: "invalid_grant", error_description: "…" }
  if (typeof record.error === "string") return { reasons: [record.error] };
  // REST APIs: { error: { code, message, errors: [{ reason }] , status } }
  if (typeof record.error === "object" && record.error !== null) {
    const err = record.error as { errors?: unknown; status?: unknown };
    const reasons = Array.isArray(err.errors)
      ? err.errors.flatMap((e) =>
          typeof e === "object" && e !== null && typeof (e as { reason?: unknown }).reason === "string"
            ? [(e as { reason: string }).reason]
            : [],
        )
      : [];
    if (typeof err.status === "string") reasons.push(err.status);
    return { reasons };
  }
  return fallback;
}

const retryAfterMs = (header: string | null): number => {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : 1000;
};

export class GoogleHttp {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly allowedHosts: ReadonlySet<string>;
  private readonly maxResponseBytes: number;

  constructor(
    private readonly provider: string,
    options: GoogleHttpOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.allowedHosts = new Set(options.allowedHosts ?? GOOGLE_HOSTS);
    this.maxResponseBytes = options.maxResponseBytes ?? 15 * 1024 * 1024;
  }

  /**
   * One retry with a forced refresh after a 401: an access token can be revoked or rotated before its expiry. A
   * second 401, or `invalid_grant` while refreshing, is an expired connection (AuthExpired).
   */
  async request<T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    req: GoogleRequest,
  ): Promise<GoogleResponse<T>> {
    try {
      return await this.once(schema, req, false);
    } catch (err) {
      if (!req.token || !(err instanceof GoogleUnauthorized)) throw err;
      return this.once(schema, req, true);
    }
  }

  private async once<T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    req: GoogleRequest,
    forceRefresh: boolean,
  ): Promise<GoogleResponse<T>> {
    const url = new URL(req.url);
    if (url.protocol !== "https:" || !this.allowedHosts.has(url.hostname))
      throw new IntegrationError(
        "Permanent",
        this.provider,
        `refusing to call ${url.protocol}//${url.hostname}`,
      );
    for (const [k, v] of Object.entries(req.query ?? {})) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) for (const item of v as readonly string[]) url.searchParams.append(k, item);
      else url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { accept: "application/json", ...req.headers };
    if (req.token)
      headers.authorization = `Bearer ${await req.token(forceRefresh ? { forceRefresh } : undefined)}`;
    let body: string | undefined;
    if (req.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(req.json);
    } else if (req.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(req.form).toString();
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: req.method ?? "GET",
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
        // A redirect would carry the bearer token elsewhere: Google's APIs never need one.
        redirect: "error",
      });
    } catch (cause) {
      throw new IntegrationError("Transient", this.provider, `network error talking to ${this.provider}`, {
        cause,
      });
    }
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > this.maxResponseBytes)
      throw new IntegrationError("Permanent", this.provider, `${this.provider} response too large`);
    const text = await res.text().catch(() => "");
    if (text.length > this.maxResponseBytes)
      throw new IntegrationError("Permanent", this.provider, `${this.provider} response too large`);
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (res.ok) {
      if (res.status === 204 || !text) return { status: res.status, body: null };
      const parsed = schema.safeParse(json);
      if (!parsed.success)
        throw new IntegrationError("Permanent", this.provider, `unexpected response from ${this.provider}`, {
          cause: parsed.error,
        });
      return { status: res.status, body: parsed.data };
    }
    if (req.allow?.includes(res.status)) return { status: res.status, body: null };
    const err = readError(json);
    // Status and Google's reason codes only: response texts may echo request data and end up in audit rows.
    const reasons = err.reasons.filter((r) => /^[A-Za-z_]{1,64}$/.test(r)).slice(0, 3);
    const message = `${this.provider} ${String(res.status)}${reasons.length ? ` ${reasons.join(",")}` : ""}`;
    if (res.status === 401) throw new GoogleUnauthorized("AuthExpired", this.provider, message);
    // invalid_grant (refresh revoked or expired) and a missing scope both need the user to reconnect.
    if (err.reasons.includes("invalid_grant") || err.reasons.includes("insufficientPermissions"))
      throw new IntegrationError("AuthExpired", this.provider, message);
    if (res.status === 429 || (res.status === 403 && err.reasons.some((r) => RATE_LIMIT_REASONS.has(r))))
      throw new IntegrationError("RateLimited", this.provider, message, {
        retryAfterMs: retryAfterMs(res.headers.get("retry-after")),
      });
    if (res.status >= 500) throw new IntegrationError("Transient", this.provider, message);
    throw new IntegrationError("Permanent", this.provider, message);
  }
}
