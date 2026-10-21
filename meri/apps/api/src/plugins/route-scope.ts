import type { FastifyRequest } from "fastify";

/**
 * Is this request handled by a `/v1` route? Decided on the matched route pattern, never on `request.url`: the router
 * percent-decodes the path before matching, so `/%761/tasks` reaches `/v1/tasks` while its raw URL does not start
 * with `/v1/` (security review, phase 5). Unmatched requests are not `/v1` routes (they keep their 404).
 */
export const isV1Route = (request: FastifyRequest): boolean =>
  request.routeOptions.url?.startsWith("/v1/") ?? false;
