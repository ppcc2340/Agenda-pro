import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  PreferencesPatchSchema,
  PreferencesSchema,
  audit,
  getMe,
  getPreferences,
  listAudit,
  updatePreferences,
  type Db,
} from "@meri/db";
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
  undoneAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export interface AccountRoutesOptions {
  db: Db;
  now: () => Date;
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
        });
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action:
              completeOnboarding && !before?.onboardedAt ? "onboarding.completed" : "preferences.updated",
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
