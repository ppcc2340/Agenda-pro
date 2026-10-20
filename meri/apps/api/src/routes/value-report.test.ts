import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  audit,
  createClient,
  createCommitment,
  insertInferredEntries,
  listAudit,
  listTimeEntries,
  updatePreferences,
  withWorkspace,
  type AccountIdentity,
} from "@meri/db";
import type { NoopAnalytics } from "@meri/integrations";
import { createTestApp, csrf, NOW, type TestApp } from "../test/harness";

interface Figure {
  key: string;
  value: number | null;
  unit: string;
  methods: string[];
  estimated: boolean;
  sources: { type: string; id: string; label: string | null; method: string; quantity: number }[];
}
interface Report {
  period: string;
  key: string;
  figures: Figure[];
}

const base = {
  clientId: null,
  kind: "explicit" as const,
  counterpartyEmail: "ana@acme.test",
  dueText: null,
  confidence: 0.95,
  evidence: "Te lo envío el viernes.",
  threadId: null,
  externalMessageId: null,
};

describe("value report (F-12, D-063, [M7])", () => {
  let t: TestApp;
  let a: AccountIdentity;
  let cookie: string;
  const report = async (qs = "", c = cookie) =>
    (await t.app.inject({ url: `/v1/value-report${qs}`, headers: { cookie: c } })).json<Report>();
  const fig = (r: Report, key: string) => r.figures.find((f) => f.key === key);

  beforeAll(async () => {
    t = await createTestApp();
    a = await t.createAccount("value");
    cookie = await t.cookieFor(a);
    await withWorkspace(t.handle.db, a.workspaceId, (tx) =>
      updatePreferences(tx, a.workspaceId, { timezone: "Europe/Madrid" }, { now: NOW }),
    );
  });
  afterAll(() => t.close());

  it("without events every figure is null with no sources (never an invented zero)", async () => {
    const r = await report();
    expect(r.period).toBe("week");
    expect(r.key).toBe("2026-W43");
    expect(r.figures.map((f) => [f.key, f.value, f.sources.length])).toEqual([
      ["commitments_saved", null, 0],
      ["deadline_risks_flagged", null, 0],
      ["hours_recovered", null, 0],
    ]);
  });

  it("fulfilling on time or after a Meri follow-up counts once, with its method and source; reverting compensates", async () => {
    const [onTime, followed, late] = await withWorkspace(t.handle.db, a.workspaceId, async (tx) => {
      const mk = (action: string, dueAt: Date | null, hash: string, direction: "owed_by_me" | "owed_to_me") =>
        createCommitment(
          tx,
          a.workspaceId,
          { ...base, direction, status: "confirmed", action, dueAt, dedupeHash: hash },
          NOW,
        );
      const c1 = await mk("enviar el informe", new Date(NOW.getTime() + 86_400_000), "v1", "owed_by_me");
      const c2 = await mk("firmar el contrato", new Date(NOW.getTime() - 3 * 86_400_000), "v2", "owed_to_me");
      const c3 = await mk("pagar la factura", new Date(NOW.getTime() - 86_400_000), "v3", "owed_to_me");
      if (!c1 || !c2 || !c3) throw new Error("seed commitments were not created");
      // A follow-up draft saved by Meri for c2 (the save route needs Gmail; its audit entry is the fact).
      await audit(
        tx,
        { workspaceId: a.workspaceId, actor: "user", actorUserId: a.userId },
        {
          action: "followup.draft_saved",
          entityType: "commitment",
          entityId: c2.id,
        },
      );
      return [c1, c2, c3];
    });
    const patch = (id: string, status: string) =>
      t.app.inject({
        method: "PATCH",
        url: `/v1/commitments/${id}`,
        headers: { cookie, ...csrf },
        payload: { status },
      });
    for (const c of [onTime, followed, late])
      expect((await patch(c.id, "fulfilled")).statusCode).toBe(200);
    let saved = fig(await report(), "commitments_saved");
    expect(saved?.value).toBe(2);
    expect(saved?.methods).toEqual(["commitment_fulfilled_on_time", "commitment_fulfilled_after_followup"]);
    expect(saved?.sources.map((s) => s.label).sort()).toEqual(["enviar el informe", "firmar el contrato"]);
    // Re-opening and fulfilling again never double-counts; re-opening removes the figure contribution.
    await patch(onTime.id, "confirmed");
    expect(fig(await report(), "commitments_saved")?.value).toBe(1);
    await patch(onTime.id, "fulfilled");
    saved = fig(await report(), "commitments_saved");
    expect(saved?.value).toBe(2);
    const analytics = t.integrations.analytics as NoopAnalytics;
    expect(
      analytics.events.filter((e) => e.event === "commitment_fulfilled").map((e) => e.props.onTime),
    ).toContain(false);
  });

  it("approving inferred time counts as recovered hours (estimated); undoing the approval removes it ([M7])", async () => {
    const clientId = await withWorkspace(t.handle.db, a.workspaceId, async (tx) => {
      const client = await createClient(tx, a.workspaceId, { name: "Acme" }, NOW);
      await insertInferredEntries(
        tx,
        a.workspaceId,
        [
          {
            sourceType: "calendar_event",
            sourceId: "01a15596-f037-71e4-bfce-25b2f4a80c01",
            clientId: client.id,
            taskId: null,
            day: "2026-10-19",
            minutes: 45,
            description: "Llamada semanal",
          },
          {
            sourceType: "schedule_block",
            sourceId: "01a15596-f037-71e4-bfce-25b2f4a80c02",
            clientId: client.id,
            taskId: null,
            day: "2026-10-19",
            minutes: 90,
            description: "Informe",
          },
        ],
        NOW,
      );
      return client.id;
    });
    const entries = await withWorkspace(t.handle.db, a.workspaceId, (tx) =>
      listTimeEntries(tx, a.workspaceId, { from: "2026-10-19", to: "2026-10-19", clientId }),
    );
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/time-entries/approve-batch",
      headers: { cookie, ...csrf },
      payload: { ids: entries.map((e) => e.id) },
    });
    expect(res.statusCode).toBe(200);
    let hours = fig(await report(), "hours_recovered");
    expect(hours).toMatchObject({
      value: 2.3,
      unit: "hours",
      estimated: true,
      methods: ["inferred_time_approved"],
    });
    expect(hours?.sources.map((s) => s.quantity).sort((x, y) => x - y)).toEqual([45, 90]);

    const page = await withWorkspace(t.handle.db, a.workspaceId, (tx) => listAudit(tx, a.workspaceId, 50));
    const approval = page.items.find((e) => e.action === "time.approved" && e.entityId === entries[0]?.id);
    const undo = await t.app.inject({
      method: "POST",
      url: `/v1/audit/${approval?.id ?? ""}/undo`,
      headers: { cookie, ...csrf },
    });
    expect(undo.statusCode).toBe(200);
    hours = fig(await report(), "hours_recovered");
    expect(hours?.sources).toHaveLength(1);
    // Approving again counts it again.
    await t.app.inject({
      method: "POST",
      url: `/v1/time-entries/${entries[0]?.id ?? ""}/approve`,
      headers: { cookie, ...csrf },
    });
    expect(fig(await report(), "hours_recovered")?.sources).toHaveLength(2);
  });

  it("month reports aggregate the calendar month; another workspace sees nothing (isolation)", async () => {
    const month = await report("?period=month&date=2026-10-05");
    expect(month.key).toBe("2026-10");
    expect(fig(month, "commitments_saved")?.value).toBe(2);
    const other = await t.cookieFor(await t.createAccount("value-b"));
    expect(
      (await report("?period=month&date=2026-10-05", other)).figures.every((f) => f.value === null),
    ).toBe(true);
    const earlier = await report("?date=2026-09-01");
    expect(earlier.figures.every((f) => f.value === null)).toBe(true);
    expect(
      (await t.app.inject({ url: "/v1/value-report?date=2026-02-31", headers: { cookie } })).statusCode,
    ).toBe(400);
  });

  it("value_report_viewed is tracked once per report and day", async () => {
    const analytics = t.integrations.analytics as NoopAnalytics;
    const views = () =>
      analytics.events.filter((e) => e.event === "value_report_viewed" && e.distinctId === a.workspaceId);
    const before = views().length;
    expect(before).toBeGreaterThan(0);
    await report();
    await report();
    expect(views().length).toBe(before);
    expect(analytics.errors).toEqual([]);
  });
});
