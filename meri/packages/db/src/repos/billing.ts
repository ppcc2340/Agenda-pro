/**
 * Phase 4 billing state (D-058..D-061, ADR 0006): the local subscription mirror, entitlements derived from the plan
 * catalogue, webhook idempotency, credit packs, credit usage and the cancellation survey.
 */
import { and, count, desc, eq, sql } from "drizzle-orm";
import {
  accessFor,
  creditBalance,
  entitlementsFor,
  isPlanCode,
  type Access,
  type CreditBalance,
  type PlanCode,
  type SubscriptionState,
  type SubscriptionStatus,
} from "@meri/core";
import type { Db } from "../client";
import {
  aiUsage,
  cancellationFeedback,
  creditGrants,
  entitlements,
  stripeEvents,
  subscriptions,
  workspaces,
} from "../schema";
import type { WorkspaceTx } from "../workspace";
import { newId, type WorkspaceId } from "../ids";
import { periodOf } from "./ai-usage";

const DAY_MS = 86_400_000;
/** [H2] after a downgrade the previous retention is honoured this long. */
export const RETENTION_GRACE_DAYS = 30;

const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "incomplete",
];
const asStatus = (s: string): SubscriptionStatus =>
  (SUBSCRIPTION_STATUSES as readonly string[]).includes(s) ? (s as SubscriptionStatus) : "unpaid";

export interface SubscriptionView extends SubscriptionState {
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  priceInterval: "month" | "year" | null;
  lastEventAt: Date | null;
}

export interface EntitlementsView {
  maxClients: number;
  aiCreditsMonthly: number;
  retentionDays: number;
  features: string[];
  previousRetentionDays: number | null;
  retentionGraceUntil: Date | null;
}

type SubRow = typeof subscriptions.$inferSelect;
const toSubscription = (r: SubRow): SubscriptionView => ({
  plan: isPlanCode(r.plan) ? r.plan : "trial",
  status: asStatus(r.status),
  trialEndsAt: r.trialEndsAt,
  currentPeriodEnd: r.currentPeriodEnd,
  cancelAtPeriodEnd: r.cancelAtPeriodEnd,
  hasPaymentMethod: r.hasPaymentMethod,
  stripeCustomerId: r.stripeCustomerId,
  stripeSubscriptionId: r.stripeSubscriptionId,
  priceInterval: r.priceInterval === "month" || r.priceInterval === "year" ? r.priceInterval : null,
  lastEventAt: r.lastEventAt,
});

export async function getSubscription(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
): Promise<SubscriptionView | null> {
  const row = await tx.query.subscriptions.findFirst({ where: eq(subscriptions.workspaceId, workspaceId) });
  return row ? toSubscription(row) : null;
}

export async function getEntitlements(tx: WorkspaceTx, workspaceId: WorkspaceId): Promise<EntitlementsView> {
  const row = await tx.query.entitlements.findFirst({ where: eq(entitlements.workspaceId, workspaceId) });
  const fallback = entitlementsFor("trial");
  return {
    maxClients: row?.maxClients ?? fallback.maxClients,
    aiCreditsMonthly: row?.aiCreditsMonthly ?? fallback.aiCreditsMonthly,
    retentionDays: row?.retentionDays ?? fallback.retentionDays,
    features: row?.features ?? [...fallback.features],
    previousRetentionDays: row?.previousRetentionDays ?? null,
    retentionGraceUntil: row?.retentionGraceUntil ?? null,
  };
}

/** Effective access now (D-058). A workspace without a subscription row is treated as an ended trial. */
export async function getAccess(tx: WorkspaceTx, workspaceId: WorkspaceId, now: Date): Promise<Access> {
  const sub = await getSubscription(tx, workspaceId);
  if (!sub) return { active: false, reason: "trial_ended", trialDaysLeft: 0 };
  return accessFor(sub, now);
}

/**
 * [H2] Retention the purge may apply at `now`: the plan's, except during the grace window after a downgrade
 * (the longer previous value holds).
 */
export function effectiveRetentionDays(ent: EntitlementsView, now: Date): number {
  if (
    ent.previousRetentionDays !== null &&
    ent.retentionGraceUntil !== null &&
    ent.retentionGraceUntil.getTime() > now.getTime()
  )
    return Math.max(ent.retentionDays, ent.previousRetentionDays);
  return ent.retentionDays;
}

/** Provider snapshot as the db layer needs it (mirrors `@meri/integrations` SubscriptionSnapshot). */
export interface SnapshotInput {
  customerId: string;
  subscriptionId: string;
  plan: Exclude<PlanCode, "trial">;
  interval: "month" | "year";
  status: SubscriptionStatus;
  trialEnd: string | null;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  hasPaymentMethod: boolean;
}

export type ApplyResult =
  | { applied: true; before: SubscriptionView | null; after: SubscriptionView; entitlementsChanged: boolean }
  | {
      applied: false;
      reason: "stale" | "customer_mismatch" | "duplicate_subscription" | "no_subscription_row";
    };

/**
 * Mirrors the canonical provider subscription into the workspace (webhooks and API-initiated changes).
 * - `eventAt` (webhooks only): an event older than the last one applied changes nothing ([H1]).
 * - A different provider customer than the one already linked is refused ([H1] "workspace ajeno").
 * - Entitlements follow the plan while the subscription is live; canceling, unpaid or incomplete never downgrade
 *   them (access decides, [H2]). A trial with a card keeps the trial allowance until the first charge.
 */
export async function applySubscriptionSnapshot(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  snap: SnapshotInput,
  options: { eventAt: Date | null; now: Date },
): Promise<ApplyResult> {
  const [row] = await tx
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.workspaceId, workspaceId))
    .for("update")
    .limit(1);
  if (!row) return { applied: false, reason: "no_subscription_row" };
  if (row.stripeCustomerId !== null && row.stripeCustomerId !== snap.customerId)
    return { applied: false, reason: "customer_mismatch" };
  // A second live subscription for the same workspace (two checkouts completed): the first one stays the plan and
  // the caller cancels the newcomer at the provider (security review M3). A canceled one may be replaced.
  if (
    row.stripeSubscriptionId !== null &&
    row.stripeSubscriptionId !== snap.subscriptionId &&
    row.status !== "canceled"
  )
    return { applied: false, reason: "duplicate_subscription" };
  if (options.eventAt && row.lastEventAt && options.eventAt.getTime() < row.lastEventAt.getTime())
    return { applied: false, reason: "stale" };

  const before = toSubscription(row);
  const [updated] = await tx
    .update(subscriptions)
    .set({
      stripeCustomerId: snap.customerId,
      stripeSubscriptionId: snap.subscriptionId,
      plan: snap.plan,
      status: snap.status,
      // A local trial keeps its end date when the provider has none (e.g. checkout without trial).
      trialEndsAt: snap.trialEnd
        ? new Date(snap.trialEnd)
        : snap.status === "trialing"
          ? row.trialEndsAt
          : null,
      currentPeriodEnd: new Date(snap.currentPeriodEnd),
      cancelAtPeriodEnd: snap.cancelAtPeriodEnd,
      priceInterval: snap.interval,
      hasPaymentMethod: snap.hasPaymentMethod,
      lastEventAt: options.eventAt ?? row.lastEventAt,
      updatedAt: options.now,
    })
    .where(eq(subscriptions.workspaceId, workspaceId))
    .returning();
  if (!updated) throw new Error(`subscription row of ${workspaceId} vanished during update`);

  let entitlementsChanged = false;
  if (snap.status === "active" || snap.status === "past_due" || snap.status === "trialing") {
    const target = entitlementsFor(snap.status === "trialing" ? "trial" : snap.plan);
    if (snap.status === "trialing") {
      // Trial with a card: limits of the chosen plan, allowance of the trial (docs/08 "créditos limitados").
      const chosen = entitlementsFor(snap.plan);
      target.maxClients = chosen.maxClients;
      target.retentionDays = chosen.retentionDays;
      target.features = chosen.features;
    }
    entitlementsChanged = await setEntitlements(tx, workspaceId, target, options.now);
  }
  return { applied: true, before, after: toSubscription(updated), entitlementsChanged };
}

/** Writes entitlements; a shorter retention starts the [H2] grace window. Returns whether anything changed. */
export async function setEntitlements(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  target: { maxClients: number; aiCreditsMonthly: number; retentionDays: number; features: string[] },
  now: Date,
): Promise<boolean> {
  const current = await getEntitlements(tx, workspaceId);
  const same =
    current.maxClients === target.maxClients &&
    current.aiCreditsMonthly === target.aiCreditsMonthly &&
    current.retentionDays === target.retentionDays &&
    JSON.stringify([...current.features].sort()) === JSON.stringify([...target.features].sort());
  if (same) return false;
  const downgraded = target.retentionDays < current.retentionDays;
  await tx
    .insert(entitlements)
    .values({ workspaceId, ...target, updatedAt: now })
    .onConflictDoUpdate({
      target: entitlements.workspaceId,
      set: {
        ...target,
        ...(downgraded
          ? {
              previousRetentionDays: current.retentionDays,
              retentionGraceUntil: new Date(now.getTime() + RETENTION_GRACE_DAYS * DAY_MS),
            }
          : {}),
        updatedAt: now,
      },
    });
  return true;
}

/** Links the provider customer created by a checkout before the subscription snapshot arrives. */
export async function linkStripeCustomer(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  customerId: string,
): Promise<boolean> {
  const rows = await tx
    .update(subscriptions)
    .set({ stripeCustomerId: customerId })
    .where(and(eq(subscriptions.workspaceId, workspaceId), sql`${subscriptions.stripeCustomerId} is null`))
    .returning({ id: subscriptions.id });
  return rows.length > 0;
}

/** Webhook idempotency (D-060): true only the first time an event id is seen. */
export async function recordStripeEvent(
  tx: WorkspaceTx | Db,
  eventId: string,
  type: string,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .insert(stripeEvents)
    .values({ id: eventId, type, processedAt: now })
    .onConflictDoNothing()
    .returning({ id: stripeEvents.id });
  return rows.length > 0;
}

/** True when the workspace exists and is not logically deleted (D-054): webhooks for others are ignored. */
export async function isWorkspaceLive(db: Db, workspaceId: WorkspaceId): Promise<boolean> {
  const [row] = await db
    .select({ deletedAt: workspaces.deletedAt })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  return row !== undefined && row.deletedAt === null;
}

// ---------- Credits (D-061) ----------

/** Grants a purchased pack once per provider event ([L16]: valid for the calendar month of purchase). */
export async function grantCreditPack(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: { pack: string; credits: number; sourceEventId: string; purchasedAt: Date },
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .insert(creditGrants)
    .values({
      id: newId(),
      workspaceId,
      credits: input.credits,
      pack: input.pack,
      // [L16] valid in the month of purchase, even when the webhook is processed after midnight.
      period: periodOf(input.purchasedAt),
      sourceEventId: input.sourceEventId,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: creditGrants.id });
  return rows.length > 0;
}

export async function creditsUsed(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  period: string,
): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${aiUsage.credits}), 0)` })
    .from(aiUsage)
    .where(and(eq(aiUsage.workspaceId, workspaceId), eq(aiUsage.period, period)));
  return Number(row?.total ?? 0);
}

export async function creditsGranted(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  period: string,
): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${creditGrants.credits}), 0)` })
    .from(creditGrants)
    .where(and(eq(creditGrants.workspaceId, workspaceId), eq(creditGrants.period, period)));
  return Number(row?.total ?? 0);
}

/** Balance of the current calendar month: plan allowance + packs − usage. */
export async function getCreditBalance(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  now: Date,
): Promise<CreditBalance> {
  const period = periodOf(now);
  const [ent, granted, used] = await Promise.all([
    getEntitlements(tx, workspaceId),
    creditsGranted(tx, workspaceId, period),
    creditsUsed(tx, workspaceId, period),
  ]);
  return creditBalance({ monthly: ent.aiCreditsMonthly, granted, used });
}

/** How many AI calls of one operation ran this period (Pro's monthly briefing allowance, [L13]). */
export async function countAiOperations(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  operation: string,
  period: string,
): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(aiUsage)
    .where(
      and(eq(aiUsage.workspaceId, workspaceId), eq(aiUsage.period, period), eq(aiUsage.operation, operation)),
    );
  return row?.n ?? 0;
}

// ---------- Cancellation survey (D-066) ----------

export const CANCELLATION_REASONS = [
  "price",
  "not_using",
  "missing_feature",
  "switched_tool",
  "privacy",
  "other",
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

export async function recordCancellationFeedback(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: { reason: CancellationReason; comment: string | null },
  now: Date,
): Promise<string> {
  const id = newId();
  await tx.insert(cancellationFeedback).values({
    id,
    workspaceId,
    reason: input.reason,
    comment: input.comment?.trim() ? input.comment.trim().slice(0, 500) : null,
    createdAt: now,
  });
  return id;
}

export async function listCancellationFeedback(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
): Promise<{ id: string; reason: string; comment: string | null; createdAt: Date }[]> {
  return tx
    .select({
      id: cancellationFeedback.id,
      reason: cancellationFeedback.reason,
      comment: cancellationFeedback.comment,
      createdAt: cancellationFeedback.createdAt,
    })
    .from(cancellationFeedback)
    .where(eq(cancellationFeedback.workspaceId, workspaceId))
    .orderBy(desc(cancellationFeedback.createdAt));
}

/** Moves the local trial end (demo seed and operator tooling only; the bootstrap sets the 14-day default). */
export async function setTrialEndsAt(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  trialEndsAt: Date,
): Promise<void> {
  await tx.update(subscriptions).set({ trialEndsAt }).where(eq(subscriptions.workspaceId, workspaceId));
}
