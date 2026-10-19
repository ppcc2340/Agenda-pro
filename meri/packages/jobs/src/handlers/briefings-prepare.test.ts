import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger, parseEnv, resolveModes } from "@meri/config";
import {
  bootstrapAccount,
  createClient,
  createDb,
  listNotifications,
  updatePreferences,
  upsertCalendarEvent,
  withWorkspace,
  type DbHandle,
  type WorkspaceId,
} from "@meri/db";
import { createIntegrations } from "@meri/integrations";
import type { HandlerDeps } from "./context";
import { prepareBriefings } from "./briefings-prepare";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const NOW = new Date("2026-10-19T10:40:00Z");
const h = (n: number) => new Date(NOW.getTime() + n * 3_600_000);

describe("briefings.prepare (D-043)", () => {
  let handle: DbHandle;
  let deps: HandlerDeps;
  let ws: WorkspaceId;
  beforeAll(async () => {
    handle = createDb(TEST_APP_URL, { max: 2 });
    const env = parseEnv({
      DATABASE_URL: TEST_APP_URL,
      AUTH_SECRET: "x".repeat(40),
      INTERNAL_API_SECRET: "y".repeat(20),
      LOCAL_MASTER_KEY: Buffer.alloc(32, 11).toString("base64"),
    });
    const integrations = createIntegrations(
      { env, modes: resolveModes(env), isProduction: false, isTest: true, fakesOnProductionBuild: false },
      { now: () => NOW },
    );
    deps = { db: handle.db, integrations, keys: integrations.kms.keys, logger: createLogger({ name: "t", level: "silent" }), now: () => NOW };
    ws = (await bootstrapAccount(handle.db, { email: `bp-${Date.now().toString(36)}@test.local`, now: NOW })).workspaceId;
    await withWorkspace(handle.db, ws, async (tx) => {
      const acme = await createClient(tx, ws, { name: "Acme", domains: ["acme.test"] }, NOW);
      const ev = (externalId: string, start: Date, extra: Partial<Parameters<typeof upsertCalendarEvent>[2]> = {}) =>
        upsertCalendarEvent(tx, ws, {
          integrationAccountId: "01a15596-f037-71e4-bfce-25b2f4a80b33",
          externalId,
          etag: null,
          title: `Reunión ${externalId}`,
          startsAt: start,
          endsAt: new Date(start.getTime() + 3_600_000),
          allDay: false,
          attendees: ["ana@acme.test"],
          busy: true,
          origin: "external",
          clientId: acme.id,
          ...extra,
        }, NOW);
      await ev("soon", h(20));
      await ev("far", h(80));
      await ev("past", h(-2));
      await ev("noclient", h(10), { clientId: null });
      await ev("meri", h(10), { origin: "meri" });
      await ev("allday", h(10), { allDay: true });
    });
  });
  afterAll(() => handle.close());

  it("notifies once per upcoming client meeting, respects the preference and the daily cap", async () => {
    expect(await prepareBriefings(deps, ws)).toEqual({ status: "done", meetings: 1, notified: 1 });
    expect(await prepareBriefings(deps, ws)).toEqual({ status: "done", meetings: 1, notified: 0 });
    const list = await withWorkspace(handle.db, ws, (tx) => listNotifications(tx, ws, { limit: 10 }));
    const n = list.items.find((x) => x.template === "briefing.suggested");
    expect(n?.params).toMatchObject({ clientName: "Acme", title: "Reunión soon" });
    expect(n?.refs.some((r) => r.type === "event")).toBe(true);
    await withWorkspace(handle.db, ws, (tx) => updatePreferences(tx, ws, { briefingBeforeMeetings: false }, { now: NOW }));
    expect(await prepareBriefings(deps, ws)).toEqual({ status: "skipped", meetings: 0, notified: 0 });
  });

  it("stops at the daily alert cap and resumes on a later run", async () => {
    const ws2 = (await bootstrapAccount(handle.db, { email: `bp2-${Date.now().toString(36)}@test.local`, now: NOW })).workspaceId;
    await withWorkspace(handle.db, ws2, async (tx) => {
      await updatePreferences(tx, ws2, { maxAlertsPerDay: 1 }, { now: NOW });
      const acme = await createClient(tx, ws2, { name: "Acme", domains: [] }, NOW);
      for (const [externalId, start] of [["m1", h(20)], ["m2", h(30)]] as const)
        await upsertCalendarEvent(tx, ws2, { integrationAccountId: "01a15596-f037-71e4-bfce-25b2f4a80b33", externalId, etag: null, title: externalId, startsAt: start, endsAt: new Date(start.getTime() + 3_600_000), allDay: false, attendees: [], busy: true, origin: "external", clientId: acme.id }, NOW);
    });
    expect(await prepareBriefings(deps, ws2)).toEqual({ status: "done", meetings: 2, notified: 1 });
    expect(await prepareBriefings(deps, ws2)).toEqual({ status: "done", meetings: 2, notified: 0 });
    const tomorrow = { ...deps, now: () => new Date(NOW.getTime() + 86_400_000) };
    // Next day: m1 has started (out of the window), m2 is still ahead and gets its alert.
    expect(await prepareBriefings(tomorrow, ws2)).toEqual({ status: "done", meetings: 1, notified: 1 });
  });
});
