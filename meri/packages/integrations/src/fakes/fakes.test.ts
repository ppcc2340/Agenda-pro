import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseEnv, resolveModes } from "@meri/config";
import { FakeCalendar } from "./calendar";
import { calendarContract } from "../calendar/contract";
import { mailContract } from "../mail/contract";
import { FakeGmail } from "./mail";
import { FakeAiClient } from "./ai";
import { NoopAnalytics } from "./analytics";
import { createIntegrations } from "../factory";
import { IntegrationError } from "../errors";
import type { MailProvider } from "../mail/types";

const now = () => new Date("2026-10-19T10:40:00Z");

describe("FakeCalendar contract (docs/07: Meri only touches its own events)", () => {
  calendarContract(() => {
    const cal = new FakeCalendar({ now });
    return Promise.resolve({
      calendar: cal,
      addExternal: (input) => {
        const ev = cal.addExternalEvent(input);
        return Promise.resolve({ calendarId: ev.calendarId, externalId: ev.externalId });
      },
    });
  });

  it("exposes the injected clock", () => {
    expect(new FakeCalendar({ now }).currentTime().toISOString()).toBe("2026-10-19T10:40:00.000Z");
  });
});

describe("FakeGmail contract (readonly + drafts, no send)", () => {
  mailContract(() => {
    const mail = new FakeGmail({ email: "yo@acme.test" });
    let n = 0;
    return Promise.resolve({
      mail,
      deliver: (m) => {
        n += 1;
        const id = `m${String(n)}`;
        const threadId = `t${String(n)}`;
        mail.addMessage({
          id,
          threadId,
          from: m.from,
          to: [m.to],
          subject: m.subject,
          date: m.date,
          headers: {},
          labels: ["INBOX"],
          snippet: m.body.slice(0, 200),
          bodyText: m.body,
        });
        return Promise.resolve({ id, threadId });
      },
    });
  });

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
    const draft = await mail.createDraft({
      threadId: "t1",
      inReplyToMessageId: "m1",
      to: ["ana@acme.com"],
      subject: "Re: Contrato",
      bodyText: "...",
    });
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
    const res = await ai.complete({
      operation: "echo",
      model: "fast",
      system: "s",
      user: "hola",
      schema: z.object({ text: z.string() }),
    });
    expect(res.output.text).toBe("hola");
    expect(res.usage.costMicroUsd).toBe(0);
    expect(ai.calls).toHaveLength(1);
    await expect(
      ai.complete({
        operation: "echo",
        model: "fast",
        system: "s",
        user: "x",
        schema: z.object({ n: z.number() }),
      }),
    ).rejects.toThrow(/schema validation/);
    await expect(
      ai.complete({ operation: "unknown", model: "fast", system: "s", user: "x", schema: z.any() }),
    ).rejects.toThrow(/no fake handler/);
  });
});

describe("NoopAnalytics", () => {
  it("records analytics in memory", async () => {
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
    const integrations = createIntegrations(
      { env, modes: resolveModes(env), isProduction: false, isTest: true, fakesOnProductionBuild: false },
      { now },
    );
    expect(integrations.ai.mode).toBe("fake");
    expect(integrations.billing.mode).toBe("fake");
    expect(integrations.analytics.mode).toBe("noop");
    expect(integrations.kms.provider).toBe("local");
    expect(integrations.calendarFor("a@b.c")).toBe(integrations.calendarFor("a@b.c"));
    expect(integrations.mailFor("a@b.c")).not.toBe(integrations.mailFor("other@b.c"));
  });

  it("Stripe and analytics live modes build the live adapters from env (switching is configuration only)", () => {
    const env = parseEnv({
      ...base,
      STRIPE_MODE: "live",
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
      STRIPE_PRICE_PRO: "price_pro_m",
      STRIPE_PRICE_PRO_ANNUAL: "price_pro_y",
      STRIPE_PRICE_PRO_PLUS: "price_plus_m",
      STRIPE_PRICE_PRO_PLUS_ANNUAL: "price_plus_y",
      STRIPE_PRICE_CREDITS_500: "price_c500",
      STRIPE_PRICE_CREDITS_2000: "price_c2000",
      ANALYTICS_MODE: "live",
      SENTRY_DSN: "https://k@sentry.example/1",
      POSTHOG_KEY: "phc_x",
    });
    const integrations = createIntegrations(
      { env, modes: resolveModes(env), isProduction: false, isTest: true, fakesOnProductionBuild: false },
      { now },
    );
    expect(integrations.billing.mode).toBe("live");
    expect(integrations.analytics.mode).toBe("live");
  });

  it("live Google without its adapter still fails loudly instead of silently using fakes", () => {
    const env = parseEnv({ ...base, GOOGLE_MODE: "live", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" });
    expect(() =>
      createIntegrations(
        { env, modes: resolveModes(env), isProduction: false, isTest: true, fakesOnProductionBuild: false },
        { now },
      ),
    ).toThrow(/google-oauth live adapter/);
  });

  it("AI live mode builds the Anthropic client from env (models and prices are configuration)", () => {
    const env = parseEnv({
      ...base,
      AI_MODE: "live",
      ANTHROPIC_API_KEY: "sk-test",
      AI_MODEL_FAST: "claude-haiku-5-5",
    });
    const integrations = createIntegrations(
      { env, modes: resolveModes(env), isProduction: false, isTest: true, fakesOnProductionBuild: false },
      { now },
    );
    expect(integrations.ai.mode).toBe("live");
  });
});
