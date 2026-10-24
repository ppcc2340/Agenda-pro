/** Background jobs: reminders, overdue tasks, stale/inactive deals, SLA risk, delayed workflow actions, webhook retries, retention. */
import type { Db } from "../db.js";
import { parseJson, type Row } from "../db.js";
import { now, addDays } from "../lib/util.js";
import { systemCtx } from "./system.js";
import { notify } from "./notifications.js";
import { emit } from "./events.js";
import { resumeActions, runScheduledDaily } from "./workflows.js";
import { retryDueDeliveries } from "./webhooks.js";
import { withRelated as dealWithRelated } from "./deals.js";
import { anonymizeContact } from "./contacts.js";
import { dailyContractChecks } from "./clm.js";

let timer: NodeJS.Timeout | null = null;
let lastDaily = "";

export function startScheduler(db: Db, intervalMs = 60000) {
  stopScheduler();
  timer = setInterval(() => { void tick(db); }, intervalMs);
  timer.unref();
}
export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function tick(db: Db, opts: { forceDaily?: boolean } = {}) {
  const workspaces = db.all<{ id: string }>("SELECT id FROM workspaces");
  for (const w of workspaces) {
    let ctx;
    try { ctx = systemCtx(db, w.id); } catch { continue; }
    try {
      // 1. delayed workflow actions
      for (const job of db.all<Row>("SELECT * FROM scheduled_jobs WHERE done_at IS NULL AND run_at <= ? AND workspace_id=? LIMIT 100", now(), w.id)) {
        parseJson(job, ["payload"]);
        try {
          if (job.kind === "workflow_actions") resumeActions(ctx, job.payload as never);
          db.update("scheduled_jobs", job.id as string, { done_at: now() });
        } catch (e) {
          db.update("scheduled_jobs", job.id as string, { attempts: (job.attempts as number) + 1, error: (e as Error).message, done_at: (job.attempts as number) >= 3 ? now() : null, run_at: addDays(now(), 1 / 24) });
        }
      }
      // 2. task reminders (due within 60 min) and overdue tasks
      for (const t of db.all<Row>("SELECT * FROM tasks WHERE workspace_id=? AND completed_at IS NULL AND reminded_at IS NULL AND due_at IS NOT NULL AND due_at <= datetime('now', '+60 minutes') AND due_at > datetime('now', '-1 day')", w.id)) {
        notify(db, w.id, t.assignee_id as string | null, { type: "task_due", title: `Tarea próxima: ${t.title}`, body: `Vence ${new Date(t.due_at as string).toLocaleString("es-ES")}`, link: `/tareas?task=${t.id}` });
        db.update("tasks", t.id as string, { reminded_at: now() });
      }
      for (const t of db.all<Row>("SELECT * FROM tasks WHERE workspace_id=? AND completed_at IS NULL AND overdue_notified_at IS NULL AND due_at IS NOT NULL AND due_at < ?", w.id, now())) {
        notify(db, w.id, t.assignee_id as string | null, { type: "task_overdue", title: `Tarea vencida: ${t.title}`, link: `/tareas?task=${t.id}` });
        db.update("tasks", t.id as string, { overdue_notified_at: now() });
        emit(ctx, { type: "task.overdue", object: "task", record: t });
      }
      // 3. tickets near SLA (within 1h) -> notify assignee once (use tags? use audit) -> emit event
      for (const t of db.all<Row>("SELECT * FROM tickets WHERE workspace_id=? AND status IN ('new','open') AND sla_due_at IS NOT NULL AND sla_due_at <= datetime('now','+1 hour') AND first_response_at IS NULL", w.id)) {
        const already = db.get("SELECT id FROM notifications WHERE user_id=? AND type='sla_risk' AND link=?", t.assignee_id ?? "", `/tickets/${t.id}`);
        if (already) continue;
        notify(db, w.id, t.assignee_id as string | null, { type: "sla_risk", title: `SLA a punto de vencer: ticket #${t.number}`, body: t.subject as string, link: `/tickets/${t.id}` });
        emit(ctx, { type: "ticket.sla_risk", object: "ticket", record: t });
      }
      // 4. webhook retries
      await retryDueDeliveries(db);
      // 5. daily checks
      const today = now().slice(0, 10);
      if (opts.forceDaily || lastDaily !== today) {
        lastDaily = today;
        dailyChecks(db, w.id, ctx);
        try { dailyContractChecks(ctx); } catch (e) { console.error("[clm daily]", e); }
      }
    } catch (e) {
      console.error("[scheduler]", e);
    }
  }
}

function dailyChecks(db: Db, ws: string, ctx: ReturnType<typeof systemCtx>) {
  const s = ctx.settings;
  // stale deals: exceeded expected days in stage
  const stale = db.all<Row>(`SELECT d.*, st.expected_days, st.name AS stage_name FROM deals d JOIN stages st ON st.id=d.stage_id WHERE d.workspace_id=? AND d.deleted_at IS NULL AND d.status='open' AND julianday('now') - julianday(d.stage_entered_at) > st.expected_days`, ws);
  for (const d of stale) {
    const days = Math.floor((Date.now() - new Date(d.stage_entered_at as string).getTime()) / 86400000);
    const dup = db.get("SELECT id FROM notifications WHERE user_id=? AND type='deal_stale' AND link=? AND created_at > datetime('now','-7 days')", d.owner_id ?? "", `/negocios/${d.id}`);
    if (!dup) notify(db, ws, d.owner_id as string | null, { type: "deal_stale", title: `Negocio estancado: ${d.name}`, body: `${days} días en ${d.stage_name} (esperado ${d.expected_days})`, link: `/negocios/${d.id}` });
    emit(ctx, { type: "deal.stale", object: "deal", record: dealWithRelated(ctx, { ...d, contacts: [], products: [] }), meta: { days } });
  }
  // inactive deals: no activity for N days
  const inactive = db.all<Row>(`SELECT * FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status='open' AND julianday('now') - julianday(COALESCE(last_activity_at, created_at)) >= ?`, ws, s.inactive_deal_days);
  for (const d of inactive) {
    const days = Math.floor((Date.now() - new Date((d.last_activity_at as string | null) ?? (d.created_at as string)).getTime()) / 86400000);
    emit(ctx, { type: "deal.inactive", object: "deal", record: dealWithRelated(ctx, { ...d, contacts: [], products: [] }), meta: { days } });
  }
  // lead SLA: new leads not contacted within N hours -> notify owner + manager
  const leads = db.all<Row>(`SELECT c.*, t.manager_id FROM contacts c LEFT JOIN users u ON u.id=c.owner_id LEFT JOIN teams t ON t.id=u.team_id WHERE c.workspace_id=? AND c.deleted_at IS NULL AND c.lead_status='new' AND c.lifecycle_stage IN ('lead','mql','sql') AND c.first_response_at IS NULL AND c.created_at < datetime('now', ?)`, ws, `-${s.lead_sla_hours} hours`);
  for (const c of leads) {
    const dup = db.get("SELECT id FROM notifications WHERE user_id=? AND type='lead_sla' AND link=?", c.owner_id ?? "", `/contactos/${c.id}`);
    if (dup) continue;
    notify(db, ws, c.owner_id as string | null, { type: "lead_sla", title: `Lead sin contactar: ${c.first_name} ${c.last_name}`, body: `Lleva más de ${s.lead_sla_hours} h sin primer contacto`, link: `/contactos/${c.id}` });
    if (c.manager_id && c.manager_id !== c.owner_id) notify(db, ws, c.manager_id as string, { type: "lead_sla", title: `Lead sin contactar en tu equipo: ${c.first_name} ${c.last_name}`, link: `/contactos/${c.id}` });
  }
  // birthdays today
  for (const c of db.all<Row>("SELECT * FROM contacts WHERE workspace_id=? AND deleted_at IS NULL AND birthday IS NOT NULL AND strftime('%m-%d', birthday)=strftime('%m-%d','now')", ws)) {
    notify(db, ws, c.owner_id as string | null, { type: "birthday", title: `Hoy es el cumpleaños de ${c.first_name} ${c.last_name}`, link: `/contactos/${c.id}` });
  }
  // quotes expired
  db.run("UPDATE quotes SET status='expired' WHERE workspace_id=? AND status IN ('sent','viewed') AND valid_until < date('now')", ws);
  // retention policy
  if (s.retention_enabled) {
    const old = db.all<Row>("SELECT id FROM contacts WHERE workspace_id=? AND deleted_at IS NULL AND anonymized_at IS NULL AND lifecycle_stage NOT IN ('customer','evangelist') AND COALESCE(last_activity_at, created_at) < datetime('now', ?) AND NOT EXISTS (SELECT 1 FROM deal_contacts dc JOIN deals d ON d.id=dc.deal_id WHERE dc.contact_id=contacts.id AND d.status='open')", ws, `-${s.retention_months} months`);
    for (const c of old) { try { anonymizeContact(ctx, c.id as string); } catch (e) { console.warn("[retention]", (e as Error).message); } }
  }
  // purge recycle bin (>30 days) and old jobs
  db.run("DELETE FROM contacts WHERE workspace_id=? AND deleted_at IS NOT NULL AND deleted_at < datetime('now','-30 days')", ws);
  db.run("DELETE FROM companies WHERE workspace_id=? AND deleted_at IS NOT NULL AND deleted_at < datetime('now','-30 days')", ws);
  db.run("DELETE FROM deals WHERE workspace_id=? AND deleted_at IS NOT NULL AND deleted_at < datetime('now','-30 days')", ws);
  db.run("DELETE FROM scheduled_jobs WHERE workspace_id=? AND done_at IS NOT NULL AND done_at < datetime('now','-30 days')", ws);
  db.run("DELETE FROM sessions WHERE expires_at < ?", now());
  // scheduled daily workflows
  runScheduledDaily(ctx);
}
