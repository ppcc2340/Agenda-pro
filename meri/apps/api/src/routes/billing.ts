/**
 * Billing (D-058..D-061, D-066, ADR 0006): checkout with the local trial carried over, portal, cancel with survey,
 * reactivation, credit packs and the simulated checkout completion. The provider is the source of truth: every
 * change is mirrored from the snapshot it returns, and webhooks confirm it later (idempotently).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CANCELLATION_REASONS,
  applySubscriptionSnapshot,
  audit,
  getAccess,
  getCreditBalance,
  getEntitlements,
  getSubscription,
  linkStripeCustomer,
  recordCancellationFeedback,
  type Db,
} from "@meri/db";
import {
  FakeBilling,
  IntegrationError,
  type Analytics,
  type BillingProvider,
  type SubscriptionSnapshot,
} from "@meri/integrations";
import { processBillingEvent, track } from "@meri/jobs";
import type { Logger } from "@meri/config";
import { ApiError } from "../errors";
import { requireSession, sessionOf } from "../plugins/session";

const HOUR_MS = 3_600_000;
/** [M10] Checkout carries the local trial only if at least this much of it is left; otherwise it charges now. */
export const MIN_TRIAL_CARRYOVER_MS = 48 * HOUR_MS;

export interface BillingRoutesOptions {
  db: Db;
  billing: BillingProvider;
  analytics: Analytics;
  logger: Logger;
  now: () => Date;
  appUrl: string;
  /** The simulated completion route exists only with fake billing outside production ([M4]). */
  allowFakeCompletion: boolean;
}

const SubscriptionView = z.object({
  plan: z.enum(["trial", "pro", "pro_plus"]),
  status: z.enum(["trialing", "active", "past_due", "canceled", "unpaid", "incomplete"]),
  interval: z.enum(["month", "year"]).nullable(),
  trialEndsAt: z.string().datetime().nullable(),
  currentPeriodEnd: z.string().datetime().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  hasPaymentMethod: z.boolean(),
  hasBillingAccount: z.boolean(),
  access: z.object({
    active: z.boolean(),
    reason: z.enum([
      "trial",
      "trial_card_on_file",
      "active",
      "past_due",
      "trial_ended",
      "canceled",
      "unpaid",
    ]),
    trialDaysLeft: z.number().int().nullable(),
  }),
  entitlements: z.object({
    maxClients: z.number().int(),
    aiCreditsMonthly: z.number().int(),
    retentionDays: z.number().int(),
    features: z.array(z.string()),
  }),
  credits: z.object({ allowance: z.number(), used: z.number(), remaining: z.number() }),
  mode: z.enum(["fake", "live"]),
});
const UrlView = z.object({ url: z.string() });
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** [M5] Billing writes are never retried blindly: the Idempotency-Key header is mandatory. */
function requireIdempotencyKey(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: (err?: Error) => void,
): void {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || key.trim() === "") {
    done(new ApiError("VALIDATION_FAILED", "Idempotency-Key header is required for billing requests."));
    return;
  }
  done();
}

/** Provider failures become stable problems: never a 500 for a declined or unavailable provider. */
async function provider<T>(log: FastifyRequest["log"], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IntegrationError) {
      log.warn({ kind: err.kind, provider: err.provider }, "billing provider call failed");
      throw new ApiError("CONFLICT", "The billing provider could not complete the request. Try again later.");
    }
    throw err;
  }
}

export function billingRoutes(app: FastifyInstance, options: BillingRoutesOptions, done: () => void): void {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const keyOf = (request: FastifyRequest, intent: string) =>
    `${intent}-${sessionOf(request).workspaceId}-${request.headers["idempotency-key"] as string}`;
  /**
   * One provider customer per workspace, created and linked before the first checkout, so two checkouts in two tabs
   * share it and the second subscription is recognised as a duplicate (security review M3).
   */
  const customerFor = async (request: FastifyRequest, current: string | null): Promise<string> => {
    const session = sessionOf(request);
    const customerId = await provider(request.log, () =>
      options.billing.ensureCustomer({
        workspaceId: session.workspaceId,
        email: session.email,
        customerId: current,
      }),
    );
    if (customerId !== current)
      await request.withWorkspace((tx) => linkStripeCustomer(tx, session.workspaceId, customerId));
    return customerId;
  };
  /** After a write, mirror what the provider now says, not the write's response (review H1). */
  const reread = async (
    request: FastifyRequest,
    written: SubscriptionSnapshot,
  ): Promise<SubscriptionSnapshot> =>
    (await provider(request.log, () => options.billing.getSubscription(written.subscriptionId))) ?? written;
  const writes = { preHandler: [requireSession, requireIdempotencyKey] };
  const returnUrl = (status: string) => `${options.appUrl}/control?billing=${status}#plan`;

  r.get(
    "/v1/billing/subscription",
    { preHandler: requireSession, schema: { tags: ["billing"], response: { 200: SubscriptionView } } },
    async (request) => {
      const session = sessionOf(request);
      const now = options.now();
      return request.withWorkspace(async (tx) => {
        const sub = await getSubscription(tx, session.workspaceId);
        if (!sub) throw new ApiError("NOT_FOUND", "Subscription not found.");
        const ent = await getEntitlements(tx, session.workspaceId);
        const credits = await getCreditBalance(tx, session.workspaceId, now);
        return {
          plan: sub.plan,
          status: sub.status,
          interval: sub.priceInterval,
          trialEndsAt: iso(sub.trialEndsAt),
          currentPeriodEnd: iso(sub.currentPeriodEnd),
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          hasPaymentMethod: sub.hasPaymentMethod,
          hasBillingAccount: sub.stripeCustomerId !== null,
          access: await getAccess(tx, session.workspaceId, now),
          entitlements: {
            maxClients: ent.maxClients,
            aiCreditsMonthly: ent.aiCreditsMonthly,
            retentionDays: ent.retentionDays,
            features: ent.features,
          },
          credits: { allowance: credits.allowance, used: credits.used, remaining: credits.remaining },
          mode: options.billing.mode,
        };
      });
    },
  );

  r.post(
    "/v1/billing/checkout",
    {
      ...writes,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["billing"],
        body: z.object({ plan: z.enum(["pro", "pro_plus"]), interval: z.enum(["month", "year"]) }),
        response: { 200: UrlView },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const now = options.now();
      const sub = await request.withWorkspace((tx) => getSubscription(tx, session.workspaceId));
      if (!sub) throw new ApiError("NOT_FOUND", "Subscription not found.");
      // A live paid subscription changes plan in the portal (proration is the provider's job).
      if (sub.stripeSubscriptionId && sub.status !== "canceled")
        throw new ApiError(
          "CONFLICT",
          "You already have a subscription; change plan from the billing portal.",
        );
      const trialLeft =
        sub.status === "trialing" && sub.trialEndsAt ? sub.trialEndsAt.getTime() - now.getTime() : 0;
      const trialEnd =
        trialLeft >= MIN_TRIAL_CARRYOVER_MS && sub.trialEndsAt ? sub.trialEndsAt.toISOString() : null;
      const customerId = await customerFor(request, sub.stripeCustomerId);
      const checkout = await provider(request.log, () =>
        options.billing.createCheckoutSession({
          workspaceId: session.workspaceId,
          email: session.email,
          customerId,
          successUrl: returnUrl("success"),
          cancelUrl: returnUrl("cancelled"),
          idempotencyKey: keyOf(request, "checkout"),
          plan: request.body.plan,
          interval: request.body.interval,
          trialEnd,
        }),
      );
      await request.withWorkspace((tx) =>
        audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: "billing.checkout_started",
            entityType: "workspace",
            entityId: session.workspaceId,
            after: {
              plan: request.body.plan,
              interval: request.body.interval,
              trialCarriedOver: trialEnd !== null,
            },
          },
        ),
      );
      return { url: checkout.url };
    },
  );

  r.post(
    "/v1/billing/credit-packs",
    {
      ...writes,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags: ["billing"],
        body: z.object({ pack: z.enum(["500", "2000"]) }),
        response: { 200: UrlView },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const now = options.now();
      const { sub, access } = await request.withWorkspace(async (tx) => ({
        sub: await getSubscription(tx, session.workspaceId),
        access: await getAccess(tx, session.workspaceId, now),
      }));
      // Credits only help while the AI can run: an ended trial or a cancelled plan needs a plan first.
      if (!sub || !access.active)
        throw new ApiError("ENTITLEMENT_REQUIRED", "An active plan is required to buy credits.");
      const customerId = await customerFor(request, sub.stripeCustomerId);
      const checkout = await provider(request.log, () =>
        options.billing.createCreditPackCheckout({
          workspaceId: session.workspaceId,
          email: session.email,
          customerId,
          successUrl: returnUrl("credits"),
          cancelUrl: returnUrl("cancelled"),
          idempotencyKey: keyOf(request, "pack"),
          pack: request.body.pack,
        }),
      );
      return { url: checkout.url };
    },
  );

  r.post(
    "/v1/billing/portal",
    { ...writes, schema: { tags: ["billing"], response: { 200: UrlView } } },
    async (request) => {
      const session = sessionOf(request);
      const sub = await request.withWorkspace((tx) => getSubscription(tx, session.workspaceId));
      const customerId = sub?.stripeCustomerId;
      if (!customerId) throw new ApiError("CONFLICT", "There is no billing account yet: add a card first.");
      return provider(request.log, () =>
        options.billing.createPortalSession({ customerId, returnUrl: returnUrl("portal") }),
      );
    },
  );

  r.post(
    "/v1/billing/cancel",
    {
      ...writes,
      schema: {
        tags: ["billing"],
        body: z.object({
          reason: z.enum(CANCELLATION_REASONS),
          comment: z.string().max(500).nullable().optional(),
        }),
        response: {
          200: SubscriptionView.pick({ status: true, cancelAtPeriodEnd: true, currentPeriodEnd: true }),
        },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const now = options.now();
      const sub = await request.withWorkspace((tx) => getSubscription(tx, session.workspaceId));
      const subscriptionId = sub?.stripeSubscriptionId;
      if (!subscriptionId || sub.status === "canceled")
        throw new ApiError("CONFLICT", "There is no active subscription to cancel.");
      const snapshot = await reread(
        request,
        await provider(request.log, () =>
          options.billing.cancelSubscription(subscriptionId, {
            atPeriodEnd: true,
            idempotencyKey: keyOf(request, "cancel"),
          }),
        ),
      );
      if (!snapshot.cancelAtPeriodEnd && snapshot.status !== "canceled")
        throw new ApiError("CONFLICT", "The billing provider did not confirm the cancellation. Try again.");
      const after = await request.withWorkspace(async (tx) => {
        const applied = await applySubscriptionSnapshot(tx, session.workspaceId, snapshot, {
          eventAt: null,
          now,
        });
        if (!applied.applied)
          throw new ApiError("CONFLICT", "The subscription does not belong to this workspace.");
        await recordCancellationFeedback(
          tx,
          session.workspaceId,
          { reason: request.body.reason, comment: request.body.comment ?? null },
          now,
        );
        // The comment stays in cancellation_feedback: never in the audit trail, the logs or analytics.
        await audit(
          tx,
          { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
          {
            action: "billing.cancel_requested",
            entityType: "workspace",
            entityId: session.workspaceId,
            before: { cancelAtPeriodEnd: sub.cancelAtPeriodEnd },
            after: { cancelAtPeriodEnd: true, reason: request.body.reason, subscriptionId },
          },
        );
        return applied.after;
      });
      track(options.analytics, "subscription_cancelled", session.workspaceId, {
        reason: request.body.reason,
      });
      return {
        status: after.status,
        cancelAtPeriodEnd: after.cancelAtPeriodEnd,
        currentPeriodEnd: iso(after.currentPeriodEnd),
      };
    },
  );

  r.post(
    "/v1/billing/reactivate",
    {
      ...writes,
      schema: {
        tags: ["billing"],
        response: { 200: z.object({ status: z.enum(["resumed", "checkout"]), url: z.string().nullable() }) },
      },
    },
    async (request) => {
      const session = sessionOf(request);
      const now = options.now();
      const sub = await request.withWorkspace((tx) => getSubscription(tx, session.workspaceId));
      if (!sub?.stripeSubscriptionId)
        throw new ApiError("CONFLICT", "There is no subscription to reactivate.");
      const subscriptionId = sub.stripeSubscriptionId;
      const periodLeft = sub.currentPeriodEnd !== null && sub.currentPeriodEnd.getTime() > now.getTime();
      if (sub.status !== "canceled" && periodLeft) {
        if (!sub.cancelAtPeriodEnd)
          throw new ApiError("CONFLICT", "The subscription is not scheduled to end.");
        const snapshot = await reread(
          request,
          await provider(request.log, () =>
            options.billing.resumeSubscription(subscriptionId, { idempotencyKey: keyOf(request, "resume") }),
          ),
        );
        await request.withWorkspace(async (tx) => {
          const applied = await applySubscriptionSnapshot(tx, session.workspaceId, snapshot, {
            eventAt: null,
            now,
          });
          if (!applied.applied)
            throw new ApiError("CONFLICT", "The subscription does not belong to this workspace.");
          await audit(
            tx,
            { workspaceId: session.workspaceId, actor: "user", actorUserId: session.userId },
            {
              action: "billing.reactivated",
              entityType: "workspace",
              entityId: session.workspaceId,
              before: { cancelAtPeriodEnd: true },
              after: { cancelAtPeriodEnd: false, subscriptionId },
            },
          );
        });
        return { status: "resumed" as const, url: null };
      }
      // The period is over: a new subscription of the same plan, charged now.
      const checkout = await provider(request.log, () =>
        options.billing.createCheckoutSession({
          workspaceId: session.workspaceId,
          email: session.email,
          customerId: sub.stripeCustomerId,
          successUrl: returnUrl("success"),
          cancelUrl: returnUrl("cancelled"),
          idempotencyKey: keyOf(request, "reactivate"),
          plan: sub.plan === "trial" ? "pro" : sub.plan,
          interval: sub.priceInterval ?? "month",
          trialEnd: null,
        }),
      );
      return { status: "checkout" as const, url: checkout.url };
    },
  );

  if (options.allowFakeCompletion && options.billing instanceof FakeBilling) {
    const fake = options.billing;
    // [M4] The simulated hosted checkout: signs the provider event and runs it through the real webhook handler.
    r.get(
      "/v1/billing/fake/complete",
      {
        preHandler: requireSession,
        schema: {
          tags: ["billing"],
          hide: true,
          querystring: z.object({ session: z.string().min(1).max(100) }),
        },
      },
      async (request, reply) => {
        const session = sessionOf(request);
        const checkout = fake.sessions.get(request.query.session);
        if (checkout?.workspaceId !== session.workspaceId)
          throw new ApiError("NOT_FOUND", "Checkout not found.");
        if (!checkout.completed) {
          const signed = fake.completeCheckout(checkout.id);
          const event = await fake.parseWebhook(signed.rawBody, signed.signature);
          await processBillingEvent(
            {
              db: options.db,
              billing: fake,
              analytics: options.analytics,
              logger: options.logger,
              now: options.now,
            },
            event,
          );
        }
        return reply.redirect(returnUrl(checkout.mode === "payment" ? "credits" : "success"), 303);
      },
    );
  }

  done();
}
