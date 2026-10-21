import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { ApiError } from "../errors";
import { isV1Route } from "./route-scope";

declare module "fastify" {
  interface FastifyContextConfig {
    /** A `/v1` route reachable without a session (`POST /v1/waitlist`, `POST /v1/email/unsubscribe`; fails closed). */
    public?: boolean;
    /**
     * A public route authorized by a signed token in the URL instead of a cookie (D-116: one-click email
     * unsubscribe, called by mail servers without Origin or our header). It skips CSRF, which protects cookies.
     */
    signedToken?: boolean;
  }
}

/**
 * Fail-closed authentication (ADR 0007, P5-06): every `/v1` request needs a live session before parsing or
 * validation (`preParsing`: after the per-route rate limit, so anonymous floods are still throttled), unless the
 * route opts out with `config.public`. Unknown paths keep their 404. A new route can never ship unauthenticated by
 * forgetting `preHandler: requireSession` (which stays on routes as documentation and a second check).
 * Runs after the session plugin and the account guard, so a deleted or revoked session is already gone.
 */
export const authGatePlugin = fp((app: FastifyInstance, _options, done) => {
  app.addHook("preParsing", (request, _reply, payload, next) => {
    if (isV1Route(request) && !request.session && request.routeOptions.config.public !== true) {
      next(new ApiError("UNAUTHENTICATED", "Sign in to continue."));
      return;
    }
    next(null, payload);
  });
  done();
});
