import { describe, it, expect, beforeAll } from "vitest";
import { makeApp, login } from "./helpers.js";

type Agent = Awaited<ReturnType<typeof login>>;
let app: ReturnType<typeof makeApp>["app"];
let admin: Agent;
let sales: Agent;
let sales2: Agent;
let roles: { id: string; key: string }[];
let salesUser: { id: string };
let sales2User: { id: string; team_id?: string | null };

beforeAll(async () => {
  ({ app } = makeApp(false));
  admin = await login(app, "admin@test.local", "Admin1234!");
  roles = (await admin.get("/api/admin/roles")).body.items;
  const rid = (k: string) => roles.find((r) => r.key === k)!.id;
  salesUser = (await admin.post("/api/admin/users").send({ name: "Vera Ventas", email: "vera@test.local", password: "Clave-Ventas-2026", role_id: rid("sales") })).body;
  sales2User = (await admin.post("/api/admin/users").send({ name: "Saúl Ventas", email: "saul@test.local", password: "Clave-Ventas-2027", role_id: rid("sales") })).body;
  sales = await login(app, "vera@test.local", "Clave-Ventas-2026");
  sales2 = await login(app, "saul@test.local", "Clave-Ventas-2027");
});

describe("diseño de fichas", () => {
  it("genera un diseño por defecto, guarda uno general y uno por rol con caída al general", async () => {
    const gen = await sales.get("/api/layouts/contact");
    expect(gen.status).toBe(200);
    expect(gen.body.source).toBe("generated");
    expect(gen.body.layout.sections[0].fields.some((f: { key: string }) => f.key === "email")).toBe(true);
    const cfg = { sections: [{ id: "a", title: "Básico", fields: [{ key: "email", required: true, help: "Email de trabajo" }, { key: "phone" }] }, { id: "b", title: "Comercial", collapsed: true, fields: [{ key: "lifecycle_stage" }, { key: "owner_id" }] }], create: ["first_name", "email", "phone"], quick: ["email"] };
    expect((await admin.put("/api/layouts/contact").send({ config: cfg })).status).toBe(200);
    const eff = (await sales.get("/api/layouts/contact")).body;
    expect(eff.source).toBe("default");
    expect(eff.layout.sections.map((s: { title: string }) => s.title)).toEqual(["Básico", "Comercial"]);
    // diseño propio del rol comercial
    const salesRole = roles.find((r) => r.key === "sales")!.id;
    await admin.put("/api/layouts/contact").send({ role_id: salesRole, config: { sections: [{ id: "x", title: "Solo comercial", fields: [{ key: "phone" }] }], create: ["first_name"], quick: [] } });
    expect((await sales.get("/api/layouts/contact")).body.layout.sections[0].title).toBe("Solo comercial");
    expect((await admin.get("/api/layouts/contact")).body.layout.sections[0].title).toBe("Básico");
    // borrar el del rol devuelve al general
    await admin.delete(`/api/layouts/contact?role_id=${salesRole}`);
    expect((await sales.get("/api/layouts/contact")).body.source).toBe("default");
    // validación de campos desconocidos y permisos
    expect((await admin.put("/api/layouts/contact").send({ config: { sections: [{ id: "a", title: "X", fields: [{ key: "no_existe" }] }] } })).status).toBe(400);
    expect((await sales.put("/api/layouts/contact").send({ config: cfg })).status).toBe(403);
  });

  it("exige en el servidor los obligatorios del formulario de alta", async () => {
    const bad = await sales.post("/api/contacts").send({ first_name: "Sin Email" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("Email");
    const ok = await sales.post("/api/contacts").send({ first_name: "Con Email", email: "con.email@cliente.es" });
    expect(ok.status).toBe(200);
    await admin.delete("/api/layouts/contact");
  });
});

describe("seguridad por campo", () => {
  let dealId = "";
  it("oculta campos en listados, fichas, exportaciones, celdas, búsqueda e informes", async () => {
    const d = await sales.post("/api/deals").send({ name: "Operación confidencial", amount: 99000 });
    dealId = d.body.id;
    const salesRole = roles.find((r) => r.key === "sales")!.id;
    expect((await admin.put("/api/field-permissions").send({ role_id: salesRole, object: "deal", fields: { amount: "hidden", expected_close_date: "read" } })).status).toBe(200);
    const list = await sales.get("/api/deals?page_size=50");
    const row = list.body.items.find((x: { id: string }) => x.id === dealId);
    expect(row).toBeTruthy();
    expect("amount" in row).toBe(false);
    expect("weighted_amount" in row).toBe(false);
    const det = await sales.get(`/api/deals/${dealId}`);
    expect(det.body.amount).toBeUndefined();
    expect(det.body.name).toBe("Operación confidencial");
    const csv = await sales.get("/api/deals/export");
    expect(csv.text.split("\n")[0]).not.toContain("amount");
    const cells = await sales.get(`/api/cells/deal/${dealId}`);
    expect(cells.body.column_values.some((c: { id: string }) => c.id === "amount")).toBe(false);
    const rep = await sales.post("/api/analytics/run").send({ object: "deal", config: { dims: [], metrics: [{ fn: "sum", field: "amount" }] } });
    expect(rep.status).toBe(403);
    const meta = await sales.get("/api/filter-meta");
    expect(meta.body.fields.deal.amount).toBeUndefined();
    // el administrador sigue viéndolo todo
    expect((await admin.get(`/api/deals/${dealId}`)).body.amount).toBe(99000);
    expect((await sales.get("/api/field-permissions/me")).body.deal.amount).toBe("hidden");
  });

  it("impide escribir en campos de solo lectura u ocultos, también en bloque, celdas e importaciones", async () => {
    expect((await sales.put(`/api/deals/${dealId}`).send({ amount: 1 })).status).toBe(403);
    const ro = await sales.put(`/api/deals/${dealId}`).send({ expected_close_date: "2027-01-01" });
    expect(ro.status).toBe(403);
    expect(ro.body.error).toContain("Cierre previsto");
    expect((await sales.put(`/api/deals/${dealId}`).send({ name: "Operación renombrada" })).status).toBe(200);
    expect((await sales.post("/api/deals/bulk").send({ ids: [dealId], action: "update", patch: { amount: 5 } })).status).toBe(403);
    expect((await sales.put(`/api/cells/deal/${dealId}`).send({ column_id: "amount", value: 5 })).status).toBe(403);
    const batch = await sales.post("/api/cells/deal/batch").send({ changes: [{ id: dealId, column_id: "amount", value: 7 }, { id: dealId, column_id: "name", value: "Op. lote" }] });
    expect(batch.body.ok).toBe(1);
    expect(batch.body.errors[0].column_id).toBe("amount");
    const imp = await sales.post("/api/imports").send({ object: "deal", mapping: { Nombre: "name", Importe: "amount" }, rows: [{ Nombre: "Importada", Importe: "10" }] });
    expect(imp.status).toBe(403);
    expect((await sales.post("/api/deals").send({ name: "Con importe", amount: 500 })).status).toBe(403);
    expect((await admin.get(`/api/deals/${dealId}`)).body.amount).toBe(99000);
    const salesRole = roles.find((r) => r.key === "sales")!.id;
    await admin.put("/api/field-permissions").send({ role_id: salesRole, object: "deal", fields: { amount: "edit", expected_close_date: "edit" } });
    expect((await sales.put(`/api/deals/${dealId}`).send({ amount: 100 })).status).toBe(200);
  });
});

describe("compartir registros", () => {
  it("da acceso a un comercial que no lo vería y se retira al dejar de compartir", async () => {
    const d = await sales.post("/api/deals").send({ name: "Negocio de Vera", amount: 10 });
    expect((await sales2.get(`/api/deals/${d.body.id}`)).status).toBe(403);
    expect((await sales2.get("/api/deals?page_size=200")).body.items.some((x: { id: string }) => x.id === d.body.id)).toBe(false);
    const sh = await sales.post(`/api/shares/deal/${d.body.id}`).send({ user_id: sales2User.id, access: "read" });
    expect(sh.status).toBe(200);
    expect((await sales2.get(`/api/deals/${d.body.id}`)).status).toBe(200);
    expect((await sales2.get("/api/deals?page_size=200")).body.items.some((x: { id: string }) => x.id === d.body.id)).toBe(true);
    // solo consulta: no puede editar
    expect((await sales2.put(`/api/deals/${d.body.id}`).send({ name: "Cambio" })).status).toBe(403);
    await sales.post(`/api/shares/deal/${d.body.id}`).send({ user_id: sales2User.id, access: "edit" });
    expect((await sales2.put(`/api/deals/${d.body.id}`).send({ name: "Cambio" })).status).toBe(200);
    const list = (await sales.get(`/api/shares/deal/${d.body.id}`)).body.items;
    expect(list).toHaveLength(1);
    expect(list[0].user_name).toBe("Saúl Ventas");
    expect((await sales.delete(`/api/shares/${list[0].id}`)).status).toBe(200);
    expect((await sales2.get(`/api/deals/${d.body.id}`)).status).toBe(403);
    // quien no puede editar el registro no puede compartirlo
    expect((await sales2.post(`/api/shares/deal/${d.body.id}`).send({ user_id: sales2User.id })).status).toBe(403);
    void salesUser;
  });
});
