import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { ApiError } from "../errors";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "meri";

/**
 * CSRF defence for cookie-authenticated mutations (docs/06 §4, §7): browsers cannot add a custom header
 * cross-origin without a CORS preflight, which this API never grants. Webhooks and internal routes are exempt
 * because they do not use the session cookie.
 */
export const csrfPlugin = fp((app: FastifyInstance, _options, done) => {
  app.addHook("preHandler", (request, _reply, next) => {
    const needsCheck =
      MUTATING.has(request.method) && request.url.startsWith("/v1/") && request.session !== null;
    if (needsCheck && request.headers[CSRF_HEADER] !== CSRF_VALUE) {
      next(new ApiError("FORBIDDEN", `Missing ${CSRF_HEADER} header.`));
      return;
    }
    next();
  });
  done();
});
