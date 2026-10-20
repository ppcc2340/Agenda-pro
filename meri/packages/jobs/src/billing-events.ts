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
import {
  IntegrationError,
  type Analytics,
  type BillingProvider,
  type BillingWebhookEvent,
  type CreditPackCode,
  type SubscriptionSnapshot,
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
      reason:
        | "no_workspace"
        | "unknown_workspace"
        | "stale"
        | "customer_mismatch"
        | "duplicate_subscription"
        | "awaiting_payment"
        | "unhandled";
    };

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);
const CHECKOUT_EVENTS = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded"]);

type Ignored = Extract<BillingEventOutcome, { status: "ignored" }>["reason"];

/**
 * Reads canonical provider state; a Permanent error (unknown object, a price that is not Meri's) is an event Meri
 * cannot act on: recorded and acknowledged (never a 5xx that makes the provider retry for days). Transient errors
 * propagate so the provider retries.
 */
async function canonical<T>(
  read: () => Promise<T | null>,
  log: BillingEventDeps["logger"],
): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof IntegrationError && err.kind === "Permanent") {
      log.error({ err: err.message }, "billing object Meri cannot map; acknowledged without effects");
      return null;
    }
    throw err;
  }
}

export async function processBillingEvent(
  deps: BillingEventDeps,
  event: BillingWebhookEvent,
): Promise<BillingEventOutcome> {
  const now = deps.now();
  const log = deps.logger.child({ eventId: event.id, eventType: event.type });
  const ignore = async (reason: Ignored) => {
    // Recorded so a replay is a cheap no-op; never a workspace effect.
    await recordStripeEvent(deps.db, event.id, event.type, now);
    log.warn({ reason }, "billing event ignored");
    return { status: "ignored", reason } as const;
  };

  // 1. Canonical state, never the event body (ADR 0006 §3): subscriptions and checkout sessions are re-read.
  let snapshot: SubscriptionSnapshot | null = null;
  let pack: { sessionId: string; pack: CreditPackCode; paid: boolean } | null = null;
  let workspaceRaw: string | null = null;
  const isCheckout = CHECKOUT_EVENTS.has(event.type) && event.checkout !== null;
  if (isCheckout && event.checkout?.mode === "payment") {
    const session = await canonical(
      () => deps.billing.getCheckoutSession(event.checkout?.sessionId ?? ""),
      log,
    );
    if (!session?.creditPack || session.mode !== "payment") return ignore("unhandled");
    workspaceRaw = session.workspaceId;
    pack = { sessionId: session.id, pack: session.creditPack, paid: session.paymentStatus === "paid" };
  } else if (event.subscriptionId && (SUBSCRIPTION_EVENTS.has(event.type) || isCheckout)) {
    const subscriptionId = event.subscriptionId;
    snapshot = await canonical(() => deps.billing.getSubscription(subscriptionId), log);
    if (!snapshot) return ignore("unhandled");
    workspaceRaw = snapshot.workspaceId;
    // A checkout whose metadata disagrees with its own subscription's is never trusted.
    if (isCheckout && event.workspaceId !== null && snapshot.workspaceId !== event.workspaceId)
      return ignore("customer_mismatch");
  }
  if (!snapshot && !pack) return ignore("unhandled");
  const parsedWs = WorkspaceId.safeParse(workspaceRaw);
  if (!parsedWs.success) return ignore("no_workspace");
  const workspaceId = parsedWs.data;
  if (!(await isWorkspaceLive(deps.db, workspaceId))) {
    // Backstop for account deletion (security review M2): a live subscription of a deleted workspace never
    // keeps charging, whatever happened to the cancellation at deletion time.
    if (snapshot && snapshot.status !== "canceled") {
      await deps.billing.cancelSubscription(snapshot.subscriptionId, {
        atPeriodEnd: false,
        idempotencyKey: `orphan-${snapshot.subscriptionId}`,
      });
      log.warn({ subscriptionId: snapshot.subscriptionId }, "subscription of a deleted workspace cancelled");
    }
    return ignore("unknown_workspace");
  }
  if (pack && !pack.paid) return ignore("awaiting_payment");

  // 2. Effects + idempotency marker in one transaction (a transient error rolls both back → the provider retries).
  const result = await withWorkspace(deps.db, workspaceId, async (tx) => {
    if (!(await recordStripeEvent(tx, event.id, event.type, now))) return { kind: "duplicate" as const };
    const ctx = { workspaceId, actor: "system" as const };
    const analytics: (() => void)[] = [];
    let staleMirror = false;
    if (snapshot) {
      const applied = await applySubscriptionSnapshot(tx, workspaceId, snapshot, {
        eventAt: new Date(event.createdAt),
        now,
      });
      if (!applied.applied && applied.reason === "duplicate_subscription") {
        // Two completed checkouts: the first subscription is the plan, the newcomer never charges.
        if (snapshot.status !== "canceled")
          await deps.billing.cancelSubscription(snapshot.subscriptionId, {
            atPeriodEnd: false,
            idempotencyKey: `duplicate-${snapshot.subscriptionId}`,
          });
        await audit(tx, ctx, {
          action: "billing.duplicate_cancelled",
          entityType: "workspace",
          entityId: workspaceId,
          after: { subscriptionId: snapshot.subscriptionId },
        });
        return { kind: "ignored" as const, reason: applied.reason };
      }
      if (!applied.applied && applied.reason !== "stale") {
        if (applied.reason === "customer_mismatch")
          log.error(
            { workspaceId, subscriptionId: snapshot.subscriptionId },
            "subscription of another customer",
          );
        return { kind: "ignored" as const, reason: applied.reason };
      }
      // An older event leaves the mirror alone but its own effects (invoice notices, audit) still apply.
      staleMirror = !applied.applied;
      if (applied.applied)
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
    if (pack) {
      // Keyed by the session: `completed` (paid) and a later `async_payment_succeeded` never grant twice.
      const granted = await grantCreditPack(
        tx,
        workspaceId,
        {
          pack: pack.pack,
          credits: CREDIT_PACKS[pack.pack],
          sourceEventId: `checkout:${pack.sessionId}`,
          purchasedAt: new Date(event.createdAt),
        },
        now,
      );
      if (granted)
        await audit(tx, ctx, {
          action: "billing.credits_granted",
          entityType: "workspace",
          entityId: workspaceId,
          after: { pack: pack.pack, credits: CREDIT_PACKS[pack.pack] },
        });
    }
    return { kind: "applied" as const, analytics, staleMirror };
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
  if (result.staleMirror) {
    log.info({ workspaceId }, "older billing event: mirror kept, its own effects applied");
    return { status: "ignored", reason: "stale" };
  }
  log.info({ workspaceId }, "billing event applied");
  return { status: "applied", workspaceId };
}
