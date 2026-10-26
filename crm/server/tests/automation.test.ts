import { describe, it, expect, beforeAll } from "vitest";
import { makeApp, login } from "./helpers.js";
import { tick } from "../services/scheduler.js";
import { evalFormula, aggregate } from "../services/columns.js";
import { computeFireAt, localToUtc } from "../services/workflows.js";
import { systemCtx } from "../services/system.js";
import type { Db } from "../db.js";

type Agent = Awaited<ReturnType<typeof login>>;
let app: ReturnType<typeof makeApp>["app"];
let db: Db;
let admin: Agent;
const today = () => new Date().toISOString().slice(0, 10);
const plus = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  ({ app, db } = makeApp(false));
  admin = await login(app, "admin@test.local", "Admin1234!");
});

describe("motor de fórmulas y agregaciones", () => {
  const ref = (vals: Record<string, unknown>) => (n: string) => { if (!(n in vals)) throw new Error(`Columna desconocida: {${n}}`); return vals[n]; };
  it("evalúa operadores, funciones y fechas", () => {
    expect(evalFormula("ROUND({Importe}*{Prob}/100, 2)", ref({ Importe: 1234.5, Prob: 30 })).value).toBe(370.35);
    expect(evalFormula('IF(DAYS({Fin}, "2026-10-01") < 0, "Vencido", IF(DAYS({Fin}, "2026-10-01") < 30, "Pronto", "OK"))', ref({ Fin: "2026-10-20" })).value).toBe("Pronto");
    expect(evalFormula('SUBTRACT_DAYS({Fin}, {Preaviso})', ref({ Fin: "2026-12-31", Preaviso: 90 })).value).toBe("2026-10-02");
    expect(evalFormula('CONCATENATE(UPPER("a"), "-", LEN("hola"))', ref({})).value).toBe("A-4");
    expect(evalFormula("2 + 3 * 4 ^ 2", ref({})).value).toBe(50);
    expect(evalFormula('SWITCH({E}, "a", 1, "b", 2, 0)', ref({ E: "b" })).value).toBe(2);
    expect(evalFormula('WORKDAYS("2026-10-30", "2026-10-26")', ref({})).value).toBe(5);
    expect(evalFormula('ADD_WORKDAYS("2026-10-30", 1)', ref({})).value).toBe("2026-11-02");
    expect(evalFormula("{Nope} + 1", ref({})).error).toContain("Columna desconocida");
    expect(evalFormula("IF(1, 2", ref({})).error).toBeTruthy();
  });
  it("agrega reflejos, incluido TODOS/ALGUNO/%", () => {
    expect(aggregate([10, 20, null, 30], "sum")).toBe(60);
    expect(aggregate([10, 20, 30], "median")).toBe(20);
    expect(aggregate(["done", "done"], "all_eq", "Done")).toBe(true);
    expect(aggregate(["done", "pending"], "all_eq", "done")).toBe(false);
    expect(aggregate(["done", "pending"], "any_eq", "done")).toBe(true);
    expect(aggregate(["done", "pending", "x", "done"], "pct_eq", "done")).toBe(50);
    expect(aggregate(["2026-01-05", "2025-12-01"], "earliest")).toBe("2025-12-01");
  });
  it("calcula la próxima ejecución de un disparador de fecha en la zona de la cuenta", () => {
    const ctx = systemCtx(db, db.get<{ id: string }>("SELECT id FROM workspaces")!.id);
    expect(localToUtc("2026-01-15", 9, "Europe/Madrid").toISOString()).toBe("2026-01-15T08:00:00.000Z");
    expect(localToUtc("2026-07-15", 9, "Europe/Madrid").toISOString()).toBe("2026-07-15T07:00:00.000Z");
    expect(computeFireAt(ctx, { type: "date_arrives", offset_days: -30, at_hour: 9 }, "2026-07-31").toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(computeFireAt(ctx, { type: "date_arrives", offset_days: 2, business_days: true, at_hour: 8 }, "2026-10-30").toISOString()).toBe("2026-11-03T07:00:00.000Z");
  });
});

describe("columnas: estados por ID, fórmulas, reflejos, por defecto y obligatorias", () => {
  let companyId: string, dealId: string, stateFieldId: string;
  it("guarda el estado por ID de etiqueta y renombrar no toca las celdas", async () => {
    const f = await admin.post("/api/admin/custom-fields").send({ object: "deal", key: "fase_legal", label: "Fase legal", type: "status", settings: { labels: [{ label: "Pendiente" }, { label: "Revisado", color: "#00c875", done: true }] } });
    expect(f.status).toBe(200);
    stateFieldId = f.body.id;
    expect(f.body.settings.labels.map((l: { id: number }) => l.id)).toEqual([1, 2]);
    const co = await admin.post("/api/companies").send({ name: "Fórmulas SL", sector: "Tecnología" });
    companyId = co.body.id;
    const d = await admin.post("/api/deals").send({ name: "Deal fórmulas", amount: 10000, company_id: companyId, custom: { fase_legal: "Revisado" } });
    expect(d.status).toBe(200);
    dealId = d.body.id;
    expect(d.body.custom.fase_legal).toBe(2);
    const bad = await admin.put(`/api/deals/${dealId}`).send({ custom: { fase_legal: "Inventada" } });
    expect(bad.status).toBe(400);
    const ren = await admin.put(`/api/admin/custom-fields/${stateFieldId}`).send({ settings: { labels: [{ id: 1, label: "Pendiente" }, { id: 2, label: "Aprobado por legal", done: true }] } });
    expect(ren.status).toBe(200);
    const cells = await admin.get(`/api/cells/deal/${dealId}`);
    const cell = cells.body.column_values.find((c: { id: string }) => c.id === "custom.fase_legal");
    expect(cell).toMatchObject({ value: 2, text: "Aprobado por legal", is_done: true });
    // borrar una etiqueta en uso está bloqueado
    const del = await admin.put(`/api/admin/custom-fields/${stateFieldId}`).send({ settings: { labels: [{ id: 1, label: "Pendiente" }] } });
    expect(del.status).toBe(409);
  });
  it("fórmulas y reflejos se calculan por fila y aparecen en listas, fichas y celdas", async () => {
    expect((await admin.post("/api/admin/custom-fields").send({ object: "deal", key: "ponderado", label: "Ponderado", type: "formula", settings: { expression: "ROUND({Importe} * {Probabilidad} / 100, 2)", result: "number" } })).status).toBe(200);
    expect((await admin.post("/api/admin/custom-fields").send({ object: "deal", key: "semaforo", label: "Semáforo", type: "formula", settings: { expression: 'IF({Ponderado} > 1000, "Alto", "Bajo")' } })).status).toBe(200);
    expect((await admin.post("/api/admin/custom-fields").send({ object: "company", key: "pipeline_total", label: "Pipeline total", type: "mirror", settings: { relation: "deals", field: "amount", agg: "sum" } })).status).toBe(200);
    expect((await admin.post("/api/admin/custom-fields").send({ object: "deal", key: "num", label: "Nº", type: "autonumber", settings: { prefix: "N-", pad: 3 } })).status).toBe(200);
    const bad = await admin.post("/api/admin/custom-fields").send({ object: "deal", key: "rota", label: "Rota", type: "formula", settings: { expression: "SUM(1," } });
    expect(bad.status).toBe(400);
    const d = (await admin.get(`/api/deals/${dealId}`)).body;
    expect(d.custom.ponderado).toBe(Math.round(10000 * d.probability) / 100);
    expect(d.custom.semaforo).toBe(d.custom.ponderado > 1000 ? "Alto" : "Bajo");
    expect(d.custom.num).toMatch(/^N-\d{3}$/);
    await admin.post("/api/deals").send({ name: "Deal 2", amount: 5000, company_id: companyId });
    const c = (await admin.get(`/api/companies/${companyId}`)).body;
    expect(c.custom.pipeline_total).toBe(15000);
    const list = (await admin.get("/api/companies?page_size=50")).body.items.find((x: { id: string }) => x.id === companyId);
    expect(list.custom.pipeline_total).toBe(15000);
    const prev = await admin.post("/api/columns/formula/preview").send({ object: "deal", expression: "{Importe} * 2", record_id: dealId });
    expect(prev.body.value).toBe(20000);
    const deps = await admin.get("/api/columns/dependents/deal/ponderado");
    expect(deps.body.items.some((x: { kind: string }) => x.kind === "fórmula")).toBe(true);
    const types = await admin.get("/api/columns/types");
    expect(Object.keys(types.body.types)).toEqual(expect.arrayContaining(["status", "formula", "mirror", "timeline", "button", "rating"]));
  });
  it("aplica valores por defecto del tablero y columnas obligatorias por estado", async () => {
    const cfg = (await admin.get("/api/boards/ticket")).body.config ?? {};
    await admin.put("/api/boards/ticket").send({ ...cfg, defaults: { category: "General", priority: "high" }, required: [{ when_field: "status", values: ["resolved"], fields: ["category", "description"] }] });
    const t = await admin.post("/api/tickets").send({ subject: "Sin categoría" });
    expect(t.body.category).toBe("General");
    expect(t.body.priority).toBe("high");
    const r = await admin.put(`/api/tickets/${t.body.id}`).send({ status: "resolved" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("Descripción");
    await admin.put(`/api/tickets/${t.body.id}`).send({ description: "Resuelto por teléfono" });
    expect((await admin.put(`/api/tickets/${t.body.id}`).send({ status: "resolved" })).status).toBe(200);
  });
  it("API de celdas: escritura múltiple y solo lectura", async () => {
    const w = await admin.put(`/api/cells/deal/${dealId}`).send({ values: { amount: 12000, "custom.fase_legal": { id: 1 } } });
    expect(w.status).toBe(200);
    expect(w.body.column_values.find((c: { id: string }) => c.id === "amount").value).toBe(12000);
    expect((await admin.put(`/api/cells/deal/${dealId}`).send({ column_id: "created_at", value: "2020-01-01" })).status).toBe(400);
  });
});

describe("automatizaciones v2", () => {
  let dealId: string, companyId: string;
  const ws = () => db.get<{ id: string }>("SELECT id FROM workspaces")!.id;
  beforeAll(async () => {
    const co = await admin.post("/api/companies").send({ name: "Automatiza SA" });
    companyId = co.body.id;
    dealId = (await admin.post("/api/deals").send({ name: "Deal auto", amount: 1000, company_id: companyId })).body.id;
  });
  it("disparador «cambia de X a Y» sobre un estado, rama si/si no y propietario de servicio", async () => {
    const wf = await admin.post("/api/workflows").send({ name: "De Pendiente a Aprobado", trigger: { type: "field_changed", object: "deal", field: "custom.fase_legal", from: "Pendiente", value: "Aprobado por legal" }, allow_reenroll: true,
      actions: [{ type: "branch", conditions: { logic: "or", conditions: [{ field: "amount", op: "gt", value: 50000 }, { logic: "and", conditions: [{ field: "custom.semaforo", op: "eq", value: "Alto" }, { field: "_origin", op: "neq", value: "automation" }] }] }, then: [{ type: "add_tag", tag: "grande" }], else: [{ type: "add_tag", tag: "pequeño" }] }] });
    expect(wf.status).toBe(200);
    await admin.put(`/api/deals/${dealId}`).send({ custom: { fase_legal: "Pendiente" } });
    await admin.put(`/api/deals/${dealId}`).send({ custom: { fase_legal: "Aprobado por legal" } });
    const d = (await admin.get(`/api/deals/${dealId}`)).body;
    expect(d.tags).toContain(d.custom.semaforo === "Alto" ? "grande" : "pequeño");
    const runs = (await admin.get(`/api/workflows/${wf.body.id}/runs`)).body.items;
    expect(runs[0]).toMatchObject({ status: "ok", actions_count: 1, origin: "ui" });
    const tagAudit = db.get<{ user_id: string }>("SELECT user_id FROM audit_log WHERE object='deal' AND record_id=? AND changes LIKE '%grande%' OR changes LIKE '%pequeño%' ORDER BY created_at DESC LIMIT 1", dealId);
    expect(db.get<{ is_service: number }>("SELECT is_service FROM users WHERE id=?", tagAudit!.user_id)!.is_service).toBe(1);
  });
  it("una fórmula dispara y condiciona (a diferencia de monday)", async () => {
    const wf = await admin.post("/api/workflows").send({ name: "Semáforo pasa a Alto", allow_reenroll: true, trigger: { type: "field_changed", object: "deal", field: "custom.semaforo", value: "Alto" }, actions: [{ type: "set_number", field: "probability", mode: "set", value: "90" }, { type: "set_date", field: "expected_close_date", mode: "today", days: 3, business_days: true }] });
    expect(wf.status).toBe(200);
    await admin.put(`/api/deals/${dealId}`).send({ amount: 1000 });
    await admin.put(`/api/deals/${dealId}`).send({ amount: 200000 });
    const d = (await admin.get(`/api/deals/${dealId}`)).body;
    expect(d.probability).toBe(90);
    expect(d.expected_close_date >= plus(3)).toBe(true);
  });
  it("aprobación humana: el flujo espera y continúa por la rama elegida", async () => {
    const manager = db.get<{ id: string }>("SELECT id FROM users WHERE is_service=0 ORDER BY created_at LIMIT 1")!.id;
    const wf = await admin.post("/api/workflows").send({ name: "Botón aprobar", allow_reenroll: true, trigger: { type: "button_clicked", object: "deal", button: "aprobar" }, actions: [{ type: "request_approval", approver: `user:${manager}`, title: "¿Aprobar {{name}}?", then: [{ type: "add_tag", tag: "aprobado" }], else: [{ type: "add_tag", tag: "rechazado" }] }, { type: "log_note", title: "Tras la aprobación" }] });
    expect(wf.status).toBe(200);
    await admin.post("/api/admin/custom-fields").send({ object: "deal", key: "aprobar", label: "Aprobar", type: "button", settings: { label: "Aprobar" } });
    expect((await admin.post(`/api/cells/deal/${dealId}/button/aprobar`)).status).toBe(200);
    const ap = (await admin.get("/api/workflows/approvals")).body.items.find((x: { status: string; workflow_id: string }) => x.workflow_id === wf.body.id && x.status === "pending");
    expect(ap.title).toBe("¿Aprobar Deal auto?");
    const runs1 = (await admin.get(`/api/workflows/${wf.body.id}/runs`)).body.items;
    expect(runs1[0].status).toBe("waiting");
    const dec = await admin.post(`/api/workflows/approvals/${ap.id}/decide`).send({ decision: "approved", comment: "OK" });
    expect(dec.status).toBe(200);
    const d = (await admin.get(`/api/deals/${dealId}`)).body;
    expect(d.tags).toContain("aprobado");
    expect(db.get("SELECT id FROM activities WHERE deal_id=? AND subject='Tras la aprobación'", dealId)).toBeTruthy();
    expect((await admin.post(`/api/workflows/approvals/${ap.id}/decide`).send({ decision: "rejected", comment: "x" })).status).toBe(400);
  });
  it("planificador de fechas: programa al cambiar la fecha, reprograma y dispara a su hora", async () => {
    await admin.post("/api/admin/custom-fields").send({ object: "deal", key: "seguimiento", label: "Seguimiento", type: "date" });
    const wf = await admin.post("/api/workflows").send({ name: "Seguimiento 1 día antes", allow_reenroll: true, trigger: { type: "date_arrives", object: "deal", field: "custom.seguimiento", offset_days: -1, at_hour: 9 }, actions: [{ type: "create_task", title: "Preparar seguimiento de {{name}}", due_in_days: 1 }] });
    expect(wf.status).toBe(200);
    await admin.put(`/api/deals/${dealId}`).send({ custom: { seguimiento: plus(10) } });
    let sched = (await admin.get(`/api/workflows/${wf.body.id}/schedule`)).body.items;
    expect(sched.length).toBe(1);
    expect(sched[0].basis).toBe(plus(10));
    await admin.put(`/api/deals/${dealId}`).send({ custom: { seguimiento: plus(20) } });
    sched = (await admin.get(`/api/workflows/${wf.body.id}/schedule`)).body.items;
    expect(sched.length).toBe(1);
    expect(sched[0].basis).toBe(plus(20));
    db.run("UPDATE automation_schedule SET fire_at=? WHERE id=?", new Date(Date.now() - 1000).toISOString(), sched[0].id);
    await tick(db);
    expect(db.get("SELECT id FROM tasks WHERE deal_id=? AND title='Preparar seguimiento de Deal auto'", dealId)).toBeTruthy();
    // fecha pasada: sin efecto retroactivo
    await admin.put(`/api/deals/${dealId}`).send({ custom: { seguimiento: plus(-5) } });
    expect((await admin.get(`/api/workflows/${wf.body.id}/schedule`)).body.items.length).toBe(0);
    const perRecord = (await admin.get(`/api/workflows/record/deal/${dealId}`)).body;
    expect(perRecord.items.length).toBeGreaterThan(0);
  });
  it("subelementos: todos completados → acción sobre el padre; actualizar elemento conectado", async () => {
    const wf = await admin.post("/api/workflows").send({ name: "Checklist completa", allow_reenroll: true, trigger: { type: "all_subitems_done", object: "deal" }, actions: [{ type: "update_related", relation: "company", field: "sector", value: "Checklist {{name}}" }] });
    expect(wf.status).toBe(200);
    const t1 = await admin.post("/api/tasks").send({ title: "Paso 1", deal_id: dealId });
    const t2 = await admin.post("/api/tasks").send({ title: "Paso 2", deal_id: dealId });
    for (const t of db.all<{ id: string }>("SELECT id FROM tasks WHERE deal_id=? AND completed_at IS NULL AND id NOT IN (?,?)", dealId, t1.body.id, t2.body.id)) await admin.post(`/api/tasks/${t.id}/complete`).send({});
    await admin.post(`/api/tasks/${t1.body.id}/complete`).send({});
    expect(db.get<{ sector: string }>("SELECT sector FROM companies WHERE id=?", companyId)!.sector).not.toBe("Checklist Deal auto");
    await admin.post(`/api/tasks/${t2.body.id}/complete`).send({});
    expect(db.get<{ sector: string }>("SELECT sector FROM companies WHERE id=?", companyId)!.sector).toBe("Checklist Deal auto");
  });
  it("protección de bucles: dos automatizaciones que se disparan mutuamente se cortan y se pausan", async () => {
    const a = await admin.post("/api/workflows").send({ name: "Bucle A", allow_reenroll: true, trigger: { type: "field_changed", object: "company", field: "city" }, actions: [{ type: "update_field", field: "country", value: "X{{city}}" }] });
    const b = await admin.post("/api/workflows").send({ name: "Bucle B", allow_reenroll: true, trigger: { type: "field_changed", object: "company", field: "country" }, actions: [{ type: "update_field", field: "city", value: "Y{{country}}" }] });
    await admin.put(`/api/companies/${companyId}`).send({ city: "Madrid" });
    const wa = (await admin.get(`/api/workflows/${a.body.id}`)).body, wb = (await admin.get(`/api/workflows/${b.body.id}`)).body;
    const runs = [...(await admin.get(`/api/workflows/${a.body.id}/runs`)).body.items, ...(await admin.get(`/api/workflows/${b.body.id}/runs`)).body.items];
    expect(runs.some((r: { error: string | null }) => /Bucle/.test(String(r.error)))).toBe(true);
    expect(wa.active === 0 || wb.active === 0).toBe(true);
    expect(String(wa.paused_reason ?? wb.paused_reason)).toContain("Bucle");
    await admin.del(`/api/workflows/${a.body.id}`); await admin.del(`/api/workflows/${b.body.id}`);
  });
  it("cuenta acciones contra el presupuesto, avisa y bloquea la edición al agotarlo", async () => {
    const usage = (await admin.get("/api/workflows/usage")).body;
    expect(usage.used).toBeGreaterThan(0);
    await admin.put("/api/admin/settings").send({ automation_budget: usage.used });
    await admin.put(`/api/deals/${dealId}`).send({ amount: 100 });
    await admin.put(`/api/deals/${dealId}`).send({ amount: 300000 });
    const blocked = await admin.post("/api/workflows").send({ name: "No debería", trigger: { type: "record_created", object: "deal" }, actions: [{ type: "add_tag", tag: "x" }] });
    expect(blocked.status).toBe(409);
    expect(db.get("SELECT key FROM counters WHERE key LIKE 'auto_alert:%:100'")).toBeTruthy();
    await admin.put("/api/admin/settings").send({ automation_budget: 25000 });
    const csv = await admin.get("/api/workflows/runs.csv");
    expect(csv.text.split("\n")[0]).toContain("automatización");
  });
  it("un propietario desactivado pausa la automatización con un error legible; reasignar la reactiva", async () => {
    const u = await admin.post("/api/admin/users").send({ name: "Temporal", email: "temporal@test.local", password: "Clave-Segura-1234", role_id: db.get<{ id: string }>("SELECT id FROM roles WHERE key='admin'")!.id });
    const wf = await admin.post("/api/workflows").send({ name: "Del temporal", owner_id: u.body.id, allow_reenroll: true, trigger: { type: "record_created", object: "company" }, actions: [{ type: "add_tag", tag: "nueva" }] });
    db.run("UPDATE users SET active=0 WHERE id=?", u.body.id);
    await admin.post("/api/companies").send({ name: "Dispara SA" });
    const w = (await admin.get(`/api/workflows/${wf.body.id}`)).body;
    expect(w.active).toBe(0);
    expect(w.paused_reason).toContain("propietario");
    const re = await admin.post("/api/workflows/reassign").send({ from: u.body.id, to: null, reactivate: true });
    expect(re.body.updated).toBe(1);
    const c = await admin.post("/api/companies").send({ name: "Dispara 2 SA" });
    expect(c.body.tags ?? (await admin.get(`/api/companies/${c.body.id}`)).body.tags).toBeDefined();
    expect((await admin.get(`/api/companies/${c.body.id}`)).body.tags).toContain("nueva");
  });
  it("instala recetas del catálogo con sus columnas y la ejecución atómica deshace cambios", async () => {
    const list = (await admin.get("/api/workflows/recipes")).body.items;
    expect(list.length).toBeGreaterThanOrEqual(20);
    const r8 = await admin.post("/api/workflows/recipes/R8/install").send({});
    expect(r8.status).toBe(200);
    expect(r8.body.fields_created).toContain("Aprobación");
    const r9 = await admin.post("/api/workflows/recipes/R9/install").send({});
    expect(r9.status).toBe(200);
    const atomic = await admin.post("/api/workflows").send({ name: "Atómica", atomic: true, allow_reenroll: true, trigger: { type: "button_clicked", object: "deal", button: "aprobar" }, actions: [{ type: "add_tag", tag: "atomica" }, { type: "change_stage", stage_id: "no-existe" }] });
    expect(atomic.status).toBe(200);
    await admin.post(`/api/cells/deal/${dealId}/button/aprobar`);
    const d = (await admin.get(`/api/deals/${dealId}`)).body;
    expect(d.tags).not.toContain("atomica");
    const run = (await admin.get(`/api/workflows/${atomic.body.id}/runs`)).body.items[0];
    expect(run.status).toBe("error");
    expect(run.log.join(" ")).toContain("deshecho");
    const cat = (await admin.get("/api/workflows/catalog")).body.items;
    expect(cat.find((x: { name: string }) => x.name === "Atómica").owner_name).toBe("Automatizaciones");
    const sim = await admin.post("/api/workflows/simulate").send({ workflow: { name: "s", trigger: { type: "date_arrives", object: "deal", field: "custom.seguimiento", offset_days: 1 }, conditions: { logic: "and", conditions: [] }, actions: [{ type: "create_subitems", titles: "a\nb\nc" }] }, object: "deal", record_id: dealId });
    expect(sim.body.actions_count).toBe(3);
    void ws; void today;
  });
});
