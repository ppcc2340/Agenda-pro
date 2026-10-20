import { and, eq, isNull, sql } from "drizzle-orm";
import {
  entitlements,
  integrationAccounts,
  memberships,
  preferences,
  subscriptions,
  users,
  workspaces,
} from "../schema";
import { audit } from "./audit";
import type { Db } from "../client";
import { newId, newUserId, newWorkspaceId, type UserId, type WorkspaceId } from "../ids";
import { withWorkspace, type WorkspaceTx } from "../workspace";

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

/** Sign-in of an email whose account was logically deleted (D-054): refused until the purge job removes it. */
export class AccountDeletedError extends Error {
  override readonly name = "AccountDeletedError";
  constructor(readonly email: string) {
    super(`The account ${email} was deleted and is pending purge.`);
  }
}

/**
 * Idempotent first-login bootstrap (F-01): user + workspace + membership + preferences + trial subscription + entitlements.
 * Runs in one transaction; users/workspaces are not RLS tables, the rest are written under the new workspace context.
 */
export async function bootstrapAccount(db: Db, input: BootstrapInput): Promise<AccountIdentity> {
  const email = input.email.trim().toLowerCase();
  const existing = await findExisting(db, email, input);
  if (existing) return existing;

  const userId = newUserId();
  const workspaceId = newWorkspaceId();
  const locale = input.locale ?? "es";
  // One transaction for the whole bootstrap (docs/12 §4): identity rows first, then the RLS context, then tenant rows.
  // Concurrent first logins for the same email race on users_email_uq: the loser inserts nothing and re-reads.
  const created = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(users)
      .values({ id: userId, email, name: input.name ?? null, image: input.image ?? null, locale })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });
    if (inserted.length === 0) return false;
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
    return true;
  });
  if (!created) {
    const winner = await findExisting(db, email, input);
    if (!winner) throw new Error(`bootstrap race: user ${email} vanished`);
    return winner;
  }
  return { userId, workspaceId, email, name: input.name ?? null, locale, created: true };
}

async function findExisting(db: Db, email: string, input: BootstrapInput): Promise<AccountIdentity | null> {
  const existing = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existing) {
    if (existing.deletedAt) throw new AccountDeletedError(email);
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
  return null;
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
      // D-045 / ADR 0005: preferences.vertical is the source of truth; workspaces.vertical is deprecated.
      workspace: { id: workspaceId, name: ws.name, vertical: prefs?.vertical ?? ws.vertical },
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

/** Plan cap on mail retention (D-036): the effective window is min(preferences.retention_days, this). */
export async function getEntitlementRetentionDays(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
): Promise<number> {
  const ent = await tx.query.entitlements.findFirst({ where: eq(entitlements.workspaceId, workspaceId) });
  return ent?.retentionDays ?? 90;
}

/** Plan ceiling on active clients (docs/08 `max_clients`). */
export async function getEntitlementMaxClients(tx: WorkspaceTx, workspaceId: WorkspaceId): Promise<number> {
  const ent = await tx.query.entitlements.findFirst({ where: eq(entitlements.workspaceId, workspaceId) });
  return ent?.maxClients ?? 10;
}

/**
 * Hard delete of an account and the workspaces it owns (cascades through every workspace table). Demo/test
 * tooling only: production deletion is the logical `DELETE /v1/account` plus the `data.delete_account` job.
 * Needs an owner connection with the admin read context (RLS lets the owner delete only through its policies).
 */
export async function hardDeleteAccountByEmail(db: Db, email: string): Promise<number> {
  const found = await db.query.users.findFirst({ where: eq(users.email, email.trim().toLowerCase()) });
  if (!found) return 0;
  const owned = await db.delete(workspaces).where(eq(workspaces.ownerId, found.id)).returning({ id: workspaces.id });
  await db.delete(users).where(eq(users.id, found.id));
  return owned.length;
}

/** Liveness check for the API session guard: false once the user or the workspace is logically deleted. */
export async function isAccountActive(db: Db, userId: UserId, workspaceId: WorkspaceId): Promise<boolean> {
  const [user] = await db.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, userId)).limit(1);
  const [ws] = await db
    .select({ deletedAt: workspaces.deletedAt })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return user !== undefined && ws !== undefined && user.deletedAt === null && ws.deletedAt === null;
}

export interface SoftDeleteResult {
  deleted: boolean;
  revokedAccounts: number;
}

/**
 * Logical deletion (D-050/D-054, `DELETE /v1/account`): user and workspace marked deleted, every integration
 * account revoked with its encrypted tokens wiped (no dispatcher syncs it again), one audit row; all in one
 * transaction. Idempotent. The
 * physical purge is the phase 5 `data.delete_account` job.
 */
export async function softDeleteAccount(
  db: Db,
  input: { userId: UserId; workspaceId: WorkspaceId; now: Date },
): Promise<SoftDeleteResult> {
  return db.transaction(async (tx) => {
    const marked = await tx
      .update(users)
      .set({ deletedAt: input.now })
      .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
      .returning({ id: users.id });
    if (marked.length === 0) return { deleted: false, revokedAccounts: 0 };
    await tx
      .update(workspaces)
      .set({ deletedAt: input.now })
      .where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.ownerId, input.userId)));
    await tx.execute(sql`select set_config('app.workspace_id', ${input.workspaceId}, true)`);
    const revoked = await tx
      .update(integrationAccounts)
      // The ciphertext goes too (docs/06 §1): the caller revokes the tokens at the provider before this runs.
      .set({ status: "revoked", lastError: "account deleted", encryptedTokens: "" })
      .where(eq(integrationAccounts.workspaceId, input.workspaceId))
      .returning({ id: integrationAccounts.id });
    await audit(
      tx,
      { workspaceId: input.workspaceId, actor: "user", actorUserId: input.userId },
      {
        action: "account.deleted",
        entityType: "workspace",
        entityId: input.workspaceId,
        after: { revokedAccounts: revoked.length, purge: "data.delete_account" },
      },
    );
    return { deleted: true, revokedAccounts: revoked.length };
  });
}
