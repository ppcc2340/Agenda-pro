import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import type { ErrorTracker } from "@meri/config";
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from "fastify-type-provider-zod";

/** Stable error codes (docs/13 "Códigos de error estables"). */
export const ERROR_CODES = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  ENTITLEMENT_REQUIRED: 402,
  AI_CREDITS_EXHAUSTED: 402,
  INTEGRATION_NEEDS_REAUTH: 409,
  BETA_INVITE_REQUIRED: 403,
  INTERNAL: 500,
} as const;
export type ErrorCode = keyof typeof ERROR_CODES;

/** RFC 9457 problem details. `detail` is user-safe; internal messages never leave the process. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  traceId: string;
  errors?: { path: string; message: string }[];
}

export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
    readonly errors?: { path: string; message: string }[],
  ) {
    super(detail ?? code);
    this.status = ERROR_CODES[code];
  }
}

const TITLES: Record<ErrorCode, string> = {
  VALIDATION_FAILED: "Validation failed",
  UNAUTHENTICATED: "Authentication required",
  FORBIDDEN: "Forbidden",
  NOT_FOUND: "Not found",
  CONFLICT: "Conflict",
  RATE_LIMITED: "Too many requests",
  ENTITLEMENT_REQUIRED: "Plan upgrade required",
  AI_CREDITS_EXHAUSTED: "AI credits exhausted",
  INTEGRATION_NEEDS_REAUTH: "Integration needs re-authorisation",
  BETA_INVITE_REQUIRED: "Invitation required",
  INTERNAL: "Internal error",
};

export function problemFrom(
  code: ErrorCode,
  traceId: string,
  detail?: string,
  errors?: Problem["errors"],
): Problem {
  const p: Problem = {
    type: `https://meri.app/problems/${code.toLowerCase()}`,
    title: TITLES[code],
    status: ERROR_CODES[code],
    code,
    traceId,
  };
  if (detail) p.detail = detail;
  if (errors && errors.length > 0) p.errors = errors;
  return p;
}

export function sendProblem(reply: FastifyReply, problem: Problem): FastifyReply {
  return reply
    .status(problem.status)
    .header("content-type", "application/problem+json; charset=utf-8")
    .send(problem);
}

/** Global error handler: everything leaves as application/problem+json with a stable code. */
export function createErrorHandler(errors: ErrorTracker) {
  return function errorHandler(
    error: FastifyError | ApiError | Error,
    request: FastifyRequest,
    reply: FastifyReply,
  ): FastifyReply {
    const traceId = request.id;
    if (error instanceof ApiError) {
      return sendProblem(reply, problemFrom(error.code, traceId, error.detail, error.errors));
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      const errors = error.validation.map((v) => ({
        path: v.instancePath.replace(/^\//, "").replace(/\//g, ".") || v.params.issue.path.join("."),
        message: v.message,
      }));
      return sendProblem(
        reply,
        problemFrom("VALIDATION_FAILED", traceId, "The request body or query is invalid.", errors),
      );
    }
    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, "response serialization failed");
      return sendProblem(reply, problemFrom("INTERNAL", traceId));
    }
    const fe = error as FastifyError;
    if (fe.statusCode === 429)
      return sendProblem(reply, problemFrom("RATE_LIMITED", traceId, "Slow down and retry shortly."));
    if (fe.statusCode === 404) return sendProblem(reply, problemFrom("NOT_FOUND", traceId));
    if (fe.statusCode === 413)
      return sendProblem(reply, problemFrom("VALIDATION_FAILED", traceId, "Request body too large."));
    if (fe.statusCode === 415 || fe.statusCode === 400)
      return sendProblem(reply, problemFrom("VALIDATION_FAILED", traceId, "Malformed request."));
    request.log.error({ err: error }, "unhandled error");
    errors.captureException(error, {
      traceId,
      route: request.routeOptions.url ?? request.url,
      workspaceId: request.session?.workspaceId,
    });
    return sendProblem(reply, problemFrom("INTERNAL", traceId));
  };
}
