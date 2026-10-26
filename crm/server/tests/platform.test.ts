import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { makeApp, login } from "./helpers.js";
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

describe("API pública y plataforma", () => {
  it("publica OpenAPI con las rutas reales y esquemas de los objetos", async () => {
    const r = await request(app).get("/api/v1/openapi.json");
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe("3.1.0");
    expect(r.body.paths["/contacts"].get).toBeTruthy();
    expect(r.body.paths["/contacts/{id}"].patch.parameters.some((p: { name: string }) => p.name === "If-Match")).toBe(true);
    expect(r.body.components.schemas.Contact.properties.email).toBeTruthy();
    expect(Object.keys(r.body.paths).length).toBeGreaterThan(80);
    const d = await request(app).get("/api/docs");
    expect(d.text).toContain("docs.js");
  });

  it("añade identificador de petición y cabeceras de seguridad", async () => {
    const r = await request(app).get("/api/health");
    expect(r.headers["x-request-id"]).toMatch(/^[\w-]{6,}$/);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    const page = await request(app).get("/login");
    if (page.status === 200) expect(page.headers["content-security-policy"]).toContain("default-src 'self'");
    expect((await request(app).get("/api/health").set("x-request-id", "mi-peticion-123")).headers["x-request-id"]).toBe("mi-peticion-123");
  });

  it("evita sobrescrituras con ETag / If-Match", async () => {
    const c = (await admin.post("/api/companies").send({ name: "Concurrencia SL" })).body;
    const g = await admin.get(`/api/companies/${c.id}`);
    const etag = g.headers.etag;
    expect(etag).toBeTruthy();
    await new Promise((r) => setTimeout(r, 5));
    expect((await admin.put(`/api/companies/${c.id}`).set("If-Match", etag).send({ city: "Madrid" })).status).toBe(200);
    const stale = await admin.put(`/api/companies/${c.id}`).set("If-Match", etag).send({ city: "Bilbao" });
    expect(stale.status).toBe(412);
    expect((await admin.get(`/api/companies/${c.id}`)).body.city).toBe("Madrid");
    expect((await admin.put(`/api/companies/${c.id}`).send({ city: "Bilbao" })).status).toBe(200); // sin If-Match sigue funcionando
  });

  it("pagina por cursor y rechaza un cursor de otra consulta", async () => {
    for (let i = 0; i < 7; i++) await admin.post("/api/companies").send({ name: `Cursor ${i}` });
    const seen = new Set<string>(); let cursor: string | null = null; let pages = 0;
    do {
      const r: { body: { items: { id: string }[]; next_cursor: string | null } } = await admin.get(`/api/companies?limit=3&sort=name&dir=asc${cursor ? `&cursor=${cursor}` : ""}`);
      r.body.items.forEach((x) => seen.add(x.id)); cursor = r.body.next_cursor; pages++;
    } while (cursor && pages < 20);
    const total = (await admin.get("/api/companies?page_size=500")).body.total;
    expect(seen.size).toBe(total);
    const first = (await admin.get("/api/companies?limit=3&sort=name&dir=asc")).body.next_cursor;
    expect((await admin.get(`/api/companies?limit=3&sort=city&cursor=${first}`)).status).toBe(400);
  });

  it("encadena el registro de auditoría y lo hace inalterable", async () => {
    await admin.post("/api/companies").send({ name: "Auditada SA" });
    const v = await admin.get("/api/admin/audit/verify");
    expect(v.body.ok).toBe(true);
    expect(v.body.checked).toBeGreaterThan(1);
    expect(() => db.run("UPDATE audit_log SET action='x'")).toThrow(/solo inserción/);
    expect(() => db.run("DELETE FROM audit_log")).toThrow(/solo inserción/);
    // si alguien manipula la base saltándose los triggers, la verificación lo detecta
    db.sql.exec("DROP TRIGGER audit_log_no_update");
    db.run("UPDATE audit_log SET ip='1.2.3.4' WHERE seq=2");
    const broken = await admin.get("/api/admin/audit/verify");
    expect(broken.body.ok).toBe(false);
    expect(broken.body.broken_at).toBe(2);
  });

  it("emite cambios en vivo por SSE", async () => {
    const server = app.listen(0); const port = (server.address() as { port: number }).port;
    const cookie = (await request(app).post("/api/auth/login").send({ email: "admin@test.local", password: "Admin1234!" })).headers["set-cookie"] as unknown as string[];
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events`, { headers: { cookie: cookie.map((c) => c.split(";")[0]).join("; ") }, signal: ctrl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader(); let text = "";
    await request(app).post("/api/companies").set("cookie", cookie.map((c) => c.split(";")[0]).join("; ")).send({ name: "En vivo SL" });
    const t0 = Date.now();
    while (!text.includes("event: change") && Date.now() - t0 < 3000) { const { value } = await reader.read(); text += new TextDecoder().decode(value); }
    ctrl.abort(); server.close();
    expect(text).toContain('"object":"company"');
  });
});

describe("seguridad de cuentas", () => {
  it("exige contraseñas de 12+ caracteres, con letras y números y sin el email", async () => {
    const mk = (password: string) => admin.post("/api/admin/users").send({ name: "Pol", email: "pol.ticas@test.local", password, role_id: "x" });
    expect((await mk("Corta123")).status).toBe(400);
    expect((await mk("solamenteletras")).status).toBe(400);
    expect((await mk("pol.ticas2026xx")).status).toBe(400);
  });

  it("activa TOTP con códigos de recuperación de un solo uso", async () => {
    const roles = (await admin.get("/api/admin/roles")).body.items as { id: string; key: string }[];
    const sales = roles.find((r) => r.key === "sales") ?? roles[0]!;
    const u = await admin.post("/api/admin/users").send({ name: "Mfa User", email: "mfa@test.local", password: "Una-Clave-Larga-42", role_id: sales.id });
    expect(u.status).toBe(200);
    const ag = await login(app, "mfa@test.local", "Una-Clave-Larga-42");
    const { secret } = (await ag.post("/api/auth/2fa/setup")).body;
    const en = await ag.post("/api/auth/2fa/enable").send({ code: totpCode(secret) });
    expect(en.body.recovery_codes).toHaveLength(10);
    const code = en.body.recovery_codes[0] as string;
    const a2 = request.agent(app);
    expect((await a2.post("/api/auth/login").send({ email: "mfa@test.local", password: "Una-Clave-Larga-42" })).body.requires_2fa).toBe(true);
    const r = await a2.post("/api/auth/2fa").send({ code });
    expect(r.status).toBe(200);
    expect(r.body.warning).toContain("código de recuperación");
    const a3 = request.agent(app);
    await a3.post("/api/auth/login").send({ email: "mfa@test.local", password: "Una-Clave-Larga-42" });
    expect((await a3.post("/api/auth/2fa").send({ code })).status).toBe(401); // ya usado
  });

  it("obliga a activar 2FA a los roles marcados", async () => {
    const roles = (await admin.get("/api/admin/roles")).body.items as { id: string; key: string }[];
    const sales = roles.find((r) => r.key === "sales") ?? roles[0]!;
    await admin.post("/api/admin/users").send({ name: "Sin 2FA", email: "sin2fa@test.local", password: "Otra-Clave-Larga-77", role_id: sales.id });
    await admin.put("/api/admin/settings").send({ mfa_required_roles: [sales.key] });
    const ag = await login(app, "sin2fa@test.local", "Otra-Clave-Larga-77");
    const blocked = await ag.get("/api/contacts");
    expect(blocked.status).toBe(403);
    expect(blocked.body.details.code).toBe("mfa_setup_required");
    expect((await ag.get("/api/auth/me")).body.mfa_setup_required).toBe(true);
    const { secret } = (await ag.post("/api/auth/2fa/setup")).body;
    await ag.post("/api/auth/2fa/enable").send({ code: totpCode(secret) });
    expect((await ag.get("/api/contacts")).status).toBe(200);
    await admin.put("/api/admin/settings").send({ mfa_required_roles: [] });
  });
});
