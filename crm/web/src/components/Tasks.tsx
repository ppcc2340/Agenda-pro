import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, RotateCcw } from "lucide-react";
import { api } from "../api";
import { Modal, Field, Picker, useToast, errorMessage } from "./ui";
import { useApp } from "../lib/app";
import { fmtDateTime, isOverdue, isToday, TASK_TYPES, PRIORITY, toLocalInput, fromLocalInput } from "../lib/format";

export interface Task { id: string; title: string; type: string; due_at: string | null; priority: string; assignee_id: string | null; assignee_name?: string | null; contact_id: string | null; contact_name?: string | null; company_id: string | null; company_name?: string | null; deal_id: string | null; deal_name?: string | null; ticket_id?: string | null; description: string | null; completed_at: string | null; outcome: string | null; recurrence: string | null; recurrence_interval?: number; recurrence_days?: number[] | string | null; duration_min?: number | null }

export function TaskForm({ task, defaults, onClose, onSaved }: { task?: Task | null; defaults?: Partial<Task>; onClose: () => void; onSaved: () => void }) {
  const { me, users } = useApp();
  const toast = useToast();
  const [days, setDays] = useState<number[]>(() => { const v = task?.recurrence_days; try { return Array.isArray(v) ? v : v ? JSON.parse(v) : []; } catch { return []; } });
  const [f, setF] = useState<Partial<Task>>({ title: "", type: "todo", priority: "normal", assignee_id: me.id, due_at: new Date(Date.now() + 86400000).toISOString(), ...defaults, ...(task ?? {}) });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Task, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    if (!f.title?.trim()) { toast("Indica el título", "error"); return; }
    setBusy(true);
    try {
      const payload = { title: f.title, type: f.type, due_at: f.due_at ?? null, priority: f.priority, assignee_id: f.assignee_id ?? null, contact_id: f.contact_id ?? null, company_id: f.company_id ?? null, deal_id: f.deal_id ?? null, ticket_id: f.ticket_id ?? null, description: f.description ?? null, recurrence: f.recurrence ?? null, recurrence_interval: f.recurrence ? Math.max(1, Number(f.recurrence_interval) || 1) : 1, recurrence_days: f.recurrence === "weekly" && days.length ? days : null, duration_min: f.duration_min ? Number(f.duration_min) : null };
      if (task) await api.put(`tasks/${task.id}`, payload); else await api.post("tasks", payload);
      toast(task ? "Tarea actualizada" : "Tarea creada", "ok"); onSaved(); onClose();
    } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  };
  return (
    <Modal title={task ? "Editar tarea" : "Nueva tarea"} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy} onClick={save}>{task ? "Guardar" : "Crear tarea"}</button></>}>
      <div className="form-grid">
        <Field label="Título" full><input className="input" autoFocus value={f.title ?? ""} onChange={(e) => set("title", e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} /></Field>
        <Field label="Tipo"><select className="input" value={f.type} onChange={(e) => set("type", e.target.value)}>{Object.entries(TASK_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Prioridad"><select className="input" value={f.priority} onChange={(e) => set("priority", e.target.value)}>{["low", "normal", "high"].map((k) => <option key={k} value={k}>{PRIORITY[k]}</option>)}</select></Field>
        <Field label="Vencimiento"><input className="input" type="datetime-local" value={toLocalInput(f.due_at)} onChange={(e) => set("due_at", fromLocalInput(e.target.value))} /></Field>
        <Field label="Asignada a"><select className="input" value={f.assignee_id ?? ""} onChange={(e) => set("assignee_id", e.target.value || null)}>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <Field label="Contacto"><Picker kind="contact" value={f.contact_id} onChange={(id) => set("contact_id", id)} /></Field>
        <Field label="Empresa"><Picker kind="company" value={f.company_id} onChange={(id) => set("company_id", id)} /></Field>
        <Field label="Negocio"><Picker kind="deal" value={f.deal_id} onChange={(id) => set("deal_id", id)} /></Field>
        <Field label="Duración"><select className="input" value={String(f.duration_min ?? "")} onChange={(e) => set("duration_min", e.target.value ? Number(e.target.value) : null)}><option value="">—</option>{[15, 30, 45, 60, 90, 120, 240].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>)}</select></Field>
        <Field label="Repetir"><div className="row" style={{ gap: 6 }}><select className="input" value={f.recurrence ?? ""} onChange={(e) => set("recurrence", e.target.value || null)}><option value="">No</option><option value="daily">Cada día</option><option value="weekdays">Días laborables (lun-vie)</option><option value="weekly">Cada semana</option><option value="monthly">Cada mes</option><option value="yearly">Cada año</option></select>{f.recurrence && <label className="row xs" style={{ gap: 4, whiteSpace: "nowrap" }}>cada<input className="input sm" type="number" min={1} max={365} style={{ width: 60 }} value={Number(f.recurrence_interval ?? 1)} onChange={(e) => set("recurrence_interval", Number(e.target.value))} />{({ daily: "días", weekdays: "días háb.", weekly: "semanas", monthly: "meses", yearly: "años" } as Record<string, string>)[f.recurrence]}</label>}</div></Field>
        {f.recurrence === "weekly" && <Field label="Los días" full><div className="row wrap" style={{ gap: 4 }}>{["L", "M", "X", "J", "V", "S", "D"].map((l, i) => { const wd = (i + 1) % 7; const on = days.includes(wd); return <button key={l} type="button" className={`btn sm ${on ? "primary" : ""}`} aria-pressed={on} onClick={() => setDays(on ? days.filter((x) => x !== wd) : [...days, wd])}>{l}</button>; })}<span className="xs muted">Vacío = el mismo día de la semana</span></div></Field>}
        <Field label="Descripción" full><textarea className="input" value={f.description ?? ""} onChange={(e) => set("description", e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

export function CompleteTaskDialog({ task, onClose, onDone }: { task: Task; onClose: () => void; onDone: () => void }) {
  const [outcome, setOutcome] = useState(task.type === "call" ? "Contactado" : "Hecho");
  const [note, setNote] = useState("");
  const toast = useToast();
  const go = async () => { try { await api.post(`tasks/${task.id}/complete`, { outcome, note: note || null }); toast("Tarea completada", "ok"); onDone(); onClose(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <Modal title={`Completar: ${task.title}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={go}><Check />Completar</button></>}>
      <div className="col">
        <Field label="Resultado"><select className="input" value={outcome} onChange={(e) => setOutcome(e.target.value)}>{(task.type === "call" ? ["Contactado", "Sin respuesta", "Buzón de voz", "Reunión agendada", "No interesado"] : task.type === "email" ? ["Enviado", "Respondido"] : task.type === "meeting" ? ["Realizada", "Cancelada", "Pospuesta"] : ["Hecho", "No procede"]).map((o) => <option key={o}>{o}</option>)}</select></Field>
        <Field label="Nota (se registra en la línea temporal)"><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} autoFocus /></Field>
      </div>
    </Modal>
  );
}

export function TaskRow({ task, onChanged, onEdit, showLinks = true }: { task: Task; onChanged: () => void; onEdit?: (t: Task) => void; showLinks?: boolean }) {
  const [completing, setCompleting] = useState(false);
  const toast = useToast();
  const done = !!task.completed_at;
  const reopen = async () => { await api.post(`tasks/${task.id}/reopen`); toast("Tarea reabierta", "ok"); onChanged(); };
  const over = !done && isOverdue(task.due_at);
  return (
    <div className="row" style={{ padding: "8px 0", borderBottom: "1px solid var(--rule2)", gap: 10, opacity: done ? 0.6 : 1 }}>
      <button className="iconbtn" style={{ width: 26, height: 26, border: `1.5px solid ${done ? "var(--ok)" : "var(--rule)"}`, borderRadius: "50%", background: done ? "var(--ok)" : "transparent", color: "#fff" }} title={done ? "Reabrir" : "Completar"} onClick={() => (done ? reopen() : setCompleting(true))}>{done ? <Check size={14} /> : <span />}</button>
      <div className="grow" style={{ minWidth: 0, cursor: onEdit ? "pointer" : "default" }} onClick={() => onEdit?.(task)}>
        <div className="row wrap" style={{ gap: 6 }}><span className={done ? "" : "bold"} style={{ textDecoration: done ? "line-through" : "none" }}>{task.title}</span><span className="badge">{TASK_TYPES[task.type]}</span>{task.priority === "high" && <span className="badge risk">Alta</span>}{task.recurrence && <span className="badge" title="Recurrente"><RotateCcw size={10} /></span>}</div>
        <div className="small muted row wrap" style={{ gap: 6 }}>
          {task.due_at && <span className={over ? "bold" : ""} style={over ? { color: "var(--risk-ink)" } : isToday(task.due_at) ? { color: "var(--sea-ink)", fontWeight: 600 } : undefined}>{fmtDateTime(task.due_at)}</span>}
          {task.assignee_name && <span>· {task.assignee_name}</span>}
          {showLinks && task.contact_id && <Link to={`/contactos/${task.contact_id}`} onClick={(e) => e.stopPropagation()}>· {task.contact_name}</Link>}
          {showLinks && task.deal_id && <Link to={`/negocios/${task.deal_id}`} onClick={(e) => e.stopPropagation()}>· {task.deal_name}</Link>}
          {showLinks && !task.contact_id && task.company_id && <Link to={`/empresas/${task.company_id}`} onClick={(e) => e.stopPropagation()}>· {task.company_name}</Link>}
          {done && task.outcome && <span className="badge ok">{task.outcome}</span>}
        </div>
      </div>
      {completing && <CompleteTaskDialog task={task} onClose={() => setCompleting(false)} onDone={onChanged} />}
    </div>
  );
}
