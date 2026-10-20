import { describe, expect, it } from "vitest";
import { createLogger } from "@meri/config";
import { createDb } from "@meri/db";
import { FakeBilling, IntegrationError, NoopAnalytics, type BillingWebhookEvent } from "@meri/integrations";
import { processBillingEvent } from "./billing-events";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const NOW = new Date("2026-10-20T08:40:00Z");
const event = (id: string): BillingWebhookEvent => ({
  id,
  type: "customer.subscription.updated",
  createdAt: NOW.toISOString(),
  workspaceId: null,
  customerId: "cus_x",
  subscriptionId: "sub_x",
  checkout: null,
  invoice: null,
});

describe("processBillingEvent: provider errors (code review L1, security L4)", () => {
  it("acknowledges an object Meri cannot map (Permanent) and lets transient errors propagate for a retry", async () => {
    const handle = createDb(TEST_APP_URL, { max: 1 });
    const billing = new FakeBilling(() => NOW);
    const deps = {
      db: handle.db,
      billing,
      analytics: new NoopAnalytics(),
      logger: createLogger({ name: "t", level: "silent" }),
      now: () => NOW,
    };
    try {
      billing.getSubscription = () =>
        Promise.reject(
          new IntegrationError("Permanent", "stripe", "subscription sub_x has no known Meri price"),
        );
      await expect(processBillingEvent(deps, event(`evt_${crypto.randomUUID()}`))).resolves.toEqual({
        status: "ignored",
        reason: "unhandled",
      });
      billing.getSubscription = () => Promise.reject(new IntegrationError("Transient", "stripe", "503"));
      await expect(processBillingEvent(deps, event(`evt_${crypto.randomUUID()}`))).rejects.toThrow(/503/);
    } finally {
      await handle.close();
    }
  });
});
