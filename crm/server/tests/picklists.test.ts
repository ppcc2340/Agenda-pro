import { describe, it, expect, beforeAll } from "vitest";
import { makeApp, login } from "./helpers.js";
import { sentLog } from "../services/email.js";

type Agent = Awaited<ReturnType<typeof login>>;
let app: ReturnType<typeof makeApp>["app"];
let admin: Agent;
beforeAll(async () => { ({ app } = makeApp(false)); admin = await login(app, "admin@test.local", "Admin1234!"); });

type Opt = { id: string; label: string; color: string; role: string; hidden?: boolean };
const get = async (key: string) => (await admin.get(`/api/picklists/${key}`)).body as { options: Opt[]; usage: Record<string, number>; uncovered: { role: string; logic: string | null }[]; roles: { key: string }[] };

describe("listas de valores totalmente editables", () => {
  it("lista todas las listas de CRM y CLM con sus comportamientos", async () => {
    const r = await admin.get("/api/picklists");
    const keys = (r.body.items as { key: string }[]).map((x) => x.key);
    expect(keys).toEqual(expect.arrayContaining(["contact.lead_status", "ticket.status", "deal.status", "contract.status", "obligation.type", "task.type"]));
    const ls = await get("contact.lead_status");
    expect(ls.options.map((o) => o.id)).toEqual(["new", "contacted", "qualified", "unqualified", "nurturing"]);
  });

  it("permite renombrar, añadir y BORRAR etiquetas del sistema moviendo sus registros", async () => {
    const c1 = (await admin.post("/api/contacts").send({ first_name: "Uno", email: "uno@pl.es", lead_status: "nurturing" })).body;
    const c2 = (await admin.post("/api/contacts").send({ first_name: "Dos", email: "dos@pl.es", lead_status: "contacted" })).body;
    let ls = await get("contact.lead_status");
    expect(ls.usage.nurturing).toBe(1);
    // borrar «En nutrición» (en uso) sin sustituta → 409
    const without = ls.options.filter((o) => o.id !== "nurturing");
    const bad = await admin.put("/api/picklists/contact.lead_status").send({ options: without });
    expect(bad.status).toBe(409);
    // nuevo vocabulario: renombrar, añadir «Frío» (se comporta como nutrición) y mover allí los registros
    const opts = [...without.map((o) => (o.id === "new" ? { ...o, label: "Entrante" } : o)), { label: "Frío", color: "#66ccff", role: "nurturing" }];
    const ok = await admin.put("/api/picklists/contact.lead_status").send({ options: opts, reassign: { nurturing: "__frio__" } });
    expect(ok.status).toBe(409); // la sustituta debe existir en la lista nueva por id
    const saved1 = await admin.put("/api/picklists/contact.lead_status").send({ options: [...ls.options.map((o) => (o.id === "new" ? { ...o, label: "Entrante" } : o)), { label: "Frío", color: "#66ccff", role: "nurturing" }] });
    expect(saved1.status).toBe(200);
    const frio = (saved1.body.options as Opt[]).find((o) => o.label === "Frío")!;
    expect(frio.id).toMatch(/^x_/);
    const saved2 = await admin.put("/api/picklists/contact.lead_status").send({ options: (saved1.body.options as Opt[]).filter((o) => o.id !== "nurturing"), reassign: { nurturing: frio.id } });
    expect(saved2.status).toBe(200);
    expect(saved2.body.moved).toBe(1);
    const after = (await admin.get(`/api/contacts/${c1.id}`)).body;
    expect(after.lead_status).toBe("nurturing"); // la lógica sigue viendo el comportamiento
    expect(after.custom._lbl_lead_status).toBe(frio.id);
    const cells = (await admin.get(`/api/cells/contact/${c1.id}`)).body.column_values as { id: string; text: string }[];
    expect(cells.find((x) => x.id === "lead_status")!.text).toBe("Frío");
    // un contacto nuevo con el comportamiento «nurturing» se muestra con la etiqueta que queda para él
    const c3 = (await admin.post("/api/contacts").send({ first_name: "Tres", email: "tres@pl.es", lead_status: "nurturing" })).body;
    expect((await admin.get(`/api/cells/contact/${c3.id}`)).body.column_values.find((x: { id: string }) => x.id === "lead_status").text).toBe("Frío");
    void c2;
  });

  it("mover a una etiqueta de otro comportamiento aplica la lógica (ticket resuelto → encuesta)", async () => {
    const c = (await admin.post("/api/contacts").send({ first_name: "Eva", email: "eva.pl@cliente.es" })).body;
    const t = (await admin.post("/api/tickets").send({ subject: "Duda", contact_id: c.id, status: "pending" })).body;
    const st = await get("ticket.status");
    const r = await admin.put("/api/picklists/ticket.status").send({ options: st.options.filter((o) => o.id !== "pending"), reassign: { pending: "resolved" } });
    expect(r.status).toBe(200);
    const tk = (await admin.get(`/api/tickets/${t.id}`)).body;
    expect(tk.status).toBe("resolved");
    expect(tk.resolved_at).toBeTruthy();
    await new Promise((x) => setTimeout(x, 20));
    expect(sentLog.some((m) => m.to === "eva.pl@cliente.es")).toBe(true);
    // sin etiquetas para «pending» la lista avisa de qué lógica queda sin uso
    expect((await get("ticket.status")).uncovered.map((u) => u.role)).toContain("pending");
  });

  it("valida: etiquetas repetidas, comportamientos inexistentes y listas de solo renombrar", async () => {
    const st = await get("company.type");
    expect((await admin.put("/api/picklists/company.type").send({ options: [...st.options, { label: "Prospecto", color: "#000000", role: "prospect" }] })).status).toBe(400);
    expect((await admin.put("/api/picklists/company.type").send({ options: [{ label: "X", color: "#000000", role: "inventado" }] })).status).toBe(400);
    const cs = await get("contract.status");
    expect((await admin.put("/api/picklists/contract.status").send({ options: [...cs.options, { label: "Otro", color: "#000000", role: "DRAFT" }] })).status).toBe(400);
    const renamed = await admin.put("/api/picklists/contract.status").send({ options: cs.options.map((o) => (o.id === "DRAFT" ? { ...o, label: "Solicitud" } : o)) });
    expect(renamed.status).toBe(200);
  });

  it("las tareas y los tickets admiten etiquetas propias", async () => {
    const tt = await get("task.type");
    const r = await admin.put("/api/picklists/task.type").send({ options: [...tt.options, { label: "Visita comercial", color: "#a25ddc", role: "meeting" }] });
    const visit = (r.body.options as Opt[]).find((o) => o.label === "Visita comercial")!;
    const t = await admin.post("/api/tasks").send({ title: "Ver al cliente", type: "meeting", custom: { _lbl_type: visit.id } });
    expect(t.status).toBe(200);
    expect(t.body.custom._lbl_type).toBe(visit.id);
    expect((await admin.get("/api/picklists/task.type")).body.usage[visit.id]).toBe(1);
  });
});
