import { eq, sql } from "drizzle-orm";
import { entitlements, memberships, preferences, subscriptions, users, workspaces } from "../schema";
import type { Db } from "../client";
import { newId, newUserId, newWorkspaceId, type UserId, type WorkspaceId } from "../ids";
import { withWorkspace } from "../workspace";

export interface BootstrapInput {
  email: string;
  name?: string | null;
  image?: string | null;
  locale?: "es" | "en";
  /** Injected clock: trial length is computed from it. */
  now: Date;
}

export interface AccountIdentity {
  userId: UserId;
  workspaceId: WorkspaceId;
  email: string;
  name: string | null;
  locale: string;
  created: boolean;
}

const TRIAL_DAYS = 14;

/**
 * Idempotent first-login bootstrap (F-01): user + workspace + membership + preferences + trial subscription + entitlements.
 * Runs in one transaction; users/workspaces are not RLS tables, the rest are written under the new workspace context.
 */
export async function bootstrapAccount(db: Db, input: BootstrapInput): Promise<AccountIdentity> {
  const email = input.email.trim().toLowerCase();
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) {
    const membership = await db
      .select({ workspaceId: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.ownerId, existing.id))
      .limit(1);
    const ws = membership[0];
    if (!ws) throw new Error(`user ${existing.id} has no workspace`);
    if (input.name && input.name !== existing.name) {
      await db
        .update(users)
        .set({ name: input.name, image: input.image ?? existing.image })
        .where(eq(users.id, existing.id));
    }
    return {
      userId: existing.id as UserId,
      workspaceId: ws.workspaceId as WorkspaceId,
      email,
      name: input.name ?? existing.name,
      locale: existing.locale,
      created: false,
    };
  }

  const userId = newUserId();
  const workspaceId = newWorkspaceId();
  const locale = input.locale ?? "es";
  // One transaction for the whole bootstrap (docs/12 §4): identity rows first, then the RLS context, then tenant rows.
  await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({ id: userId, email, name: input.name ?? null, image: input.image ?? null, locale });
    await tx
      .insert(workspaces)
      .values({ id: workspaceId, name: input.name ?? email, ownerId: userId, vertical: "generic" });
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    await tx.insert(memberships).values({ workspaceId, userId, role: "owner" });
    await tx.insert(preferences).values({ workspaceId });
    await tx.insert(subscriptions).values({
      id: newId(),
      workspaceId,
      plan: "trial",
      status: "trialing",
      trialEndsAt: new Date(input.now.getTime() + TRIAL_DAYS * 86_400_000),
    });
    await tx.insert(entitlements).values({ workspaceId });
  });
  return { userId, workspaceId, email, name: input.name ?? null, locale, created: true };
}

export interface MeView {
  user: { id: UserId; email: string; name: string | null; image: string | null; locale: string };
  workspace: { id: WorkspaceId; name: string; vertical: string | null };
  plan: { plan: string; status: string; trialEndsAt: Date | null; currentPeriodEnd: Date | null };
  entitlements: { maxClients: number; aiCreditsMonthly: number; retentionDays: number; features: string[] };
  onboarded: boolean;
}

export async function getMe(db: Db, userId: UserId, workspaceId: WorkspaceId): Promise<MeView | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId) });
  if (!user || !ws || user.deletedAt || ws.deletedAt) return null;
  return withWorkspace(db, workspaceId, async (tx) => {
    const member = await tx.query.memberships.findFirst({ where: eq(memberships.userId, userId) });
    if (!member) return null;
    const sub = await tx.query.subscriptions.findFirst({ where: eq(subscriptions.workspaceId, workspaceId) });
    const ent = await tx.query.entitlements.findFirst({ where: eq(entitlements.workspaceId, workspaceId) });
    const prefs = await tx.query.preferences.findFirst({ where: eq(preferences.workspaceId, workspaceId) });
    return {
      user: { id: userId, email: user.email, name: user.name, image: user.image, locale: user.locale },
      workspace: { id: workspaceId, name: ws.name, vertical: ws.vertical },
      plan: {
        plan: sub?.plan ?? "trial",
        status: sub?.status ?? "trialing",
        trialEndsAt: sub?.trialEndsAt ?? null,
        currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      },
      entitlements: {
        maxClients: ent?.maxClients ?? 10,
        aiCreditsMonthly: ent?.aiCreditsMonthly ?? 300,
        retentionDays: ent?.retentionDays ?? 90,
        features: ent?.features ?? [],
      },
      onboarded: prefs?.onboardedAt !== null && prefs?.onboardedAt !== undefined,
    };
  });
}
