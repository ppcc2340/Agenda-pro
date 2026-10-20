import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { DEMO_USER } from "@meri/config";
import type { KeyProvider } from "@meri/config/crypto";
import type { GoogleOAuth } from "@meri/integrations";
import { readTokens } from "@meri/jobs";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  PreferencesPatchSchema,
  PreferencesSchema,
  audit,
  getMe,
  getPreferences,
  listAudit,
  listBlocks,
  listCalendarEvents,
  listClientsFull,
  listCommitments,
  listContacts,
  listIntegrationAccounts,
  listNotifications,
  listProjects,
  listProposals,
  listTasks,
  listTimeEntries,
  softDeleteAccount,
  updatePreferences,
  PreferencesValidationError,
  withWorkspace,
  type Db,
  type WorkspaceId,
  type WorkspaceTx,
} from "@meri/db";
import { ApiError } from "../errors";
import { markAccountDeleted } from "../plugins/account-guard";
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

/** Export (D-050/D-055): at most this many rows per collection; larger accounts get the phase 5 zip job. */
const EXPORT_MAX_ROWS = 5000;
const PAGE = 100;

/**
 * Reads pages until the collection ends or exceeds `max`; a collection cut at `max` is named in `truncated`
 * (never silently cut). Reading one row past the cap tells "exactly max" apart from "more than max".
 */
export async function drainCapped<T>(
  name: string,
  truncated: string[],
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
  max = EXPORT_MAX_ROWS,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    all.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && all.length <= max);
  if (all.length > max) truncated.push(name);
  return all.slice(0, max);
}

/**
 * Allow-list serialisers (never `select *`, docs/06): the export carries the user's own records and nothing
 * from the integration layer (no tokens, key ids, sync cursors, mail bodies or audit payloads of integrations).
 */
export async function buildAccountExport(
  tx: WorkspaceTx,
  input: { workspaceId: string; now: Date; me: { email: string; name: string | null; locale: string }; workspace: { name: string; vertical: string | null } },
): Promise<Record<string, unknown>> {
  const ws = input.workspaceId as Parameters<typeof listClientsFull>[1];
  const prefs = await getPreferences(tx, ws);
  const year = 366 * 86_400_000;
  const truncated: string[] = [];
  const [clients, projects, contacts, tasks, commitments, proposals, timeEntries, events, blocks, notifications, activity, accounts] =
    await Promise.all([
      listClientsFull(tx, ws, { includeArchived: true }),
      listProjects(tx, ws),
      listContacts(tx, ws),
      drainCapped("tasks", truncated, (cursor) => listTasks(tx, ws, { includeCompleted: true }, { limit: PAGE, cursor })),
      drainCapped("commitments", truncated, (cursor) => listCommitments(tx, ws, { includeProposed: true }, { limit: PAGE, cursor })),
      drainCapped("proposals", truncated, (cursor) => listProposals(tx, ws, {}, { limit: PAGE, cursor })),
      listTimeEntries(tx, ws, { from: "2000-01-01", to: "2100-01-01", includeRejected: true }),
      listCalendarEvents(tx, ws, { from: new Date(input.now.getTime() - year), to: new Date(input.now.getTime() + year) }),
      listBlocks(tx, ws),
      drainCapped("notifications", truncated, (cursor) => listNotifications(tx, ws, { limit: PAGE, cursor })),
      drainCapped("activity", truncated, (cursor) => listAudit(tx, ws, PAGE, cursor)),
      listIntegrationAccounts(tx, ws),
    ]);
  return {
    format: "meri-export/1",
    exportedAt: input.now.toISOString(),
    truncated,
    user: { email: input.me.email, name: input.me.name, locale: input.me.locale },
    workspace: { name: input.workspace.name, vertical: input.workspace.vertical },
    preferences: prefs ? { ...prefs, onboardedAt: iso(prefs.onboardedAt) } : null,
    clients: clients.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      domains: c.domains,
      notes: c.notes,
      verticalTags: c.verticalTags,
      followupsMuted: c.followupsMuted,
      archivedAt: iso(c.archivedAt),
      createdAt: c.createdAt.toISOString(),
    })),
    projects: projects.map((p) => ({ id: p.id, clientId: p.clientId, name: p.name, kind: p.kind, dueAt: iso(p.dueAt), status: p.status, createdAt: p.createdAt.toISOString() })),
    contacts: contacts.map((c) => ({ id: c.id, clientId: c.clientId, email: c.email, name: c.name, muted: c.muted, createdAt: c.createdAt.toISOString() })),
    tasks: tasks.map((t) => ({
      id: t.id,
      clientId: t.clientId,
      projectId: t.projectId,
      parentId: t.parentId,
      title: t.title,
      notes: t.notes,
      status: t.status,
      kind: t.kind,
      priority: t.priority,
      dueAt: iso(t.dueAt),
      deadlineType: t.deadlineType,
      estimateMinutes: t.estimateMinutes,
      tags: t.tags,
      origin: t.origin,
      blockedBy: t.blockedBy,
      completedAt: iso(t.completedAt),
      createdAt: t.createdAt.toISOString(),
    })),
    commitments: commitments.map((c) => ({
      id: c.id,
      clientId: c.clientId,
      direction: c.direction,
      kind: c.kind,
      status: c.status,
      counterpartyEmail: c.counterpartyEmail,
      action: c.action,
      dueAt: iso(c.dueAt),
      dueText: c.dueText,
      confidence: c.confidence,
      evidence: c.evidence,
      taskId: c.taskId,
      origin: c.origin,
      createdAt: c.createdAt.toISOString(),
    })),
    proposals: proposals.map((p) => ({
      id: p.id,
      kind: p.kind,
      status: p.status,
      payload: p.payload,
      confidence: p.confidence,
      explanation: p.explanation,
      resolution: p.resolution,
      resolvedAt: iso(p.resolvedAt),
      createdAt: p.createdAt.toISOString(),
    })),
    timeEntries: timeEntries.map((e) => ({
      id: e.id,
      clientId: e.clientId,
      projectId: e.projectId,
      taskId: e.taskId,
      day: e.day,
      minutes: e.minutes,
      description: e.description,
      status: e.status,
      sourceType: e.sourceType,
      approvedAt: iso(e.approvedAt),
      createdAt: e.createdAt.toISOString(),
    })),
    calendarEvents: events.map((e) => ({
      id: e.id,
      title: e.title,
      startsAt: e.startsAt.toISOString(),
      endsAt: e.endsAt.toISOString(),
      allDay: e.allDay,
      attendees: e.attendees,
      clientId: e.clientId,
      origin: e.origin,
      busy: e.busy,
    })),
    blocks: blocks.map((b) => ({
      id: b.id,
      taskId: b.taskId,
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
      pinned: b.pinned,
      reason: b.reason,
      planVersion: b.planVersion,
      completedAt: iso(b.completedAt),
    })),
    notifications: notifications.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, day: n.day, readAt: iso(n.readAt), createdAt: n.createdAt.toISOString() })),
    activity: activity.map((a) => ({
      id: a.id,
      actor: a.actor,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      reason: a.reason,
      undoneAt: iso(a.undoneAt),
      createdAt: a.createdAt.toISOString(),
    })),
    connections: accounts.map((a) => ({ provider: a.provider, email: a.email, status: a.status, scopes: a.scopes, lastSyncAt: iso(a.lastSyncAt), createdAt: a.createdAt.toISOString() })),
  };
}

export interface AccountRoutesOptions {
  db: Db;
  now: () => Date;
  /** Provider revocation on account deletion (docs/06 §1). */
  oauth: GoogleOAuth;
  keys: KeyProvider;
  /** DEMO_MODE (D-049): the shared demo account can never be deleted. */
  demoMode: boolean;
}

/**
 * Reads every connection's tokens before they are wiped, so they can be revoked at the provider after commit.
 * A token that cannot be decrypted is skipped (it is wiped anyway).
 */
export async function collectTokensToRevoke(
  deps: { db: Db; keys: KeyProvider },
  workspaceId: WorkspaceId,
  logger: FastifyBaseLogger,
): Promise<{ accountId: string; token: string }[]> {
  const accounts = await withWorkspace(deps.db, workspaceId, (tx) => listIntegrationAccounts(tx, workspaceId));
  const out: { accountId: string; token: string }[] = [];
  for (const account of accounts) {
    try {
      const tokens = await readTokens(deps, workspaceId, account.id);
      const token = tokens?.refreshToken ?? tokens?.accessToken;
      if (token) out.push({ accountId: account.id, token });
    } catch (err) {
      logger.warn({ err, accountId: account.id }, "tokens unreadable before deletion; wiped without revocation");
    }
  }
  return out;
}

/** Best-effort revocation at the provider (never blocks the deletion); each outcome is logged. */
export async function revokeAtProvider(
  oauth: GoogleOAuth,
  items: { accountId: string; token: string }[],
  logger: FastifyBaseLogger,
): Promise<number> {
  let revoked = 0;
  for (const item of items) {
    try {
      await oauth.revoke(item.token);
      revoked++;
    } catch (err) {
      logger.warn({ err, accountId: item.accountId }, "provider revocation failed; the token stays unusable here");
    }
  }
  return revoked;
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
      schema: { tags: ["account"], response: { 200: z.record(z.string(), z.unknown()) } },
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
          { action: "account.exported", entityType: "workspace", entityId: session.workspaceId, after: { format: doc["format"] } },
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
      markAccountDeleted(session.userId, session.workspaceId);
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
