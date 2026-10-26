import { describe, it, expect, beforeAll } from "vitest";
import { makeApp, login } from "./helpers.js";
import { relationsFor } from "../services/columns.js";
import { systemCtx } from "../services/system.js";
import type { Db } from "../db.js";

type Agent = Awaited<ReturnType<typeof login>>;
let app: ReturnType<typeof makeApp>["app"];
let db: Db;
let admin: Agent;
let companyId: string;

beforeAll(async () => {
  ({ app, db } = makeApp(false));
  admin = await login(app, "admin@test.local", "Admin1234!");
  companyId = (await admin.post("/api/companies").send({ name: "Constructora Norte" })).body.id;
});

describe("objetos personalizados: definiciones", () => {
  it("crea «Proyectos» con numeración, estados y relación con Empresas", async () => {
    const r = await admin.post("/api/objects").send({ name: "Proyecto", plural: "Proyectos", icon: "folder", color: "#7c3aed", primary_label: "Nombre del proyecto", number_prefix: "PRJ", number_pad: 3, has_owner: true,
      statuses: [{ label: "Planificado", color: "#579bfc" }, { label: "En curso", color: "#fdab3d" }, { label: "Terminado", color: "#00c875", done: true }],
      relations: [{ label: "Empresa", target: "company", many: false, inverse_label: "Proyectos" }, { label: "Contactos", target: "contact", many: true }] });
    expect(r.status).toBe(200);
    expect(r.body.key).toBe("o_proyectos");
    expect(r.body.statuses.map((s: { id: number }) => s.id)).toEqual([1, 2, 3]);
    expect(r.body.relations.map((x: { key: string }) => x.key)).toEqual(["empresa", "contactos"]);
    const list = await admin.get("/api/objects");
    expect(list.body.items.map((d: { key: string }) => d.key)).toContain("o_proyectos");
    // los roles reciben permisos para el nuevo objeto
    const roles = (await admin.get("/api/admin/roles")).body;
    expect(roles.objects).toContain("o_proyectos");
    expect(roles.items.find((x: { key: string }) => x.key === "sales").permissions.o_proyectos).toBeTruthy();
    // validaciones
    expect((await admin.post("/api/objects").send({ name: "X", plural: "Xs", relations: [{ label: "Mal", target: "nope" }] })).status).toBe(400);
    expect((await admin.post("/api/objects").send({ name: "Proyecto", plural: "Proyectos" })).status).toBe(409);
  });

  it("edita los estados y no deja quitar uno en uso", async () => {
    const rec = await admin.post("/api/records/o_proyectos").send({ name: "Temporal", status: "Planificado" });
    expect(rec.status).toBe(200);
    const def = (await admin.get("/api/objects/o_proyectos")).body;
    const renamed = await admin.put("/api/objects/o_proyectos").send({ statuses: def.statuses.map((s: { id: number; label: string }) => (s.id === 1 ? { ...s, label: "Pendiente" } : s)) });
    expect(renamed.status).toBe(200);
    expect((await admin.get(`/api/records/o_proyectos/${rec.body.id}`)).body.status_label ?? renamed.body.statuses[0].label).toBe("Pendiente");
    const removed = await admin.put("/api/objects/o_proyectos").send({ statuses: def.statuses.filter((s: { id: number }) => s.id !== 1) });
    expect(removed.status).toBe(409);
    await admin.delete(`/api/records/o_proyectos/${rec.body.id}`);
    expect((await admin.put("/api/objects/o_proyectos").send({ statuses: def.statuses })).status).toBe(200);
  });

  it("borra un objeto sólo con confirmación si tiene registros", async () => {
    const o = await admin.post("/api/objects").send({ name: "Vehículo", plural: "Vehículos", number_prefix: "VH" });
    expect(o.body.key).toBe("o_vehiculos");
    await admin.post("/api/records/o_vehiculos").send({ name: "Furgoneta 1" });
    expect((await admin.delete("/api/objects/o_vehiculos")).status).toBe(409);
    expect((await admin.delete("/api/objects/o_vehiculos?force=1")).status).toBe(200);
    expect((await admin.get("/api/records/o_vehiculos")).status).toBe(404);
    expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM custom_records WHERE object_key='o_vehiculos'")!.n).toBe(0);
  });
});

describe("objetos personalizados: registros", () => {
  let p1: string;
  it("crea registros con numeración, columnas personalizadas y fórmula", async () => {
    expect((await admin.post("/api/admin/custom-fields").send({ object: "o_proyectos", key: "presupuesto", label: "Presupuesto", type: "currency" })).status).toBe(200);
    expect((await admin.post("/api/admin/custom-fields").send({ object: "o_proyectos", key: "con_iva", label: "Con IVA", type: "formula", settings: { expression: "ROUND({Presupuesto} * 1.21, 2)", result: "number" } })).status).toBe(200);
    const r = await admin.post("/api/records/o_proyectos").send({ name: "Reforma oficinas", status: "En curso", custom: { presupuesto: 1000 }, links: { empresa: [companyId] } });
    expect(r.status).toBe(200);
    p1 = r.body.id;
    expect(r.body.number).toMatch(/^PRJ-\d{3}$/);
    expect(r.body.empresa_id).toBe(companyId);
    expect(r.body.empresa_name).toBe("Constructora Norte");
    const got = (await admin.get(`/api/records/o_proyectos/${p1}`)).body;
    expect(got.custom.presupuesto).toBe(1000);
    expect(got.custom.con_iva).toBe(1210);
    // la respuesta de una edición ya trae la fórmula recalculada
    expect((await admin.patch(`/api/records/o_proyectos/${p1}`).send({ custom: { presupuesto: 1000 } })).body.custom.con_iva).toBe(1210);
    expect(got.links.empresa[0].name).toBe("Constructora Norte");
    // estado inválido y relación hacia un elemento que no existe
    expect((await admin.post("/api/records/o_proyectos").send({ name: "Mal", status: "Nope" })).status).toBe(400);
    expect((await admin.post("/api/records/o_proyectos").send({ name: "Mal", links: { empresa: ["nope"] } })).status).toBe(400);
    // relación simple: no admite dos empresas
    const co2 = (await admin.post("/api/companies").send({ name: "Otra SA" })).body.id;
    expect((await admin.post("/api/records/o_proyectos").send({ name: "Mal", links: { empresa: [companyId, co2] } })).status).toBe(400);
  });

  it("lista con búsqueda, filtros y orden; edita por celdas y por lotes", async () => {
    await admin.post("/api/records/o_proyectos").send({ name: "Nave industrial", status: "Planificado", custom: { presupuesto: 50000 } });
    const all = await admin.get("/api/records/o_proyectos").query({ sort: "custom.presupuesto", dir: "desc" });
    expect(all.body.total).toBe(2);
    expect(all.body.items[0].name).toBe("Nave industrial");
    expect((await admin.get("/api/records/o_proyectos").query({ q: "Reforma" })).body.total).toBe(1);
    const f = JSON.stringify({ logic: "and", conditions: [{ field: "status", op: "eq", value: "2" }] });
    expect((await admin.get("/api/records/o_proyectos").query({ filters: f })).body.items.map((x: { id: string }) => x.id)).toEqual([p1]);
    // celdas: estado por etiqueta y columna personalizada
    const cells = await admin.post("/api/cells/o_proyectos/batch").send({ changes: [{ id: p1, column_id: "custom.presupuesto", value: 2000 }, { id: p1, column_id: "status", value: "Terminado" }] });
    expect(cells.status).toBe(200);
    const got = (await admin.get(`/api/records/o_proyectos/${p1}`)).body;
    expect(got.custom.con_iva).toBe(2420);
    expect(got.status).toBe("3");
    const cv = (await admin.get(`/api/cells/o_proyectos/${p1}`)).body.column_values as { id: string; text: string }[];
    expect(cv.find((c) => c.id === "custom.con_iva")?.text).toContain("2420");
    // historial
    const tl = (await admin.get(`/api/records/o_proyectos/${p1}/timeline`)).body;
    expect(tl.history.length).toBeGreaterThan(0);
  });

  it("muestra la relación en los dos sentidos", async () => {
    const rel = await admin.get(`/api/records/related/company/${companyId}`);
    expect(rel.status).toBe(200);
    const g = rel.body.groups.find((x: { object: string }) => x.object === "o_proyectos");
    expect(g.label).toBe("Proyectos");
    expect(g.items.map((x: { id: string }) => x.id)).toEqual([p1]);
    // la empresa ve la relación inversa como columna reflejable
    const ctx = systemCtx(db, db.get<{ id: string }>("SELECT id FROM workspaces")!.id);
    expect(Object.keys(relationsFor(ctx, "company"))).toContain("inv_o_proyectos_empresa");
    expect(Object.keys(relationsFor(ctx, "o_proyectos"))).toContain("empresa");
    // al archivar el registro desaparece del lado inverso
    await admin.delete(`/api/records/o_proyectos/${p1}`);
    expect((await admin.get(`/api/records/related/company/${companyId}`)).body.groups.find((x: { object: string }) => x.object === "o_proyectos")?.items.length ?? 0).toBe(0);
    expect((await admin.post(`/api/records/o_proyectos/${p1}/restore`)).status).toBe(200);
  });

  it("notas y tareas vinculadas al registro", async () => {
    expect((await admin.post(`/api/records/o_proyectos/${p1}/notes`).send({ body: "Visita a obra" })).status).toBe(200);
    expect((await admin.post(`/api/records/o_proyectos/${p1}/tasks`).send({ title: "Pedir licencia" })).status).toBe(200);
    const tl = (await admin.get(`/api/records/o_proyectos/${p1}/timeline`)).body;
    expect(tl.activities.map((a: { body: string }) => a.body)).toContain("Visita a obra");
    expect(tl.tasks.map((t: { title: string }) => t.title)).toContain("Pedir licencia");
  });

  it("exporta e importa CSV", async () => {
    const csv = await admin.get("/api/records/o_proyectos/export");
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("Reforma oficinas");
    expect(csv.text).toContain("Constructora Norte");
    const imp = await admin.post("/api/records/o_proyectos/import").send({ rows: [{ "Nombre del proyecto": "Importado 1", estado: "Planificado", Presupuesto: "1.500,50" }, { estado: "Planificado" }] });
    expect(imp.body.created).toBe(1);
    expect(imp.body.errors).toHaveLength(1);
    const it1 = (await admin.get("/api/records/o_proyectos").query({ q: "Importado 1" })).body.items[0];
    expect(it1.custom.presupuesto).toBe(1500.5);
    expect(it1.status).toBe("1");
  });
});

describe("objetos personalizados: permisos por rol", () => {
  it("un comercial sólo ve lo suyo y el rol puede quitarle el objeto", async () => {
    const roles = (await admin.get("/api/admin/roles")).body.items as { id: string; key: string; permissions: Record<string, unknown> }[];
    const sales = roles.find((r) => r.key === "sales")!;
    const u1 = (await admin.post("/api/admin/users").send({ name: "Ana Obras", email: "ana@test.local", password: "Password12345", role_id: sales.id })).body;
    await admin.post("/api/admin/users").send({ name: "Bea Obras", email: "bea@test.local", password: "Password12345", role_id: sales.id });
    const ana = await login(app, "ana@test.local", "Password12345");
    const bea = await login(app, "bea@test.local", "Password12345");
    const mine = await ana.post("/api/records/o_proyectos").send({ name: "Proyecto de Ana" });
    expect(mine.status).toBe(200);
    expect(mine.body.owner_id).toBe(u1.id);
    expect((await bea.get("/api/records/o_proyectos")).body.items.map((x: { name: string }) => x.name)).not.toContain("Proyecto de Ana");
    expect((await bea.get(`/api/records/o_proyectos/${mine.body.id}`)).status).toBe(403);
    expect((await bea.put(`/api/records/o_proyectos/${mine.body.id}`).send({ name: "Hack" })).status).toBe(403);
    // sin permiso de lectura el objeto desaparece de la lista y de la API
    const perms = { ...sales.permissions, o_proyectos: [] };
    expect((await admin.put(`/api/admin/roles/${sales.id}`).send({ permissions: perms })).status).toBe(200);
    expect((await ana.get("/api/objects")).body.items.map((d: { key: string }) => d.key)).not.toContain("o_proyectos");
    expect((await ana.get("/api/records/o_proyectos")).status).toBe(403);
    // sólo el administrador define objetos
    expect((await ana.post("/api/objects").send({ name: "Pedido", plural: "Pedidos" })).status).toBe(403);
  });
});

describe("objetos personalizados: automatizaciones e informes", () => {
  it("dispara una automatización al cambiar el estado y crea registros desde otro objeto", async () => {
    const wf = await admin.post("/api/workflows").send({ name: "Proyecto terminado", allow_reenroll: true, trigger: { type: "field_changed", object: "o_proyectos", field: "status", value: "Terminado" }, actions: [{ type: "create_task", title: "Facturar {{name}}", due_in_days: 2 }] });
    expect(wf.status).toBe(200);
    const p = (await admin.post("/api/records/o_proyectos").send({ name: "Tejado", status: "En curso", links: { empresa: [companyId] } })).body;
    await admin.put(`/api/records/o_proyectos/${p.id}`).send({ status: "Terminado" });
    const tl = (await admin.get(`/api/records/o_proyectos/${p.id}/timeline`)).body;
    expect(tl.tasks.map((t: { title: string }) => t.title)).toContain("Facturar Tejado");

    // «crear registro de Proyectos» cuando se crea un negocio: se conecta a la empresa del negocio
    const wf2 = await admin.post("/api/workflows").send({ name: "Negocio → proyecto", allow_reenroll: true, trigger: { type: "record_created", object: "deal" }, actions: [{ type: "create_record", object: "o_proyectos", values: { name: "Proyecto {{name}}", status: "Planificado" } }] });
    expect(wf2.status).toBe(200);
    expect((await admin.post("/api/deals").send({ name: "Ampliación", company_id: companyId, amount: 1000 })).status).toBe(200);
    const created = (await admin.get("/api/records/o_proyectos").query({ q: "Proyecto Ampliación" })).body.items[0];
    expect(created).toBeTruthy();
    expect(created.links.empresa[0].id).toBe(companyId);
  });

  it("los informes funcionan sobre el objeto", async () => {
    const meta = (await admin.get("/api/analytics/meta")).body;
    expect(meta.objects.o_proyectos.label).toBe("Proyectos");
    const r = await admin.post("/api/analytics/run").send({ object: "o_proyectos", config: { dims: [{ field: "status" }], metrics: [{ fn: "count" }] } });
    expect(r.status).toBe(200);
    const labels = JSON.stringify(r.body);
    expect(labels).toContain("Terminado");
    expect(labels).toContain("Planificado");
  });
});

describe("objetos personalizados: búsqueda global", () => {
  it("encuentra registros de objetos personalizados por nombre o número", async () => {
    await admin.post("/api/records/o_proyectos").send({ name: "Torre Mirador Búsqueda" });
    const r = await admin.get("/api/search?q=Mirador");
    expect(r.status).toBe(200);
    const hit = r.body.records.find((x: { name: string }) => x.name === "Torre Mirador Búsqueda");
    expect(hit).toMatchObject({ object_key: "o_proyectos", object_name: "Proyecto" });
    expect(hit.number).toMatch(/^PRJ-/);
  });
});
