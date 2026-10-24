import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { makeApp, login } from "./helpers.js";
import { tick } from "../services/scheduler.js";
import { sentLog } from "../services/email.js";
import type { Db } from "../db.js";

type Agent = Awaited<ReturnType<typeof login>>;
let app: ReturnType<typeof makeApp>["app"];
let db: Db;
let admin: Agent;

beforeAll(async () => {
  ({ app, db } = makeApp(true));
  admin = await login(app, "admin@test.local", "Admin1234!");
});

describe("CLM", () => {
  it("seeds catalog and demo contracts in every lifecycle state", async () => {
    const meta = await admin.get("/api/clm/meta");
    expect(meta.body.types.length).toBeGreaterThan(10);
    const list = await admin.get("/api/clm/contracts?page_size=100");
    const statuses = new Set(list.body.items.map((c: { status: string }) => c.status));
    for (const s of ["ACTIVE", "INTERNAL_REVIEW", "PENDING_APPROVAL", "APPROVED", "PARTIALLY_SIGNED", "EXPIRED", "TERMINATED", "DRAFT", "NEGOTIATION"]) expect(statuses.has(s)).toBe(true);
    const rep = await admin.get("/api/clm/reports");
    expect(rep.body.active).toBeGreaterThan(3);
    expect(rep.body.compliance.unlimited_liability.length).toBeGreaterThan(0);
  });
  it("runs the full lifecycle: intake → template → playbook → approval → signature (OTP) → active → obligations/milestones", async () => {
    const types = (await admin.get("/api/clm/types")).body.items;
    const msa = types.find((t: { code: string }) => t.code === "MSA");
    const co = db.get<{ id: string }>("SELECT id FROM companies WHERE deleted_at IS NULL LIMIT 1")!;
    const c = await admin.post("/api/clm/contracts").send({ title: "MSA de prueba", type_id: msa.id, counterparty_company_id: co.id, total_value: 60000, annual_value: 60000, term_months: 12, renewal_type: "auto", renewal_period_months: 12, notice_period_days: 60, payment_model: "recurring", payment_terms_days: 30, contains_personal_data: true, data_role: "processor" });
    expect(c.status).toBe(200);
    expect(c.body.number).toMatch(/^MSA-\d{4}-\d{5}$/);
    const d1 = (await admin.get(`/api/clm/contracts/${c.body.id}`)).body;
    expect(d1.versions.length).toBe(1);
    expect(d1.current_body).toContain("LIMITACIÓN DE RESPONSABILIDAD".toLowerCase().slice(0, 0) + "Limitación de responsabilidad");
    expect(d1.clauses.some((x: { category: string }) => x.category === "F02")).toBe(true);
    // state machine guard: cannot request approval without counterparty? (has one) -> submit review
    const t1 = await admin.post(`/api/clm/contracts/${c.body.id}/transitions`).send({ event: "submit_for_review" });
    expect(t1.body.status).toBe("INTERNAL_REVIEW");
    const ap = await admin.post(`/api/clm/contracts/${c.body.id}/approvals/request`);
    expect(ap.status).toBe(200);
    expect(ap.body.steps.some((s: { name: string }) => s.name.includes("Finanzas"))).toBe(true);
    // decide every pending step as admin (admin override)
    for (let i = 0; i < 6; i++) { const d = (await admin.get(`/api/clm/contracts/${c.body.id}`)).body; const p = d.approvals.find((a: { status: string }) => a.status === "pending"); if (!p) break; const r = await admin.post(`/api/clm/approvals/${p.id}/decide`).send({ decision: "approved", comment: "ok" }); expect(r.status).toBe(200); }
    const d2 = (await admin.get(`/api/clm/contracts/${c.body.id}`)).body;
    expect(d2.status).toBe("APPROVED");
    // version change after approval invalidates and returns to review
    const v = await admin.post(`/api/clm/contracts/${c.body.id}/versions`).send({ body: d2.current_body + "\n\nAnexo adicional.", comment: "cambio" });
    expect(v.status).toBe(200);
    const d3 = (await admin.get(`/api/clm/contracts/${c.body.id}`)).body;
    expect(d3.status).toBe("INTERNAL_REVIEW");
    expect(d3.approvals.every((a: { status: string }) => a.status !== "pending")).toBe(true);
    await admin.post(`/api/clm/contracts/${c.body.id}/approvals/request`);
    for (let i = 0; i < 6; i++) { const d = (await admin.get(`/api/clm/contracts/${c.body.id}`)).body; const p = d.approvals.find((a: { status: string }) => a.status === "pending"); if (!p) break; await admin.post(`/api/clm/approvals/${p.id}/decide`).send({ decision: "approved" }); }
    // signature: checklist blocks signer without authority
    const adminUser = db.get<{ id: string; name: string; email: string }>("SELECT id, name, email FROM users WHERE email='admin@test.local'")!;
    const bad = await admin.post(`/api/clm/contracts/${c.body.id}/envelopes`).send({ signers: [{ name: "Nadie", email: "nadie@x.com", party: "us", user_id: "nope" }, { name: "Cliente", email: "cliente@x.com", party: "them" }] });
    expect(bad.status).toBe(400);
    const env = await admin.post(`/api/clm/contracts/${c.body.id}/envelopes`).send({ signers: [{ name: adminUser.name, email: adminUser.email, party: "us", user_id: adminUser.id }, { name: "Cliente Prueba", email: "cliente@x.com", party: "them" }] });
    expect(env.status).toBe(200);
    expect(env.body.status).toBe("OUT_FOR_SIGNATURE");
    const signers = db.all<{ token: string; email: string }>("SELECT token, email FROM signers WHERE envelope_id=(SELECT id FROM signature_envelopes WHERE contract_id=? ORDER BY created_at DESC LIMIT 1)", c.body.id);
    expect(signers.length).toBe(2);
    for (const s of signers) {
      const view = await request(app).get(`/s/${s.token}.json`); expect(view.status).toBe(200); expect(view.body.document).toContain("MSA DE PRUEBA");
      const wrong = await request(app).post(`/s/${s.token}/sign`).send({ otp: "000000", consent: true }); expect(wrong.status).toBe(400);
      const otp = await request(app).post(`/s/${s.token}/otp`); expect(otp.body.demo_code).toMatch(/^\d{6}$/);
      const mail = sentLog.find((m) => m.to === s.email && m.subject.includes("código")); expect(mail).toBeTruthy();
      const ok = await request(app).post(`/s/${s.token}/sign`).send({ otp: otp.body.demo_code, consent: true }); expect(ok.status).toBe(200);
    }
    const d4 = (await admin.get(`/api/clm/contracts/${c.body.id}`)).body;
    expect(d4.status).toBe("ACTIVE");
    expect(d4.signed_version_id).toBeTruthy();
    expect(d4.current_body).toContain("CERTIFICADO DE EVIDENCIAS");
    expect(d4.milestones.some((m: { type: string }) => m.type === "notice_deadline")).toBe(true);
    expect(d4.obligations.length).toBeGreaterThan(1);
    expect(d4.payments.length).toBe(12);
    expect(sentLog.filter((m) => m.subject.startsWith("Copia firmada")).length).toBeGreaterThanOrEqual(2);
    // signed document is immutable
    const imm = await admin.post(`/api/clm/contracts/${c.body.id}/versions`).send({ body: "hack" });
    expect(imm.status).toBe(409);
    const ver = await admin.post("/api/clm/verify").send({ sha256: db.get<{ sha256: string }>("SELECT sha256 FROM contract_versions WHERE id=?", d4.signed_version_id)!.sha256 });
    expect(ver.body.valid).toBe(true);
    // amendment flow applies effective values
    const am = await admin.post(`/api/clm/contracts/${c.body.id}/amendments`).send({ type: "price_update", changes: { annual_value: 66000, total_value: 66000 } });
    expect(am.status).toBe(200);
    expect(am.body.kind).toBe("amendment");
    await admin.post(`/api/clm/contracts/${am.body.id}/transitions`).send({ event: "submit_for_review" });
    await admin.post(`/api/clm/contracts/${am.body.id}/approvals/request`);
    for (let i = 0; i < 6; i++) { const d = (await admin.get(`/api/clm/contracts/${am.body.id}`)).body; const p = d.approvals.find((a: { status: string }) => a.status === "pending"); if (!p) break; await admin.post(`/api/clm/approvals/${p.id}/decide`).send({ decision: "approved" }); }
    await admin.post(`/api/clm/contracts/${am.body.id}/envelopes`).send({ signers: [{ name: adminUser.name, email: adminUser.email, party: "us", user_id: adminUser.id }, { name: "Cliente Prueba", email: "cliente@x.com", party: "them" }] });
    for (const s of db.all<{ token: string }>("SELECT token FROM signers WHERE envelope_id=(SELECT id FROM signature_envelopes WHERE contract_id=? ORDER BY created_at DESC LIMIT 1)", am.body.id)) { const otp = await request(app).post(`/s/${s.token}/otp`); await request(app).post(`/s/${s.token}/sign`).send({ otp: otp.body.demo_code, consent: true }); }
    const d5 = (await admin.get(`/api/clm/contracts/${c.body.id}`)).body;
    expect(d5.effective_values.annual_value).toBe(66000);
    expect(d5.annual_value).toBe(66000);
    expect(d5.children.length).toBe(1);
    // obligation fulfil with recurrence creates next instance
    const ob = d5.obligations.find((o: { recurrence: string }) => o.recurrence === "monthly");
    const f = await admin.patch(`/api/clm/obligations/${ob.id}`).send({ status: "fulfilled", evidence_note: "Factura 2026-001" });
    expect(f.body.status).toBe("fulfilled");
    const d6 = (await admin.get(`/api/clm/contracts/${c.body.id}`)).body;
    expect(d6.obligations.filter((o: { title: string }) => o.title === ob.title).length).toBe(2);
    // termination
    const term = await admin.post(`/api/clm/contracts/${c.body.id}/transitions`).send({ event: "terminate", payload: { cause: "mutual", date: new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10), note: "Acuerdo de salida" } });
    expect(term.body.status).toBe("TERMINATED");
    expect((await admin.get(`/api/clm/contracts/${c.body.id}`)).body.obligations.some((o: { survives_termination: number; status: string }) => o.survives_termination && o.status === "pending")).toBe(true);
  });
  it("reviews external paper against the playbook and flags prohibited clauses with high risk", async () => {
    const list = (await admin.get("/api/clm/contracts?queue=legal&page_size=50")).body.items;
    const ext = list.find((c: { paper_origin: string }) => c.paper_origin === "theirs");
    expect(ext).toBeTruthy();
    const d = (await admin.get(`/api/clm/contracts/${ext.id}`)).body;
    const e01 = d.clauses.find((x: { category: string }) => x.category === "E01");
    expect(e01.deviation_level).toBe("prohibited");
    expect(d.clauses.find((x: { category: string }) => x.category === "C02").deviation_level).toBe("prohibited");
    expect(d.clauses.find((x: { category: string }) => x.category === "I01").deviation_level).toBe("major");
    expect(["high", "critical"]).toContain(d.risk_level);
    expect(d.approval_preview.some((s: { name: string }) => s.name.includes("Director legal"))).toBe(true);
    const cmp = await admin.get(`/api/clm/versions/${d.versions[0].id}/compare`);
    expect(cmp.status).toBe(400); // only one version
  });
  it("daily job: alerts on notice deadline, auto-renews by inaction and breaches obligations", async () => {
    const before = db.get<{ n: number }>("SELECT COUNT(*) n FROM notifications")!.n;
    await tick(db, { forceDaily: true });
    const after = db.get<{ n: number }>("SELECT COUNT(*) n FROM notifications")!.n;
    expect(after).toBeGreaterThan(before);
    // force an active auto-renew contract past its end -> auto renewed by inaction
    const c = db.get<{ id: string; end_date: string; renewals_done: number }>("SELECT id, end_date, renewals_done FROM contracts WHERE status='ACTIVE' AND renewal_type='auto' AND kind='master' LIMIT 1")!;
    db.run("UPDATE contracts SET end_date=date('now','-1 day'), notice_deadline=date('now','-61 day') WHERE id=?", c.id);
    await tick(db, { forceDaily: true });
    const upd = db.get<{ end_date: string; renewals_done: number; status: string }>("SELECT end_date, renewals_done, status FROM contracts WHERE id=?", c.id)!;
    expect(upd.status).toBe("ACTIVE");
    expect(upd.renewals_done).toBe(c.renewals_done + 1);
    expect(upd.end_date > new Date().toISOString().slice(0, 10)).toBe(true);
    expect(db.get("SELECT id FROM renewal_decisions WHERE contract_id=? AND decision='auto_renewed_by_inaction'", c.id)).toBeTruthy();
    const breached = db.get<{ n: number }>("SELECT COUNT(*) n FROM obligations WHERE status='breached'")!.n;
    expect(breached).toBeGreaterThan(0);
  });
  it("compares versions with paragraph and word diff", async () => {
    const list = (await admin.get("/api/clm/contracts?status=ACTIVE&page_size=50")).body.items;
    let d: { versions: { id: string }[] } | null = null;
    for (const c of list) { const x = (await admin.get(`/api/clm/contracts/${c.id}`)).body; if (x.versions.length >= 2) { d = x; break; } }
    expect(d).toBeTruthy(); if (!d) return;
    const cmp = await admin.get(`/api/clm/versions/${d.versions[d.versions.length - 1].id}/compare`);
    expect(cmp.status).toBe(200);
    expect(cmp.body.summary).toBeTruthy();
    expect(cmp.body.html).toContain("<p");
  });
});
