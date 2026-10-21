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
}

export type TokenSupplier = () => Promise<string>;

export interface GoogleRequest {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  url: string;
  query?: Record<string, string | number | boolean | undefined | null>;
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
  message: string;
  reasons: string[];
}

function readError(json: unknown, status: number): GoogleErrorBody {
  const fallback = { message: `HTTP ${String(status)}`, reasons: [] };
  if (typeof json !== "object" || json === null) return fallback;
  const record = json as Record<string, unknown>;
  // OAuth endpoints: { error: "invalid_grant", error_description: "…" }
  if (typeof record.error === "string")
    return {
      message: typeof record.error_description === "string" ? record.error_description : record.error,
      reasons: [record.error],
    };
  // REST APIs: { error: { code, message, errors: [{ reason }] , status } }
  if (typeof record.error === "object" && record.error !== null) {
    const err = record.error as { message?: unknown; errors?: unknown; status?: unknown };
    const reasons = Array.isArray(err.errors)
      ? err.errors.flatMap((e) =>
          typeof e === "object" && e !== null && typeof (e as { reason?: unknown }).reason === "string"
            ? [(e as { reason: string }).reason]
            : [],
        )
      : [];
    if (typeof err.status === "string") reasons.push(err.status);
    return { message: typeof err.message === "string" ? err.message : fallback.message, reasons };
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

  constructor(
    private readonly provider: string,
    options: GoogleHttpOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async request<T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    req: GoogleRequest,
  ): Promise<GoogleResponse<T>> {
    const url = new URL(req.url);
    for (const [k, v] of Object.entries(req.query ?? {}))
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: "application/json", ...req.headers };
    if (req.token) headers.authorization = `Bearer ${await req.token()}`;
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
      });
    } catch (cause) {
      throw new IntegrationError("Transient", this.provider, `network error talking to ${this.provider}`, {
        cause,
      });
    }
    const text = await res.text().catch(() => "");
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
    const err = readError(json, res.status);
    const message = `${this.provider} ${String(res.status)}: ${err.message.slice(0, 200)}`;
    if (res.status === 401 || err.reasons.includes("invalid_grant"))
      throw new IntegrationError("AuthExpired", this.provider, message);
    if (res.status === 429 || (res.status === 403 && err.reasons.some((r) => RATE_LIMIT_REASONS.has(r))))
      throw new IntegrationError("RateLimited", this.provider, message, {
        retryAfterMs: retryAfterMs(res.headers.get("retry-after")),
      });
    if (res.status >= 500) throw new IntegrationError("Transient", this.provider, message);
    throw new IntegrationError("Permanent", this.provider, message);
  }
}
