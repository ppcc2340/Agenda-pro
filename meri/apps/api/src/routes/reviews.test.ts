import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyTaskRisks,
  createClient,
  createTask,
  insertInferredEntries,
  insertBlocks,
  setTimeEntriesStatus,
  updatePreferences,
  withWorkspace,
  type AccountIdentity,
} from "@meri/db";
import { createTestApp, NOW, type TestApp } from "../test/harness";

// NOW = Monday 2026-10-19 10:40 UTC = 12:40 in Madrid (ISO week 2026-W43).
const at = (h: number, m = 0, dayOffset = 0) => new Date(Date.UTC(2026, 9, 19 + dayOffset, h - 2, m)); // Madrid is UTC+2 in October

interface Item {
  taskId: string;
  title: string;
}
interface Daily {
  date: string;
  done: Item[];
  pending: Item[];
  toReschedule: Item[];
  blocked: Item[];
  newRisks: Item[];
  tomorrow: (Item & { startsAt: string })[];
}
interface Weekly {
  week: string;
  days: {
    day: string;
    capacityMinutes: number;
    plannedMinutes: number;
    completedMinutes: number;
    load: number | null;
  }[];
  totals: { plannedMinutes: number; completedMinutes: number };
  estimates: (Item & { estimateMinutes: number; actualMinutes: number; deltaPct: number })[];
  medianEstimateErrorPct: number | null;
  trend: { previousPlannedMinutes: number; plannedDeltaPct: number | null } | null;
}

describe("daily close and weekly review (F-12, D-064, [M8])", () => {
  let t: TestApp;
  let a: AccountIdentity;
  let cookie: string;
  const ids: Record<"done" | "past" | "ahead" | "blocked" | "risky" | "tomorrow", string> = {
    done: "",
    past: "",
    ahead: "",
    blocked: "",
    risky: "",
    tomorrow: "",
  };

  beforeAll(async () => {
    t = await createTestApp();
    a = await t.createAccount("reviews");
    cookie = await t.cookieFor(a);
    const ws = a.workspaceId;
    await withWorkspace(t.handle.db, ws, async (tx) => {
      await updatePreferences(tx, ws, { timezone: "Europe/Madrid" }, { now: NOW });
      const mk = async (title: string, extra: Record<string, unknown> = {}) =>
        (await createTask(tx, ws, { title, estimateMinutes: 60, ...extra }, NOW)).id;
      ids.done = await mk("Informe entregado", { status: "completed" });
      ids.past = await mk("Revisión pasada");
      ids.ahead = await mk("Propuesta de la tarde");
      ids.blocked = await mk("Esperando firma", { status: "waiting_on_third_party" });
      ids.risky = await mk("Entrega con riesgo");
      ids.tomorrow = await mk("Preparar reunión");
      // The planner's own write path: one task at risk since this morning, the planned ones scheduled.
      await applyTaskRisks(
        tx,
        ws,
        new Map([[ids.risky, { cause: "LOW_SLACK" as const, slackHours: 1, since: at(9).toISOString() }]]),
        new Set([ids.past, ids.ahead, ids.tomorrow]),
        NOW,
      );
      await insertBlocks(
        tx,
        ws,
        [
          { taskId: ids.done, startsAt: at(9), endsAt: at(10, 30), reason: [], completedAt: at(10, 30) },
          { taskId: ids.past, startsAt: at(11), endsAt: at(12), reason: [] },
          { taskId: ids.ahead, startsAt: at(16), endsAt: at(17), reason: [] },
          { taskId: ids.tomorrow, startsAt: at(9, 0, 1), endsAt: at(10, 0, 1), reason: [] },
          // Previous week, for the trend.
          { taskId: ids.past, startsAt: at(10, 0, -7), endsAt: at(12, 0, -7), reason: [] },
        ],
        1,
        NOW,
      );
      // 75 approved minutes for the completed task replace its 90 block minutes ([M8]).
      const client = await createClient(tx, ws, { name: "Acme" }, NOW);
      await insertInferredEntries(
        tx,
        ws,
        [
          {
            sourceType: "schedule_block",
            sourceId: "01a15596-f037-71e4-bfce-25b2f4a80d01",
            clientId: client.id,
            taskId: ids.done,
            day: "2026-10-19",
            minutes: 75,
            description: "Informe",
          },
        ],
        NOW,
      );
      const entries = await tx.query.timeEntries.findMany();
      await setTimeEntriesStatus(
        tx,
        ws,
        entries.map((e) => e.id),
        "approved",
        NOW,
      );
    });
  });
  afterAll(() => t.close());

  it("daily close: done, pending, to reschedule, blocked, new risks and tomorrow's priorities", async () => {
    const res = await t.app.inject({ url: "/v1/reviews/daily", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const d = res.json<Daily>();
    expect(d.date).toBe("2026-10-19");
    const titles = (xs: Item[]) => xs.map((x) => x.title);
    expect(titles(d.done)).toEqual(["Informe entregado"]);
    expect(titles(d.pending)).toEqual(["Propuesta de la tarde"]);
    expect(titles(d.toReschedule)).toEqual(["Revisión pasada"]);
    expect(titles(d.blocked)).toEqual(["Esperando firma"]);
    expect(titles(d.newRisks)).toEqual(["Entrega con riesgo"]);
    expect(d.tomorrow.map((x) => x.title)).toEqual(["Preparar reunión"]);
  });

  it("weekly review: load per day, estimate vs actual from approved time (never summed with blocks), trend", async () => {
    const res = await t.app.inject({ url: "/v1/reviews/weekly", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const w = res.json<Weekly>();
    expect(w.week).toBe("2026-W43");
    expect(w.days).toHaveLength(7);
    const monday = w.days[0];
    expect(monday).toMatchObject({ day: "2026-10-19", plannedMinutes: 210, completedMinutes: 90 });
    expect(monday?.capacityMinutes).toBeGreaterThan(0);
    expect(w.days[5]?.capacityMinutes).toBe(0); // Saturday: not a working day
    expect(w.days[5]?.load).toBeNull();
    expect(w.estimates).toEqual([
      expect.objectContaining({
        title: "Informe entregado",
        estimateMinutes: 60,
        actualMinutes: 75,
        deltaPct: 25,
      }),
    ]);
    expect(w.medianEstimateErrorPct).toBe(25);
    expect(w.trend).toMatchObject({ previousPlannedMinutes: 120 });
  });

  it("validates inputs and isolates tenants", async () => {
    expect(
      (await t.app.inject({ url: "/v1/reviews/daily?date=2026-02-30", headers: { cookie } })).statusCode,
    ).toBe(400);
    expect(
      (await t.app.inject({ url: "/v1/reviews/weekly?week=2026-W60", headers: { cookie } })).statusCode,
    ).toBe(400);
    const other = await t.cookieFor(await t.createAccount("reviews-b"));
    const d = (
      await t.app.inject({ url: "/v1/reviews/daily?date=2026-10-19", headers: { cookie: other } })
    ).json<Daily>();
    expect(
      [d.done, d.pending, d.toReschedule, d.blocked, d.newRisks, d.tomorrow].every((x) => x.length === 0),
    ).toBe(true);
  });
});
