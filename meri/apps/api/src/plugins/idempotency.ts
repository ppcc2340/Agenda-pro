import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { getIdempotentResponse, storeIdempotentResponse } from "@meri/db";
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
    const stored = await request.withWorkspace((tx) => getIdempotentResponse(tx, session.workspaceId, key));
    if (stored) {
      if (stored.requestHash !== hash)
        throw new ApiError("CONFLICT", "Idempotency-Key was already used with a different request.");
      return reply.status(stored.statusCode).header("idempotency-replayed", "true").send(stored.response);
    }
    request.idempotency = { key, hash };
  });

  app.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const idem = request.idempotency;
    if (!idem || !request.session || reply.statusCode >= 500) return payload;
    const session = request.session;
    let response: unknown = null;
    if (typeof payload === "string" && payload.length > 0) {
      try {
        response = JSON.parse(payload);
      } catch {
        response = payload;
      }
    }
    await request.withWorkspace((tx) =>
      storeIdempotentResponse(
        tx,
        session.workspaceId,
        idem.key,
        { requestHash: idem.hash, statusCode: reply.statusCode, response },
        options.now(),
      ),
    );
    return payload;
  });
  done();
});
