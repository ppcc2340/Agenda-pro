import { describe, it, expect, beforeAll } from "vitest";
import { makeApp, login } from "./helpers.js";
import { parseNumber, parseDate, parseBool } from "../services/convert.js";

type Agent = Awaited<ReturnType<typeof login>>;
let app: ReturnType<typeof makeApp>["app"];
let admin: Agent;

beforeAll(async () => {
  ({ app } = makeApp(false));
  admin = await login(app, "admin@test.local", "Admin1234!");
});

describe("conversión de valores pegados", () => {
  it("entiende números, fechas y casillas en formato español", () => {
    expect(parseNumber("1.234,56 €")).toBe(1234.56);
    expect(parseNumber("12%")).toBe(12);
    expect(parseNumber("1,5")).toBe(1.5);
    expect(parseNumber("1,234")).toBe(1.234);
    expect(parseNumber("1,234,567")).toBe(1234567);
    expect(parseNumber("abc")).toBeNull();
    expect(parseDate("31/12/2026")).toBe("2026-12-31");
    expect(parseDate("5-1-27")).toBe("2027-01-05");
    expect(parseDate("2026-03-04T10:00")).toBe("2026-03-04");
    expect(parseBool("Sí")).toBe(true);
    expect(parseBool("x")).toBe(true);
    expect(parseBool("no")).toBe(false);
  });
});

describe("tabla tipo Excel", () => {
  let ids: string[] = [];
  it("edita en bloque varias celdas y devuelve los errores por celda", async () => {
    for (const n of ["Grid A", "Grid B", "Grid C"]) ids.push((await admin.post("/api/companies").send({ name: n })).body.id);
    const r = await admin.post("/api/cells/company/batch").send({ changes: [
      { id: ids[0], column_id: "city", value: "Madrid" }, { id: ids[1], column_id: "city", value: "Madrid" }, { id: ids[2], column_id: "city", value: "Madrid" },
      { id: ids[0], column_id: "size", value: 50 }, { id: ids[1], column_id: "size", value: "muchos" },
      { id: ids[2], column_id: "created_at", value: "2020-01-01" },
    ] });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(4);
    expect(r.body.errors.map((e: { column_id: string }) => e.column_id).sort()).toEqual(["created_at", "size"]);
    const b = await admin.get(`/api/companies/${ids[1]}`);
    expect(b.body.city).toBe("Madrid");
  });

  it("guarda subetiquetas de estados del sistema y las muestra en las celdas", async () => {
    const cfg = { labels: { type: { customer: { label: "Cliente activo", color: "#00c875" }, competitor: { hidden: true } } }, label_order: { type: ["customer", "prospect"] }, extra_labels: { type: [{ id: "x_vip", label: "Cliente VIP", color: "#ff158a", base: "customer" }] }, summary: { size: "avg" }, num_formats: { revenue: { decimals: 0, suffix: " €", thousands: true } }, cond_formats: [{ id: "r1", column: "size", op: "gt", value: 10, bg: "#ffe1e1", scope: "row" }], freeze: 1 };
    const put = await admin.put("/api/boards/company").send(cfg);
    expect(put.status).toBe(200);
    expect(put.body.config.extra_labels.type[0].base).toBe("customer");
    const got = await admin.get("/api/boards/company");
    expect(got.body.config.cond_formats[0].scope).toBe("row");
    const u = await admin.put(`/api/companies/${ids[0]}`).send({ type: "customer", custom: { _lbl_type: "x_vip" } });
    expect(u.status).toBe(200);
    let cells = (await admin.get(`/api/cells/company/${ids[0]}`)).body.column_values as { id: string; text: string; sublabel?: string }[];
    expect(cells.find((c) => c.id === "type")!.text).toBe("Cliente VIP");
    // si el estado base cambia, la subetiqueta deja de aplicarse
    await admin.put(`/api/companies/${ids[0]}`).send({ type: "partner" });
    cells = (await admin.get(`/api/cells/company/${ids[0]}`)).body.column_values;
    expect(cells.find((c) => c.id === "type")!.text).toBe("Partner");
    await admin.put(`/api/companies/${ids[0]}`).send({ type: "customer", custom: { _lbl_type: null } });
    cells = (await admin.get(`/api/cells/company/${ids[0]}`)).body.column_values;
    expect(cells.find((c) => c.id === "type")!.text).toBe("Cliente activo");
    const bad = await admin.put("/api/boards/company").send({ extra_labels: { type: [{ id: "malo", label: "x", color: "#000", base: "customer" }] } });
    expect(bad.status).toBe(400);
  });

  it("cambia el tipo de una columna convirtiendo los valores", async () => {
    const f = (await admin.post("/api/admin/custom-fields").send({ object: "company", key: "nivel", label: "Nivel", type: "text" })).body;
    await admin.post("/api/cells/company/batch").send({ changes: [{ id: ids[0], column_id: "custom.nivel", value: "Oro" }, { id: ids[1], column_id: "custom.nivel", value: "Plata" }, { id: ids[2], column_id: "custom.nivel", value: "Oro" }] });
    const prev = await admin.post("/api/columns/convert-preview").send({ object: "company", key: "nivel", type: "status" });
    expect(prev.body.filled).toBe(3);
    expect(prev.body.lost).toBe(0);
    expect(prev.body.labels.map((l: { label: string }) => l.label)).toEqual(["Oro", "Plata"]);
    const ch = await admin.put(`/api/admin/custom-fields/${f.id}`).send({ type: "status" });
    expect(ch.status).toBe(200);
    expect(ch.body.settings.labels).toHaveLength(2);
    const c = await admin.get(`/api/companies/${ids[1]}`);
    expect(c.body.custom.nivel).toBe(2);
    // y de vuelta a texto: el estado se convierte en su etiqueta
    await admin.put(`/api/admin/custom-fields/${f.id}`).send({ type: "text" });
    expect((await admin.get(`/api/companies/${ids[1]}`)).body.custom.nivel).toBe("Plata");
    // texto → número: lo que no es número se pierde (y lo avisa la vista previa)
    const n = await admin.post("/api/columns/convert-preview").send({ object: "company", key: "nivel", type: "number" });
    expect(n.body.lost).toBe(3);
  });
});
