import { z } from "zod";
import { IntegrationError } from "../errors";
import type { BillingEventType, BillingWebhookEvent, CreditPackCode } from "./types";

/**
 * Stripe event JSON → BillingWebhookEvent (ADR 0006 §3). Shared by the live adapter and the fake (which emits
 * Stripe-shaped events), so every test of the fake also exercises this mapping. Pinned to Stripe-Version
 * 2024-06-20 (`invoice.subscription` at the top level), with the newer `parent.subscription_details` as fallback.
 */
export const STRIPE_API_VERSION = "2024-06-20";

const KNOWN: readonly BillingEventType[] = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];

const Id = z.string().min(1).max(255);
const Metadata = z.record(z.string(), z.string()).nullish();
const Ref = z
  .union([Id, z.object({ id: Id })])
  .nullish()
  .transform((v) => (v === null || v === undefined ? null : typeof v === "string" ? v : v.id));

const EventEnvelope = z.object({
  id: Id,
  type: z.string().min(1).max(100),
  created: z.number().int().nonnegative(),
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});
const CheckoutObject = z.object({
  id: Id,
  mode: z.enum(["subscription", "payment", "setup"]),
  client_reference_id: z.string().nullish(),
  customer: Ref,
  subscription: Ref,
  metadata: Metadata,
});
const SubscriptionObject = z.object({ id: Id, customer: Ref, metadata: Metadata });
const InvoiceObject = z.object({
  id: Id,
  customer: Ref,
  subscription: Ref,
  amount_paid: z.number().int().nonnegative().default(0),
  parent: z
    .object({ subscription_details: z.object({ subscription: Ref, metadata: Metadata }).nullish() })
    .nullish(),
});

const UUID = z.string().uuid();
const workspaceOf = (...candidates: (string | null | undefined)[]): string | null => {
  for (const c of candidates) if (c && UUID.safeParse(c).success) return c;
  return null;
};
const packOf = (value: string | undefined): CreditPackCode | null =>
  value === "500" || value === "2000" ? value : null;

export function normalizeStripeEvent(raw: unknown): BillingWebhookEvent {
  const env = EventEnvelope.safeParse(raw);
  if (!env.success) throw new IntegrationError("Permanent", "stripe", "malformed webhook event");
  const { id, type, created, data } = env.data;
  const base: BillingWebhookEvent = {
    id,
    type: (KNOWN as readonly string[]).includes(type) ? (type as BillingEventType) : "other",
    createdAt: new Date(created * 1000).toISOString(),
    workspaceId: null,
    customerId: null,
    subscriptionId: null,
    checkout: null,
    invoice: null,
  };
  const bad = () => new IntegrationError("Permanent", "stripe", `malformed ${type} object`);
  if (base.type === "checkout.session.completed") {
    const o = CheckoutObject.safeParse(data.object);
    if (!o.success) throw bad();
    return {
      ...base,
      workspaceId: workspaceOf(o.data.metadata?.workspaceId, o.data.client_reference_id),
      customerId: o.data.customer,
      subscriptionId: o.data.subscription,
      checkout: {
        mode: o.data.mode === "payment" ? "payment" : "subscription",
        sessionId: o.data.id,
        creditPack: packOf(o.data.metadata?.creditPack),
      },
    };
  }
  if (base.type.startsWith("customer.subscription.")) {
    const o = SubscriptionObject.safeParse(data.object);
    if (!o.success) throw bad();
    return {
      ...base,
      workspaceId: workspaceOf(o.data.metadata?.workspaceId),
      customerId: o.data.customer,
      subscriptionId: o.data.id,
    };
  }
  if (base.type.startsWith("invoice.")) {
    const o = InvoiceObject.safeParse(data.object);
    if (!o.success) throw bad();
    const details = o.data.parent?.subscription_details;
    return {
      ...base,
      workspaceId: workspaceOf(details?.metadata?.workspaceId),
      customerId: o.data.customer,
      subscriptionId: o.data.subscription ?? details?.subscription ?? null,
      invoice: { amountPaidCents: o.data.amount_paid },
    };
  }
  return base;
}

export function parseStripeJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody) as unknown;
  } catch (cause) {
    throw new IntegrationError("Permanent", "stripe", "malformed webhook event", { cause });
  }
}
