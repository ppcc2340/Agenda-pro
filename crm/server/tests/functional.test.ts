import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { makeApp, login } from "./helpers.js";
import { nextOccurrence } from "../services/tasks.js";
import { sentLog } from "../services/email.js";

type Agent = Awaited<ReturnType<typeof login>>;
let app: ReturnType<typeof makeApp>["app"];
let admin: Agent;

beforeAll(async () => {
  ({ app } = makeApp(false));
  admin = await login(app, "admin@test.local", "Admin1234!");
});

describe("presupuesto en PDF", () => {
  it("genera un PDF válido con tildes, totales y huella, también desde el enlace público", async () => {
    const co = await admin.post("/api/companies").send({ name: "Cliente Ñandú SL" });
    const deal = await admin.post("/api/deals").send({ name: "Implantación año 1", company_id: co.body.id, amount: 1000 });
    const q = await admin.post("/api/quotes").send({ deal_id: deal.body.id, valid_days: 30, lines: [{ name: "Licencia anual con módulo de facturación electrónica y soporte prioritario incluido", description: "Usuarios ilimitados · migración", quantity: 2, unit_price: 1234.5, discount: 10, tax_rate: 21 }], discount: 0, notes: "Pago a 30 días. Precios sin IVA." });
    expect(q.status).toBe(200);
    const pdf = await admin.get(`/api/quotes/${q.body.id}/pdf`).buffer(true).parse((res, cb) => { const ch: Buffer[] = []; res.on("data", (c: Buffer) => ch.push(c)); res.on("end", () => cb(null, Buffer.concat(ch))); });
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    const body = pdf.body as Buffer;
    expect(body.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    expect(body.toString("latin1")).toContain("%%EOF");
    expect(body.toString("latin1")).toContain("Licencia anual"); // texto en el contenido (sin compresión)
    expect(pdf.headers["x-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    // la huella no cambia entre descargas del mismo contenido
    const again = await admin.get(`/api/quotes/${q.body.id}/pdf`);
    expect(again.headers["x-content-sha256"]).toBe(pdf.headers["x-content-sha256"]);
    const pub = await request(app).get(`/q/${q.body.token}.pdf`);
    expect(pub.status).toBe(200);
    expect(pub.headers["x-content-sha256"]).toBe(pdf.headers["x-content-sha256"]);
    // la aceptación queda auditada con la huella del documento visto
    await request(app).post(`/q/${q.body.token}/decision`).send({ decision: "accepted", name: "Ana Cliente" });
    const audit = (await admin.get(`/api/admin/audit?object=quote`)).body.items as { changes: Record<string, unknown> }[];
    expect(audit.some((a) => a.changes?.content_sha256 === pdf.headers["x-content-sha256"])).toBe(true);
  });

  it("la página pública del presupuesto escapa el contenido", async () => {
    const deal = await admin.post("/api/deals").send({ name: "XSS", amount: 1 });
    const q = await admin.post("/api/quotes").send({ deal_id: deal.body.id, valid_days: 30, lines: [{ name: "<img src=x onerror=alert(1)>", quantity: 1, unit_price: 1, discount: 0, tax_rate: 0 }], discount: 0 });
    const page = await request(app).get(`/q/${q.body.token}`);
    expect(page.text).toContain("var e=function(t)");
    expect(page.text).toContain("e(l.name)");
  });
});

describe("varios emails y teléfonos", () => {
  it("guarda la lista, refleja el principal y detecta duplicados por cualquiera de ellos", async () => {
    const c = await admin.post("/api/contacts").send({ first_name: "Marta", last_name: "Ruiz", emails: [{ value: "marta@empresa.es", label: "Trabajo" }, { value: "Marta.Personal@Gmail.com", label: "Personal", primary: true }], phones: [{ value: "600 111 222", label: "Móvil" }] });
    expect(c.status).toBe(200);
    expect(c.body.email).toBe("marta.personal@gmail.com");
    expect(c.body.emails).toHaveLength(2);
    expect(c.body.phones[0].value).toMatch(/^\+34600111222$/);
    const dup = await admin.post("/api/contacts").send({ first_name: "Otra", email: "marta@empresa.es" });
    expect(dup.status).toBe(409);
    const found = await admin.get("/api/contacts?q=marta@empresa.es");
    expect(found.body.items.some((x: { id: string }) => x.id === c.body.id)).toBe(true);
    // cambiar solo el email principal lo coloca primero sin perder los demás
    const u = await admin.patch(`/api/contacts/${c.body.id}`).send({ email: "marta@empresa.es" });
    expect(u.body.email).toBe("marta@empresa.es");
    expect(u.body.emails.find((e: { primary: boolean }) => e.primary).value).toBe("marta@empresa.es");
    expect(u.body.emails).toHaveLength(2);
    const other = await admin.post("/api/contacts").send({ first_name: "Luis", email: "luis@empresa.es" });
    const clash = await admin.patch(`/api/contacts/${other.body.id}`).send({ emails: [{ value: "luis@empresa.es" }, { value: "marta.personal@gmail.com" }] });
    expect(clash.status).toBe(409);
  });
});

describe("tareas recurrentes", () => {
  it("calcula el siguiente vencimiento conservando la hora", () => {
    expect(nextOccurrence("2026-10-30T09:30:00.000Z", "weekdays")).toBe("2026-11-02T09:30:00.000Z"); // viernes → lunes
    expect(nextOccurrence("2026-01-31T08:00:00.000Z", "monthly")).toBe("2026-02-28T08:00:00.000Z"); // fin de mes
    expect(nextOccurrence("2026-10-26T10:00:00.000Z", "weekly", 2)).toBe("2026-11-09T10:00:00.000Z");
    expect(nextOccurrence("2026-10-26T10:00:00.000Z", "weekly", 1, [1, 3])).toBe("2026-10-28T10:00:00.000Z"); // lunes → miércoles
    expect(nextOccurrence("2026-10-28T10:00:00.000Z", "weekly", 1, [1, 3])).toBe("2026-11-02T10:00:00.000Z"); // miércoles → lunes
    expect(nextOccurrence("2024-02-29", "yearly")).toBe("2025-02-28");
    expect(nextOccurrence("2026-10-26T10:00:00.000Z", "daily", 3)).toBe("2026-10-29T10:00:00.000Z");
  });
  it("al completar crea la siguiente con la misma regla", async () => {
    const t = await admin.post("/api/tasks").send({ title: "Informe semanal", due_at: "2026-10-30T09:00:00.000Z", recurrence: "weekdays", recurrence_interval: 1, duration_min: 30 });
    expect(t.status).toBe(200);
    await admin.post(`/api/tasks/${t.body.id}/complete`).send({});
    const list = (await admin.get("/api/tasks?page_size=200")).body.items as { title: string; due_at: string; completed_at: string | null; duration_min: number }[];
    const next = list.find((x) => x.title === "Informe semanal" && !x.completed_at);
    expect(next?.due_at).toBe("2026-11-02T09:00:00.000Z");
    expect(next?.duration_min).toBe(30);
  });
});

describe("encuesta de satisfacción", () => {
  it("se envía al resolver y registra la valoración desde la página pública", async () => {
    const c = await admin.post("/api/contacts").send({ first_name: "Pedro", email: "pedro.csat@cliente.es" });
    const t = await admin.post("/api/tickets").send({ subject: "No me llega la factura", contact_id: c.body.id });
    await admin.put(`/api/tickets/${t.body.id}`).send({ status: "resolved" });
    await new Promise((r) => setTimeout(r, 30));
    const mail = sentLog.find((m) => m.to === "pedro.csat@cliente.es" && m.subject.includes("¿Cómo lo hemos hecho?"));
    expect(mail).toBeTruthy();
    const tok = /\/csat\/([\w-]+)\?s=5/.exec(mail!.html)![1]!;
    const page = await request(app).get(`/csat/${tok}?s=5`);
    expect(page.status).toBe(200);
    expect((await admin.get(`/api/tickets/${t.body.id}`)).body.csat ?? null).toBeNull(); // abrir el enlace no vota
    const post = await request(app).post(`/csat/${tok}`).type("form").send({ score: "2", comment: "Tardasteis mucho" });
    expect(post.status).toBe(200);
    const after = (await admin.get(`/api/tickets/${t.body.id}`)).body;
    expect(after.csat).toBe(2);
    expect(after.csat_comment).toBe("Tardasteis mucho");
    expect((await request(app).post(`/csat/${tok}`).type("form").send({ score: "9" })).status).toBe(400);
  });
});
