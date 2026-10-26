import { describe, it, expect, beforeAll } from "vitest";
import { makeApp, login } from "./helpers.js";
import { tick } from "../services/scheduler.js";
import { systemCtx } from "../services/system.js";
import * as clm from "../services/clm.js";
import type { Db } from "../db.js";

type Agent = Awaited<ReturnType<typeof login>>;
let app: ReturnType<typeof makeApp>["app"];
let db: Db;
let admin: Agent;
let ws: string;
const typeId = (code: string) => db.get<{ id: string }>("SELECT id FROM contract_types WHERE code=?", code)!.id;
const userId = (email: string) => db.get<{ id: string }>("SELECT id FROM users WHERE email=?", email)!.id;
const company = () => db.get<{ id: string }>("SELECT id FROM companies WHERE deleted_at IS NULL LIMIT 1")!.id;
const isoIn = (days: number) => new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);

beforeAll(async () => {
  ({ app, db } = makeApp(true));
  admin = await login(app, "admin@test.local", "Admin1234!");
  ws = db.get<{ id: string }>("SELECT id FROM workspaces LIMIT 1")!.id;
});

describe("CLM configurable", () => {
  it("lifecycle per type: sub-states, optional entry skip, transition and phase guards, SLA escalation", async () => {
    const nda = typeId("NDA");
    const lc = {
      states: [
        { key: "pre_borrador", label: "Pre-borrador", phase: "DRAFT", optional: true },
        { key: "solicitud", label: "Solicitud recibida", phase: "DRAFT" },
        { key: "triaje", label: "Triaje", phase: "INTERNAL_REVIEW", sla_hours: 4, escalate_to: "manager" },
        { key: "revision_legal", label: "Revisión legal", phase: "INTERNAL_REVIEW", required_fields: ["department"], roles: ["admin", "manager"] },
        { key: "revision_fiscal", label: "Revisión fiscal", phase: "INTERNAL_REVIEW" },
        { key: "enviado", label: "Enviado a contraparte", phase: "NEGOTIATION", required_fields: ["jurisdiction"] },
      ],
      transitions: [{ from: "triaje", to: "revision_legal", label: "A legal" }, { from: "revision_legal", to: "revision_fiscal" }],
    };
    const put = await admin.put(`/api/clm/lifecycles/${nda}`).send(lc);
    expect(put.status).toBe(200);
    // estado repetido o transición a un estado inexistente → 400
    expect((await admin.put(`/api/clm/lifecycles/${nda}`).send({ states: [lc.states[0], lc.states[0]] })).status).toBe(400);
    expect((await admin.put(`/api/clm/lifecycles/${nda}`).send({ states: lc.states, transitions: [{ from: "triaje", to: "nope" }] })).status).toBe(400);

    const c = await admin.post("/api/clm/contracts").send({ title: "NDA ciclo", type_id: nda, counterparty_company_id: company() });
    expect(c.status).toBe(200);
    let d = (await admin.get(`/api/clm/contracts/${c.body.id}`)).body;
    expect(d.lifecycle.current.key).toBe("solicitud"); // el opcional se salta
    expect(d.state_label).toBe("Solicitud recibida");

    const sub = await admin.post(`/api/clm/contracts/${c.body.id}/transitions`).send({ event: "submit_for_review" });
    expect(sub.status).toBe(200);
    d = (await admin.get(`/api/clm/contracts/${c.body.id}`)).body;
    expect(d.lifecycle.current.key).toBe("triaje");
    expect(d.lifecycle.moves.map((s: { key: string }) => s.key)).toEqual(["revision_legal"]);
    // listado con la etiqueta del estado
    const list = (await admin.get(`/api/clm/contracts?type_id=${nda}&page_size=100`)).body.items;
    expect(list.find((x: { id: string }) => x.id === c.body.id).state_label).toBe("Triaje");

    // transición no configurada (triaje → fiscal)
    expect((await admin.post(`/api/clm/contracts/${c.body.id}/transitions`).send({ event: "move_state", payload: { state: "revision_fiscal" } })).status).toBe(409);
    // campo obligatorio en la transición
    const miss = await admin.post(`/api/clm/contracts/${c.body.id}/transitions`).send({ event: "move_state", payload: { state: "revision_legal" } });
    expect(miss.status).toBe(400);
    expect(miss.body.error.message ?? miss.body.error).toMatch(/Departamento/);
    await admin.patch(`/api/clm/contracts/${c.body.id}`).send({ department: "Legal" });
    const ok = await admin.post(`/api/clm/contracts/${c.body.id}/transitions`).send({ event: "move_state", payload: { state: "revision_legal" } });
    expect(ok.status).toBe(200);
    expect(ok.body.state_key).toBe("revision_legal");
    // un estado de otra fase no se alcanza con move_state
    expect((await admin.post(`/api/clm/contracts/${c.body.id}/transitions`).send({ event: "move_state", payload: { state: "enviado" } })).status).toBe(409);
    // guarda en el cambio de fase del motor: NEGOTIATION/enviado exige jurisdicción
    const neg = await admin.post(`/api/clm/contracts/${c.body.id}/transitions`).send({ event: "send_to_counterparty" });
    expect(neg.status).toBe(400);
    expect(JSON.stringify(neg.body)).toMatch(/Jurisdicción/);
    await admin.patch(`/api/clm/contracts/${c.body.id}`).send({ jurisdiction: "Madrid" });
    const neg2 = await admin.post(`/api/clm/contracts/${c.body.id}/transitions`).send({ event: "send_to_counterparty" });
    expect(neg2.status).toBe(200);
    expect(neg2.body.status).toBe("NEGOTIATION");
    expect(neg2.body.state_key).toBe("enviado");

    // rol: un comercial no puede pasar a «Revisión legal»
    const c2 = await admin.post("/api/clm/contracts").send({ title: "NDA rol", type_id: nda, counterparty_company_id: company(), department: "Ventas", owner_id: userId("carlos@crm.local") });
    await admin.post(`/api/clm/contracts/${c2.body.id}/transitions`).send({ event: "submit_for_review" });
    const carlos = await login(app, "carlos@crm.local", "Demo1234!");
    const denied = await carlos.post(`/api/clm/contracts/${c2.body.id}/transitions`).send({ event: "move_state", payload: { state: "revision_legal" } });
    expect(denied.status).toBe(403);

    // SLA por estado vencido → escalado (una sola vez)
    db.run("UPDATE contracts SET state_due_at=? WHERE id=?", new Date(Date.now() - 3600e3).toISOString(), c2.body.id);
    await tick(db, { forceDaily: true });
    const esc = db.get<{ state_escalated_at: string | null }>("SELECT state_escalated_at FROM contracts WHERE id=?", c2.body.id)!;
    expect(esc.state_escalated_at).toBeTruthy();
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE title LIKE ?", "%SLA superado en «Triaje»%")!.n).toBeGreaterThan(0);

    // borrar el ciclo: los contratos quedan solo con fases
    expect((await admin.delete(`/api/clm/lifecycles/${nda}`)).status).toBe(200);
    expect(db.get<{ state_key: string | null }>("SELECT state_key FROM contracts WHERE id=?", c.body.id)!.state_key).toBeNull();
  });

  it("approval matrix: seeded defaults, nested conditions, groups any/all, parallel stages, substitutes, stage order and expiry", async () => {
    const rules = (await admin.get("/api/clm/approval-rules")).body.items;
    expect(rules.map((r: { name: string }) => r.name)).toEqual(["Aprobación de negocio", "Legal", "Director legal", "Finanzas", "DPO", "Dirección general"]);
    const nda = typeId("NDA");
    const [carlos, marta, javier, lucia, ana] = ["carlos", "marta", "javier", "lucia", "ana"].map((n) => userId(`${n}@crm.local`));
    db.run("UPDATE companies SET country='US' WHERE id=?", company());
    const rule = await admin.post("/api/clm/approval-rules").send({
      name: "NDA internacional", priority: 1, type_ids: [nda], stop: true, reason: "NDA {value} con contraparte fuera de España",
      conditions: { logic: "all", conditions: [{ field: "value", op: "gte", value: 1000 }, { logic: "any", conditions: [{ field: "counterparty_country", op: "in", value: "US,GB" }, { field: "risk_level", op: "eq", value: "high" }] }] },
      steps: [
        { name: "Comercial", approver: { kind: "group", users: [carlos, marta], mode: "any" }, sla_hours: 24, expiry_days: 10 },
        { name: "Compliance", approver: { kind: "user", user_id: javier }, parallel: true },
        { name: "Comité", approver: { kind: "group", users: [lucia, ana], mode: "all" } },
      ],
    });
    expect(rule.status).toBe(200);
    // sustitución por ausencia: Javier → Lucía hoy
    const today = isoIn(0);
    expect((await admin.post("/api/clm/delegations").send({ user_id: javier, substitute_id: lucia, from_date: today, to_date: isoIn(3), reason: "Vacaciones" })).status).toBe(200);

    const c = await admin.post("/api/clm/contracts").send({ title: "NDA EEUU", type_id: nda, counterparty_company_id: company(), total_value: 2000 });
    const prev = (await admin.get(`/api/clm/contracts/${c.body.id}/approvals/preview`)).body.steps;
    expect(prev.map((s: { name: string; stage: number }) => `${s.stage}:${s.name}`)).toEqual(["1:Comercial", "1:Compliance", "2:Comité", "2:Comité"]);
    expect(prev[0].group).toEqual([carlos, marta]);
    expect(prev[1].approver_user_id).toBe(lucia);
    expect(prev[1].substitute_for).toBe(javier);
    expect(prev[1].reason).toMatch(/2000|2\.000/);
    expect(prev.slice(2).map((s: { approver_user_id: string }) => s.approver_user_id).sort()).toEqual([lucia, ana].sort());
    // la regla con stop impide que se apliquen las de por defecto; con valor bajo no aplica y vuelven las de por defecto
    const low = await admin.post("/api/clm/contracts").send({ title: "NDA bajo", type_id: nda, counterparty_company_id: company(), total_value: 10 });
    const lowSteps = (await admin.get(`/api/clm/contracts/${low.body.id}/approvals/preview`)).body.steps;
    expect(lowSteps.some((s: { name: string }) => s.name === "Comercial")).toBe(false);

    await admin.post(`/api/clm/contracts/${c.body.id}/transitions`).send({ event: "submit_for_review" });
    const req = await admin.post(`/api/clm/contracts/${c.body.id}/approvals/request`);
    expect(req.status).toBe(200);
    let d = (await admin.get(`/api/clm/contracts/${c.body.id}`)).body;
    const pend = d.approvals.filter((a: { status: string }) => a.status === "pending");
    expect(pend.length).toBe(4);
    const comercial = pend.find((a: { step_name: string }) => a.step_name === "Comercial");
    expect(comercial.approver_group).toEqual([carlos, marta]);
    expect(comercial.expires_at).toBeTruthy();
    // etapa 2 no se decide antes que la 1
    const comite = pend.find((a: { step_name: string }) => a.step_name === "Comité");
    expect((await admin.post(`/api/clm/approvals/${comite.id}/decide`).send({ decision: "approved" })).status).toBe(409);
    // cualquiera del grupo puede decidir: Marta aparece en su bandeja
    const martaAg = await login(app, "marta@crm.local", "Demo1234!");
    const inbox = (await martaAg.get("/api/clm/approvals/pending")).body.items;
    expect(inbox.some((a: { id: string }) => a.id === comercial.id)).toBe(true);
    for (const a of pend.filter((x: { step_order: number }) => x.step_order === 1)) expect((await admin.post(`/api/clm/approvals/${a.id}/decide`).send({ decision: "approved" })).status).toBe(200);
    for (const a of pend.filter((x: { step_order: number }) => x.step_order === 2)) expect((await admin.post(`/api/clm/approvals/${a.id}/decide`).send({ decision: "approved" })).status).toBe(200);
    d = (await admin.get(`/api/clm/contracts/${c.body.id}`)).body;
    expect(d.status).toBe("APPROVED");

    // caducidad: una aprobación pendiente caducada devuelve el contrato a revisión
    const c3 = await admin.post("/api/clm/contracts").send({ title: "NDA caduca", type_id: nda, counterparty_company_id: company(), total_value: 3000 });
    await admin.post(`/api/clm/contracts/${c3.body.id}/transitions`).send({ event: "submit_for_review" });
    await admin.post(`/api/clm/contracts/${c3.body.id}/approvals/request`);
    db.run("UPDATE contract_approvals SET expires_at=? WHERE contract_id=? AND status='pending' AND step_name='Comercial'", new Date(Date.now() - 1000).toISOString(), c3.body.id);
    await tick(db, { forceDaily: true });
    expect(db.get<{ status: string }>("SELECT status FROM contracts WHERE id=?", c3.body.id)!.status).toBe("INTERNAL_REVIEW");
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM contract_approvals WHERE contract_id=? AND status='expired'", c3.body.id)!.n).toBe(1);

    // validación de referencias
    expect((await admin.post("/api/clm/approval-rules").send({ name: "Mal", steps: [{ name: "x", approver: { kind: "role" } }] })).status).toBe(400);
    // restablecer la política por defecto
    const reset = await admin.post("/api/clm/approval-rules/reset");
    expect(reset.body.items.length).toBe(6);
  });

  it("numbering tokens per type, preview without consuming", async () => {
    const nda = typeId("NDA");
    expect((await admin.put(`/api/clm/types/${nda}`).send({ number_format: "{TYPE}/{YYYY}" })).status).toBe(400);
    expect((await admin.put(`/api/clm/types/${nda}`).send({ number_format: "{TYPE}/{YYYY}/{DEPT}-{SEQ:4}" })).status).toBe(200);
    const y = new Date().getFullYear();
    const pv = await admin.post(`/api/clm/types/${nda}/number-preview`).send({ department: "Compras" });
    expect(pv.body.number).toBe(`NDA/${y}/COMPRA-0001`);
    const a = await admin.post("/api/clm/contracts").send({ title: "N1", type_id: nda, department: "Ventas" });
    const b = await admin.post("/api/clm/contracts").send({ title: "N2", type_id: nda, department: "Ventas" });
    const c = await admin.post("/api/clm/contracts").send({ title: "N3", type_id: nda, department: "Compras" });
    expect([a.body.number, b.body.number, c.body.number]).toEqual([`NDA/${y}/VENTAS-0001`, `NDA/${y}/VENTAS-0002`, `NDA/${y}/COMPRA-0001`]);
    expect((await admin.post(`/api/clm/types/${nda}/number-preview`).send({ department: "Compras" })).body.number).toBe(`NDA/${y}/COMPRA-0002`);
    const fmt2 = await admin.post(`/api/clm/types/${nda}/number-preview`).send({ format: "{CODE}-{YY}{MM}-{SEQ:3}" });
    expect(fmt2.body.number).toMatch(new RegExp(`^NDA-${String(y).slice(2)}\\d{2}-\\d{3}$`));
    await admin.put(`/api/clm/types/${nda}`).send({ number_format: null });
    expect((await admin.post("/api/clm/contracts").send({ title: "N4", type_id: nda })).body.number).toMatch(/^NDA-\d{4}-\d{5}$/);
  });

  it("per-type intake form: required, conditional, mapping and type-scoped custom fields", async () => {
    const sow = typeId("SOW"); const msa = typeId("MSA");
    const form = [
      { key: "objeto", label: "Objeto del encargo", type: "textarea", required: true, map_to: "description", help: "Qué se contrata" },
      { key: "tiene_datos", label: "¿Trata datos personales?", type: "boolean" },
      { key: "volumen", label: "Volumen de datos", type: "select", options: ["bajo", "alto"], required: true, show_if: { field: "tiene_datos", op: "truthy" } },
      { key: "presupuesto", label: "Presupuesto", type: "money", map_to: "total_value" },
    ];
    expect((await admin.put(`/api/clm/types/${sow}`).send({ intake_form: [{ key: "x", label: "X", type: "select" }] })).status).toBe(400);
    expect((await admin.put(`/api/clm/types/${sow}`).send({ intake_form: form })).status).toBe(200);
    const t = (await admin.get("/api/clm/types")).body.items.find((x: { id: string }) => x.id === sow);
    expect(t.intake_form.length).toBe(4);

    const r1 = await admin.post("/api/clm/contracts").send({ title: "SOW sin objeto", type_id: sow, intake: {} });
    expect(r1.status).toBe(400);
    expect(JSON.stringify(r1.body)).toMatch(/Faltan datos de la solicitud: Objeto del encargo/);
    const r2 = await admin.post("/api/clm/contracts").send({ title: "SOW datos", type_id: sow, intake: { objeto: "Migración", tiene_datos: true } });
    expect(r2.status).toBe(400);
    expect(JSON.stringify(r2.body)).toMatch(/Volumen de datos/);
    const r3 = await admin.post("/api/clm/contracts").send({ title: "SOW ok", type_id: sow, intake: { objeto: "Migración", tiene_datos: false, presupuesto: "12500", volumen: "alto" } });
    expect(r3.status).toBe(200);
    expect(r3.body.description).toBe("Migración");
    expect(r3.body.total_value).toBe(12500);
    expect(r3.body.intake.volumen).toBeUndefined(); // oculto por la condición: no se guarda

    // campo personalizado limitado al tipo SOW y obligatorio
    const cf = await admin.post("/api/admin/custom-fields").send({ object: "contract", key: "codigo_proyecto", label: "Código de proyecto", type: "text", required: true, contract_type_id: sow });
    expect(cf.status).toBe(200);
    expect((await admin.post("/api/clm/contracts").send({ title: "MSA sin código", type_id: msa })).status).toBe(200);
    const r4 = await admin.post("/api/clm/contracts").send({ title: "SOW sin código", type_id: sow, intake: { objeto: "x" } });
    expect(r4.status).toBe(400);
    expect(JSON.stringify(r4.body)).toMatch(/Código de proyecto/);
    expect((await admin.post("/api/clm/contracts").send({ title: "SOW con código", type_id: sow, intake: { objeto: "x" }, custom: { codigo_proyecto: "P-1" } })).status).toBe(200);
    await admin.put(`/api/clm/types/${sow}`).send({ intake_form: [] });
    db.run("DELETE FROM custom_fields WHERE key='codigo_proyecto'");
  });

  it("alerts per type: milestone offsets, default obligations/milestones, obligation reminders, escalation and acknowledgement", async () => {
    const lic = typeId("LIC");
    const cfgPut = await admin.put(`/api/clm/types/${lic}`).send({
      alert_config: { notice: [45, 10], end: [20], obligation: [3], escalate_after_days: 0, escalate_to: "manager" },
      default_obligations: [{ title: "Informe trimestral de uso", anchor: "effective", offset_days: 2, type: "report", recurrence: "quarterly" }],
      default_milestones: [{ label: "Revisión de precios", anchor: "effective", offset_days: 5, alert_offsets: [10] }, { label: "Auditoría anual", anchor: "effective", offset_days: 8, alert_offsets: [30] }],
    });
    expect(cfgPut.status).toBe(200);
    const c = await admin.post("/api/clm/contracts").send({ title: "Licencia", type_id: lic, counterparty_company_id: company(), effective_date: isoIn(0), term_months: 12, notice_period_days: 60, renewal_type: "auto", renewal_period_months: 12 });
    expect(c.status).toBe(200);
    const sctx = systemCtx(db, ws);
    clm.activateContract(sctx, c.body.id, "system");
    const ms = db.all<{ type: string; label: string; alert_offsets: string; id: string }>("SELECT * FROM milestones WHERE contract_id=?", c.body.id);
    expect(JSON.parse(ms.find((m) => m.type === "notice_deadline")!.alert_offsets)).toEqual([45, 10]);
    expect(JSON.parse(ms.find((m) => m.type === "end")!.alert_offsets)).toEqual([20]);
    expect(ms.some((m) => m.label === "Revisión de precios")).toBe(true);
    const ob = db.get<{ id: string; due_date: string }>("SELECT * FROM obligations WHERE contract_id=? AND title='Informe trimestral de uso'", c.body.id)!;
    expect(ob.due_date).toBe(isoIn(2));

    // reconoce una alerta antes del escalado
    const audit = ms.find((m) => m.label === "Auditoría anual")!;
    const ack = await admin.post(`/api/clm/milestones/${audit.id}/ack`);
    expect(ack.status).toBe(200);
    expect(ack.body.acknowledged_at).toBeTruthy();

    await tick(db, { forceDaily: true });
    expect(JSON.parse(db.get<{ alerted: string }>("SELECT alerted FROM obligations WHERE id=?", ob.id)!.alerted)).toEqual([3]);
    const price = db.get<{ first_alerted_at: string | null; escalated_at: string | null }>("SELECT * FROM milestones WHERE contract_id=? AND label='Revisión de precios'", c.body.id)!;
    expect(price.first_alerted_at).toBeTruthy();
    expect(price.escalated_at).toBeTruthy(); // sin acuse y escalate_after_days = 0
    const aud = db.get<{ escalated_at: string | null; first_alerted_at: string | null }>("SELECT * FROM milestones WHERE id=?", audit.id)!;
    expect(aud.first_alerted_at).toBeTruthy();
    expect(aud.escalated_at).toBeNull(); // con acuse no se escala
    // segunda pasada: no duplica avisos de obligación
    await tick(db, { forceDaily: true });
    expect(JSON.parse(db.get<{ alerted: string }>("SELECT alerted FROM obligations WHERE id=?", ob.id)!.alerted)).toEqual([3]);
  });

  it("clause/playbook CRUD and full configuration export → import roundtrip", async () => {
    // CRUD de cláusulas y playbooks
    const cl = await admin.post("/api/clm/clauses").send({ code: "ZZ-01", title: "Cláusula de prueba", category: "A01", body: "Texto" });
    expect(cl.status).toBe(200);
    expect((await admin.put(`/api/clm/clauses/${cl.body.id}`).send({ body: "Texto 2" })).body.version).toBe(2);
    const pb = await admin.post("/api/clm/playbooks").send({ name: "Playbook prueba", rules: [{ category: "A01", must_exist: true }] });
    expect(pb.status).toBe(200);
    expect((await admin.put(`/api/clm/playbooks/${pb.body.id}`).send({ name: "Playbook prueba 2" })).body.name).toBe("Playbook prueba 2");

    const nda = typeId("NDA");
    await admin.put(`/api/clm/lifecycles/${nda}`).send({ states: [{ key: "alta", label: "Alta", phase: "DRAFT" }, { key: "rev", label: "Revisión", phase: "INTERNAL_REVIEW", sla_hours: 8 }], transitions: [] });
    await admin.put("/api/clm/lifecycles/*").send({ states: [{ key: "borrador", label: "Borrador", phase: "DRAFT" }] });
    await admin.put(`/api/clm/types/${nda}`).send({ number_format: "{TYPE}-{SEQ:6}", intake_form: [{ key: "motivo", label: "Motivo", type: "text", required: true }], alert_config: { notice: [30] } });
    await admin.post("/api/clm/approval-rules").send({ name: "Grupo legal", priority: 5, type_ids: [nda], conditions: { logic: "all", conditions: [{ field: "value", op: "gt", value: 0 }] }, steps: [{ name: "Legal", approver: { kind: "group", users: [userId("lucia@crm.local"), userId("ana@crm.local")], mode: "all" } }] });

    const exp = await admin.get("/api/clm/config/export");
    expect(exp.status).toBe(200);
    expect(exp.body.format).toBe("crm-clm-config");
    expect(exp.body.lifecycles.length).toBe(2);
    expect(exp.body.approval_rules.find((r: { name: string }) => r.name === "Grupo legal").steps[0].approver.user_emails).toEqual(["lucia@crm.local", "ana@crm.local"]);

    const other = makeApp(true);
    const admin2 = await login(other.app, "admin@test.local", "Admin1234!");
    const imp = await admin2.post("/api/clm/config/import").send({ data: exp.body, mode: "replace" });
    expect(imp.status).toBe(200);
    expect(imp.body.created.lifecycles).toBe(2);
    expect(imp.body.created.clauses).toBeGreaterThanOrEqual(1);
    const exp2 = (await admin2.get("/api/clm/config/export")).body;
    const norm = (e: typeof exp.body) => ({
      lifecycles: e.lifecycles.sort((a: { type_code: string }, b: { type_code: string }) => a.type_code.localeCompare(b.type_code)),
      rules: e.approval_rules.map((r: Record<string, unknown>) => ({ ...r, priority: r.priority })).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
      nda: e.types.find((t: { code: string }) => t.code === "NDA"),
      clauses: e.clauses.length, playbooks: e.playbooks.map((p: { name: string }) => p.name).sort(),
    });
    expect(norm(exp2)).toEqual(norm(exp.body));
    // la configuración importada funciona: el número y el formulario del tipo se aplican
    const ndaOther = other.db.get<{ id: string }>("SELECT id FROM contract_types WHERE code='NDA'")!.id;
    expect((await admin2.post("/api/clm/contracts").send({ title: "x", type_id: ndaOther })).status).toBe(400);
    const made = await admin2.post("/api/clm/contracts").send({ title: "x", type_id: ndaOther, intake: { motivo: "Prueba" } });
    expect(made.body.number).toBe("NDA-000001");
    expect(made.body.state_key).toBe("alta");
    // importar requiere el formato correcto
    expect((await admin2.post("/api/clm/config/import").send({ data: { format: "otro", version: 1 } })).status).toBe(400);
  });
});
