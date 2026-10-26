import { z } from "zod";
import type { Ctx } from "../context.js";
import type { Row } from "../db.js";
import { id, now, addDays } from "../lib/util.js";
import { notFound, forbidden } from "../lib/errors.js";
import { assert, canSeeRecord, ownerScope } from "../lib/permissions.js";
import { audit, diff } from "./audit.js";
import { emit } from "./events.js";
import { logActivity } from "./activities.js";
import { notify } from "./notifications.js";
import { nullableStr, validateCustom } from "./records.js";
import { parseJson } from "../db.js";

export const TASK_TYPES = ["call", "email", "meeting", "followup", "todo"] as const;
export const taskSchema = z.object({
  title: z.string().trim().min(1, "El título es obligatorio").max(300),
  type: z.enum(TASK_TYPES).optional(),
  due_at: z.string().nullable().optional(),
  priority: z.enum(["low", "normal", "high"]).optional(),
  assignee_id: z.string().nullable().optional(),
  contact_id: z.string().nullable().optional(),
  company_id: z.string().nullable().optional(),
  deal_id: z.string().nullable().optional(),
  ticket_id: z.string().nullable().optional(),
  description: nullableStr,
  recurrence: z.enum(["daily", "weekdays", "weekly", "monthly", "yearly"]).nullable().optional(),
  /** cada N días / semanas / meses / años */
  recurrence_interval: z.number().int().min(1).max(365).optional(),
  /** semanal: días concretos (0 = domingo … 6 = sábado) */
  recurrence_days: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
  duration_min: z.number().int().min(0).max(24 * 60).nullable().optional(),
  custom: z.record(z.string(), z.unknown()).optional(),
});
export type TaskInput = z.infer<typeof taskSchema>;

/**
 * Siguiente vencimiento de una tarea recurrente conservando la hora: diaria, días laborables (lun-vie),
 * semanal (cada N semanas o días concretos), mensual (mismo día; si no existe, el último del mes) y anual.
 */
export function nextOccurrence(dueAt: string, rule: string, interval = 1, days?: number[] | null): string {
  const d = new Date(dueAt.length === 10 ? `${dueAt}T09:00:00Z` : dueAt);
  const n = Math.max(1, interval);
  const out = new Date(d);
  switch (rule) {
    case "daily": out.setUTCDate(out.getUTCDate() + n); break;
    case "weekdays": { let left = n; while (left > 0) { out.setUTCDate(out.getUTCDate() + 1); const wd = out.getUTCDay(); if (wd !== 0 && wd !== 6) left--; } break; }
    case "weekly": {
      const set = (days ?? []).filter((x) => x >= 0 && x <= 6);
      if (set.length) {
        // siguiente día marcado; al pasar el domingo se salta (n-1) semanas
        for (let i = 1; i <= 7 * n + 7; i++) { const c = new Date(d); c.setUTCDate(d.getUTCDate() + i); const weeksAhead = Math.floor((d.getUTCDay() + i) / 7); if (set.includes(c.getUTCDay()) && (weeksAhead === 0 || weeksAhead % n === 0)) return keep(dueAt, c); }
      }
      out.setUTCDate(out.getUTCDate() + 7 * n); break;
    }
    case "monthly": case "yearly": {
      const months = rule === "monthly" ? n : 12 * n;
      const day = d.getUTCDate();
      out.setUTCDate(1); out.setUTCMonth(out.getUTCMonth() + months);
      const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
      out.setUTCDate(Math.min(day, last)); break;
    }
    default: out.setUTCDate(out.getUTCDate() + n);
  }
  return keep(dueAt, out);
}
const keep = (orig: string, d: Date) => (orig.length === 10 ? d.toISOString().slice(0, 10) : d.toISOString());

const SELECT = `t.*, (SELECT name FROM users WHERE id=t.assignee_id) assignee_name,
  (SELECT first_name||' '||last_name FROM contacts WHERE id=t.contact_id) contact_name,
  (SELECT name FROM companies WHERE id=t.company_id) company_name,
  (SELECT name FROM deals WHERE id=t.deal_id) deal_name`;

export function getTask(ctx: Ctx, tid: string): Row {
  const t = parseJson(ctx.db.get<Row>(`SELECT ${SELECT} FROM tasks t WHERE t.id=? AND t.workspace_id=?`, tid, ctx.ws), ["custom"]);
  if (!t) throw notFound("Tarea");
  if (!canSeeRecord(ctx, t.assignee_id as string | null)) throw forbidden("Esta tarea es de otro equipo");
  return t;
}

export function createTask(ctx: Ctx, input: TaskInput, opts: { silent?: boolean } = {}): Row {
  assert(ctx, "task", "create");
  const row = { custom: validateCustom(ctx, "task", input.custom ?? {}), id: id(), workspace_id: ctx.ws, title: input.title, type: input.type ?? "todo", due_at: input.due_at ?? null, priority: input.priority ?? "normal", assignee_id: input.assignee_id === undefined ? ctx.user.id : input.assignee_id, contact_id: input.contact_id ?? null, company_id: input.company_id ?? null, deal_id: input.deal_id ?? null, ticket_id: input.ticket_id ?? null, description: input.description ?? null, recurrence: input.recurrence ?? null, recurrence_interval: input.recurrence_interval ?? 1, recurrence_days: input.recurrence_days ?? null, duration_min: input.duration_min ?? null, created_by: ctx.user.id, created_at: now(), updated_at: now() };
  if (!row.company_id && row.contact_id) row.company_id = ctx.db.get<{ company_id: string | null }>("SELECT company_id FROM contacts WHERE id=?", row.contact_id)?.company_id ?? null;
  ctx.db.insert("tasks", row);
  refreshNextActivity(ctx, row.deal_id);
  audit(ctx, "task", row.id, "create", { title: row.title });
  if (!opts.silent && row.assignee_id && row.assignee_id !== ctx.user.id) notify(ctx.db, ctx.ws, row.assignee_id, { type: "task_assigned", title: `Nueva tarea: ${row.title}`, body: `Asignada por ${ctx.user.name}`, link: `/tareas?task=${row.id}` });
  const t = getTask(ctx, row.id);
  emit(ctx, { type: "task.created", object: "task", record: t });
  return t;
}

export function updateTask(ctx: Ctx, tid: string, patch: Partial<TaskInput>): Row {
  assert(ctx, "task", "update");
  const prev = getTask(ctx, tid);
  if (patch.custom) patch = { ...patch, custom: validateCustom(ctx, "task", patch.custom, (prev.custom as Record<string, unknown>) ?? {}, true) };
  const changes = diff(prev, patch as Record<string, unknown>);
  if (!Object.keys(changes).length) return prev;
  ctx.db.update("tasks", tid, { ...patch, updated_at: now(), overdue_notified_at: patch.due_at && patch.due_at !== prev.due_at ? null : undefined });
  refreshNextActivity(ctx, (patch.deal_id ?? prev.deal_id) as string | null);
  audit(ctx, "task", tid, "update", changes);
  if (changes.assignee_id && patch.assignee_id && patch.assignee_id !== ctx.user.id) notify(ctx.db, ctx.ws, patch.assignee_id, { type: "task_assigned", title: `Tarea asignada: ${prev.title}`, link: `/tareas?task=${tid}` });
  return getTask(ctx, tid);
}

export function completeTask(ctx: Ctx, tid: string, outcome?: string | null, note?: string | null): Row {
  assert(ctx, "task", "update");
  const t = getTask(ctx, tid);
  if (t.completed_at) return t;
  const at = now();
  ctx.db.update("tasks", tid, { completed_at: at, outcome: outcome ?? null, updated_at: at });
  if (t.contact_id || t.deal_id || t.company_id || t.ticket_id) {
    const typeMap: Record<string, string> = { call: "call", email: "email", meeting: "meeting", followup: "task", todo: "task" };
    logActivity(ctx, { type: typeMap[t.type as string] as "call", subject: t.title as string, body: note ?? null, outcome: outcome ?? null, direction: ["call", "email", "meeting"].includes(t.type as string) ? "outbound" : null, contact_id: t.contact_id as string | null, company_id: t.company_id as string | null, deal_id: t.deal_id as string | null, ticket_id: t.ticket_id as string | null, meta: { task_id: tid } });
  }
  if (t.recurrence && t.due_at) {
    let days: number[] | null = null; try { days = t.recurrence_days ? JSON.parse(String(t.recurrence_days)) : null; } catch { days = null; }
    const next = nextOccurrence(t.due_at as string, t.recurrence as string, Number(t.recurrence_interval) || 1, days);
    ctx.db.insert("tasks", { id: id(), workspace_id: ctx.ws, title: t.title, type: t.type, due_at: next, priority: t.priority, assignee_id: t.assignee_id, contact_id: t.contact_id, company_id: t.company_id, deal_id: t.deal_id, ticket_id: t.ticket_id, description: t.description, recurrence: t.recurrence, recurrence_interval: t.recurrence_interval ?? 1, recurrence_days: t.recurrence_days ?? null, duration_min: t.duration_min ?? null, created_by: ctx.user.id, created_at: at, updated_at: at });
  }
  refreshNextActivity(ctx, t.deal_id as string | null);
  audit(ctx, "task", tid, "update", { completed: true, outcome: outcome ?? null });
  const done = getTask(ctx, tid);
  emit(ctx, { type: "task.completed", object: "task", record: done });
  return done;
}

export function reopenTask(ctx: Ctx, tid: string): Row {
  assert(ctx, "task", "update");
  getTask(ctx, tid);
  ctx.db.update("tasks", tid, { completed_at: null, outcome: null, updated_at: now() });
  return getTask(ctx, tid);
}
export function deleteTask(ctx: Ctx, tid: string) {
  assert(ctx, "task", "delete");
  const t = getTask(ctx, tid);
  ctx.db.run("DELETE FROM tasks WHERE id=?", tid);
  refreshNextActivity(ctx, t.deal_id as string | null);
  audit(ctx, "task", tid, "delete", { title: t.title });
}

export function refreshNextActivity(ctx: Ctx, dealId: string | null | undefined) {
  if (!dealId) return;
  ctx.db.run("UPDATE deals SET next_activity_at=(SELECT MIN(due_at) FROM tasks WHERE deal_id=? AND completed_at IS NULL) WHERE id=?", dealId, dealId);
}

/** "Mi día": overdue, today, upcoming (7 days) and no-date tasks for the user. */
export function myDay(ctx: Ctx, userId: string) {
  const base = `SELECT ${SELECT} FROM tasks t WHERE t.workspace_id=? AND t.assignee_id=? AND t.completed_at IS NULL`;
  const today = now().slice(0, 10);
  return {
    overdue: ctx.db.all<Row>(`${base} AND date(t.due_at) < date(?) ORDER BY t.due_at`, ctx.ws, userId, today),
    today: ctx.db.all<Row>(`${base} AND date(t.due_at) = date(?) ORDER BY t.due_at`, ctx.ws, userId, today),
    upcoming: ctx.db.all<Row>(`${base} AND date(t.due_at) > date(?) AND date(t.due_at) <= date(?, '+7 days') ORDER BY t.due_at`, ctx.ws, userId, today, today),
    no_date: ctx.db.all<Row>(`${base} AND t.due_at IS NULL ORDER BY t.created_at DESC LIMIT 50`, ctx.ws, userId),
    meetings: ctx.db.all<Row>(`SELECT a.*, (SELECT first_name||' '||last_name FROM contacts WHERE id=a.contact_id) contact_name, (SELECT name FROM companies WHERE id=a.company_id) company_name FROM activities a WHERE a.workspace_id=? AND a.user_id=? AND a.type='meeting' AND a.occurred_at >= ? AND a.occurred_at <= datetime(?, '+7 days') ORDER BY a.occurred_at`, ctx.ws, userId, now(), now()),
    completed_today: ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM tasks WHERE workspace_id=? AND assignee_id=? AND date(completed_at)=date(?)", ctx.ws, userId, today)?.n ?? 0,
  };
}

export function listTasks(ctx: Ctx, q: { status?: string; assignee_id?: string; q?: string; deal_id?: string; contact_id?: string; company_id?: string; page?: number; page_size?: number }) {
  assert(ctx, "task", "read");
  const scope = ownerScope(ctx, "t.assignee_id");
  const where = ["t.workspace_id=?", scope.sql];
  const params: unknown[] = [ctx.ws, ...scope.params];
  if (q.status === "open") where.push("t.completed_at IS NULL");
  if (q.status === "done") where.push("t.completed_at IS NOT NULL");
  if (q.status === "overdue") { where.push("t.completed_at IS NULL AND t.due_at < ?"); params.push(now()); }
  if (q.assignee_id) { where.push("t.assignee_id=?"); params.push(q.assignee_id); }
  if (q.deal_id) { where.push("t.deal_id=?"); params.push(q.deal_id); }
  if (q.contact_id) { where.push("t.contact_id=?"); params.push(q.contact_id); }
  if (q.company_id) { where.push("t.company_id=?"); params.push(q.company_id); }
  if (q.q) { where.push("t.title LIKE ?"); params.push(`%${q.q}%`); }
  const page = q.page ?? 1, size = q.page_size ?? 100;
  const w = where.join(" AND ");
  const total = ctx.db.get<{ n: number }>(`SELECT COUNT(*) n FROM tasks t WHERE ${w}`, ...params)?.n ?? 0;
  const items = ctx.db.all<Row>(`SELECT ${SELECT} FROM tasks t WHERE ${w} ORDER BY t.completed_at IS NOT NULL, t.due_at IS NULL, t.due_at, t.created_at DESC LIMIT ? OFFSET ?`, ...params, size, (page - 1) * size);
  return { items, total, page, page_size: size };
}
