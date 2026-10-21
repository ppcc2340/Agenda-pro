import { decode } from "@auth/core/jwt";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import type { UserId, WorkspaceId } from "@meri/db";
import { ApiError } from "../errors";

/** Claims Meri puts in the Auth.js JWT (apps/web/src/auth.ts). */
export const SessionClaims = z.object({
  sub: z.string().uuid(),
  workspaceId: z.string().uuid(),
  email: z.string().email(),
  locale: z.enum(["es", "en"]).default("es"),
  /** Sign-in instant in ms, set once by the web `jwt` callback and never refreshed (ADR 0007). */
  // Milliseconds since the epoch: a seconds value (< 1e12, before 2001) is refused rather than read as revoked.
  authTime: z.number().int().min(1e12),
});

export interface Session {
  userId: UserId;
  workspaceId: WorkspaceId;
  email: string;
  locale: "es" | "en";
  /** When the user authenticated (ms): drives revocation and the absolute session lifetime. */
  authTime: number;
}

declare module "fastify" {
  interface FastifyRequest {
    session: Session | null;
  }
}

export interface SessionPluginOptions {
  secret: string;
  secure: boolean;
}

/** Auth.js cookie names depend on the Secure prefix. The salt used to encrypt the JWT is the cookie name. */
export function sessionCookieName(secure: boolean): string {
  return secure ? "__Secure-authjs.session-token" : "authjs.session-token";
}

/**
 * Decrypts the Auth.js session cookie (JWE, shared AUTH_SECRET) and exposes `request.session`.
 * The workspace always comes from the signed session, never from the request body (docs/13).
 */
export const sessionPlugin = fp<SessionPluginOptions>((app: FastifyInstance, options, done) => {
  app.decorateRequest("session", null);
  app.addHook("onRequest", async (request) => {
    const name = sessionCookieName(options.secure);
    const token = request.cookies[name];
    if (!token) return;
    try {
      const payload = await decode({ token, secret: options.secret, salt: name });
      const claims = SessionClaims.safeParse(payload);
      if (claims.success) {
        request.session = {
          userId: claims.data.sub as UserId,
          workspaceId: claims.data.workspaceId as WorkspaceId,
          email: claims.data.email,
          locale: claims.data.locale,
          authTime: claims.data.authTime,
        };
      }
    } catch (err) {
      request.log.debug({ err }, "invalid session cookie ignored");
    }
  });
  done();
});

/** preHandler: rejects (never throws synchronously, which Fastify would not route to the error handler). */
export function requireSession(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  return request.session
    ? Promise.resolve()
    : Promise.reject(new ApiError("UNAUTHENTICATED", "Sign in to continue."));
}

export function sessionOf(request: FastifyRequest): Session {
  if (!request.session) throw new ApiError("UNAUTHENTICATED", "Sign in to continue.");
  return request.session;
}
