import { Router, type Request } from "express";
import { z } from "zod";
import type { Db, Row } from "../db.js";
import { parseJson } from "../db.js";
import { h, parse, param } from "./_helpers.js";
import { assertAdmin } from "../lib/permissions.js";
import { id, now, normalizeEmail } from "../lib/util.js";
import { badRequest, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { systemCtx } from "../services/system.js";
import { createContact, updateContact, findDuplicateCandidates, getContact, withRelated } from "../services/contacts.js";
import { pickAssignee, type AssignmentRule } from "../services/assignment.js";
import { notify } from "../services/notifications.js";
import { emit } from "../services/events.js";
import { createDeal } from "../services/deals.js";
import { logActivity } from "../services/activities.js";
import { rateLimit, clientIp } from "../auth.js";
import { createTask } from "../services/tasks.js";

const fieldSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9_.]*$/), label: z.string().min(1), type: z.enum(["text", "email", "phone", "textarea", "select", "checkbox", "hidden"]).default("text"), required: z.boolean().default(false), options: z.array(z.string()).optional(), placeholder: z.string().optional() });
const formSchema = z.object({
  name: z.string().trim().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/, "Solo minúsculas, números y guiones").optional(),
  fields: z.array(fieldSchema).min(1),
  settings: z.object({
    assignment: z.object({ mode: z.enum(["fixed", "round_robin", "least_loaded", "none"]).default("round_robin"), user_id: z.string().nullable().optional(), team_id: z.string().nullable().optional() }).default({ mode: "round_robin" }),
    create_deal: z.boolean().default(false), pipeline_id: z.string().nullable().optional(), deal_name: z.string().optional(),
    create_task: z.boolean().default(true), task_title: z.string().default("Llamar al nuevo lead en 1 h"),
    thank_you: z.string().default("¡Gracias! Nos pondremos en contacto contigo muy pronto."), redirect_url: z.string().nullable().optional(),
    consent_text: z.string().default("Acepto recibir comunicaciones comerciales."), require_consent: z.boolean().default(false),
    tags: z.array(z.string()).default([]), source: z.string().default("web"), lifecycle_stage: z.string().default("lead"),
    notify_assignee: z.boolean().default(true), button_text: z.string().default("Enviar"), title: z.string().optional(), description: z.string().optional(),
  }).prefault({}),
  active: z.boolean().optional(),
});

export function formAdminRoutes() {
  const r = Router();
  r.get("/", h(async (req) => ({ items: req.ctx.db.all<Row>("SELECT * FROM forms WHERE workspace_id=? ORDER BY name", req.ctx.ws).map((f) => parseJson(f, ["fields", "settings"])) })));
  r.post("/", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(formSchema, req.body);
    const slug = b.slug ?? b.name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (req.ctx.db.get("SELECT id FROM forms WHERE slug=?", slug)) throw badRequest("Ya existe un formulario con ese slug");
    const fid = id();
    req.ctx.db.insert("forms", { id: fid, workspace_id: req.ctx.ws, name: b.name, slug, fields: b.fields, settings: b.settings, active: b.active === false ? 0 : 1, created_at: now() });
    audit(req.ctx, "form", fid, "create", { name: b.name });
    return parseJson(req.ctx.db.get<Row>("SELECT * FROM forms WHERE id=?", fid), ["fields", "settings"]);
  }));
  r.put("/:id", h(async (req) => {
    assertAdmin(req.ctx);
    const b = parse(formSchema.partial(), req.body);
    const f = req.ctx.db.get<Row>("SELECT id FROM forms WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws);
    if (!f) throw notFound("Formulario");
    req.ctx.db.update("forms", f.id as string, { ...b, active: b.active === undefined ? undefined : b.active ? 1 : 0 });
    return parseJson(req.ctx.db.get<Row>("SELECT * FROM forms WHERE id=?", f.id), ["fields", "settings"]);
  }));
  r.delete("/:id", h(async (req) => { assertAdmin(req.ctx); req.ctx.db.run("DELETE FROM forms WHERE id=? AND workspace_id=?", param(req, "id"), req.ctx.ws); return { ok: true }; }));
  r.get("/:id/submissions", h(async (req) => ({ items: req.ctx.db.all<Row>("SELECT s.*, (SELECT first_name||' '||last_name FROM contacts WHERE id=s.contact_id) contact_name FROM form_submissions s WHERE s.form_id=? AND s.workspace_id=? ORDER BY s.created_at DESC LIMIT 200", param(req, "id"), req.ctx.ws).map((x) => parseJson(x, ["data", "meta"])) })));
  return r;
}

/** Public: GET /f/:slug renders a standalone form page; POST /f/:slug receives the submission (also used by embed.js). */
export function formPublicRoutes(db: Db) {
  const r = Router();
  r.get("/:slug.json", (req, res) => {
    const f = parseJson(db.get<Row>("SELECT id, name, fields, settings, active FROM forms WHERE slug=?", String(req.params.slug)), ["fields", "settings"]);
    if (!f || !f.active) return res.status(404).json({ error: "Formulario no disponible" });
    res.json({ name: f.name, fields: f.fields, settings: publicSettings(f.settings as Record<string, unknown>) });
  });
  r.get("/:slug", (req, res) => {
    const f = parseJson(db.get<Row>("SELECT * FROM forms WHERE slug=?", String(req.params.slug)), ["fields", "settings"]);
    if (!f || !f.active) return res.status(404).send("<h1>Formulario no disponible</h1>");
    res.type("html").send(renderFormPage(f));
  });
  r.post("/:slug", rateLimit(30, 10 * 60000), (req, res, next) => {
    try {
      const f = parseJson(db.get<Row>("SELECT * FROM forms WHERE slug=?", String(req.params.slug)), ["fields", "settings"]);
      if (!f || !f.active) return res.status(404).json({ error: "Formulario no disponible" });
      const result = handleSubmission(db, f, (req.body ?? {}) as Record<string, unknown>, req);
      const s = f.settings as Record<string, unknown>;
      res.json({ ok: true, message: s.thank_you, redirect_url: s.redirect_url ?? null, contact_id: result.contact_id });
    } catch (e) { next(e); }
  });
  return r;
}

function publicSettings(s: Record<string, unknown>) {
  return { thank_you: s.thank_you, redirect_url: s.redirect_url, consent_text: s.consent_text, require_consent: s.require_consent, button_text: s.button_text, title: s.title, description: s.description };
}

export function handleSubmission(db: Db, form: Row, body: Record<string, unknown>, req?: Request): { contact_id: string } {
  const ctx = systemCtx(db, form.workspace_id as string);
  const fields = form.fields as { key: string; label: string; type: string; required: boolean }[];
  const s = form.settings as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const f of fields) {
    const v = body[f.key];
    const str = v === undefined || v === null ? "" : String(v).trim();
    if (f.required && !str && f.type !== "checkbox") errors.push(`${f.label} es obligatorio`);
    if (f.type === "email" && str && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(str)) errors.push(`${f.label}: email no válido`);
    data[f.key] = f.type === "checkbox" ? (v === true || v === "on" || v === "true" || v === "1") : str;
  }
  const consent = body.consent === true || body.consent === "on" || body.consent === "true" || body.consent === "1";
  if (s.require_consent && !consent) errors.push("Debes aceptar el consentimiento");
  if (typeof body._hp === "string" && body._hp) errors.push("Spam detectado"); // honeypot
  if (errors.length) throw badRequest(errors.join(". "), { fields: errors });

  const email = normalizeEmail(data.email);
  const utm: Record<string, string> = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) if (typeof body[k] === "string" && body[k]) utm[k] = String(body[k]);
  const meta = { ip: req ? clientIp(req) : "", user_agent: req?.headers["user-agent"]?.slice(0, 200) ?? "", referrer: String(body.referrer ?? req?.headers.referer ?? ""), page: String(body.page ?? ""), utm };
  const custom: Record<string, unknown> = {};
  const std: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) { if (k.startsWith("custom.")) custom[k.slice(7)] = v; else std[k] = v; }
  const firstName = String(std.first_name ?? "") || String(std.name ?? "").split(" ")[0] || (email ? email.split("@")[0] : "") || "Lead";
  const lastName = String(std.last_name ?? "") || String(std.name ?? "").split(" ").slice(1).join(" ");
  const existing = email ? findDuplicateCandidates(ctx, { email })[0] : undefined;
  let contactId: string;
  const assignRule = s.assignment as AssignmentRule | undefined;
  if (existing) {
    contactId = existing.id;
    const prev = getContact(ctx, contactId);
    updateContact(ctx, contactId, { phone: (std.phone as string | undefined) ?? undefined, job_title: (std.job_title as string | undefined) ?? undefined, company_name: (std.company as string | undefined) ?? (std.company_name as string | undefined) ?? undefined, custom: Object.keys(custom).length ? custom : undefined, consent_marketing: consent ? true : undefined, consent_source: consent ? `form:${form.slug}` : undefined, tags: Array.from(new Set([...(prev.tags as string[]), ...((s.tags as string[]) ?? [])])) });
  } else {
    const owner = pickAssignee(db, ctx.ws, assignRule, `form:${form.id}`);
    const c = createContact(ctx, { first_name: firstName, last_name: lastName, email: email ?? null, phone: (std.phone as string | undefined) ?? null, job_title: (std.job_title as string | undefined) ?? null, company_name: (std.company as string | undefined) ?? (std.company_name as string | undefined), lifecycle_stage: (s.lifecycle_stage as "lead") ?? "lead", source: (s.source as string) ?? "web", utm, owner_id: owner, consent_marketing: consent, consent_source: consent ? `form:${form.slug}` : null, tags: (s.tags as string[]) ?? [], custom, city: (std.city as string | undefined) ?? null, country: (std.country as string | undefined) ?? null }, { force: true, autoCreateCompany: true });
    contactId = c.id as string;
  }
  const contact = getContact(ctx, contactId);
  db.insert("form_submissions", { id: id(), workspace_id: ctx.ws, form_id: form.id, contact_id: contactId, data, meta, created_at: now() });
  db.run("UPDATE forms SET submissions=submissions+1 WHERE id=?", form.id);
  logActivity(ctx, { type: "system", subject: `Formulario enviado: ${form.name}`, body: (std.message as string | undefined) ?? null, contact_id: contactId, meta: { form_id: form.id, data } }, null);
  if (s.create_deal) {
    try { createDeal(ctx, { name: String(s.deal_name ?? `${contact.company_name ?? `${contact.first_name} ${contact.last_name}`} · ${form.name}`), pipeline_id: (s.pipeline_id as string | null) ?? undefined, company_id: contact.company_id as string | null, owner_id: contact.owner_id as string | null, contacts: [{ contact_id: contactId, role: "decision_maker" }], source: (s.source as string) ?? "web" }); } catch (e) { console.warn("[form] deal", (e as Error).message); }
  }
  if (s.create_task !== false && contact.owner_id) createTask(ctx, { title: String(s.task_title ?? "Llamar al nuevo lead"), type: "call", due_at: new Date(Date.now() + 3600000).toISOString(), priority: "high", assignee_id: contact.owner_id as string, contact_id: contactId, company_id: contact.company_id as string | null }, { silent: true });
  if (s.notify_assignee !== false && contact.owner_id) notify(db, ctx.ws, contact.owner_id as string, { type: "new_lead", title: `Nuevo lead: ${contact.first_name} ${contact.last_name}`, body: `Formulario ${form.name}${contact.company_name ? ` · ${contact.company_name}` : ""}`, link: `/contactos/${contactId}` });
  emit(ctx, { type: "form.submitted", object: "contact", record: withRelated(ctx, contact), meta: { form_id: form.id, data } });
  return { contact_id: contactId };
}

function esc(s: unknown) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c); }

function renderFormPage(f: Row): string {
  const s = f.settings as Record<string, unknown>;
  const fields = f.fields as { key: string; label: string; type: string; required: boolean; options?: string[]; placeholder?: string }[];
  const inputs = fields.map((x) => {
    const req = x.required ? " required" : "";
    const name = esc(x.key);
    if (x.type === "hidden") return `<input type="hidden" name="${name}" />`;
    const label = `<label for="f_${name}">${esc(x.label)}${x.required ? " *" : ""}</label>`;
    if (x.type === "textarea") return `<div class="fld">${label}<textarea id="f_${name}" name="${name}" rows="4"${req} placeholder="${esc(x.placeholder)}"></textarea></div>`;
    if (x.type === "select") return `<div class="fld">${label}<select id="f_${name}" name="${name}"${req}><option value="">Elige…</option>${(x.options ?? []).map((o) => `<option>${esc(o)}</option>`).join("")}</select></div>`;
    if (x.type === "checkbox") return `<div class="fld chk"><label><input type="checkbox" id="f_${name}" name="${name}" /> ${esc(x.label)}</label></div>`;
    return `<div class="fld">${label}<input id="f_${name}" type="${x.type === "phone" ? "tel" : x.type}" name="${name}"${req} placeholder="${esc(x.placeholder)}" /></div>`;
  }).join("\n");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${esc(s.title ?? f.name)}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f3f5f7;margin:0;padding:24px;color:#0f1e2e}.card{max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:28px;box-shadow:0 8px 30px rgba(15,30,46,.08)}h1{font-size:22px;margin:0 0 6px}p.d{color:#44566a;margin:0 0 18px}.fld{margin-bottom:14px}label{display:block;font-size:13px;font-weight:600;margin-bottom:5px}input:not([type=checkbox]),select,textarea{width:100%;box-sizing:border-box;border:1px solid #d2dbe1;border-radius:8px;padding:10px 12px;font:inherit}.chk label{font-weight:400;display:flex;gap:8px;align-items:center}button{background:#0e6b74;color:#fff;border:0;border-radius:8px;padding:11px 18px;font:inherit;font-weight:600;cursor:pointer;width:100%}button:disabled{opacity:.6}.ok{background:#e9f7f0;color:#2a7b58;padding:14px;border-radius:8px}.err{background:#fdecee;color:#bf3a4a;padding:10px;border-radius:8px;margin-bottom:12px;display:none}.hp{position:absolute;left:-9999px}</style></head>
<body><div class="card"><h1>${esc(s.title ?? f.name)}</h1>${s.description ? `<p class="d">${esc(s.description)}</p>` : ""}
<form id="crmf"><div class="err" id="err"></div>${inputs}
<input class="hp" type="text" name="_hp" tabindex="-1" autocomplete="off"/>
<div class="fld chk"><label><input type="checkbox" name="consent"${s.require_consent ? " required" : ""}/> ${esc(s.consent_text)}</label></div>
<button type="submit">${esc(s.button_text ?? "Enviar")}</button></form></div>
<script>
(function(){var f=document.getElementById('crmf'),e=document.getElementById('err');var q=new URLSearchParams(location.search);
f.addEventListener('submit',function(ev){ev.preventDefault();var d={};new FormData(f).forEach(function(v,k){d[k]=v});['utm_source','utm_medium','utm_campaign','utm_term','utm_content'].forEach(function(k){if(q.get(k))d[k]=q.get(k)});d.referrer=document.referrer;d.page=location.href;
var b=f.querySelector('button');b.disabled=true;fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(d)}).then(function(r){return r.json()}).then(function(r){if(r.ok){if(r.redirect_url){location.href=r.redirect_url;return}f.outerHTML='<div class="ok">'+r.message+'</div>'}else{e.textContent=r.error||'Error';e.style.display='block';b.disabled=false}}).catch(function(){e.textContent='No se pudo enviar. Inténtalo de nuevo.';e.style.display='block';b.disabled=false})})})();
</script></body></html>`;
}

export const EMBED_JS = `(function(){var s=document.currentScript;var slug=s.getAttribute('data-form');var base=s.src.replace(/\\/embed\\.js.*$/,'');var el=document.getElementById(s.getAttribute('data-target')||'crm-form');if(!el){el=document.createElement('div');s.parentNode.insertBefore(el,s)}
var ifr=document.createElement('iframe');ifr.src=base+'/f/'+slug;ifr.style.cssText='width:100%;border:0;min-height:'+(s.getAttribute('data-height')||'560')+'px';ifr.title='Formulario';el.appendChild(ifr)})();`;
