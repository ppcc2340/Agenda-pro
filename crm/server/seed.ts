import { randomBytes } from "node:crypto";
/** Bootstrap (first run) + optional demo data. Idempotent: only runs on an empty database. */
import { ensureServiceUser } from "./services/workflows.js";
import { Db, type Row } from "./db.js";
import { id, now, hashPassword, addDays } from "./lib/util.js";
import { PRESET_ROLES } from "./lib/permissions.js";
import { DEFAULT_SETTINGS } from "./context.js";
import { buildCtx } from "./services/system.js";
import { createCompany } from "./services/companies.js";
import { createContact } from "./services/contacts.js";
import { createDeal, moveStage, closeDeal, setDealProducts } from "./services/deals.js";
import { createTask, completeTask } from "./services/tasks.js";
import { logActivity } from "./services/activities.js";
import { createTicket } from "./services/tickets.js";
import { createQuote } from "./services/quotes.js";
import type { Ctx } from "./context.js";
import { seedClmCatalog, seedClmDemo } from "./clm_seed.js";

export interface BootstrapInfo { createdAdmin: boolean; seededDemo: boolean; adminEmail: string; adminPassword: string; workspaceId: string }

export function bootstrap(db: Db, opts: { demo?: boolean; adminEmail?: string; adminPassword?: string } = {}): BootstrapInfo {
  const adminEmail = (opts.adminEmail ?? process.env.ADMIN_EMAIL ?? "admin@crm.local").toLowerCase();
  // en producción nunca hay contraseña por defecto: o se pasa ADMIN_PASSWORD o se genera una aleatoria (se muestra una vez)
  const adminPassword = opts.adminPassword ?? process.env.ADMIN_PASSWORD ?? (process.env.NODE_ENV === "production" ? `Crm-${randomBytes(9).toString("base64url")}` : "Admin1234!");
  const existing = db.get<{ id: string }>("SELECT id FROM workspaces LIMIT 1");
  if (existing) return { createdAdmin: false, seededDemo: false, adminEmail, adminPassword, workspaceId: existing.id };

  const ws = id();
  db.transaction(() => {
    db.insert("workspaces", { id: ws, name: "Mi empresa", settings: { ...DEFAULT_SETTINGS, company_name: "Mi empresa" }, created_at: now() });
    for (const r of PRESET_ROLES) db.insert("roles", { id: id(), workspace_id: ws, name: r.name, key: r.key, permissions: r.permissions, visibility: r.visibility, is_system: 1 });
    const adminRole = db.get<{ id: string }>("SELECT id FROM roles WHERE workspace_id=? AND key='admin'", ws)!;
    db.insert("users", { id: id(), workspace_id: ws, name: "Administrador", email: adminEmail, password_hash: hashPassword(adminPassword), role_id: adminRole.id, created_at: now() });
    const pid = id();
    db.insert("pipelines", { id: pid, workspace_id: ws, name: "Ventas", position: 0, is_default: 1, created_at: now() });
    const stages = [
      ["Cualificación", 10, "#74869A", 7, []], ["Contacto", 25, "#3A6EDB", 10, []], ["Propuesta", 50, "#B07414", 14, ["amount", "contacts"]], ["Negociación", 75, "#B0407E", 10, ["amount", "expected_close_date"]],
    ] as const;
    stages.forEach((s, i) => db.insert("stages", { id: id(), workspace_id: ws, pipeline_id: pid, name: s[0], position: i, probability: s[1], color: s[2], expected_days: s[3], required_fields: [...s[4]], kind: "open" }));
    db.insert("stages", { id: id(), workspace_id: ws, pipeline_id: pid, name: "Ganado", position: 98, probability: 100, color: "#2A7B58", expected_days: 365, required_fields: [], kind: "won" });
    db.insert("stages", { id: id(), workspace_id: ws, pipeline_id: pid, name: "Perdido", position: 99, probability: 0, color: "#BF3A4A", expected_days: 365, required_fields: [], kind: "lost" });
    // predefined automations (8.4)
    const wf = (name: string, description: string, trigger: unknown, conditions: unknown, actions: unknown[], active = 1) => db.insert("workflows", { id: id(), workspace_id: ws, name, description, trigger, conditions, actions, active, allow_reenroll: 0, created_by: null, created_at: now(), updated_at: now() });
    wf("Negocio sin actividad 7 días → tarea + aviso al manager", "Crea una tarea de seguimiento al propietario y avisa al manager cuando un negocio abierto lleva 7 días sin actividad.", { type: "deal_inactive", days: 7 }, { logic: "and", conditions: [{ field: "status", op: "eq", value: "open" }] }, [{ type: "create_task", title: "Retomar {{name}} (sin actividad 7 días)", task_type: "followup", due_in_days: 1, priority: "high", assignee: "owner" }, { type: "notify", to: "manager", title: "Negocio parado: {{name}}", body: "Lleva 7 días sin actividad. Importe {{importe}}." }]);
    wf("Negocio ganado → onboarding", "Al ganar: tarea de onboarding al propietario y aviso a administración.", { type: "deal_won" }, { logic: "and", conditions: [] }, [{ type: "create_task", title: "Onboarding de {{empresa}}: kickoff y alta en facturación", task_type: "todo", due_in_days: 2, priority: "high", assignee: "owner" }, { type: "notify", to: "manager", title: "¡Negocio ganado! {{name}}", body: "Importe {{importe}}. Avisa a finanzas." }]);
    wf("Lead nuevo por formulario → email de bienvenida", "Envía un email de bienvenida al contacto que llega por formulario web (si tiene email).", { type: "form_submitted" }, { logic: "and", conditions: [{ field: "email", op: "not_empty" }] }, [{ type: "send_email", to: "contact", title: "Gracias por tu interés, {{nombre}}", body: "Hola {{nombre}},\n\nGracias por contactar con nosotros. En breve {{propietario.nombre}} se pondrá en contacto contigo.\n\nUn saludo." }]);
    wf("Negocio estancado en etapa → aviso", "Cuando un negocio supera los días esperados en su etapa, avisa al propietario.", { type: "deal_stale" }, { logic: "and", conditions: [] }, [{ type: "notify", to: "owner", title: "{{name}} lleva demasiado tiempo en su etapa", body: "Revisa el siguiente paso o actualiza la fecha de cierre." }]);
    wf("Presupuesto visto → tarea de llamada", "Cuando el cliente abre el presupuesto, crea una tarea para llamarle al día siguiente.", { type: "quote_viewed" }, { logic: "and", conditions: [] }, [{ type: "create_task", title: "Llamar: ha visto el presupuesto {{number}}", task_type: "call", due_in_days: 1, priority: "high", assignee: "owner" }], 1);
    wf("Ticket urgente → avisar al manager", "Los tickets con prioridad urgente avisan al manager del asignado.", { type: "ticket_created" }, { logic: "and", conditions: [{ field: "priority", op: "eq", value: "urgent" }] }, [{ type: "notify", to: "manager", title: "Ticket urgente: {{subject}}" }]);
    // email templates
    const tpl = (name: string, folder: string, subject: string, body: string) => db.insert("email_templates", { id: id(), workspace_id: ws, name, folder, subject, body, created_by: null, created_at: now(), updated_at: now() });
    tpl("Primer contacto", "Prospección", "{{nombre}}, ¿hablamos esta semana?", "Hola {{nombre}},\n\nSoy {{propietario.nombre}} de {{empresa_propia}}. He visto que en {{empresa}} podríais estar interesados en mejorar vuestro proceso comercial.\n\n¿Tienes 15 minutos esta semana para una llamada?\n\nUn saludo,\n{{propietario.nombre}}\n{{propietario.firma}}");
    tpl("Seguimiento de propuesta", "Ventas", "Propuesta para {{empresa}}", "Hola {{nombre}},\n\nTe escribo para saber si has podido revisar la propuesta que te enviamos. Quedo a tu disposición para resolver cualquier duda.\n\nUn saludo,\n{{propietario.nombre}}");
    tpl("Bienvenida cliente", "Clientes", "¡Bienvenido a bordo, {{nombre}}!", "Hola {{nombre}},\n\nGracias por confiar en nosotros. En los próximos días te contactaremos para planificar el arranque.\n\nUn saludo,\n{{propietario.nombre}}");
    // scoring rules
    const rule = (label: string, field: string, op: string, value: string | null, points: number) => db.insert("scoring_rules", { id: id(), workspace_id: ws, label, field, op, value, points, active: 1 });
    rule("Cargo directivo", "job_title", "contains", "director", 15);
    rule("Cargo CEO/gerente", "job_title", "contains", "ceo", 15);
    rule("Empresa mediana o grande (>50 empleados)", "company.size", "gt", "50", 10);
    rule("Origen referido", "source", "eq", "referral", 10);
    rule("Origen web", "source", "eq", "web", 5);
    rule("Consentimiento de marketing", "consent_marketing", "is_true", null, 5);
    // custom fields
    db.insert("custom_fields", { id: id(), workspace_id: ws, object: "contact", key: "interes", label: "Producto de interés", type: "select", options: ["CRM", "Consultoría", "Formación", "Soporte"], required: 0, position: 0, section: "Comercial" });
    db.insert("custom_fields", { id: id(), workspace_id: ws, object: "deal", key: "tipo_contrato", label: "Tipo de contrato", type: "select", options: ["Nuevo", "Renovación", "Ampliación"], required: 0, position: 0, section: "Comercial" });
    db.insert("custom_fields", { id: id(), workspace_id: ws, object: "company", key: "numero_sedes", label: "Número de sedes", type: "number", options: [], required: 0, position: 0, section: "Datos" });
    // lead form
    db.insert("forms", { id: id(), workspace_id: ws, name: "Solicitud de información", slug: "contacto", fields: [{ key: "name", label: "Nombre y apellidos", type: "text", required: true }, { key: "email", label: "Email de trabajo", type: "email", required: true }, { key: "phone", label: "Teléfono", type: "phone", required: false }, { key: "company", label: "Empresa", type: "text", required: false }, { key: "custom.interes", label: "¿Qué te interesa?", type: "select", required: false, options: ["CRM", "Consultoría", "Formación", "Soporte"] }, { key: "message", label: "Cuéntanos qué necesitas", type: "textarea", required: false }], settings: { assignment: { mode: "round_robin", team_id: null }, create_deal: false, create_task: true, task_title: "Llamar al nuevo lead en 1 h", thank_you: "¡Gracias! Te contactaremos en menos de 24 horas.", consent_text: "Acepto recibir comunicaciones comerciales.", require_consent: false, tags: ["web"], source: "web", lifecycle_stage: "lead", notify_assignee: true, button_text: "Enviar solicitud", title: "¿Hablamos?", description: "Déjanos tus datos y te llamamos." }, active: 1, submissions: 0, created_at: now() });
  });
  let seededDemo = false;
  ensureServiceUser(db, ws);
  seedClmCatalog(db, ws);
  if (opts.demo) { seedDemo(db, ws); seededDemo = true; }
  return { createdAdmin: true, seededDemo, adminEmail, adminPassword, workspaceId: ws };
}

const rnd = (n: number) => Math.floor(Math.random() * n);
const pick = <T,>(a: readonly T[]): T => a[rnd(a.length)]!;

export function seedDemo(db: Db, ws: string) {
  const roles = Object.fromEntries(db.all<{ key: string; id: string }>("SELECT key, id FROM roles WHERE workspace_id=?", ws).map((r) => [r.key, r.id]));
  const pw = hashPassword("Demo1234!");
  const teamId = id(), team2 = id();
  const mk = (name: string, email: string, role: string, team: string | null, quota: number | null) => { const uid = id(); db.insert("users", { id: uid, workspace_id: ws, name, email, password_hash: pw, role_id: roles[role], team_id: team, quota, email_signature: `${name}\n${email}`, created_at: now() }); return uid; };
  const manager = mk("Lucía Fernández", "lucia@crm.local", "manager", teamId, 120000);
  const sales1 = mk("Carlos Ruiz", "carlos@crm.local", "sales", teamId, 60000);
  const sales2 = mk("Marta López", "marta@crm.local", "sales", teamId, 60000);
  const sales3 = mk("Javier Ortega", "javier@crm.local", "sales", team2, 50000);
  const support = mk("Ana Soler", "ana@crm.local", "support", null, null);
  mk("Marketing", "marketing@crm.local", "marketing", null, null);
  db.insert("teams", { id: teamId, workspace_id: ws, name: "Ventas Centro", manager_id: manager, created_at: now() });
  db.insert("teams", { id: team2, workspace_id: ws, name: "Ventas Norte", manager_id: null, created_at: now() });
  db.run("UPDATE forms SET settings=json_set(settings,'$.assignment.team_id',?) WHERE workspace_id=?", teamId, ws);
  const admin = db.get<Row>("SELECT u.* FROM users u JOIN roles r ON r.id=u.role_id WHERE u.workspace_id=? AND r.key='admin'", ws)!;
  const adminRow = db.get<Row>("SELECT * FROM users WHERE id=?", admin.id)!;
  const ctx = buildCtx(db, adminRow, "session", "seed");
  const as = (uid: string): Ctx => buildCtx(db, db.get<Row>("SELECT * FROM users WHERE id=?", uid)!, "session", "seed");
  const owners = [sales1, sales2, sales3, manager];

  // products
  const products = [["CRM-PRO", "Licencia CRM Pro (usuario/mes)", 29, "monthly"], ["CRM-ENT", "Licencia CRM Enterprise (usuario/mes)", 59, "monthly"], ["CONS-DIA", "Consultoría (jornada)", 850, "one_time"], ["FORM-EQ", "Formación de equipo (sesión)", 600, "one_time"], ["SOP-PREM", "Soporte premium anual", 2400, "yearly"]] as const;
  const productIds: string[] = [];
  for (const p of products) { const pid = id(); productIds.push(pid); db.insert("products", { id: pid, workspace_id: ws, sku: p[0], name: p[1], unit_price: p[2], currency: "EUR", tax_rate: 21, category: p[0].startsWith("CRM") ? "Software" : "Servicios", unit: "ud", billing_period: p[3], active: 1, created_at: now() }); }

  // companies
  const sectors = ["Tecnología", "Industria", "Retail", "Servicios", "Salud", "Educación", "Construcción", "Logística"];
  const cities = ["Madrid", "Barcelona", "Valencia", "Sevilla", "Bilbao", "Zaragoza", "Málaga", "Murcia"];
  const compNames = ["Altaria Soluciones", "Grupo Mendívil", "Nortec Industrial", "Bioluz Salud", "Logística Peninsular", "Edutec Formación", "Construcciones Vega", "Retail Ibérica", "Finanzas Delta", "Hotelera Sur", "Agroalimentaria Campos", "Nexo Consulting", "Vidrios Castilla", "Clínicas Aurora", "TransRápido", "Dental Prime"];
  const companies: Row[] = compNames.map((name, i) => {
    const domain = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "") + ".es";
    const c = createCompany(as(owners[i % owners.length]!), { name, domain, sector: sectors[i % sectors.length], size: [12, 45, 120, 300, 800, 25, 60, 150][i % 8], city: cities[i % cities.length], country: "España", phone: `+34 9${rnd(90) + 10} ${rnd(900) + 100} ${rnd(900) + 100}`, type: i < 4 ? "customer" : "prospect", custom: { numero_sedes: 1 + rnd(6) }, tags: i % 3 === 0 ? ["clave"] : [] }, { force: true, skipEvents: true });
    return c;
  });
  db.run("UPDATE companies SET parent_id=? WHERE id=?", companies[1]!.id, companies[12]!.id);

  // contacts
  const first = ["Pablo", "María", "Jorge", "Elena", "Raúl", "Sara", "Diego", "Laura", "Andrés", "Cristina", "Miguel", "Patricia", "Sergio", "Nuria", "Alberto", "Beatriz", "Víctor", "Irene", "Hugo", "Clara", "Óscar", "Rocío", "Iván", "Teresa", "Rubén", "Silvia", "Marcos", "Lorena", "Adrián", "Eva"];
  const last = ["García", "Martínez", "Rodríguez", "López", "Sánchez", "Pérez", "Gómez", "Díaz", "Moreno", "Jiménez", "Romero", "Navarro", "Torres", "Ramírez", "Gil"];
  const titles = ["Director general", "Directora de operaciones", "Responsable de compras", "CEO", "Jefe de ventas", "Responsable de IT", "Gerente", "Directora financiera", "Técnico de compras", "Office manager"];
  const sources = ["web", "referral", "event", "outbound", "ads", "web", "web"] as const;
  const contacts: Row[] = [];
  for (let i = 0; i < 42; i++) {
    const company = companies[i % companies.length]!;
    const fn = first[i % first.length]!, ln = last[(i * 7) % last.length]!, ln2 = last[(i * 3 + 1) % last.length]!;
    const ownerId = (company.owner_id as string) ?? sales1;
    const stage = i < 8 ? "customer" : i < 14 ? "opportunity" : i < 20 ? "sql" : i < 28 ? "mql" : i < 38 ? "lead" : "subscriber";
    const createdAt = addDays(now(), -rnd(180));
    const c = createContact(as(ownerId), { first_name: fn, last_name: `${ln} ${ln2}`, email: `${fn}.${ln}@${company.domain}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""), phone: `+34 6${rnd(90) + 10} ${rnd(900) + 100} ${rnd(900) + 100}`, job_title: titles[i % titles.length], company_id: company.id as string, lifecycle_stage: stage as "lead", lead_status: stage === "lead" || stage === "subscriber" ? (i % 2 ? "new" : "contacted") : "qualified", source: sources[i % sources.length], consent_marketing: i % 3 !== 0, consent_source: "import", custom: { interes: pick(["CRM", "Consultoría", "Formación", "Soporte"]) }, tags: i % 5 === 0 ? ["decisor"] : [], birthday: `198${rnd(10)}-${String(1 + rnd(12)).padStart(2, "0")}-${String(1 + rnd(28)).padStart(2, "0")}` }, { force: true });
    db.run("UPDATE contacts SET created_at=?, updated_at=? WHERE id=?", createdAt, createdAt, c.id);
    if (stage !== "lead" && stage !== "subscriber") db.run("UPDATE contacts SET first_response_at=? WHERE id=?", addDays(createdAt, 1), c.id);
    contacts.push(c);
  }
  // a probable duplicate for the dedupe screen
  const dup = contacts[5]!;
  const d2 = createContact(ctx, { first_name: dup.first_name as string, last_name: dup.last_name as string, phone: dup.phone as string, company_id: dup.company_id as string, email: null, source: "event", lifecycle_stage: "lead" }, { force: true });
  db.run("UPDATE contacts SET email=NULL WHERE id=?", d2.id);

  // deals
  const stages = db.all<Row>("SELECT * FROM stages WHERE workspace_id=? AND kind='open' ORDER BY position", ws);
  const dealNames = ["Implantación CRM", "Renovación licencias", "Consultoría de procesos", "Formación equipo comercial", "Ampliación usuarios", "Soporte premium", "Migración de datos", "Integración ERP"];
  const deals: Row[] = [];
  for (let i = 0; i < 30; i++) {
    const company = companies[i % companies.length]!;
    const cs = contacts.filter((c) => c.company_id === company.id);
    const ownerId = (company.owner_id as string) ?? sales1;
    const octx = as(ownerId);
    const amount = [2400, 4800, 8500, 12000, 18000, 25000, 36000, 6000][i % 8]!;
    const stage = stages[i % stages.length]!;
    const d = createDeal(octx, { name: `${dealNames[i % dealNames.length]} · ${company.name}`, company_id: company.id as string, amount, expected_close_date: addDays(now(), 5 + rnd(90)).slice(0, 10), contacts: cs.slice(0, 2).map((c, j) => ({ contact_id: c.id as string, role: j === 0 ? "decision_maker" : "influencer" })), source: pick(sources), custom: { tipo_contrato: pick(["Nuevo", "Renovación", "Ampliación"]) } });
    const createdAt = addDays(now(), -(10 + rnd(120)));
    db.run("UPDATE deals SET created_at=?, stage_entered_at=? WHERE id=?", createdAt, i % 4 === 0 ? addDays(now(), -(20 + rnd(20))) : addDays(now(), -rnd(10)), d.id);
    db.run("UPDATE deal_stage_history SET entered_at=? WHERE deal_id=?", createdAt, d.id);
    if ((stage.position as number) > 0) { for (const s of stages.slice(1, (stage.position as number) + 1)) moveStage(octx, d.id as string, s.id as string, { skipValidation: true }); }
    if (i % 5 === 1) setDealProducts(octx, d.id as string, [{ product_id: productIds[0]!, name: products[0][1], quantity: 10 + rnd(30), unit_price: 29, discount: 0, billing_period: "monthly" }, { product_id: productIds[2]!, name: products[2][1], quantity: 2, unit_price: 850, discount: 10, billing_period: "one_time" }]);
    deals.push(d);
  }
  // close some: won / lost spread over last months
  const lossReasons = ["price", "competitor", "no_budget", "no_response", "timing"];
  deals.forEach((d, i) => {
    const octx = as((d.owner_id as string) ?? sales1);
    const createdAt = db.get<{ created_at: string }>("SELECT created_at FROM deals WHERE id=?", d.id)!.created_at;
    const closedAt = addDays(createdAt, 5 + rnd(Math.max(6, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000) - 1)));
    if (i % 3 === 0 && i < 24) { closeDeal(octx, d.id as string, { status: "won", closed_at: closedAt }); }
    else if (i % 7 === 2) { closeDeal(octx, d.id as string, { status: "lost", loss_reason: lossReasons[i % lossReasons.length], competitor: i % 2 ? "CompetidorX" : null, closed_at: closedAt }); }
  });
  // quote for an open deal in proposal
  const openDeal = db.get<Row>("SELECT * FROM deals WHERE workspace_id=? AND status='open' AND amount>5000 ORDER BY created_at LIMIT 1", ws);
  if (openDeal) createQuote(as(openDeal.owner_id as string), { deal_id: openDeal.id as string, valid_days: 30, lines: [{ product_id: productIds[1]!, name: products[1][1], description: "Incluye onboarding", quantity: 15, unit_price: 59, discount: 0, tax_rate: 21 }, { product_id: productIds[3]!, name: products[3][1], quantity: 1, unit_price: 600, discount: 0, tax_rate: 21 }], discount: 5, notes: "Validez 30 días. Pago a 30 días desde factura." });

  // activities + tasks
  const subjects = { call: ["Llamada de cualificación", "Seguimiento de propuesta", "Llamada de presentación"], email: ["Envío de información", "Propuesta comercial", "Resumen de la reunión"], meeting: ["Demo del producto", "Reunión de kickoff", "Visita a cliente"], note: ["Interesados en integración con su ERP", "Decisión prevista para el próximo trimestre", "Pidieron referencias de clientes del sector"] };
  for (const c of contacts) {
    const n = 1 + rnd(4);
    const octx = as((c.owner_id as string) ?? sales1);
    for (let k = 0; k < n; k++) {
      const type = pick(["call", "email", "meeting", "note"] as const);
      const dealsOf = db.all<{ id: string }>("SELECT d.id FROM deals d JOIN deal_contacts dc ON dc.deal_id=d.id WHERE dc.contact_id=?", c.id);
      logActivity(octx, { type, subject: pick(subjects[type]), body: type === "note" ? "Nota de la conversación." : null, occurred_at: addDays(now(), -rnd(60)), duration_min: type === "call" ? 5 + rnd(30) : type === "meeting" ? 30 + rnd(60) : null, direction: type === "note" ? null : k % 3 === 0 ? "inbound" : "outbound", outcome: type === "call" ? pick(["Contactado", "Sin respuesta", "Buzón de voz"]) : null, contact_id: c.id as string, deal_id: dealsOf[0]?.id ?? null });
    }
  }
  const taskTitles = ["Llamar para cerrar", "Enviar propuesta revisada", "Preparar demo", "Confirmar reunión", "Revisar contrato", "Enviar referencias"];
  for (const d of db.all<Row>("SELECT * FROM deals WHERE workspace_id=? AND status='open'", ws)) {
    if (rnd(10) < 7) createTask(as(d.owner_id as string), { title: pick(taskTitles), type: pick(["call", "email", "meeting", "followup"] as const), due_at: addDays(now(), rnd(12) - 3), priority: pick(["low", "normal", "high"] as const), deal_id: d.id as string, company_id: d.company_id as string | null, contact_id: db.get<{ contact_id: string }>("SELECT contact_id FROM deal_contacts WHERE deal_id=?", d.id)?.contact_id ?? null }, { silent: true });
  }
  for (const u of owners) { const t = createTask(as(u), { title: "Revisar pipeline semanal", type: "todo", due_at: addDays(now(), 0), recurrence: "weekly" }, { silent: true }); if (u === sales2) completeTask(as(u), t.id as string, "Hecho"); }
  // meetings in the next days
  for (let i = 0; i < 6; i++) { const c = contacts[i * 5]!; logActivity(as((c.owner_id as string) ?? sales1), { type: "meeting", subject: pick(subjects.meeting), occurred_at: addDays(now(), 1 + rnd(6)), duration_min: 45, contact_id: c.id as string, company_id: c.company_id as string }); }
  db.run("UPDATE contacts SET last_activity_at=NULL WHERE id IN (SELECT id FROM contacts WHERE workspace_id=? ORDER BY created_at LIMIT 3)", ws);

  // tickets
  const tsubjects = ["No puedo exportar a Excel", "Error al sincronizar calendario", "Solicitud de nueva funcionalidad", "Factura duplicada", "Acceso bloqueado tras cambio de contraseña", "Dudas sobre la renovación"];
  const sctx = as(support);
  contacts.slice(0, 9).forEach((c, i) => {
    const t = createTicket(sctx, { subject: tsubjects[i % tsubjects.length]!, description: "Descripción reportada por el cliente.", contact_id: c.id as string, channel: pick(["email", "form", "phone"]), priority: pick(["low", "normal", "high", "urgent"] as const), category: pick(["Técnico", "Facturación", "Producto"]), status: i < 3 ? "resolved" : i < 6 ? "open" : "new", assignee_id: support });
    if (i < 3) { db.run("UPDATE tickets SET resolved_at=?, first_response_at=?, csat=? WHERE id=?", addDays(now(), -rnd(10)), addDays(now(), -rnd(10)), 3 + rnd(3), t.id); }
    if (i >= 3 && i < 6) db.run("UPDATE tickets SET first_response_at=? WHERE id=?", now(), t.id);
    db.run("UPDATE tickets SET created_at=? WHERE id=?", addDays(now(), -rnd(20)), t.id);
  });

  // lists & views
  const l1 = id();
  db.insert("lists", { id: l1, workspace_id: ws, object: "contact", name: "Leads calientes (MQL+)", kind: "dynamic", filters: { logic: "and", conditions: [{ field: "lifecycle_stage", op: "in", value: ["mql", "sql"] }] }, created_by: admin.id, created_at: now() });
  const l2 = id();
  db.insert("lists", { id: l2, workspace_id: ws, object: "contact", name: "Newsletter trimestral", kind: "static", filters: {}, created_by: admin.id, created_at: now() });
  for (const c of contacts.filter((c) => c.consent_marketing).slice(0, 15)) db.run("INSERT OR IGNORE INTO list_members (list_id, record_id, added_at) VALUES (?,?,?)", l2, c.id, now());
  db.insert("views", { id: id(), workspace_id: ws, object: "contact", name: "Mis leads nuevos", filters: { logic: "and", conditions: [{ field: "lead_status", op: "eq", value: "new" }] }, columns: ["name", "company_name", "email", "source", "score", "created_at"], sort: { field: "created_at", dir: "desc" }, shared: 1, user_id: admin.id, created_at: now() });
  db.insert("views", { id: id(), workspace_id: ws, object: "deal", name: "Cierres este mes", filters: { logic: "and", conditions: [{ field: "status", op: "eq", value: "open" }, { field: "expected_close_date", op: "next_days", value: 30 }] }, columns: ["name", "company_name", "stage_name", "amount", "expected_close_date", "owner_name"], sort: { field: "expected_close_date", dir: "asc" }, shared: 1, user_id: admin.id, created_at: now() });
  // CLM demo contracts
  seedClmDemo(db, ws, as);
  // clean notifications generated during seed (keep a couple)
  db.run("DELETE FROM notifications WHERE workspace_id=?", ws);
  db.run("DELETE FROM workflow_runs WHERE workspace_id=?", ws);
  db.run("UPDATE workflows SET runs=0, last_run_at=NULL WHERE workspace_id=?", ws);
}

// CLI: npm run seed  (adds demo data to an existing DB if it only has the admin)
if (process.argv[1] && process.argv[1].endsWith("seed.ts")) {
  const db = new Db(process.env.DATABASE_PATH ?? "./data/crm.db");
  const info = bootstrap(db, { demo: true });
  if (!info.createdAdmin) {
    const ws = info.workspaceId;
    const n = db.get<{ n: number }>("SELECT COUNT(*) n FROM contacts WHERE workspace_id=?", ws)?.n ?? 0;
    if (n > 0) console.log("La base de datos ya tiene datos; no se añaden datos de demostración.");
    else { seedDemo(db, ws); console.log("Datos de demostración añadidos."); }
  } else console.log(`Base de datos inicializada. Usuario: ${info.adminEmail} / ${info.adminPassword}`);
  db.close();
}
