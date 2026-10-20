/**
 * Billing webhook effects (D-060, [H1], ADR 0006): one transaction per event, idempotent by event id, applied from
 * the provider's canonical subscription (re-read, never trusted from the body) to the workspace named in the
 * subscription's own metadata. Unknown/deleted workspaces and foreign customers are recorded and ignored.
 */
import { CREDIT_PACKS, localDateKey } from "@meri/core";
import {
  applySubscriptionSnapshot,
  audit,
  auditActionExists,
  getPreferences,
  grantCreditPack,
  insertNotification,
  isWorkspaceLive,
  recordStripeEvent,
  WorkspaceId,
  withWorkspace,
  type Db,
} from "@meri/db";
import type {
  Analytics,
  BillingProvider,
  BillingWebhookEvent,
  SubscriptionSnapshot,
} from "@meri/integrations";
import type { Logger } from "@meri/config";
import { track } from "./analytics";

export interface BillingEventDeps {
  db: Db;
  billing: BillingProvider;
  analytics: Analytics;
  logger: Logger;
  now: () => Date;
}

export type BillingEventOutcome =
  | { status: "applied"; workspaceId: string }
  | { status: "duplicate" }
  | {
      status: "ignored";
      reason: "no_workspace" | "unknown_workspace" | "stale" | "customer_mismatch" | "unhandled";
    };

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

export async function processBillingEvent(
  deps: BillingEventDeps,
  event: BillingWebhookEvent,
): Promise<BillingEventOutcome> {
  const now = deps.now();
  const log = deps.logger.child({ eventId: event.id, eventType: event.type });
  const ignore = async (reason: Extract<BillingEventOutcome, { status: "ignored" }>["reason"]) => {
    // Recorded so a replay is a cheap no-op; never a workspace effect.
    await recordStripeEvent(deps.db, event.id, event.type, now);
    log.warn({ reason }, "billing event ignored");
    return { status: "ignored", reason } as const;
  };

  // 1. Canonical state: for subscription and invoice events the subscription is re-read from the provider.
  let snapshot: SubscriptionSnapshot | null = null;
  let workspaceRaw: string | null = event.workspaceId;
  if (
    event.subscriptionId &&
    (SUBSCRIPTION_EVENTS.has(event.type) || event.checkout?.mode === "subscription")
  ) {
    snapshot = await deps.billing.getSubscription(event.subscriptionId);
    if (!snapshot) return ignore("unhandled");
    if (event.type !== "checkout.session.completed") workspaceRaw = snapshot.workspaceId;
    // A checkout whose metadata disagrees with its own subscription's is never trusted.
    else if (snapshot.workspaceId !== null && snapshot.workspaceId !== workspaceRaw)
      return ignore("customer_mismatch");
  }
  const isPack = event.type === "checkout.session.completed" && event.checkout?.mode === "payment";
  if (!snapshot && !isPack) return ignore("unhandled");
  const parsedWs = WorkspaceId.safeParse(workspaceRaw);
  if (!parsedWs.success) return ignore("no_workspace");
  const workspaceId = parsedWs.data;
  if (!(await isWorkspaceLive(deps.db, workspaceId))) return ignore("unknown_workspace");

  // 2. Effects + idempotency marker in one transaction (a transient error rolls both back → the provider retries).
  const result = await withWorkspace(deps.db, workspaceId, async (tx) => {
    if (!(await recordStripeEvent(tx, event.id, event.type, now))) return { kind: "duplicate" as const };
    const ctx = { workspaceId, actor: "system" as const };
    const analytics: (() => void)[] = [];
    if (snapshot) {
      const applied = await applySubscriptionSnapshot(tx, workspaceId, snapshot, {
        eventAt: new Date(event.createdAt),
        now,
      });
      if (!applied.applied) return { kind: "ignored" as const, reason: applied.reason };
      await audit(tx, ctx, {
        action: "billing.subscription_synced",
        // Provider ids are not uuids: the entity is the workspace, the provider id travels in `after`.
        entityType: "workspace",
        entityId: workspaceId,
        reason: event.type,
        before: applied.before && {
          plan: applied.before.plan,
          status: applied.before.status,
          cancelAtPeriodEnd: applied.before.cancelAtPeriodEnd,
        },
        after: {
          plan: applied.after.plan,
          status: applied.after.status,
          cancelAtPeriodEnd: applied.after.cancelAtPeriodEnd,
          subscriptionId: snapshot.subscriptionId,
        },
      });
    }
    if (event.type === "invoice.paid" && (event.invoice?.amountPaidCents ?? 0) > 0) {
      // D-059: subscription_started on the first real charge only.
      const firstCharge = !(await auditActionExists(tx, workspaceId, "billing.invoice_paid"));
      await audit(tx, ctx, {
        action: "billing.invoice_paid",
        entityType: "workspace",
        entityId: workspaceId,
        after: { amountPaidCents: event.invoice?.amountPaidCents ?? 0, subscriptionId: event.subscriptionId },
      });
      const snap = snapshot;
      if (firstCharge && snap)
        analytics.push(() => {
          track(deps.analytics, "subscription_started", workspaceId, {
            plan: snap.plan,
            interval: snap.interval,
          });
        });
    }
    if (event.type === "invoice.payment_failed") {
      await audit(tx, ctx, {
        action: "billing.payment_failed",
        entityType: "workspace",
        entityId: workspaceId,
        after: { subscriptionId: event.subscriptionId },
      });
      const timezone = (await getPreferences(tx, workspaceId))?.timezone ?? "UTC";
      await insertNotification(
        tx,
        workspaceId,
        {
          kind: "billing",
          template: "billing.payment_failed",
          title: "No pudimos cobrar tu suscripción",
          body: "Actualiza tu método de pago en Control → Plan. Tu acceso sigue activo mientras lo reintentamos.",
          params: {},
          refs: [{ type: "billing_event", id: event.id }],
          day: localDateKey(now.getTime(), timezone),
        },
        now,
      );
    }
    if (isPack && event.checkout?.creditPack) {
      const pack = event.checkout.creditPack;
      const granted = await grantCreditPack(
        tx,
        workspaceId,
        { pack, credits: CREDIT_PACKS[pack], sourceEventId: event.id },
        now,
      );
      if (granted)
        await audit(tx, ctx, {
          action: "billing.credits_granted",
          entityType: "workspace",
          entityId: workspaceId,
          after: { pack, credits: CREDIT_PACKS[pack] },
        });
    }
    return { kind: "applied" as const, analytics };
  });

  if (result.kind === "duplicate") return { status: "duplicate" };
  if (result.kind === "ignored") {
    log.warn({ reason: result.reason, workspaceId }, "billing event without effects");
    return {
      status: "ignored",
      reason: result.reason === "no_subscription_row" ? "unknown_workspace" : result.reason,
    };
  }
  for (const emit of result.analytics) emit();
  log.info({ workspaceId }, "billing event applied");
  return { status: "applied", workspaceId };
}
