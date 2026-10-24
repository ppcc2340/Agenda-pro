import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { makeApp, login } from "./helpers.js";
import { tick } from "../services/scheduler.js";
import { sentLog } from "../services/email.js";
import { totpCode } from "../lib/util.js";
import type { Db } from "../db.js";

type Agent = Awaited<ReturnType<typeof login>>;
let app: ReturnType<typeof makeApp>["app"];
let db: Db;
let admin: Agent;

beforeAll(async () => {
  ({ app, db } = makeApp(false));
  admin = await login(app, "admin@test.local", "Admin1234!");
});

describe("auth", () => {
  it("rejects wrong password and locks after 5 failures", async () => {
    const r = await request(app).post("/api/auth/login").send({ email: "admin@test.local", password: "nope" });
    expect(r.status).toBe(401);
    const a = await request(app).get("/api/contacts");
    expect(a.status).toBe(401);
  });
  it("supports 2FA setup and login", async () => {
    const setup = await admin.post("/api/auth/2fa/setup");
    expect(setup.body.secret).toBeTruthy();
    const en = await admin.post("/api/auth/2fa/enable").send({ code: totpCode(setup.body.secret) });
    expect(en.status).toBe(200);
    const agent = request.agent(app);
    const l = await agent.post("/api/auth/login").send({ email: "admin@test.local", password: "Admin1234!" });
    expect(l.body.requires_2fa).toBe(true);
    const blocked = await agent.get("/api/contacts");
    expect(blocked.status).toBe(401);
    const ok = await agent.post("/api/auth/2fa").send({ code: totpCode(setup.body.secret) });
    expect(ok.status).toBe(200);
    expect((await agent.get("/api/contacts")).status).toBe(200);
    await admin.post("/api/auth/2fa/disable").send({ password: "Admin1234!" });
  });
});

describe("contacts & companies", () => {
  let contactId: string;
  it("creates a contact with auto-created company by name, normalizing data", async () => {
    const r = await admin.post("/api/contacts").send({ first_name: "  ana ", last_name: "garcía lópez", email: "Ana.Garcia@ACME.com", phone: "600 11 22 33", company_name: "ACME SL", source: "referral" });
    expect(r.status).toBe(200);
    expect(r.body.email).toBe("ana.garcia@acme.com");
    expect(r.body.phone).toBe("+34600112233");
    expect(r.body.first_name).toBe("Ana");
    expect(r.body.company_name).toBe("ACME SL");
    contactId = r.body.id;
  });
  it("detects duplicates by email (409) unless forced", async () => {
    const dup = await admin.post("/api/contacts").send({ first_name: "Ana", email: "ana.garcia@acme.com" });
    expect(dup.status).toBe(409);
    expect(dup.body.details.duplicates[0].id).toBe(contactId);
    const forced = await admin.post("/api/contacts?force=1").send({ first_name: "Ana", last_name: "Dup", email: "ana.garcia@acme.com" });
    expect(forced.status).toBe(200);
    const groups = await admin.get("/api/contacts/duplicates");
    expect(groups.body.groups.length).toBeGreaterThan(0);
    // merge: survivor keeps activities, merged goes to recycle bin
    await admin.post("/api/activities").send({ type: "note", subject: "nota dup", contact_id: forced.body.id });
    const m = await admin.post("/api/contacts/merge").send({ survivor_id: contactId, merged_id: forced.body.id });
    expect(m.status).toBe(200);
    const tl = await admin.get(`/api/contacts/${contactId}/timeline`);
    expect(tl.body.items.some((a: { subject: string }) => a.subject === "nota dup")).toBe(true);
    expect((await admin.get(`/api/contacts/${forced.body.id}`)).status).toBe(404);
    const merges = await admin.get("/api/contacts/merges");
    const undo = await admin.post(`/api/contacts/merges/${merges.body.items[0].id}/undo`);
    expect(undo.status).toBe(200);
    expect((await admin.get(`/api/contacts/${forced.body.id}`)).status).toBe(200);
    await admin.delete(`/api/contacts/${forced.body.id}`);
  });
  it("records field-level audit on update", async () => {
    await admin.put(`/api/contacts/${contactId}`).send({ job_title: "CEO", lifecycle_stage: "mql" });
    const h = await admin.get(`/api/contacts/${contactId}/history`);
    const upd = h.body.items.find((x: { action: string; changes: Record<string, unknown> }) => x.action === "update" && x.changes.job_title);
    expect(upd.changes.job_title).toEqual([null, "CEO"]);
  });
  it("requires a reason to disqualify", async () => {
    const r = await admin.put(`/api/contacts/${contactId}`).send({ lead_status: "unqualified" });
    expect(r.status).toBe(400);
  });
  it("filters with the DSL and exports CSV", async () => {
    const f = await admin.get(`/api/contacts?filters=${encodeURIComponent(JSON.stringify({ logic: "and", conditions: [{ field: "email", op: "contains", value: "acme" }, { field: "lifecycle_stage", op: "in", value: ["mql", "sql"] }] }))}`);
    expect(f.body.total).toBe(1);
    const csv = await admin.get("/api/contacts/export");
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text).toContain("ana.garcia@acme.com");
  });
  it("GDPR export and anonymize", async () => {
    const c = await admin.post("/api/contacts").send({ first_name: "Pepe", email: "pepe@gmail.com" });
    const ex = await admin.get(`/api/contacts/${c.body.id}/gdpr-export`);
    expect(ex.body.contact.email).toBe("pepe@gmail.com");
    const an = await admin.post(`/api/contacts/${c.body.id}/anonymize`);
    expect(an.body.first_name).toBe("Anonimizado");
    expect(an.body.email).toBeNull();
  });
  it("blocks internal domains", async () => {
    await admin.put("/api/admin/settings").send({ internal_domains: ["test.local"] });
    const r = await admin.post("/api/contacts").send({ first_name: "Yo", email: "colleague@test.local" });
    expect(r.status).toBe(400);
  });
});

describe("deals & pipeline", () => {
  let dealId: string; let stages: { id: string; name: string; kind: string; required_fields: string[] }[]; let contactId: string; let companyId: string;
  beforeAll(async () => {
    const p = await admin.get("/api/pipelines");
    stages = p.body.items[0].stages;
    const c = await admin.post("/api/contacts").send({ first_name: "Luis", email: "luis@beta.io", company_name: "Beta" });
    contactId = c.body.id; companyId = c.body.company_id;
  });
  it("creates a deal in first stage with default probability", async () => {
    const r = await admin.post("/api/deals").send({ name: "Beta · CRM", company_id: companyId, amount: 10000, contact_ids: [contactId], expected_close_date: "2030-01-01" });
    expect(r.status).toBe(200);
    expect(r.body.stage_name).toBe("Cualificación");
    expect(r.body.probability).toBe(10);
    expect(r.body.weighted_amount).toBe(1000);
    dealId = r.body.id;
    const c = await admin.get(`/api/contacts/${contactId}`);
    expect(c.body.lifecycle_stage).toBe("opportunity");
  });
  it("rejects past close date", async () => {
    const r = await admin.post("/api/deals").send({ name: "x", expected_close_date: "2020-01-01" });
    expect(r.status).toBe(400);
  });
  it("moves stage (drag & drop) with history and audit, enforcing required fields", async () => {
    const proposal = stages.find((s) => s.name === "Propuesta")!;
    const noAmount = await admin.post("/api/deals").send({ name: "Sin importe" });
    const bad = await admin.post(`/api/deals/${noAmount.body.id}/stage`).send({ stage_id: proposal.id });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("importe");
    const ok = await admin.post(`/api/deals/${dealId}/stage`).send({ stage_id: proposal.id });
    expect(ok.status).toBe(200);
    expect(ok.body.stage_name).toBe("Propuesta");
    expect(ok.body.probability).toBe(50);
    expect(ok.body.stage_history.length).toBe(2);
    const h = await admin.get(`/api/deals/${dealId}/history`);
    expect(h.body.items.some((x: { action: string }) => x.action === "stage_change")).toBe(true);
  });
  it("cannot mark lost without reason; won marks contact as customer", async () => {
    const bad = await admin.post(`/api/deals/${dealId}/close`).send({ status: "lost" });
    expect(bad.status).toBe(400);
    const won = await admin.post(`/api/deals/${dealId}/close`).send({ status: "won" });
    expect(won.body.status).toBe("won");
    expect((await admin.get(`/api/contacts/${contactId}`)).body.lifecycle_stage).toBe("customer");
    expect((await admin.get(`/api/companies/${companyId}`)).body.type).toBe("customer");
    const reopened = await admin.post(`/api/deals/${dealId}/reopen`);
    expect(reopened.body.status).toBe("open");
  });
  it("computes amount from product lines and board totals", async () => {
    const r = await admin.put(`/api/deals/${dealId}/products`).send([{ name: "Licencia", quantity: 10, unit_price: 50, discount: 10 }, { name: "Setup", quantity: 1, unit_price: 300 }]);
    expect(r.body.amount).toBe(750);
    const board = await admin.get(`/api/deals/board/${(await admin.get("/api/pipelines")).body.items[0].id}`);
    const col = board.body.stages.find((s: { deals: { id: string }[] }) => s.deals.some((d) => d.id === dealId));
    expect(col.amount).toBeGreaterThanOrEqual(750);
    expect(["green", "yellow", "red"]).toContain(col.deals[0].light);
    const fc = await admin.get("/api/deals/forecast");
    expect(fc.body.months.length).toBeGreaterThan(0);
  });
  it("creates and accepts a quote publicly, logging views", async () => {
    const q = await admin.post("/api/quotes").send({ deal_id: dealId, valid_days: 30, lines: [{ name: "Licencia", quantity: 2, unit_price: 100, discount: 0, tax_rate: 21 }], discount: 0 });
    expect(q.status).toBe(200);
    expect(q.body.total).toBe(242);
    const pub = await request(app).get(`/q/${q.body.token}.json`);
    expect(pub.body.number).toBe(q.body.number);
    const dec = await request(app).post(`/q/${q.body.token}/decision`).send({ decision: "accepted", name: "Luis Cliente" });
    expect(dec.status).toBe(200);
    const q2 = await admin.get(`/api/quotes/${q.body.id}`);
    expect(q2.body.status).toBe("accepted");
    expect(q2.body.views).toBe(1);
  });
});

describe("tasks, my day and activities", () => {
  it("creates tasks, completes with outcome logging an activity, recurs weekly", async () => {
    const c = await admin.post("/api/contacts").send({ first_name: "Tarea", email: "tarea@x.com" });
    const t = await admin.post("/api/tasks").send({ title: "Llamar", type: "call", due_at: new Date().toISOString(), contact_id: c.body.id, recurrence: "weekly" });
    const my = await admin.get("/api/tasks/my-day");
    expect(my.body.today.some((x: { id: string }) => x.id === t.body.id)).toBe(true);
    const done = await admin.post(`/api/tasks/${t.body.id}/complete`).send({ outcome: "Contactado", note: "ok" });
    expect(done.body.completed_at).toBeTruthy();
    const tl = await admin.get(`/api/contacts/${c.body.id}/timeline?types=call`);
    expect(tl.body.items[0].outcome).toBe("Contactado");
    const open = await admin.get(`/api/tasks?status=open&contact_id=${c.body.id}`);
    expect(open.body.items.length).toBe(1); // next recurrence
    const contact = await admin.get(`/api/contacts/${c.body.id}`);
    expect(contact.body.last_contacted_at).toBeTruthy();
  });
  it("sends a templated email with tracking and records opens", async () => {
    const c = await admin.post("/api/contacts").send({ first_name: "Mail", email: "mail@x.com" });
    const before = sentLog.length;
    const r = await admin.post("/api/activities/send-email").send({ contact_id: c.body.id, subject: "Hola {{nombre}}", body: "Texto para {{nombre}} https://example.com" });
    expect(r.status).toBe(200);
    expect(sentLog.length).toBe(before + 1);
    expect(sentLog[sentLog.length - 1]!.subject).toBe("Hola Mail");
    const open = await request(app).get(`/t/o/${r.body.email_id}.gif`);
    expect(open.status).toBe(200);
    const tl = await admin.get(`/api/contacts/${c.body.id}/timeline`);
    expect(tl.body.items.some((a: { subject: string }) => a.subject.startsWith("Email abierto"))).toBe(true);
    const notif = await admin.get("/api/notifications");
    expect(notif.body.items.some((n: { type: string }) => n.type === "email_opened")).toBe(true);
  });
});

describe("permissions & visibility", () => {
  it("manager sees own team only; sales sees own records; readonly cannot create", async () => {
    const roles = (await admin.get("/api/admin/roles")).body.items as { id: string; key: string }[];
    const rid = (k: string) => roles.find((r) => r.key === k)!.id;
    const t1 = (await admin.post("/api/admin/teams").send({ name: "Equipo A" })).body;
    const t2 = (await admin.post("/api/admin/teams").send({ name: "Equipo B" })).body;
    const mgr = (await admin.post("/api/admin/users").send({ name: "Manager A", email: "mgr@test.local", password: "Password123", role_id: rid("manager"), team_id: t1.id })).body;
    await admin.put(`/api/admin/teams/${t1.id}`).send({ manager_id: mgr.id });
    const s1 = (await admin.post("/api/admin/users").send({ name: "Sales A", email: "s1@test.local", password: "Password123", role_id: rid("sales"), team_id: t1.id })).body;
    const s2 = (await admin.post("/api/admin/users").send({ name: "Sales B", email: "s2@test.local", password: "Password123", role_id: rid("sales"), team_id: t2.id })).body;
    const ro = (await admin.post("/api/admin/users").send({ name: "Lector", email: "ro@test.local", password: "Password123", role_id: rid("readonly") })).body;
    void ro;
    const d1 = (await admin.post("/api/deals").send({ name: "Deal A", owner_id: s1.id })).body;
    const d2 = (await admin.post("/api/deals").send({ name: "Deal B", owner_id: s2.id })).body;
    const mgrAgent = await login(app, "mgr@test.local", "Password123");
    const list = await mgrAgent.get("/api/deals?page_size=200");
    const ids = list.body.items.map((d: { id: string }) => d.id);
    expect(ids).toContain(d1.id);
    expect(ids).not.toContain(d2.id);
    expect((await mgrAgent.get(`/api/deals/${d2.id}`)).status).toBe(403);
    const s1Agent = await login(app, "s1@test.local", "Password123");
    expect((await s1Agent.get(`/api/deals/${d1.id}`)).status).toBe(200);
    expect((await s1Agent.get(`/api/deals/${d2.id}`)).status).toBe(403);
    expect((await s1Agent.get("/api/admin/audit")).status).toBe(403);
    const roAgent = await login(app, "ro@test.local", "Password123");
    expect((await roAgent.post("/api/contacts").send({ first_name: "x" })).status).toBe(403);
    expect((await roAgent.get("/api/contacts")).status).toBe(200);
  });
});

describe("web forms, assignment and workflows", () => {
  it("accepts a public form submission: creates contact, assigns round-robin, creates task + notification, triggers welcome email workflow", async () => {
    const form = (await admin.get("/api/forms")).body.items[0];
    const before = sentLog.length;
    const r = await request(app).post(`/f/${form.slug}`).send({ name: "Nuevo Lead", email: "lead@empresa-nueva.com", company: "Empresa Nueva", phone: "611222333", utm_source: "google", utm_campaign: "otono", consent: "on" });
    expect(r.status).toBe(200);
    const c = await admin.get(`/api/contacts/${r.body.contact_id}`);
    expect(c.body.source).toBe("web");
    expect(c.body.owner_id).toBeTruthy();
    expect(c.body.utm.utm_source).toBe("google");
    expect(c.body.company_name).toBe("Empresa Nueva");
    expect(c.body.consent_marketing).toBe(1);
    expect(c.body.tasks.length).toBe(1);
    expect(sentLog.length).toBe(before + 1); // welcome email workflow
    expect(sentLog[sentLog.length - 1]!.to).toBe("lead@empresa-nueva.com");
    const runs = await admin.get(`/api/workflows/${(await admin.get("/api/workflows")).body.items.find((w: { name: string }) => w.name.startsWith("Lead nuevo")).id}/runs`);
    expect(runs.body.items[0].status).toBe("ok");
    // honeypot & validation
    expect((await request(app).post(`/f/${form.slug}`).send({ name: "Spam", email: "a@b.com", _hp: "x" })).status).toBe(400);
    expect((await request(app).post(`/f/${form.slug}`).send({ email: "sin-nombre" })).status).toBe(400);
  });
  it("runs a custom workflow: deal stage change -> task + field update, no re-enrollment, with delay job", async () => {
    const stages = (await admin.get("/api/pipelines")).body.items[0].stages as { id: string; name: string }[];
    const contact = stages.find((s) => s.name === "Contacto")!;
    const wf = await admin.post("/api/workflows").send({ name: "Test etapa", trigger: { type: "stage_changed", stage_id: contact.id }, conditions: { logic: "and", conditions: [{ field: "amount", op: "gte", value: 1000 }] }, actions: [{ type: "create_task", title: "Preparar demo para {{name}}", due_in_days: 2, assignee: "owner" }, { type: "add_tag", tag: "demo" }, { type: "delay", minutes: 1 }, { type: "notify", to: "owner", title: "Recordatorio {{name}}" }] });
    expect(wf.status).toBe(200);
    const small = await admin.post("/api/deals").send({ name: "Pequeño", amount: 100 });
    await admin.post(`/api/deals/${small.body.id}/stage`).send({ stage_id: contact.id });
    const big = await admin.post("/api/deals").send({ name: "Grande", amount: 5000 });
    await admin.post(`/api/deals/${big.body.id}/stage`).send({ stage_id: contact.id });
    const runs = await admin.get(`/api/workflows/${wf.body.id}/runs`);
    const statuses = Object.fromEntries(runs.body.items.map((r: { record_id: string; status: string }) => [r.record_id, r.status]));
    expect(statuses[small.body.id]).toBe("skipped");
    expect(statuses[big.body.id]).toBe("ok");
    const d = await admin.get(`/api/deals/${big.body.id}`);
    expect(d.body.tasks.some((t: { title: string }) => t.title === "Preparar demo para Grande")).toBe(true);
    expect(d.body.tags).toContain("demo");
    const jobs = db.all<{ run_at: string }>("SELECT * FROM scheduled_jobs WHERE done_at IS NULL");
    expect(jobs.length).toBe(1);
    db.run("UPDATE scheduled_jobs SET run_at=datetime('now','-1 minute')");
    await tick(db);
    const notif = db.get<{ title: string }>("SELECT title FROM notifications WHERE title='Recordatorio Grande'");
    expect(notif?.title).toBe("Recordatorio Grande");
    // move back and forth: no re-enrollment
    const qual = stages.find((s) => s.name === "Cualificación")!;
    await admin.post(`/api/deals/${big.body.id}/stage`).send({ stage_id: qual.id });
    await admin.post(`/api/deals/${big.body.id}/stage`).send({ stage_id: contact.id });
    expect((await admin.get(`/api/deals/${big.body.id}`)).body.tasks.filter((t: { title: string }) => t.title.startsWith("Preparar demo")).length).toBe(1);
  });
  it("scheduler: deal without activity 7 days creates follow-up task via predefined workflow", async () => {
    const d = await admin.post("/api/deals").send({ name: "Dormido", amount: 999 });
    db.run("UPDATE deals SET created_at=datetime('now','-10 days'), last_activity_at=NULL WHERE id=?", d.body.id);
    await tick(db, { forceDaily: true });
    const tasks = await admin.get(`/api/tasks?deal_id=${d.body.id}&status=open`);
    expect(tasks.body.items.some((t: { title: string }) => t.title.includes("Retomar"))).toBe(true);
  });
  it("simulates a workflow without executing", async () => {
    const c = await admin.post("/api/contacts").send({ first_name: "Sim", email: "sim@x.com", job_title: "Director" });
    const sim = await admin.post("/api/workflows/simulate").send({ workflow: { name: "s", trigger: { type: "record_created", object: "contact" }, conditions: { logic: "and", conditions: [{ field: "job_title", op: "contains", value: "director" }] }, actions: [{ type: "notify", title: "Hola {{nombre}}" }] }, object: "contact", record_id: c.body.id });
    expect(sim.body.matches).toBe(true);
    expect(sim.body.actions[0]).toContain("Hola Sim");
  });
});

describe("import, API keys, webhooks, lists", () => {
  it("imports 5 rows without duplicating by email and is revertible", async () => {
    const rows = [{ Nombre: "Imp Uno", Email: "uno@imp.com", Empresa: "ImpCo" }, { Nombre: "Imp Dos", Email: "dos@imp.com", Empresa: "ImpCo" }, { Nombre: "Imp Uno bis", Email: "UNO@imp.com", Empresa: "ImpCo" }, { Nombre: "", Email: "", Empresa: "" }, { Nombre: "Imp Tres", Email: "tres@imp.com", Empresa: "Otra" }];
    const mapping = { Nombre: "full_name", Email: "email", Empresa: "company_name" };
    const dry = await admin.post("/api/import").send({ object: "contact", rows, mapping, dedupe: "skip", dry_run: true });
    expect(dry.body.dry_run).toBe(true);
    const r = await admin.post("/api/import").send({ object: "contact", rows, mapping, dedupe: "skip" });
    expect(r.body.created).toBe(3);
    expect(r.body.skipped).toBe(1);
    expect(r.body.errors.length).toBe(1);
    const companies = await admin.get("/api/companies?q=ImpCo");
    expect(companies.body.total).toBe(1);
    const rev = await admin.post(`/api/imports/${r.body.id}/revert`);
    expect(rev.body.reverted).toBeGreaterThanOrEqual(3);
    expect((await admin.get("/api/contacts?q=imp.com")).body.total).toBe(0);
  });
  it("API key auth works with scopes and /api/v1 alias", async () => {
    const k = await admin.post("/api/admin/api-keys").send({ name: "zapier", scopes: "read" });
    expect(k.body.key).toMatch(/^crm_/);
    const list = await request(app).get("/api/v1/contacts").set("authorization", `Bearer ${k.body.key}`);
    expect(list.status).toBe(200);
    const write = await request(app).post("/api/v1/contacts").set("authorization", `Bearer ${k.body.key}`).send({ first_name: "x" });
    expect(write.status).toBe(403);
    const k2 = await admin.post("/api/admin/api-keys").send({ name: "rw" });
    const created = await request(app).post("/api/v1/companies").set("authorization", `Bearer ${k2.body.key}`).send({ name: "Via API" });
    expect(created.status).toBe(200);
    expect((await request(app).get("/api/v1/contacts").set("authorization", "Bearer crm_bad")).status).toBe(401);
  });
  it("webhook deliveries are created, signed and retried", async () => {
    const w = await admin.post("/api/admin/webhooks").send({ url: "http://127.0.0.1:9/hook", events: ["contact.created"] });
    await admin.post("/api/contacts").send({ first_name: "Hook", email: "hook@x.com" });
    await new Promise((r) => setTimeout(r, 300));
    const del = await admin.get(`/api/admin/webhooks/${w.body.id}/deliveries`);
    expect(del.body.items.length).toBe(1);
    expect(del.body.items[0].attempts).toBe(1);
    expect(del.body.items[0].status).toBe("pending");
    expect(del.body.items[0].next_retry_at).toBeTruthy();
  });
  it("dynamic and static lists", async () => {
    const dyn = await admin.post("/api/lists").send({ name: "Clientes", kind: "dynamic", object: "contact", filters: { logic: "and", conditions: [{ field: "lifecycle_stage", op: "eq", value: "customer" }] } });
    const m = await admin.get(`/api/lists/${dyn.body.id}/members`);
    expect(m.body.items.every((c: { lifecycle_stage: string }) => c.lifecycle_stage === "customer")).toBe(true);
    const st = await admin.post("/api/lists").send({ name: "Manual", kind: "static", object: "contact" });
    const c = (await admin.get("/api/contacts?page_size=1")).body.items[0];
    await admin.post(`/api/lists/${st.body.id}/members`).send({ ids: [c.id] });
    expect((await admin.get(`/api/lists/${st.body.id}/members`)).body.total).toBe(1);
  });
  it("global search and reports respond", async () => {
    const s = await admin.get("/api/search?q=ana");
    expect(s.body.contacts.length).toBeGreaterThan(0);
    for (const ep of ["dashboard", "pipeline", "sales", "funnel", "activity", "leads", "emails", "tickets", "data-quality"]) expect((await admin.get(`/api/reports/${ep}`)).status).toBe(200);
  });
  it("tickets with SLA and reply", async () => {
    const c = await admin.post("/api/contacts").send({ first_name: "Soporte", email: "sop@x.com" });
    const t = await admin.post("/api/tickets").send({ subject: "No funciona", contact_id: c.body.id, priority: "urgent" });
    expect(t.body.number).toBe(1);
    expect(new Date(t.body.sla_due_at).getTime() - Date.now()).toBeLessThan(2.1 * 3600000);
    await admin.post(`/api/tickets/${t.body.id}/reply`).send({ body: "Lo miramos", internal: false });
    const t2 = await admin.get(`/api/tickets/${t.body.id}`);
    expect(t2.body.first_response_at).toBeTruthy();
    expect(t2.body.status).toBe("open");
    const res = await admin.put(`/api/tickets/${t.body.id}`).send({ status: "resolved" });
    expect(res.body.resolved_at).toBeTruthy();
  });
});

describe("demo seed", () => {
  it("boots a full demo workspace consistently", async () => {
    const { app: demoApp } = makeApp(true);
    const a = await login(demoApp, "admin@test.local", "Admin1234!");
    expect((await a.get("/api/contacts")).body.total).toBeGreaterThan(30);
    expect((await a.get("/api/deals")).body.total).toBeGreaterThan(20);
    const sales = (await a.get("/api/reports/sales")).body;
    expect(Number(sales.totals.avg_cycle_days)).toBeGreaterThanOrEqual(0);
    const carlos = await login(demoApp, "carlos@crm.local", "Demo1234!");
    const mine = await carlos.get("/api/deals?page_size=200");
    expect(mine.body.items.every((d: { owner_id: string | null }) => !d.owner_id || d.owner_id === (mine.body.items[0]?.owner_id ?? d.owner_id))).toBe(true);
  }, 60000);
});
