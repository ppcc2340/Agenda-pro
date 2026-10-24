import { Router } from "express";
import { h } from "./_helpers.js";
import type { Ctx } from "../context.js";
import { ownerScope, assert, isAdmin } from "../lib/permissions.js";
import { LOSS_LABELS } from "../services/deals.js";
import type { Row } from "../db.js";

function range(req: { query: Record<string, unknown> }) {
  const to = typeof req.query.to === "string" && req.query.to ? req.query.to : new Date().toISOString().slice(0, 10);
  const from = typeof req.query.from === "string" && req.query.from ? req.query.from : new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const owner = typeof req.query.owner_id === "string" && req.query.owner_id ? req.query.owner_id : null;
  const team = typeof req.query.team_id === "string" && req.query.team_id ? req.query.team_id : null;
  return { from, to: to + "T23:59:59", owner, team };
}
function scopeSql(ctx: Ctx, col: string, owner: string | null, team: string | null): { sql: string; params: unknown[] } {
  const s = ownerScope(ctx, col);
  const parts = [s.sql]; const params = [...s.params];
  if (owner) { parts.push(`${col}=?`); params.push(owner); }
  if (team) { parts.push(`${col} IN (SELECT id FROM users WHERE team_id=?)`); params.push(team); }
  return { sql: parts.join(" AND "), params };
}

export function reportRoutes() {
  const r = Router();

  r.get("/dashboard", h(async (req) => {
    const ctx = req.ctx; const db = ctx.db; const ws = ctx.ws;
    const { owner, team } = range(req as never);
    const ds = scopeSql(ctx, "owner_id", owner, team);
    const month = new Date().toISOString().slice(0, 7);
    const pipeline = db.all<Row>(`SELECT s.id, s.name, s.color, s.position, COUNT(d.id) count, COALESCE(SUM(d.amount),0) amount, COALESCE(SUM(d.amount*d.probability/100.0),0) weighted FROM stages s JOIN pipelines p ON p.id=s.pipeline_id LEFT JOIN deals d ON d.stage_id=s.id AND d.deleted_at IS NULL AND d.status='open' AND ${ds.sql.replace(/owner_id/g, "d.owner_id")} WHERE s.workspace_id=? AND s.kind='open' AND p.is_default=1 GROUP BY s.id ORDER BY s.position`, ...ds.params, ws);
    const open = db.get<Row>(`SELECT COUNT(*) count, COALESCE(SUM(amount),0) amount, COALESCE(SUM(amount*probability/100.0),0) weighted FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status='open' AND ${ds.sql}`, ws, ...ds.params);
    const wonMonth = db.get<Row>(`SELECT COUNT(*) count, COALESCE(SUM(amount),0) amount FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status='won' AND substr(closed_at,1,7)=? AND ${ds.sql}`, ws, month, ...ds.params);
    const lostMonth = db.get<Row>(`SELECT COUNT(*) count, COALESCE(SUM(amount),0) amount FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status='lost' AND substr(closed_at,1,7)=? AND ${ds.sql}`, ws, month, ...ds.params);
    const closed90 = db.get<{ won: number; lost: number }>(`SELECT SUM(status='won') won, SUM(status='lost') lost FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status IN ('won','lost') AND closed_at >= datetime('now','-90 days') AND ${ds.sql}`, ws, ...ds.params);
    const conversion = closed90 && (closed90.won + closed90.lost) > 0 ? Math.round((100 * closed90.won) / (closed90.won + closed90.lost)) : 0;
    const newLeads = db.get<{ n: number }>(`SELECT COUNT(*) n FROM contacts WHERE workspace_id=? AND deleted_at IS NULL AND created_at >= datetime('now','-30 days') AND ${ds.sql}`, ws, ...ds.params)?.n ?? 0;
    const activity = db.all<Row>(`SELECT type, COUNT(*) n FROM activities WHERE workspace_id=? AND type IN ('email','call','meeting','note','task') AND occurred_at >= datetime('now','-30 days') AND ${scopeSql(ctx, "user_id", owner, team).sql} GROUP BY type`, ws, ...scopeSql(ctx, "user_id", owner, team).params);
    const wonByMonth = db.all<Row>(`SELECT substr(closed_at,1,7) month, COUNT(*) count, COALESCE(SUM(amount),0) amount FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status='won' AND closed_at >= datetime('now','-12 months') AND ${ds.sql} GROUP BY month ORDER BY month`, ws, ...ds.params);
    const stale = db.all<Row>(`SELECT d.id, d.name, d.amount, d.currency, s.name stage_name, s.expected_days, CAST(julianday('now') - julianday(d.stage_entered_at) AS INTEGER) days, (SELECT name FROM companies WHERE id=d.company_id) company_name FROM deals d JOIN stages s ON s.id=d.stage_id WHERE d.workspace_id=? AND d.deleted_at IS NULL AND d.status='open' AND julianday('now') - julianday(d.stage_entered_at) > s.expected_days AND ${ds.sql.replace(/owner_id/g, "d.owner_id")} ORDER BY days DESC LIMIT 8`, ws, ...ds.params);
    const myTasks = db.get<{ overdue: number; today: number }>("SELECT SUM(date(due_at) < date('now')) overdue, SUM(date(due_at) = date('now')) today FROM tasks WHERE workspace_id=? AND assignee_id=? AND completed_at IS NULL", ws, ctx.user.id);
    const quota = ctx.user.quota as number | null;
    const myWon = db.get<{ amount: number }>("SELECT COALESCE(SUM(amount),0) amount FROM deals WHERE workspace_id=? AND owner_id=? AND status='won' AND deleted_at IS NULL AND substr(closed_at,1,7)=?", ws, ctx.user.id, month)?.amount ?? 0;
    const leaderboard = isAdmin(ctx) || ctx.role.visibility !== "own" ? db.all<Row>(`SELECT u.id, u.name, COUNT(d.id) count, COALESCE(SUM(d.amount),0) amount FROM users u LEFT JOIN deals d ON d.owner_id=u.id AND d.status='won' AND d.deleted_at IS NULL AND substr(d.closed_at,1,7)=? WHERE u.workspace_id=? AND u.active=1 AND ${ds.sql.replace(/owner_id/g, "u.id")} GROUP BY u.id ORDER BY amount DESC LIMIT 8`, month, ws, ...ds.params) : [];
    const tickets = db.get<Row>("SELECT SUM(status IN ('new','open','pending')) open, SUM(status IN ('new','open') AND sla_due_at < datetime('now') AND first_response_at IS NULL) sla_breached FROM tickets WHERE workspace_id=?", ws);
    const upcoming = db.all<Row>(`SELECT d.id, d.name, d.amount, d.currency, d.expected_close_date, d.probability, (SELECT name FROM companies WHERE id=d.company_id) company_name FROM deals d WHERE d.workspace_id=? AND d.deleted_at IS NULL AND d.status='open' AND d.expected_close_date <= date('now','+14 days') AND ${ds.sql.replace(/owner_id/g, "d.owner_id")} ORDER BY d.expected_close_date LIMIT 8`, ws, ...ds.params);
    return { pipeline, open, won_month: wonMonth, lost_month: lostMonth, conversion, new_leads_30d: newLeads, activity, won_by_month: wonByMonth, stale, my_tasks: myTasks, quota: { target: quota, won: myWon }, leaderboard, tickets, upcoming };
  }));

  r.get("/pipeline", h(async (req) => {
    const ctx = req.ctx; const { owner, team } = range(req as never); const ds = scopeSql(ctx, "d.owner_id", owner, team);
    const byStage = ctx.db.all(`SELECT p.name pipeline, s.id, s.name stage, s.color, s.position, COUNT(d.id) count, COALESCE(SUM(d.amount),0) amount, COALESCE(SUM(d.amount*d.probability/100.0),0) weighted, AVG(julianday('now')-julianday(d.stage_entered_at)) avg_days FROM stages s JOIN pipelines p ON p.id=s.pipeline_id LEFT JOIN deals d ON d.stage_id=s.id AND d.deleted_at IS NULL AND d.status='open' AND ${ds.sql} WHERE s.workspace_id=? AND s.kind='open' GROUP BY s.id ORDER BY p.position, s.position`, ...ds.params, ctx.ws);
    const byOwner = ctx.db.all(`SELECT u.id, u.name, COUNT(d.id) count, COALESCE(SUM(d.amount),0) amount, COALESCE(SUM(d.amount*d.probability/100.0),0) weighted FROM users u LEFT JOIN deals d ON d.owner_id=u.id AND d.deleted_at IS NULL AND d.status='open' WHERE u.workspace_id=? AND u.active=1 AND ${ds.sql.replace(/d\.owner_id/g, "u.id")} GROUP BY u.id ORDER BY amount DESC`, ctx.ws, ...ds.params);
    const byPipeline = ctx.db.all(`SELECT p.id, p.name, COUNT(d.id) count, COALESCE(SUM(d.amount),0) amount FROM pipelines p LEFT JOIN deals d ON d.pipeline_id=p.id AND d.deleted_at IS NULL AND d.status='open' AND ${ds.sql} WHERE p.workspace_id=? GROUP BY p.id`, ...ds.params, ctx.ws);
    return { by_stage: byStage, by_owner: byOwner, by_pipeline: byPipeline };
  }));

  r.get("/sales", h(async (req) => {
    const ctx = req.ctx; const { from, to, owner, team } = range(req as never); const ds = scopeSql(ctx, "owner_id", owner, team);
    const base = `workspace_id=? AND deleted_at IS NULL AND status IN ('won','lost') AND closed_at BETWEEN ? AND ? AND ${ds.sql}`;
    const p = [ctx.ws, from, to, ...ds.params];
    const byMonth = ctx.db.all(`SELECT substr(closed_at,1,7) month, SUM(status='won') won, SUM(status='lost') lost, COALESCE(SUM(CASE WHEN status='won' THEN amount END),0) won_amount, COALESCE(SUM(CASE WHEN status='lost' THEN amount END),0) lost_amount FROM deals WHERE ${base} GROUP BY month ORDER BY month`, ...p);
    const totals = ctx.db.get<Row>(`SELECT SUM(status='won') won, SUM(status='lost') lost, COALESCE(SUM(CASE WHEN status='won' THEN amount END),0) won_amount, AVG(CASE WHEN status='won' THEN amount END) avg_deal, AVG(CASE WHEN status='won' THEN julianday(closed_at)-julianday(created_at) END) avg_cycle_days FROM deals WHERE ${base}`, ...p);
    const lossReasons = ctx.db.all<Row>(`SELECT loss_reason reason, COUNT(*) count, COALESCE(SUM(amount),0) amount FROM deals WHERE ${base} AND status='lost' GROUP BY loss_reason ORDER BY count DESC`, ...p).map((x) => ({ ...x, label: LOSS_LABELS[String(x.reason)] ?? x.reason ?? "Sin motivo" }));
    const byOwner = ctx.db.all(`SELECT (SELECT name FROM users WHERE id=d.owner_id) name, SUM(status='won') won, SUM(status='lost') lost, COALESCE(SUM(CASE WHEN status='won' THEN amount END),0) won_amount FROM deals d WHERE ${base} GROUP BY owner_id ORDER BY won_amount DESC`, ...p);
    const bySource = ctx.db.all(`SELECT COALESCE(source,'sin origen') source, SUM(status='won') won, SUM(status='lost') lost, COALESCE(SUM(CASE WHEN status='won' THEN amount END),0) won_amount FROM deals WHERE ${base} GROUP BY source ORDER BY won_amount DESC`, ...p);
    return { by_month: byMonth, totals, loss_reasons: lossReasons, by_owner: byOwner, by_source: bySource, from, to: to.slice(0, 10) };
  }));

  r.get("/funnel", h(async (req) => {
    const ctx = req.ctx; const { from, to, owner, team } = range(req as never); const ds = scopeSql(ctx, "d.owner_id", owner, team);
    // stage-to-stage: deals that entered each stage (history) within the period, and how many of them ended won
    const stages = ctx.db.all<Row>(`SELECT s.id, s.name, s.color, s.position, p.name pipeline, (SELECT COUNT(DISTINCT h.deal_id) FROM deal_stage_history h JOIN deals d ON d.id=h.deal_id WHERE h.to_stage_id=s.id AND h.entered_at BETWEEN ? AND ? AND d.deleted_at IS NULL AND ${ds.sql}) entered, (SELECT AVG(julianday(COALESCE(h.left_at, 'now'))-julianday(h.entered_at)) FROM deal_stage_history h JOIN deals d ON d.id=h.deal_id WHERE h.to_stage_id=s.id AND h.entered_at BETWEEN ? AND ? AND ${ds.sql}) avg_days FROM stages s JOIN pipelines p ON p.id=s.pipeline_id WHERE s.workspace_id=? AND p.is_default=1 ORDER BY s.position`, from, to, ...ds.params, from, to, ...ds.params, ctx.ws);
    const lifecycle = ctx.db.all(`SELECT lifecycle_stage stage, COUNT(*) count FROM contacts c WHERE workspace_id=? AND deleted_at IS NULL AND ${ds.sql.replace(/d\.owner_id/g, "c.owner_id")} GROUP BY lifecycle_stage`, ctx.ws, ...ds.params);
    return { stages, lifecycle };
  }));

  r.get("/activity", h(async (req) => {
    const ctx = req.ctx; const { from, to, owner, team } = range(req as never); const us = scopeSql(ctx, "a.user_id", owner, team);
    const byUser = ctx.db.all(`SELECT u.id, u.name, SUM(a.type='email') emails, SUM(a.type='call') calls, SUM(a.type='meeting') meetings, SUM(a.type='note') notes, SUM(a.type='task') tasks, COUNT(a.id) total FROM users u LEFT JOIN activities a ON a.user_id=u.id AND a.occurred_at BETWEEN ? AND ? AND a.type!='system' WHERE u.workspace_id=? AND u.active=1 AND ${us.sql.replace(/a\.user_id/g, "u.id")} GROUP BY u.id ORDER BY total DESC`, from, to, ctx.ws, ...us.params);
    const byDay = ctx.db.all(`SELECT date(a.occurred_at) day, COUNT(*) n FROM activities a WHERE a.workspace_id=? AND a.type!='system' AND a.occurred_at BETWEEN ? AND ? AND ${us.sql} GROUP BY day ORDER BY day`, ctx.ws, from, to, ...us.params);
    const tasks = ctx.db.get(`SELECT SUM(completed_at IS NOT NULL) done, SUM(completed_at IS NULL AND due_at < datetime('now')) overdue, SUM(completed_at IS NULL) open FROM tasks t WHERE t.workspace_id=? AND ${us.sql.replace(/a\.user_id/g, "t.assignee_id")}`, ctx.ws, ...us.params);
    return { by_user: byUser, by_day: byDay, tasks };
  }));

  r.get("/leads", h(async (req) => {
    const ctx = req.ctx; const { from, to, owner, team } = range(req as never); const cs = scopeSql(ctx, "c.owner_id", owner, team);
    const bySource = ctx.db.all(`SELECT COALESCE(c.source,'otro') source, COUNT(*) leads, SUM(c.lifecycle_stage IN ('opportunity','customer','evangelist')) converted, SUM(c.lifecycle_stage='customer') customers FROM contacts c WHERE c.workspace_id=? AND c.deleted_at IS NULL AND c.created_at BETWEEN ? AND ? AND ${cs.sql} GROUP BY source ORDER BY leads DESC`, ctx.ws, from, to, ...cs.params);
    const byMonth = ctx.db.all(`SELECT substr(c.created_at,1,7) month, COUNT(*) leads FROM contacts c WHERE c.workspace_id=? AND c.deleted_at IS NULL AND c.created_at BETWEEN ? AND ? AND ${cs.sql} GROUP BY month ORDER BY month`, ctx.ws, from, to, ...cs.params);
    const response = ctx.db.get(`SELECT AVG((julianday(c.first_response_at)-julianday(c.created_at))*24) avg_hours, SUM(c.first_response_at IS NULL AND c.lead_status='new') uncontacted FROM contacts c WHERE c.workspace_id=? AND c.deleted_at IS NULL AND c.created_at BETWEEN ? AND ? AND ${cs.sql}`, ctx.ws, from, to, ...cs.params);
    const byStatus = ctx.db.all(`SELECT c.lead_status status, COUNT(*) n FROM contacts c WHERE c.workspace_id=? AND c.deleted_at IS NULL AND ${cs.sql} GROUP BY c.lead_status`, ctx.ws, ...cs.params);
    const forms = ctx.db.all(`SELECT f.name, f.submissions FROM forms f WHERE f.workspace_id=? ORDER BY f.submissions DESC`, ctx.ws);
    return { by_source: bySource, by_month: byMonth, response, by_status: byStatus, forms };
  }));

  r.get("/emails", h(async (req) => {
    const ctx = req.ctx; const { from, to } = range(req as never);
    const totals = ctx.db.get("SELECT COUNT(*) sent, SUM(opens>0) opened, SUM(clicks>0) clicked, SUM(status='failed') failed FROM emails WHERE workspace_id=? AND created_at BETWEEN ? AND ?", ctx.ws, from, to);
    const byUser = ctx.db.all("SELECT (SELECT name FROM users WHERE id=e.user_id) name, COUNT(*) sent, SUM(opens>0) opened, SUM(clicks>0) clicked FROM emails e WHERE workspace_id=? AND created_at BETWEEN ? AND ? GROUP BY user_id ORDER BY sent DESC", ctx.ws, from, to);
    const templates = ctx.db.all("SELECT t.name, COUNT(a.id) uses FROM email_templates t LEFT JOIN activities a ON a.type='email' AND json_extract(a.meta,'$.template_id')=t.id WHERE t.workspace_id=? GROUP BY t.id ORDER BY uses DESC", ctx.ws);
    return { totals, by_user: byUser, templates };
  }));

  r.get("/tickets", h(async (req) => {
    const ctx = req.ctx; assert(ctx, "ticket", "read"); const { from, to } = range(req as never);
    const totals = ctx.db.get("SELECT COUNT(*) total, SUM(status IN ('new','open','pending')) open, SUM(status IN ('resolved','closed')) resolved, AVG((julianday(first_response_at)-julianday(created_at))*24) avg_first_response_h, AVG((julianday(resolved_at)-julianday(created_at))*24) avg_resolution_h, AVG(csat) csat, SUM(first_response_at > sla_due_at OR (first_response_at IS NULL AND sla_due_at < datetime('now') AND status IN ('new','open'))) sla_breached FROM tickets WHERE workspace_id=? AND created_at BETWEEN ? AND ?", ctx.ws, from, to);
    const byStatus = ctx.db.all("SELECT status, COUNT(*) n FROM tickets WHERE workspace_id=? GROUP BY status", ctx.ws);
    const byAssignee = ctx.db.all("SELECT (SELECT name FROM users WHERE id=t.assignee_id) name, COUNT(*) n, SUM(status IN ('resolved','closed')) resolved FROM tickets t WHERE workspace_id=? AND created_at BETWEEN ? AND ? GROUP BY assignee_id ORDER BY n DESC", ctx.ws, from, to);
    const byCategory = ctx.db.all("SELECT COALESCE(category,'sin categoría') category, COUNT(*) n FROM tickets WHERE workspace_id=? AND created_at BETWEEN ? AND ? GROUP BY category ORDER BY n DESC", ctx.ws, from, to);
    return { totals, by_status: byStatus, by_assignee: byAssignee, by_category: byCategory };
  }));

  r.get("/data-quality", h(async (req) => {
    const ctx = req.ctx; const db = ctx.db; const ws = ctx.ws;
    const n = (q: string) => db.get<{ n: number }>(q, ws)?.n ?? 0;
    return {
      contacts_without_email: n("SELECT COUNT(*) n FROM contacts WHERE workspace_id=? AND deleted_at IS NULL AND email IS NULL"),
      contacts_without_owner: n("SELECT COUNT(*) n FROM contacts WHERE workspace_id=? AND deleted_at IS NULL AND owner_id IS NULL"),
      contacts_inactive_90d: n("SELECT COUNT(*) n FROM contacts WHERE workspace_id=? AND deleted_at IS NULL AND COALESCE(last_activity_at, created_at) < datetime('now','-90 days')"),
      companies_without_contacts: n("SELECT COUNT(*) n FROM companies c WHERE workspace_id=? AND deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM contacts x WHERE x.company_id=c.id AND x.deleted_at IS NULL)"),
      deals_without_close_date: n("SELECT COUNT(*) n FROM deals WHERE workspace_id=? AND deleted_at IS NULL AND status='open' AND expected_close_date IS NULL"),
      deals_without_contacts: n("SELECT COUNT(*) n FROM deals d WHERE workspace_id=? AND deleted_at IS NULL AND status='open' AND NOT EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.deal_id=d.id)"),
      probable_duplicates: n("SELECT COUNT(*) n FROM (SELECT email FROM contacts WHERE workspace_id=? AND deleted_at IS NULL AND email IS NOT NULL GROUP BY email HAVING COUNT(*)>1)"),
    };
  }));
  return r;
}
