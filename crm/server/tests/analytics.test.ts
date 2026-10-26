import { describe, it, expect, beforeAll } from "vitest";
import { makeApp, login } from "./helpers.js";
import { sentLog } from "../services/email.js";
import { runAnalyticsJobs, localNow } from "../services/analytics.js";
import type { Db } from "../db.js";

type Agent = Awaited<ReturnType<typeof login>>;
let app: ReturnType<typeof makeApp>["app"];
let db: Db;
let admin: Agent;
let s1: { id: string }; let s2: { id: string };
let stages: { id: string; name: string; kind: string; position: number }[];
const month = new Date().toISOString().slice(0, 7);

beforeAll(async () => {
  ({ app, db } = makeApp(false));
  admin = await login(app, "admin@test.local", "Admin1234!");
  const roles = (await admin.get("/api/admin/roles")).body.items as { id: string; key: string }[];
  const rid = (k: string) => roles.find((r) => r.key === k)!.id;
  const t1 = (await admin.post("/api/admin/teams").send({ name: "Norte" })).body;
  s1 = (await admin.post("/api/admin/users").send({ name: "Ana Ventas", email: "ana@test.local", password: "Password123", role_id: rid("sales"), team_id: t1.id })).body;
  s2 = (await admin.post("/api/admin/users").send({ name: "Bea Ventas", email: "bea@test.local", password: "Password123", role_id: rid("sales") })).body;
  stages = (await admin.get("/api/pipelines")).body.items[0].stages;
  const open = stages.filter((s) => s.kind === "open").sort((a, b) => a.position - b.position);
  const mk = async (name: string, owner: string, amount: number, prob: number, close: string, source = "web") => (await admin.post("/api/deals").send({ name, owner_id: owner, amount, probability: prob, expected_close_date: close, source })).body;
  const inMonth = (n: number) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); d.setUTCDate(15); return d.toISOString().slice(0, 10); };
  const a = await mk("A1", s1.id, 10000, 80, inMonth(1));
  const b = await mk("A2", s1.id, 5000, 50, inMonth(1), "referral");
  const c = await mk("B1", s2.id, 20000, 20, inMonth(2));
  const d = await mk("B2", s2.id, 7000, 10, inMonth(1));
  // a avanza dos etapas y se gana; d se pierde por precio
  await admin.post(`/api/deals/${a.id}/stage`).send({ stage_id: open[1]!.id });
  await admin.post(`/api/deals/${a.id}/stage`).send({ stage_id: open[2]!.id });
  await admin.post(`/api/deals/${a.id}/close`).send({ status: "won" });
  await admin.post(`/api/deals/${d.id}/close`).send({ status: "lost", loss_reason: "price", competitor: "ACME" });
  void b; void c;
  await admin.put("/api/analytics/quota").send({ user_id: s1.id, month, amount: 20000 });
});

describe("constructor de informes", () => {
  it("agrupa por campo y por propietario con varias métricas y totales", async () => {
    const r = await admin.post("/api/analytics/run").send({ object: "deal", config: { dims: [{ field: "owner_id" }], metrics: [{ fn: "count" }, { fn: "sum", field: "amount" }, { fn: "avg", field: "probability" }], chart: "bar" } });
    expect(r.status).toBe(200);
    const ana = r.body.rows.find((x: Record<string, unknown>) => x.d0_label === "Ana Ventas");
    expect(ana.m0).toBe(2); expect(ana.m1).toBe(15000);
    expect(r.body.totals.m1).toBe(42000);
    expect(r.body.metrics[1].money).toBe(true);
  });
  it("dos dimensiones, filtros y agrupación por mes", async () => {
    const r = await admin.post("/api/analytics/run").send({ object: "deal", config: { filters: { logic: "and", conditions: [{ field: "status", op: "eq", value: "open" }] }, dims: [{ field: "expected_close_date", bucket: "month" }, { field: "source" }], metrics: [{ fn: "sum", field: "amount" }], sort: { by: "dim", dir: "asc" } } });
    expect(r.status).toBe(200);
    expect(r.body.rows.length).toBe(2); // abiertos: mes+1 referral, mes+2 web
    expect(r.body.rows[0].d0).toMatch(/^\d{4}-\d{2}$/);
    expect(r.body.totals.m0).toBe(25000);
    const q = await admin.post("/api/analytics/run").send({ object: "deal", config: { dims: [{ field: "created_at", bucket: "quarter" }], metrics: [{ fn: "count" }] } });
    expect(q.body.rows[0].d0).toMatch(/^\d{4}-T[1-4]$/);
  });
  it("rechaza métricas no numéricas y campos desconocidos", async () => {
    expect((await admin.post("/api/analytics/run").send({ object: "deal", config: { metrics: [{ fn: "sum", field: "name" }] } })).status).toBe(400);
    expect((await admin.post("/api/analytics/run").send({ object: "deal", config: { dims: [{ field: "nope" }] } })).status).toBe(400);
  });
  it("respeta la visibilidad del rol (comercial ve solo lo suyo)", async () => {
    const ana = await login(app, "ana@test.local", "Password123");
    const r = await ana.post("/api/analytics/run").send({ object: "deal", config: { dims: [{ field: "owner_id" }], metrics: [{ fn: "count" }] } });
    expect(r.body.rows.map((x: Record<string, unknown>) => x.d0_label)).toEqual(["Ana Ventas"]);
    // filtros globales del panel
    const g = await admin.post("/api/analytics/run").send({ object: "deal", config: { metrics: [{ fn: "count" }] }, global: { owner_id: s2.id } });
    expect(g.body.totals.m0).toBe(2);
  });
  it("guarda, comparte, duplica, exporta CSV y borra", async () => {
    const rep = await admin.post("/api/analytics/reports").send({ name: "Por origen", object: "deal", config: { dims: [{ field: "source" }], metrics: [{ fn: "sum", field: "amount" }], chart: "pie" }, visibility: "all" });
    expect(rep.status).toBe(200);
    const ana = await login(app, "ana@test.local", "Password123");
    expect((await ana.get("/api/analytics/reports")).body.items.some((x: { id: string }) => x.id === rep.body.id)).toBe(true);
    expect((await ana.put(`/api/analytics/reports/${rep.body.id}`).send({ ...rep.body, name: "x" })).status).toBe(403);
    const dup = await ana.post(`/api/analytics/reports/${rep.body.id}/duplicate`);
    expect(dup.body.visibility).toBe("private");
    expect((await ana.post("/api/analytics/reports").send({ name: "Compartido", object: "deal", config: {}, visibility: "all" })).status).toBe(403);
    const csv = await admin.get(`/api/analytics/reports/${rep.body.id}/export.csv`);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
    expect(csv.text).toContain("Origen;Suma de importe");
    expect(csv.text).toContain("Total;");
    expect((await admin.delete(`/api/analytics/reports/${rep.body.id}`)).status).toBe(200);
  });
  it("informes de actividades y tickets", async () => {
    const deal = (await admin.get("/api/deals?page_size=1")).body.items[0];
    expect((await admin.post("/api/activities").send({ type: "call", subject: "Llamada", deal_id: deal.id, occurred_at: new Date().toISOString() })).status).toBe(200);
    await admin.post("/api/tickets").send({ subject: "Fallo", priority: "high" });
    const t = await admin.post("/api/analytics/run").send({ object: "ticket", config: { dims: [{ field: "priority" }], metrics: [{ fn: "count" }] } });
    expect(t.body.rows[0]).toMatchObject({ d0: "high", m0: 1 });
    const r = await admin.post("/api/analytics/run").send({ object: "activity", config: { dims: [{ field: "type" }], metrics: [{ fn: "count" }] } });
    expect(r.status).toBe(200);
    expect(r.body.rows.some((x: Record<string, unknown>) => x.d0 === "call")).toBe(true);
  });
});

describe("analítica comercial", () => {
  it("embudo etapa a etapa con conversión y días medios", async () => {
    const r = await admin.get("/api/analytics/funnel");
    expect(r.status).toBe(200);
    const first = r.body.stages[0];
    expect(first.entered).toBe(4);
    expect(first.advanced).toBe(1);
    expect(first.conversion).toBe(25);
    expect(r.body.won).toBe(1);
    expect(r.body.win_rate).toBe(25);
  });
  it("previsión vs real por mes y comercial", async () => {
    const r = await admin.get("/api/analytics/forecast");
    expect(r.status).toBe(200);
    const cur = r.body.months.find((m: { month: string }) => m.month === month);
    expect(cur.won).toBe(10000);
    expect(cur.quota).toBe(20000);
    const next = r.body.months[r.body.months.findIndex((m: { month: string }) => m.month === month) + 1];
    expect(next.best_case).toBe(5000);
    expect(next.pipeline).toBe(0);
    const ana = r.body.by_owner.find((o: { name: string }) => o.name === "Ana Ventas");
    expect(ana.won).toBe(10000); expect(ana.best_case).toBe(5000);
  });
  it("cuotas y motivos de pérdida", async () => {
    const q = await admin.get(`/api/analytics/quota?month=${month}`);
    const ana = q.body.users.find((u: { name: string }) => u.name === "Ana Ventas");
    expect(ana.attainment).toBe(50);
    const anaAgent = await login(app, "ana@test.local", "Password123");
    expect((await anaAgent.put("/api/analytics/quota").send({ user_id: s2.id, month, amount: 1 })).status).toBe(403);
    const l = await admin.get("/api/analytics/loss-reasons");
    expect(l.body.reasons[0]).toMatchObject({ reason: "price", label: "Precio", count: 1, pct: 100 });
    expect(l.body.competitors[0].name).toBe("ACME");
    const k = await admin.get("/api/analytics/kpi/conversion_rate");
    expect(k.body.value).toBe(50);
  });
});

describe("paneles, programación y alertas", () => {
  it("crea paneles por rol y guarda widgets", async () => {
    const list = await admin.get("/api/analytics/dashboards");
    expect(list.body.items.length).toBeGreaterThanOrEqual(5);
    expect(list.body.items[0].role_key).toBe("admin");
    const ana = await login(app, "ana@test.local", "Password123");
    const mine = (await ana.get("/api/analytics/dashboards")).body.items;
    expect(mine.map((d: { name: string }) => d.name)).toEqual(["Mi rendimiento"]);
    const nd = await ana.post("/api/analytics/dashboards").send({ name: "Mío", widgets: [{ id: "a", kind: "kpi", kpi: "won_amount", w: 4, h: 1 }] });
    expect(nd.status).toBe(200);
    expect((await ana.put(`/api/analytics/dashboards/${mine[0].id}`).send({ name: "x", widgets: [] })).status).toBe(403);
    expect((await ana.post("/api/analytics/dashboards").send({ name: "Todos", visibility: "all" })).status).toBe(403);
  });
  it("ejecuta un informe programado a su hora y envía el CSV adjunto", async () => {
    const rep = (await admin.post("/api/analytics/reports").send({ name: "Semanal", object: "deal", config: { dims: [{ field: "owner_id" }], metrics: [{ fn: "count" }] } })).body;
    const l = localNow("Europe/Madrid");
    const s = await admin.post("/api/analytics/schedules").send({ report_id: rep.id, frequency: "daily", hour: 0, recipients: ["direccion@test.local"] });
    expect(s.status).toBe(200);
    const before = sentLog.length;
    await runAnalyticsJobs(db, db.get<{ id: string }>("SELECT id FROM workspaces")!.id, "Europe/Madrid");
    const mail = sentLog.slice(before).find((m) => m.to === "direccion@test.local")!;
    expect(mail.subject).toBe("Informe: Semanal");
    expect(mail.attachments?.[0]?.filename).toBe("Semanal.csv");
    expect(mail.attachments?.[0]?.content).toContain("Propietario;Recuento");
    // no se repite en el mismo periodo
    const n = sentLog.length;
    await runAnalyticsJobs(db, db.get<{ id: string }>("SELECT id FROM workspaces")!.id, "Europe/Madrid");
    expect(sentLog.length).toBe(n);
    expect(db.get<{ last_period_key: string }>("SELECT last_period_key FROM report_schedules WHERE id=?", s.body.id)!.last_period_key).toBe(l.date);
  });
  it("alerta de métrica: avisa una vez por periodo", async () => {
    const a = await admin.post("/api/analytics/alerts").send({ name: "Conversión baja", metric: "conversion_rate", period: "month", op: "lt", threshold: 60 });
    expect(a.status).toBe(200);
    const c = await admin.post(`/api/analytics/alerts/${a.body.id}/check`);
    expect(c.body).toMatchObject({ value: 50, triggered: true });
    const again = await admin.post(`/api/analytics/alerts/${a.body.id}/check`);
    expect(again.body.triggered).toBe(false);
    const notifs = db.all<{ title: string }>("SELECT title FROM notifications WHERE type='metric_alert'");
    expect(notifs.length).toBe(1);
  });
});
