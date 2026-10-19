import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseEnv, resolveModes } from "@meri/config";
import { FakeCalendar } from "./calendar";
import { FakeGmail } from "./mail";
import { FakeAiClient } from "./ai";
import { FakeBilling } from "./billing";
import { NoopAnalytics } from "./analytics";
import { createIntegrations } from "../factory";
import { IntegrationError } from "../errors";
import type { MailProvider } from "../mail/types";

const now = () => new Date("2026-10-19T10:40:00Z");

describe("FakeCalendar contract (docs/07: Meri only touches its own events)", () => {
  it("creates, updates and deletes Meri events and syncs incrementally", async () => {
    const cal = new FakeCalendar({ now });
    const id = await cal.ensureMeriCalendar();
    const ev = await cal.createMeriEvent(id, { title: "Deep work", startsAt: "2026-10-19T13:00:00Z", endsAt: "2026-10-19T15:00:00Z" });
    expect(ev.meri).toBe(true);
    const page1 = await cal.sync({ calendarId: id, cursor: null, from: "2026-10-19T00:00:00Z", to: "2026-10-20T00:00:00Z" });
    expect(page1.events.map((e) => e.externalId)).toEqual([ev.externalId]);
    const page2 = await cal.sync({ calendarId: id, cursor: page1.nextCursor, from: "2026-10-19T00:00:00Z", to: "2026-10-20T00:00:00Z" });
    expect(page2.events).toHaveLength(0);
    await expect(cal.updateMeriEvent(id, ev.externalId, { title: "x" }, "stale")).rejects.toMatchObject({ kind: "Transient" });
    const updated = await cal.updateMeriEvent(id, ev.externalId, { title: "Deep work (moved)" }, ev.etag);
    expect(updated.title).toBe("Deep work (moved)");
    await cal.deleteMeriEvent(id, ev.externalId);
    expect(cal.events.get(ev.externalId)?.status).toBe("cancelled");
    expect((await cal.sync({ calendarId: "bad", cursor: "NaN", from: "", to: "" })).fullResyncRequired).toBe(true);
  });

  it("refuses to modify or delete events it did not create", async () => {
    const cal = new FakeCalendar({ now });
    const meeting = cal.addExternalEvent({ title: "Reunión con Acme", startsAt: "2026-10-19T09:30:00Z", endsAt: "2026-10-19T10:15:00Z" });
    await expect(cal.updateMeriEvent(cal.primaryCalendarId, meeting.externalId, { title: "hijack" }, null)).rejects.toThrow(/non-Meri/);
    await expect(cal.deleteMeriEvent(cal.primaryCalendarId, meeting.externalId)).rejects.toThrow(/non-Meri/);
    await expect(cal.deleteMeriEvent(cal.meriCalendarId, "missing")).rejects.toMatchObject({ kind: "Permanent" });
    expect(cal.events.get(meeting.externalId)?.title).toBe("Reunión con Acme");
    expect(cal.currentTime().toISOString()).toBe("2026-10-19T10:40:00.000Z");
  });
});

describe("FakeGmail contract (readonly + drafts, no send)", () => {
  const msg = {
    id: "m1",
    threadId: "t1",
    from: "ana@acme.com",
    to: ["me@firm.com"],
    subject: "Contrato",
    date: "2026-10-19T09:00:00Z",
    headers: {},
    labels: ["INBOX"],
    snippet: "te envío el contrato",
    bodyText: "Hola, te envío el contrato firmado el miércoles.",
  };

  it("pages history, returns metadata without body, creates drafts and exposes no send capability", async () => {
    const mail = new FakeGmail({ email: "me@firm.com", seedMessages: [msg] });
    expect((await mail.profile()).historyId).toBe("1");
    const page = await mail.listHistory({ cursor: null });
    expect(page.messageIds).toEqual(["m1"]);
    expect((await mail.listHistory({ cursor: page.nextCursor })).messageIds).toEqual([]);
    expect((await mail.listHistory({ cursor: "99" })).fullResyncRequired).toBe(true);
    const meta = await mail.getMessageMeta("m1");
    expect(meta).not.toHaveProperty("bodyText");
    expect((await mail.getMessageFull("m1")).bodyText).toContain("contrato");
    const draft = await mail.createDraft({ threadId: "t1", inReplyToMessageId: "m1", to: ["ana@acme.com"], subject: "Re: Contrato", bodyText: "..." });
    expect(mail.drafts[0]?.draftId).toBe(draft.draftId);
    await expect(mail.getMessageMeta("nope")).rejects.toBeInstanceOf(IntegrationError);
    const asProvider: MailProvider = mail;
    expect(Object.keys(asProvider).some((k) => /send/i.test(k))).toBe(false);
    expect(Object.getOwnPropertyNames(FakeGmail.prototype).some((k) => /send/i.test(k))).toBe(false);
  });
});

describe("FakeAiClient", () => {
  it("validates handler output against the schema and records usage", async () => {
    const ai = new FakeAiClient().register("echo", ({ user }) => ({ text: user }));
    const res = await ai.complete({ operation: "echo", model: "fast", system: "s", user: "hola", schema: z.object({ text: z.string() }) });
    expect(res.output.text).toBe("hola");
    expect(res.usage.costMicroUsd).toBe(0);
    expect(ai.calls).toHaveLength(1);
    await expect(ai.complete({ operation: "echo", model: "fast", system: "s", user: "x", schema: z.object({ n: z.number() }) })).rejects.toThrow(
      /schema validation/,
    );
    await expect(ai.complete({ operation: "unknown", model: "fast", system: "s", user: "x", schema: z.any() })).rejects.toThrow(/no fake handler/);
  });
});

describe("FakeBilling and NoopAnalytics", () => {
  it("never charges, verifies webhook signatures and records analytics in memory", async () => {
    const billing = new FakeBilling(now);
    const cs = await billing.createCheckoutSession({
      workspaceId: "0192aaaa-0000-7000-8000-000000000000",
      email: "me@firm.com",
      plan: "pro",
      interval: "month",
      successUrl: "http://localhost:3000/ok",
      cancelUrl: "http://localhost:3000/cancel",
    });
    expect(cs.url).toContain("fake_checkout");
    const sub = await billing.getSubscription("fake-sub-1");
    expect(sub?.currentPeriodEnd).toBe("2026-11-18T10:40:00.000Z");
    expect((await billing.createPortalSession({ customerId: "c", returnUrl: "http://x" })).url).toContain("fake_portal");
    await expect(billing.parseWebhook("{}", "bad")).rejects.toMatchObject({ kind: "Permanent" });
    await expect(billing.parseWebhook("{}", "fake-webhook-secret")).rejects.toThrow(/malformed/);
    expect(await billing.parseWebhook('{"id":"e1","type":"x"}', "fake-webhook-secret")).toEqual({ id: "e1", type: "x", data: null });

    const analytics = new NoopAnalytics();
    analytics.track("signup", "u1", { plan: "trial" });
    analytics.captureError(new Error("boom"));
    await analytics.flush();
    expect(analytics.events).toEqual([{ event: "signup", distinctId: "u1", props: { plan: "trial" } }]);
    expect(analytics.errors).toHaveLength(1);
  });
});

describe("createIntegrations factory", () => {
  const base = {
    DATABASE_URL: "postgres://x",
    AUTH_SECRET: "x".repeat(40),
    INTERNAL_API_SECRET: "y".repeat(20),
    LOCAL_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
  };

  it("builds fake adapters by default and memoises per-account connectors", () => {
    const env = parseEnv(base);
    const integrations = createIntegrations({ env, modes: resolveModes(env), isProduction: false, isTest: true }, { now });
    expect(integrations.ai.mode).toBe("fake");
    expect(integrations.billing.mode).toBe("fake");
    expect(integrations.analytics.mode).toBe("noop");
    expect(integrations.kms.provider).toBe("local");
    expect(integrations.calendarFor("a@b.c")).toBe(integrations.calendarFor("a@b.c"));
    expect(integrations.mailFor("a@b.c")).not.toBe(integrations.mailFor("other@b.c"));
  });

  it("live modes without an adapter yet fail loudly instead of silently using fakes", () => {
    const env = parseEnv({ ...base, AI_MODE: "live", ANTHROPIC_API_KEY: "sk-test" });
    expect(() => createIntegrations({ env, modes: resolveModes(env), isProduction: false, isTest: true }, { now })).toThrow(
      /anthropic live adapter/,
    );
  });
});
