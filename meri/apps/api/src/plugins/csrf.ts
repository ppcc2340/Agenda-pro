import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { ApiError } from "../errors";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "meri";

export interface CsrfOptions {
  /** Origins allowed to send cookie-authenticated mutations (APP_URL and API_URL), normalized. */
  allowedOrigins: string[];
}

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/**
 * CSRF defence for cookie-authenticated mutations (docs/06 §4, §7, ADR 0007), in two layers:
 * 1. a custom header: browsers cannot add it cross-origin without a CORS preflight, which this API never grants;
 * 2. the browser's own provenance headers: `Sec-Fetch-Site` must be `same-origin` (or `none`, typed by the user)
 *    when present, and `Origin`, when present, must be exactly one of ours (`null` is refused).
 * Server-to-server calls from the web send neither header. Webhooks and internal routes are exempt because they
 * do not use the session cookie.
 */
export const csrfPlugin = fp<CsrfOptions>((app: FastifyInstance, options, done) => {
  const allowed = new Set(options.allowedOrigins.map(originOf).filter((o): o is string => o !== null));
  // preParsing (after the per-route rate limit, before body parsing and validation): a forged request is refused
  // before any route logic runs.
  app.addHook("preParsing", (request, _reply, payload, next) => {
    const needsCheck =
      MUTATING.has(request.method) && request.url.startsWith("/v1/") && request.session !== null;
    if (!needsCheck) {
      next(null, payload);
      return;
    }
    if (request.headers[CSRF_HEADER] !== CSRF_VALUE) {
      next(new ApiError("FORBIDDEN", `Missing ${CSRF_HEADER} header.`));
      return;
    }
    const site = request.headers["sec-fetch-site"];
    if (typeof site === "string" && site !== "same-origin" && site !== "none") {
      next(new ApiError("FORBIDDEN", "Cross-site request refused."));
      return;
    }
    const origin = request.headers.origin;
    if (typeof origin === "string" && !allowed.has(originOf(origin) ?? "\0")) {
      next(new ApiError("FORBIDDEN", "Request origin refused."));
      return;
    }
    next(null, payload);
  });
  done();
});
