import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertInferredEntries, listAudit, updatePreferences, upsertCalendarEvent, withWorkspace, type AccountIdentity } from "@meri/db";
import { createTestApp, csrf, NOW, type TestApp } from "../test/harness";

interface Entry {
  id: string;
  status: string;
  minutes: number;
  clientId: string | null;
  clientName: string | null;
  approvedAt: string | null;
}
interface WeekJson {
  week: string;
  days: string[];
  items: Entry[];
  summary: { clientId: string | null; clientName: string | null; minutesApproved: number; minutesSuggested: number }[];
  unassignedEvents: { id: string; minutes: number }[];
}

/** Strict RFC 4180 parser: quoted fields, doubled quotes, CRLF rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c !== '"') throw new Error(`unquoted field at ${String(i)}`);
    i++;
    cell = "";
    for (;;) {
      const ch = text[i];
      if (ch === undefined) throw new Error("unterminated quote");
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        i++;
        break;
      }
      cell += ch;
      i++;
    }
    row.push(cell);
    if (text[i] === ",") i++;
    else if (text.startsWith("\r\n", i)) {
      i += 2;
      rows.push(row);
      row = [];
    } else throw new Error(`bad separator at ${String(i)}`);
  }
  if (row.length) rows.push(row);
  return rows;
}

describe("time entries review and CSV (F-10 AC1/AC2, D-042, D-046)", () => {
  let t: TestApp;
  let a: AccountIdentity;
  let cookie: string;
  let acme = "";
  let beta = "";
  let ids: string[] = [];
  beforeAll(async () => {
    t = await createTestApp();
    a = await t.createAccount("time-a");
    cookie = await t.cookieFor(a);
    const mk = (name: string) =>
      t.app.inject({ method: "POST", url: "/v1/clients", headers: { cookie, ...csrf }, payload: { name } });
    acme = (await mk("Acme")).json<{ id: string }>().id;
    beta = (await mk('Beta "Dos"')).json<{ id: string }>().id;
    await withWorkspace(t.handle.db, a.workspaceId, async (tx) => {
      await updatePreferences(tx, a.workspaceId, { timezone: "Europe/Madrid" }, { now: NOW });
      await insertInferredEntries(
        tx,
        a.workspaceId,
        [
          { sourceType: "calendar_event", sourceId: "01a15596-f037-71e4-bfce-25b2f4a80b51", clientId: acme, taskId: null, day: "2026-10-19", minutes: 54, description: "=Reunión de arranque" },
          { sourceType: "schedule_block", sourceId: "01a15596-f037-71e4-bfce-25b2f4a80b52", clientId: acme, taskId: null, day: "2026-10-20", minutes: 90, description: "Informe" },
          { sourceType: "calendar_event", sourceId: "01a15596-f037-71e4-bfce-25b2f4a80b53", clientId: beta, taskId: null, day: "2026-10-21", minutes: 30, description: 'Llamada "rápida"' },
          { sourceType: "calendar_event", sourceId: "01a15596-f037-71e4-bfce-25b2f4a80b54", clientId: beta, taskId: null, day: "2026-10-12", minutes: 30, description: "Semana anterior" },
        ],
        NOW,
      );
      await upsertCalendarEvent(
        tx,
        a.workspaceId,
        { integrationAccountId: "01a15596-f037-71e4-bfce-25b2f4a80b55", externalId: "u1", etag: null, title: "Sin cliente", startsAt: new Date("2026-10-19T07:00:00Z"), endsAt: new Date("2026-10-19T07:45:00Z"), allDay: false, attendees: [], busy: true, origin: "external", clientId: null },
        NOW,
      );
    });
  });
  afterAll(() => t.close());

  const get = (qs = "") => t.app.inject({ url: `/v1/time-entries${qs}`, headers: { cookie } });

  it("lists the current ISO week with per-client approved/suggested minutes and unassigned meetings", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = res.json<WeekJson>();
    expect(body.week).toBe("2026-W43");
    expect(body.days[0]).toBe("2026-10-19");
    expect(body.items).toHaveLength(3);
    ids = body.items.map((i) => i.id);
    expect(body.summary).toEqual([
      { clientId: acme, clientName: "Acme", minutesApproved: 0, minutesSuggested: 144 },
      { clientId: beta, clientName: 'Beta "Dos"', minutesApproved: 0, minutesSuggested: 30 },
    ]);
    expect(body.unassignedEvents).toEqual([expect.objectContaining({ minutes: 45 })]);
    expect((await get("?week=2026-W42")).json<WeekJson>().items).toHaveLength(1);
    expect((await get(`?clientId=${beta}`)).json<WeekJson>().items).toHaveLength(1);
    expect((await get("?week=2026-13")).statusCode).toBe(400);
  });

  it("approves one, approves in batch, rejects, edits, undoes an approval; CSV exports approved rows safely", async () => {
    const [first, second, third] = ids;
    const one = await t.app.inject({ method: "POST", url: `/v1/time-entries/${first ?? ""}/approve`, headers: { cookie, ...csrf } });
    expect(one.statusCode).toBe(200);
    expect(one.json<Entry>()).toMatchObject({ status: "approved", approvedAt: NOW.toISOString() });
    expect((await t.app.inject({ method: "POST", url: `/v1/time-entries/${first ?? ""}/approve`, headers: { cookie, ...csrf } })).statusCode).toBe(409);
    const batch = await t.app.inject({
      method: "POST",
      url: "/v1/time-entries/approve-batch",
      headers: { cookie, ...csrf },
      payload: { ids: [first, second, "01a15596-f037-71e4-bfce-25b2f4a80b99"] },
    });
    expect(batch.json<{ approved: string[]; skipped: { reason: string }[] }>()).toEqual({
      approved: [second],
      skipped: [
        { id: first, reason: "not_pending" },
        { id: "01a15596-f037-71e4-bfce-25b2f4a80b99", reason: "not_found" },
      ],
    });
    const rejected = await t.app.inject({ method: "POST", url: `/v1/time-entries/${third ?? ""}/reject`, headers: { cookie, ...csrf } });
    expect(rejected.json<Entry>().status).toBe("rejected");
    // Editing an approved entry keeps it approved.
    const edited = await t.app.inject({ method: "PATCH", url: `/v1/time-entries/${first ?? ""}`, headers: { cookie, ...csrf }, payload: { minutes: 60 } });
    expect(edited.json<Entry>()).toMatchObject({ minutes: 60, status: "approved" });
    const week = (await get()).json<WeekJson>();
    expect(week.items.map((i) => i.status).sort()).toEqual(["approved", "approved"]);
    expect(week.summary[0]).toMatchObject({ clientName: "Acme", minutesApproved: 150, minutesSuggested: 0 });
    expect((await get("?status=all")).json<WeekJson>().items).toHaveLength(3);
    // CSV: BOM, documented columns, only approved rows, formula and quote safety.
    const csv = await t.app.inject({ url: "/v1/time-entries/export.csv?week=2026-W43", headers: { cookie } });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toBe('attachment; filename="meri-tiempo-2026-W43.csv"');
    expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    const rows = parseCsv(csv.body.slice(1));
    expect(rows[0]).toEqual(["fecha", "cliente", "asunto", "descripcion", "minutos", "horas", "origen", "estado", "aprobada_el"]);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toEqual(["2026-10-19", "Acme", "", "'=Reunión de arranque", "60", "1.00", "calendar_event", "approved", NOW.toISOString()]);
    expect(rows[2]?.[4]).toBe("90");
    const all = parseCsv((await t.app.inject({ url: "/v1/time-entries/export.csv?week=2026-W43&status=all", headers: { cookie } })).body.slice(1));
    expect(all).toHaveLength(4);
    expect(all[3]?.[3]).toBe('Llamada "rápida"');
    // Export never mutates.
    expect((await get()).json<WeekJson>().items.every((i) => i.status === "approved")).toBe(true);
    // Undo the batch approval through the audit log.
    const page = await withWorkspace(t.handle.db, a.workspaceId, (tx) => listAudit(tx, a.workspaceId, 50));
    const approval = page.items.find((e) => e.action === "time.approved" && e.entityId === second);
    expect(approval).toBeDefined();
    const undo = await t.app.inject({ method: "POST", url: `/v1/audit/${approval?.id ?? ""}/undo`, headers: { cookie, ...csrf } });
    expect(undo.statusCode).toBe(200);
    expect((await get()).json<WeekJson>().items.find((i) => i.id === second)?.status).toBe("suggested");
    // Isolation: another tenant sees nothing and cannot act.
    const other = await t.cookieFor(await t.createAccount("time-b"));
    expect((await t.app.inject({ url: "/v1/time-entries", headers: { cookie: other } })).json<WeekJson>().items).toHaveLength(0);
    expect((await t.app.inject({ method: "POST", url: `/v1/time-entries/${second ?? ""}/approve`, headers: { cookie: other, ...csrf } })).statusCode).toBe(404);
  });
});
