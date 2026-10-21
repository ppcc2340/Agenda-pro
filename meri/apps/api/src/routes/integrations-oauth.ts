import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { audit, setIntegrationStatus, upsertIntegrationAccount } from "@meri/db";
import {
  hasCalendarScopes,
  hasForbiddenScope,
  hasGmailScopes,
  IntegrationError,
  scopesFor,
} from "@meri/integrations";
import { CalendarSyncJob, GmailSyncJob, encryptTokens, track } from "@meri/jobs";
import { ApiError } from "../errors";
import { newPkce, OAUTH_STATE_TTL_MS, openState, safeEqual, sealState } from "../plugins/oauth-state";
import { requireSession, sessionOf } from "../plugins/session";
import type { IntegrationRoutesOptions } from "./integrations";

/** OAuth state cookie: short-lived, HttpOnly, signed; verified on callback (docs/06 §7, ADR 0007). */
export const STATE_COOKIE = "meri.oauth.state";

/**
 * Google connect flow (ADR 0004, ADR 0007): incremental scopes per feature, `state` + PKCE S256 in a signed
 * HttpOnly cookie bound to the workspace that started the flow; the callback checks the signature, the
 * workspace, `state` in constant time, and hands the verifier to the code exchange.
 */
export function integrationOAuthRoutes(
  app: FastifyInstance,
  options: IntegrationRoutesOptions & { stateKey: Buffer },
  done: () => void,
): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const redirectUri = `${options.apiUrl}/v1/integrations/google/callback`;
  const cookieOptions = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: options.secureCookies,
    path: "/v1/integrations",
  };

  r.post(
    "/v1/integrations/:provider/connect",
    {
      preHandler: requireSession,
      schema: {
        tags: ["integrations"],
        params: z.object({ provider: z.literal("google") }),
        querystring: z.object({ feature: z.enum(["calendar", "gmail", "all"]).default("calendar") }),
        response: { 200: z.object({ url: z.string() }) },
      },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const state = randomBytes(24).toString("base64url");
      const pkce = newPkce();
      const sealed = sealState(
        options.stateKey,
        { s: state, v: pkce.verifier, w: session.workspaceId, f: request.query.feature },
        Date.now(),
      );
      reply.setCookie(STATE_COOKIE, sealed, { ...cookieOptions, maxAge: OAUTH_STATE_TTL_MS / 1000 });
      // Incremental authorization (ADR 0004 §1): only the scopes of the requested feature.
      const url = options.oauth.authorizationUrl({
        state,
        scopes: scopesFor(request.query.feature),
        redirectUri,
        loginHint: session.email,
        codeChallenge: pkce.challenge,
      });
      return { url };
    },
  );

  r.get(
    "/v1/integrations/:provider/callback",
    {
      preHandler: requireSession,
      schema: {
        tags: ["integrations"],
        params: z.object({ provider: z.literal("google") }),
        querystring: z.object({
          code: z.string().min(1).max(512).optional(),
          state: z.string().min(1).max(128),
          error: z.string().max(200).optional(),
        }),
      },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const expected = openState(options.stateKey, request.cookies[STATE_COOKIE], Date.now());
      reply.clearCookie(STATE_COOKIE, { path: "/v1/integrations" });
      if (!expected || expected.w !== session.workspaceId || !safeEqual(expected.s, request.query.state))
        throw new ApiError("FORBIDDEN", "OAuth state mismatch.");
      if (request.query.error || !request.query.code)
        return reply.redirect(`${options.appUrl}/control?integration=denied`);
      const failed = `${options.appUrl}/control?integration=error`;
      let tokens;
      try {
        tokens = await options.oauth.exchangeCode({
          code: request.query.code,
          redirectUri,
          codeVerifier: expected.v,
        });
      } catch (err) {
        // A used or expired code, a PKCE mismatch or Google being down: back to Control, never a 500 (ADR 0008).
        if (!(err instanceof IntegrationError)) throw err;
        request.log.warn({ kind: err.kind, provider: err.provider }, "google code exchange failed");
        return reply.redirect(failed);
      }
      if (hasForbiddenScope(tokens.scopes)) {
        // Meri never holds a scope it must not use (gmail.send in the MVP): revoke the grant, store nothing.
        await options.oauth.revoke(tokens.refreshToken ?? tokens.accessToken).catch((err: unknown) => {
          request.log.warn({ err }, "revoking a grant with a forbidden scope failed");
        });
        request.log.warn("google grant with a forbidden scope refused");
        return reply.redirect(failed);
      }
      const now = options.now();
      const account = await request.withWorkspace(async (tx) => {
        // Two steps: the row id is part of the encryption AAD, so insert first, then store the ciphertext.
        const provisional = await upsertIntegrationAccount(
          tx,
          session.workspaceId,
          {
            provider: "google",
            externalAccountId: tokens.externalAccountId,
            email: tokens.email,
            scopes: tokens.scopes,
            encryptedTokens: "pending",
            keyId: options.keys.keyId,
          },
          now,
        );
        const blob = await encryptTokens({ keys: options.keys }, session.workspaceId, provisional.id, tokens);
        const stored = await setIntegrationStatus(tx, session.workspaceId, provisional.id, {
          encryptedTokens: blob,
          keyId: options.keys.keyId,
          status: "healthy",
          lastError: null,
        });
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: "integration.connected",
            entityType: "integration_account",
            entityId: provisional.id,
            after: { provider: "google", scopes: tokens.scopes },
          },
        );
        return stored ?? provisional;
      });
      const connectBucket = String(Math.floor(Date.now() / 5_000));
      if (hasCalendarScopes(account.scopes)) {
        await options.dispatcher.enqueue(
          CalendarSyncJob,
          {
            workspaceId: session.workspaceId,
            traceId: request.id,
            integrationAccountId: account.id,
            reason: "connect",
          },
          { jobId: `calendar.sync_${account.id}_connect_${connectBucket}` },
        );
      }
      if (hasGmailScopes(account.scopes)) {
        await options.dispatcher.enqueue(
          GmailSyncJob,
          {
            workspaceId: session.workspaceId,
            traceId: request.id,
            integrationAccountId: account.id,
            reason: "connect",
          },
          { jobId: `gmail.sync_${account.id}_connect_${connectBucket}` },
        );
      }
      if (hasCalendarScopes(account.scopes))
        track(options.analytics, "calendar_connected", session.workspaceId, {});
      if (hasGmailScopes(account.scopes))
        track(options.analytics, "gmail_connected", session.workspaceId, {});
      const feature = hasGmailScopes(account.scopes)
        ? hasCalendarScopes(account.scopes)
          ? "all"
          : "gmail"
        : "calendar";
      return reply.redirect(`${options.appUrl}/control?integration=connected&feature=${feature}`);
    },
  );
  done();
}
