import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError } from "../errors";

export const INTERNAL_HEADER = "x-internal-secret";

/** Service-to-service guard for /internal/* (ADR 0001). Constant-time comparison of the shared secret. */
export function requireInternalSecret(secret: string) {
  const expected = Buffer.from(secret, "utf8");
  // Runs as onRequest so the secret is checked before body validation.
  return (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const header = request.headers[INTERNAL_HEADER];
    const given = Buffer.from(typeof header === "string" ? header : "", "utf8");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return Promise.reject(new ApiError("UNAUTHENTICATED", "Invalid internal secret."));
    }
    return Promise.resolve();
  };
}
