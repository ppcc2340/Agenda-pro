import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { finalizeIdempotencyKey, releaseIdempotencyKey, reserveIdempotencyKey } from "@meri/db";
import { ApiError } from "../errors";

export const IDEMPOTENCY_HEADER = "idempotency-key";

declare module "fastify" {
  interface FastifyRequest {
    idempotency: { key: string; hash: string } | null;
  }
}

function hashRequest(request: FastifyRequest): string {
  const body = request.body === undefined ? "" : JSON.stringify(request.body);
  return createHash("sha256").update(`${request.method} ${request.url}\n${body}`).digest("hex");
}

/**
 * Idempotency-Key (docs/13, D-024) for session-authenticated POSTs. A replay with the same key and body returns the
 * stored response; the same key with a different body is a CONFLICT. Keys are scoped by workspace (RLS).
 */
export const idempotencyPlugin = fp<{ now: () => Date }>((app: FastifyInstance, options, done) => {
  app.decorateRequest("idempotency", null);

  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== "POST" || !request.session || !request.url.startsWith("/v1/")) return;
    const raw = request.headers[IDEMPOTENCY_HEADER];
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key) return;
    if (key.length > 128)
      throw new ApiError("VALIDATION_FAILED", "Idempotency-Key must be at most 128 characters.");
    const hash = hashRequest(request);
    const session = request.session;
    // Reserve before running the handler so two concurrent requests with the same key never both execute.
    const outcome = await request.withWorkspace((tx) =>
      reserveIdempotencyKey(tx, session.workspaceId, key, hash, options.now()),
    );
    if (!outcome.reserved) {
      const stored = outcome.existing;
      if (stored.requestHash !== hash)
        throw new ApiError("CONFLICT", "Idempotency-Key was already used with a different request.");
      if (stored.statusCode === 0)
        throw new ApiError("CONFLICT", "A request with this Idempotency-Key is in progress.");
      return reply.status(stored.statusCode).header("idempotency-replayed", "true").send(stored.response);
    }
    request.idempotency = { key, hash };
  });

  app.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const idem = request.idempotency;
    if (!idem || !request.session) return payload;
    const session = request.session;
    // Only successful outcomes are replayable; a failed attempt frees the key for a retry.
    if (reply.statusCode < 200 || reply.statusCode >= 300) {
      await request.withWorkspace((tx) => releaseIdempotencyKey(tx, session.workspaceId, idem.key));
      return payload;
    }
    let response: unknown = null;
    if (typeof payload === "string" && payload.length > 0) {
      try {
        response = JSON.parse(payload);
      } catch {
        response = payload;
      }
    }
    await request.withWorkspace((tx) =>
      finalizeIdempotencyKey(tx, session.workspaceId, idem.key, { statusCode: reply.statusCode, response }),
    );
    return payload;
  });
  done();
});
