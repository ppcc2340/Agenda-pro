import { Router } from "express";
import type { Db, Row } from "../db.js";
import { parseJson } from "../db.js";
import { now } from "../lib/util.js";
import { systemCtx } from "../services/system.js";
import { emit } from "../services/events.js";
import { logActivity } from "../services/activities.js";
import { notify } from "../services/notifications.js";
import { publicView, publicDecision, getQuote } from "../services/quotes.js";
import { quotePdf } from "../services/quotePdf.js";
import { recordCsat } from "../services/tickets.js";
import { rateLimit, clientIp } from "../auth.js";
import { recomputeScore } from "../services/scoring.js";
import { EMBED_JS } from "./forms.js";
import { runForEvent } from "../services/workflows.js";

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export function publicRoutes(db: Db) {
  const r = Router();
  r.get("/embed.js", (_req, res) => { res.type("application/javascript").send(EMBED_JS); });

  // ---------- email tracking (7.1) ----------
  r.get("/t/o/:id.gif", (req, res) => {
    const e = db.get<Row>("SELECT * FROM emails WHERE id=?", String(req.params.id));
    if (e) {
      const first = !e.first_opened_at;
      db.update("emails", e.id as string, { opens: (e.opens as number) + 1, first_opened_at: (e.first_opened_at as string | null) ?? now() });
      try {
        const ctx = systemCtx(db, e.workspace_id as string);
        if (first && e.contact_id) {
          const contact = db.get<Row>("SELECT * FROM contacts WHERE id=?", e.contact_id);
          logActivity(ctx, { type: "system", subject: `Email abierto: ${e.subject}`, contact_id: e.contact_id as string, meta: { email_id: e.id } }, null);
          notify(db, ctx.ws, e.user_id as string | null, { type: "email_opened", title: `${contact?.first_name ?? "Un contacto"} ${contact?.last_name ?? ""} ha abierto tu email`, body: e.subject as string, link: `/contactos/${e.contact_id}` });
          recomputeScore(ctx, e.contact_id as string);
          if (contact) emit(ctx, { type: "email.opened", object: "contact", record: parseJson(contact, ["tags", "custom", "utm", "qualification"]) as Row, meta: { email_id: e.id, subject: e.subject } });
        }
      } catch (err) { console.warn("[tracking]", (err as Error).message); }
    }
    res.set({ "content-type": "image/gif", "cache-control": "no-store, max-age=0" }).send(GIF);
  });
  r.get("/t/c/:id", (req, res) => {
    const url = String(req.query.u ?? "/");
    const e = db.get<Row>("SELECT * FROM emails WHERE id=?", String(req.params.id));
    if (e) {
      db.update("emails", e.id as string, { clicks: (e.clicks as number) + 1 });
      try {
        const ctx = systemCtx(db, e.workspace_id as string);
        if (e.contact_id) { logActivity(ctx, { type: "system", subject: `Clic en enlace: ${url.slice(0, 80)}`, contact_id: e.contact_id as string, meta: { email_id: e.id, url } }, null); notify(db, ctx.ws, e.user_id as string | null, { type: "email_clicked", title: `Clic en tu email "${e.subject}"`, body: url, link: `/contactos/${e.contact_id}` }); }
      } catch { /* ignore */ }
    }
    if (!/^https?:\/\//.test(url)) return res.redirect("/");
    res.redirect(url);
  });

  // ---------- public quote (5.2) ----------
  r.get("/q/:token.json", (req, res) => {
    const q0 = db.get<Row>("SELECT workspace_id FROM quotes WHERE token=?", String(req.params.token));
    if (!q0) return res.status(404).json({ error: "Presupuesto no encontrado" });
    const ctx = systemCtx(db, q0.workspace_id as string);
    const q = publicView(ctx, String(req.params.token));
    if (!q) return res.status(404).json({ error: "Presupuesto no encontrado" });
    res.json({ number: q.number, version: q.version, date: q.date, valid_until: q.valid_until, lines: q.lines, subtotal: q.subtotal, discount: q.discount, tax: q.tax, total: q.total, status: q.status, notes: q.notes, company: ctx.settings.company_name, client: q.company_name, deal: q.deal_name, logo_url: ctx.settings.logo_url, brand_color: ctx.settings.brand_color, currency: db.get<{ currency: string }>("SELECT currency FROM deals WHERE id=?", q.deal_id)?.currency ?? ctx.settings.currency });
  });
  r.post("/q/:token/decision", rateLimit(10, 60 * 60000), (req, res, next) => {
    try {
      const q0 = db.get<Row>("SELECT workspace_id FROM quotes WHERE token=?", String(req.params.token));
      if (!q0) return res.status(404).json({ error: "Presupuesto no encontrado" });
      const ctx = systemCtx(db, q0.workspace_id as string);
      const decision = req.body?.decision === "accepted" ? "accepted" : "rejected";
      const name = String(req.body?.name ?? "").trim();
      if (!name) return res.status(400).json({ error: "Indica tu nombre para firmar" });
      // evidencia de la aceptación: nombre, IP, navegador y huella del contenido que se ha visto
      const qq = db.get<Row>("SELECT q.id, d.currency FROM quotes q JOIN deals d ON d.id=q.deal_id WHERE q.token=?", String(req.params.token))!;
      const full = getQuote(ctx, qq.id as string); full.currency = qq.currency;
      const content_sha256 = quotePdf(ctx, full).sha256;
      publicDecision(ctx, String(req.params.token), decision, { name, ip: clientIp(req), user_agent: String(req.headers["user-agent"] ?? "").slice(0, 200), content_sha256 });
      res.json({ ok: true, status: decision });
    } catch (e) { next(e); }
  });
  // ---------- encuesta de satisfacción (CSAT) ----------
  const csatPage = (title: string, body: string) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#f3f5f7;margin:0;padding:24px;color:#0f1e2e}.card{max-width:520px;margin:40px auto;background:#fff;border-radius:14px;padding:28px;box-shadow:0 8px 30px rgba(15,30,46,.08)}button,textarea{font:inherit}.s{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.s button{flex:1;min-width:64px;min-height:48px;border:1px solid #d0d4e4;background:#fff;border-radius:10px;font-size:20px;cursor:pointer}.s button[aria-pressed=true]{border-color:#0073ea;background:#e6f0ff}textarea{width:100%;min-height:90px;border:1px solid #d0d4e4;border-radius:8px;padding:8px;box-sizing:border-box}.go{margin-top:12px;background:#0073ea;color:#fff;border:0;border-radius:8px;padding:10px 18px;min-height:44px;cursor:pointer}@media (prefers-color-scheme:dark){body{background:#181b34;color:#d5d8df}.card{background:#24284a}.s button,textarea{background:#30355b;color:#d5d8df;border-color:#4b4e69}}</style></head><body><main class="card">${body}</main></body></html>`;
  const escH = (t: unknown) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  r.get("/csat/:token", (req, res) => {
    const t = db.get<Row>("SELECT id, workspace_id, number, subject, csat FROM tickets WHERE csat_token=?", String(req.params.token));
    if (!t) return res.status(404).type("html").send(csatPage("Encuesta", "<h1>Encuesta no encontrada</h1>"));
    const pre = Number(req.query.s);
    // el enlace del email solo preselecciona: los antivirus de correo abren todos los enlaces y no deben votar
    const cur = pre >= 1 && pre <= 5 ? pre : Number(t.csat) || 0;
    res.type("html").send(csatPage("¿Cómo lo hemos hecho?", `<h1 style="font-size:22px">¿Cómo valoras la atención?</h1><p>Ticket #${escH(t.number)} · ${escH(t.subject)}</p><form method="post" action="/csat/${escH(req.params.token)}"><div class="s" role="radiogroup" aria-label="Valoración de 1 a 5">${[1, 2, 3, 4, 5].map((n) => `<button type="submit" name="score" value="${n}" aria-pressed="${n === cur}" aria-label="${n} de 5">${["😞", "🙁", "😐", "🙂", "😀"][n - 1]}</button>`).join("")}</div><label for="c">Comentario (opcional)</label><textarea id="c" name="comment" maxlength="2000"></textarea>${cur ? `<button class="go" type="submit" name="score" value="${cur}">Enviar ${cur}/5</button>` : ""}</form>${t.csat != null ? `<p style="color:#037f4c">Ya registramos tu valoración (${escH(t.csat)}/5); puedes cambiarla.</p>` : ""}`));
  });
  r.post("/csat/:token", rateLimit(20, 60 * 60000), (req, res) => {
    const t = db.get<Row>("SELECT workspace_id FROM tickets WHERE csat_token=?", String(req.params.token));
    if (!t) return res.status(404).type("html").send(csatPage("Encuesta", "<h1>Encuesta no encontrada</h1>"));
    try { recordCsat(systemCtx(db, t.workspace_id as string), String(req.params.token), Number(req.body?.score), req.body?.comment ? String(req.body.comment) : null); }
    catch (e) { return res.status(400).type("html").send(csatPage("Encuesta", `<h1>${escH((e as Error).message)}</h1>`)); }
    res.type("html").send(csatPage("Gracias", "<h1>¡Gracias por tu opinión!</h1><p>Nos ayuda a mejorar.</p>"));
  });

  r.get("/q/:token.pdf", (req, res) => {
    const q0 = db.get<Row>("SELECT q.id, q.workspace_id, d.currency FROM quotes q JOIN deals d ON d.id=q.deal_id WHERE q.token=?", String(req.params.token));
    if (!q0) return res.status(404).send("Presupuesto no encontrado");
    const ctx = systemCtx(db, q0.workspace_id as string);
    const q = getQuote(ctx, q0.id as string); q.currency = q0.currency;
    const out = quotePdf(ctx, q);
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `inline; filename="${out.filename}"`);
    res.setHeader("x-content-sha256", out.sha256);
    res.send(out.pdf);
  });
  r.get("/q/:token", (req, res) => { res.type("html").send(quotePage(String(req.params.token))); });

  // ---------- inbound webhooks for workflows (webhook_in trigger) ----------
  r.post("/hooks/:workflowId", rateLimit(120, 60000), (req, res, next) => {
    try {
      const w = parseJson(db.get<Row>("SELECT * FROM workflows WHERE id=? AND active=1", String(req.params.workflowId)), ["trigger", "conditions", "actions"]);
      if (!w || (w.trigger as { type: string }).type !== "webhook_in") return res.status(404).json({ error: "Workflow no encontrado" });
      const ctx = systemCtx(db, w.workspace_id as string);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const object = String(body.object ?? "contact");
      const record = db.get<Row>(`SELECT * FROM ${object === "deal" ? "deals" : object === "company" ? "companies" : "contacts"} WHERE id=? AND workspace_id=?`, String(body.record_id ?? ""), ctx.ws);
      if (!record) return res.status(400).json({ error: "Indica object y record_id válidos" });
      runForEvent(ctx, { type: `${object}.webhook_in`, object: object as never, record: parseJson(record, ["tags", "custom"]) as Row, meta: body });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  return r;
}

function quotePage(token: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Presupuesto</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f3f5f7;margin:0;padding:24px;color:#0f1e2e}.card{max-width:760px;margin:0 auto;background:#fff;border-radius:14px;padding:32px;box-shadow:0 8px 30px rgba(15,30,46,.08)}h1{margin:0;font-size:24px}.meta{color:#44566a;font-size:14px;margin:6px 0 20px}table{width:100%;border-collapse:collapse;margin:16px 0}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #e3e9ee;font-size:14px}th{font-size:12px;color:#74869a;text-transform:uppercase;letter-spacing:.04em}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.tot{display:flex;justify-content:flex-end}.tot table{width:300px}.tot .g td{font-weight:700;font-size:16px}.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;background:#e9eef1}.actions{margin-top:24px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}input{border:1px solid #d2dbe1;border-radius:8px;padding:10px 12px;font:inherit;flex:1;min-width:200px}button{border:0;border-radius:8px;padding:11px 18px;font:inherit;font-weight:600;cursor:pointer}.ok{background:#0e6b74;color:#fff}.no{background:#fff;border:1px solid #d2dbe1!important}.done{background:#e9f7f0;color:#2a7b58;padding:14px;border-radius:8px;margin-top:20px}.notes{white-space:pre-wrap;color:#44566a;font-size:14px}@media print{body{background:#fff;padding:0}.card{box-shadow:none}.actions,.print{display:none}}</style></head>
<body><div class="card" id="app">Cargando…</div>
<script>
var token=${JSON.stringify(token)};var e=function(t){return String(t==null?'':t).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};var safeUrl=function(u){return /^https:\/\//.test(String(u||''))?e(u):''};var fmt=function(n,c){return new Intl.NumberFormat('es-ES',{style:'currency',currency:c||'EUR'}).format(n)};
fetch('/q/'+token+'.json').then(function(r){return r.json()}).then(function(q){if(q.error){document.getElementById('app').innerHTML='<h1>'+e(q.error)+'</h1>';return}
var st={draft:'Borrador',sent:'Enviado',viewed:'Visto',accepted:'Aceptado',rejected:'Rechazado',expired:'Caducado'};
var h='<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px"><div>'+(q.logo_url?'<img alt="" src="'+safeUrl(q.logo_url)+'" style="max-height:48px;margin-bottom:8px"/><br/>':'')+'<h1>Presupuesto '+e(q.number)+'</h1><div class="meta">'+e(q.company)+' · para '+e(q.client||q.deal)+' · versión '+e(q.version)+'</div></div><div><span class="badge">'+(st[q.status]||q.status)+'</span></div></div>';
h+='<div class="meta">Fecha: '+e(q.date)+(q.valid_until?' · Válido hasta: '+e(q.valid_until):'')+'</div>';
h+='<table><thead><tr><th>Concepto</th><th class="n">Cant.</th><th class="n">Precio</th><th class="n">Dto.</th><th class="n">Importe</th></tr></thead><tbody>';
q.lines.forEach(function(l){var t=l.quantity*l.unit_price*(1-(l.discount||0)/100);h+='<tr><td><strong>'+e(l.name)+'</strong>'+(l.description?'<br/><span class="meta">'+e(l.description)+'</span>':'')+'</td><td class="n">'+e(l.quantity)+'</td><td class="n">'+fmt(l.unit_price,q.currency)+'</td><td class="n">'+(l.discount||0)+'%</td><td class="n">'+fmt(t,q.currency)+'</td></tr>'});
h+='</tbody></table><div class="tot"><table><tr><td>Subtotal</td><td class="n">'+fmt(q.subtotal,q.currency)+'</td></tr>'+(q.discount?'<tr><td>Descuento global</td><td class="n">'+q.discount+'%</td></tr>':'')+'<tr><td>Impuestos</td><td class="n">'+fmt(q.tax,q.currency)+'</td></tr><tr class="g"><td>Total</td><td class="n">'+fmt(q.total,q.currency)+'</td></tr></table></div>';
if(q.notes)h+='<h3>Condiciones</h3><div class="notes">'+e(q.notes)+'</div>';
if(q.status==='accepted')h+='<div class="done">Presupuesto aceptado. ¡Gracias!</div>';else if(q.status==='rejected')h+='<div class="done" style="background:#fdecee;color:#bf3a4a">Presupuesto rechazado.</div>';else if(q.status==='expired')h+='<div class="done" style="background:#fff6e5;color:#9a6a0c">Este presupuesto ha caducado. Contacta con nosotros para renovarlo.</div>';
else h+='<div class="actions"><input id="nm" placeholder="Tu nombre y apellidos (firma)"/><button class="ok" onclick="dec(\\'accepted\\')">Aceptar presupuesto</button><button class="no" onclick="dec(\\'rejected\\')">Rechazar</button></div>';
h+='<p class="print meta" style="margin-top:20px"><a href="/q/'+encodeURIComponent(token)+'.pdf" target="_blank" rel="noopener">Descargar PDF</a> · <a href="#" onclick="window.print();return false">Imprimir</a></p>';
document.getElementById('app').innerHTML=h});
function dec(d){var n=document.getElementById('nm').value.trim();if(!n){alert('Indica tu nombre para firmar');return}if(!confirm(d==='accepted'?'¿Confirmas que aceptas este presupuesto?':'¿Rechazar el presupuesto?'))return;
fetch('/q/'+token+'/decision',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({decision:d,name:n})}).then(function(r){return r.json()}).then(function(r){if(r.ok)location.reload();else alert(r.error||'Error')})}
</script></body></html>`;
}
