import { DEMO_USER, parseEnv, resolveModes, type AppConfig } from "@meri/config";
import { describe, expect, it } from "vitest";
import { createIntegrations } from "../factory";
import { DEMO_MAIL_MESSAGE_COUNT, DEMO_MAIL_THREADS, demoMessageId, demoThreadId } from "./demo-mail";
import type { FakeGmail } from "./mail";

const NOW = new Date("2026-10-20T08:40:00Z");
/** The fake calendar's primary id (FakeCalendar.primaryCalendarId). */
const PRIMARY = "primary";

function devConfig(): AppConfig {
  const env = parseEnv({
    NODE_ENV: "development",
    DATABASE_URL: "postgres://meri:meri@localhost:5432/meri",
    AUTH_SECRET: "x".repeat(40),
    INTERNAL_API_SECRET: "y".repeat(20),
    LOCAL_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
  });
  return { env, modes: resolveModes(env), isProduction: false, isTest: false, fakesOnProductionBuild: false };
}

describe("demo mailbox and fakes for demo@meri.local (D-052)", () => {
  it("the demo account's calendar starts empty and its mailbox holds exactly the seeded threads", async () => {
    const integrations = createIntegrations(devConfig(), { now: () => NOW });
    const calendar = integrations.calendarFor(DEMO_USER.email);
    const page = await calendar.sync({ calendarId: PRIMARY, cursor: null, from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" });
    expect(page.events).toEqual([]);
    const mail = integrations.mailFor(DEMO_USER.email) as FakeGmail;
    expect(mail.messages.size).toBe(DEMO_MAIL_MESSAGE_COUNT);
    for (const t of DEMO_MAIL_THREADS)
      t.messages.forEach((_, i) => {
        const m = mail.messages.get(demoMessageId(t.key, i));
        expect(m?.threadId).toBe(demoThreadId(t.key));
        expect(m?.subject).toBe(t.subject);
      });
    // The seed pins the history cursor at the message count: an incremental sync after it reads nothing.
    const after = await mail.listHistory({ cursor: String(DEMO_MAIL_MESSAGE_COUNT) });
    expect(after.messageIds).toEqual([]);
  });

  it("any other account keeps the sample meetings and mailbox", async () => {
    const integrations = createIntegrations(devConfig(), { now: () => NOW });
    const calendar = integrations.calendarFor("someone@meri.local");
    const page = await calendar.sync({ calendarId: PRIMARY, cursor: null, from: "2026-10-01T00:00:00Z", to: "2026-11-01T00:00:00Z" });
    expect(page.events.length).toBeGreaterThan(0); // same query as above: the demo's empty calendar is meaningful
    const mail = integrations.mailFor("someone@meri.local") as FakeGmail;
    expect([...mail.messages.keys()].some((id) => id.startsWith("demo-"))).toBe(false);
    expect(mail.messages.size).toBeGreaterThan(0);
  });
});
