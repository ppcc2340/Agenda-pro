import type { FastifyInstance } from "fastify";
import { DEMO_USER } from "@meri/config";
import type { KeyProvider } from "@meri/config/crypto";
import type { GoogleOAuth } from "@meri/integrations";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  PreferencesPatchSchema,
  PreferencesSchema,
  audit,
  getMe,
  getPreferences,
  listAudit,
  softDeleteAccount,
  updatePreferences,
  PreferencesValidationError,
  type Db,
} from "@meri/db";
import { collectTokensToRevoke, revokeAtProvider } from "./account-deletion";
import { AccountExportV1, buildAccountExport } from "./account-export";
import { ApiError } from "../errors";
import { requireSession, sessionOf } from "../plugins/session";

const PreferencesView = PreferencesSchema.extend({ onboardedAt: z.string().datetime().nullable() });
const MeView = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
    locale: z.string(),
  }),
  workspace: z.object({ id: z.string(), name: z.string(), vertical: z.string().nullable() }),
  plan: z.object({
    plan: z.string(),
    status: z.string(),
    trialEndsAt: z.string().datetime().nullable(),
    currentPeriodEnd: z.string().datetime().nullable(),
  }),
  entitlements: z.object({
    maxClients: z.number(),
    aiCreditsMonthly: z.number(),
    retentionDays: z.number(),
    features: z.array(z.string()),
  }),
  onboarded: z.boolean(),
});
const AuditEntryView = z.object({
  id: z.string(),
  actor: z.enum(["user", "system", "ai"]),
  action: z.string(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  reason: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  undoOfAuditId: z.string().nullable(),
  undoneAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export interface AccountRoutesOptions {
  db: Db;
  now: () => Date;
  /** Provider revocation on account deletion (docs/06 §1). */
  oauth: GoogleOAuth;
  keys: KeyProvider;
  /** DEMO_MODE (D-049): the shared demo account can never be deleted. */
  demoMode: boolean;
}

export function accountRoutes(app: FastifyInstance, options: AccountRoutesOptions, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/v1/me",
    { preHandler: requireSession, schema: { tags: ["account"], response: { 200: MeView } } },
    async (request) => {
      const session = sessionOf(request);
      const me = await getMe(options.db, session.userId, session.workspaceId);
      if (!me) throw new ApiError("UNAUTHENTICATED", "This account no longer exists.");
      return {
        ...me,
        plan: {
          ...me.plan,
          trialEndsAt: iso(me.plan.trialEndsAt),
          currentPeriodEnd: iso(me.plan.currentPeriodEnd),
        },
      };
    },
  );

  r.get(
    "/v1/preferences",
    { preHandler: requireSession, schema: { tags: ["account"], response: { 200: PreferencesView } } },
    async (request) => {
      const session = sessionOf(request);
      const prefs = await request.withWorkspace((tx) => getPreferences(tx, session.workspaceId));
      if (!prefs) throw new ApiError("NOT_FOUND", "Preferences not found.");
      return { ...prefs, onboardedAt: iso(prefs.onboardedAt) };
    },
  );

  r.put(
    "/v1/preferences",
    {
      preHandler: requireSession,
      schema: {
        tags: ["account"],
        body: PreferencesPatchSchema.and(z.object({ completeOnboarding: z.boolean().optional() })),
        response: { 200: PreferencesView },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const { completeOnboarding, ...patch } = request.body;
      const now = options.now();
      const updated = await request.withWorkspace(async (tx) => {
        const before = await getPreferences(tx, session.workspaceId);
        const after = await updatePreferences(tx, session.workspaceId, patch, {
          now,
          completeOnboarding: completeOnboarding ?? false,
        }).catch((e: unknown) => {
          if (e instanceof PreferencesValidationError) {
            throw new ApiError("VALIDATION_FAILED", "The request body or query is invalid.", [
              { path: e.path, message: e.message },
            ]);
          }
          throw e;
        });
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action:
              completeOnboarding && !before?.onboardedAt
                ? "onboarding.completed"
                : patch.autonomy !== undefined && before?.autonomy !== after.autonomy
                  ? "preferences.autonomy_changed"
                  : "preferences.updated",
            entityType: "preferences",
            before,
            after,
          },
        );
        return after;
      });
      return { ...updated, onboardedAt: iso(updated.onboardedAt) };
    },
  );

  /** D-050/D-055: one JSON document of the user's data (the zip with CSV is the phase 5 job). */
  r.get(
    "/v1/account/export",
    {
      preHandler: requireSession,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: { tags: ["account"], response: { 200: AccountExportV1 } },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      const now = options.now();
      const me = await getMe(options.db, session.userId, session.workspaceId);
      if (!me) throw new ApiError("UNAUTHENTICATED", "This account no longer exists.");
      const document = await request.withWorkspace(async (tx) => {
        const doc = await buildAccountExport(tx, {
          workspaceId: session.workspaceId,
          now,
          me: { email: me.user.email, name: me.user.name, locale: me.user.locale },
          workspace: { name: me.workspace.name, vertical: me.workspace.vertical },
        });
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          { action: "account.exported", entityType: "workspace", entityId: session.workspaceId, after: { format: doc.format, truncated: doc.truncated } },
        );
        return doc;
      });
      void reply.header("content-disposition", `attachment; filename="meri-export-${now.toISOString().slice(0, 10)}.json"`);
      void reply.header("cache-control", "no-store");
      return document;
    },
  );

  /** D-050/D-054: logical deletion now (user, workspace, revoked connections, audit); purge by the phase 5 job. */
  r.delete(
    "/v1/account",
    {
      preHandler: requireSession,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: { tags: ["account"], response: { 204: z.null() } },
    },
    async (request, reply) => {
      const session = sessionOf(request);
      if (options.demoMode && session.email.toLowerCase() === DEMO_USER.email)
        throw new ApiError("FORBIDDEN", "The demo account cannot be deleted.");
      const toRevoke = await collectTokensToRevoke(options, session.workspaceId, request.log);
      const result = await softDeleteAccount(options.db, {
        userId: session.userId,
        workspaceId: session.workspaceId,
        now: options.now(),
      });
      app.accountGuard.markDeleted(session.userId, session.workspaceId);
      if (result.deleted) {
        const revoked = await revokeAtProvider(options.oauth, toRevoke, request.log);
        request.log.info({ revoked, connections: toRevoke.length }, "account deleted; provider tokens revoked");
      }
      return reply.status(204).send(null);
    },
  );

  r.get(
    "/v1/audit",
    {
      preHandler: requireSession,
      schema: {
        tags: ["control"],
        querystring: z.object({
          cursor: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        }),
        response: { 200: z.object({ items: z.array(AuditEntryView), nextCursor: z.string().nullable() }) },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const page = await request.withWorkspace((tx) =>
        listAudit(tx, session.workspaceId, request.query.limit, request.query.cursor),
      );
      return {
        items: page.items.map((i) => ({
          ...i,
          undoneAt: iso(i.undoneAt),
          createdAt: i.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    },
  );
  done();
}
