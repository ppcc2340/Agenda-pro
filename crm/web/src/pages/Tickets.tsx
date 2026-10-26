import { useEffect, useState, useCallback } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { Send } from "lucide-react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { DataTable, type Column, type GroupOption } from "../components/DataTable";
import { useBoard, customColumns } from "../lib/board";
import { Timeline } from "../components/Timeline";
import { TaskRow, TaskForm, type Task } from "../components/Tasks";
import { Modal, Field, Picker, Spinner, useToast, errorMessage, Tabs } from "../components/ui";
import { TICKET_STATUS, PRIORITY, fmtDateTime, relTime, isOverdue, fmtDate } from "../lib/format";
import { TICKET_STATUS_OPTS, PRIORITY_OPTS } from "../lib/colors";

interface T { id: string; number: number; subject: string; status: string; priority: string; category: string | null; channel: string; assignee_id: string | null; assignee_name: string | null; custom?: Record<string, unknown>; tags?: string[]; contact_name: string | null; company_name: string | null; sla_due_at: string | null; first_response_at: string | null; created_at: string; csat: number | null }

export function TicketsPage() {
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const { can, users, customFields, userName } = useApp();
  const board = useBoard("ticket");
  const patch = (t: T, body: Record<string, unknown>) => api.put(`tickets/${t.id}`, body).then(() => undefined);
  const editable = can("ticket", "update");
  const cols: Column<T>[] = [
    { key: "subject", label: "Ticket", type: "name", field: editable ? "subject" : undefined, sub: (t) => <span className="num">#{t.number}{t.contact_name ? ` · ${t.contact_name}` : ""}</span>, render: (t) => <Link to={`/tickets/${t.id}`} onClick={(e) => e.stopPropagation()}>{t.subject}</Link> },
    { key: "status", label: "Estado", sortable: true, type: "status", fixedOptions: true, field: "status", options: TICKET_STATUS_OPTS, onEdit: editable ? (t, v) => patch(t, { status: v }) : undefined },
    { key: "priority", label: "Prioridad", sortable: true, type: "status", fixedOptions: true, field: "priority", options: PRIORITY_OPTS, onEdit: editable ? (t, v) => patch(t, { priority: v }) : undefined },
    { key: "assignee_name", label: "Asignado", type: "person", field: "assignee_id", onEdit: editable ? (t, v) => patch(t, { assignee_id: v }) : undefined },
    { key: "sla_due_at", label: "SLA", sortable: true, className: "c", render: (t) => (["resolved", "closed"].includes(t.status) || t.first_response_at ? <span className="muted">{t.first_response_at ? "respondido" : "—"}</span> : <span><i className={`ddot ${isOverdue(t.sla_due_at) ? "late" : "soon"}`} />{relTime(t.sla_due_at)}</span>) },
    { key: "company_name", label: "Empresa", className: "l", default: false, type: "relation", field: editable ? "company_id" : undefined, relation: { endpoint: "companies", labelOf: (r) => String(r.name ?? "") } },
    { key: "category", label: "Categoría", sortable: true, className: "l", field: "category", onEdit: editable ? (t, v) => patch(t, { category: v }) : undefined },
    { key: "channel", label: "Canal", className: "c", default: false },
    { key: "created_at", label: "Creado", sortable: true, type: "date", render: (t) => fmtDate(t.created_at) },
    ...customColumns<T & { custom?: Record<string, unknown> }>(customFields, "ticket", board, editable ? (t, k, v) => patch(t, { custom: { [k]: v } }) : undefined, userName),
  ];
  const groupOptions: GroupOption<T>[] = [
    { key: "status", label: "Estado", get: (t) => t.status, groups: Object.entries(TICKET_STATUS_OPTS).map(([key, o]) => ({ key, label: o.label, color: o.color })), setValue: (t, g) => patch(t, { status: g }), createValue: (g) => ({ status: g }) },
    { key: "priority", label: "Prioridad", get: (t) => t.priority, groups: Object.entries(PRIORITY_OPTS).map(([key, o]) => ({ key, label: o.label, color: o.color })), setValue: (t, g) => patch(t, { priority: g }), createValue: (g) => ({ priority: g }) },
    { key: "assignee_id", label: "Asignado", get: (t) => t.assignee_id ?? "", groups: users.filter((u) => u.active).map((u) => ({ key: u.id, label: u.name, color: "var(--c-red)" })), other: "Sin asignar", setValue: (t, g) => patch(t, { assignee_id: g }), createValue: (g) => ({ assignee_id: g }) },
    ...customFields.filter((f) => f.object === "ticket" && f.type === "select").map<GroupOption<T>>((f) => ({ key: `custom.${f.key}`, label: f.label, get: (t) => String(t.custom?.[f.key] ?? ""), groups: Object.entries(cols.find((c) => c.key === `custom.${f.key}`)?.options ?? {}).map(([key, o]) => ({ key, label: o.label, color: o.color })), other: "Sin valor", setValue: (t, g) => patch(t, { custom: { [f.key]: g } }), createValue: (g) => ({ custom: { [f.key]: g } }) })),
  ];
  const create = async (subject: string, extra: Record<string, unknown>) => { return api.post("tickets", { subject, ...extra }); };
  const duplicate = async (t: T) => { await api.post("tickets", { subject: `${t.subject} (copia)`, priority: t.priority, category: t.category, channel: t.channel, assignee_id: t.assignee_id, custom: t.custom }); };
  return (
    <div>
      <div className="page-head"><div><h1>Tickets</h1><p className="sub">Soporte y atención al cliente con SLA por prioridad.</p></div></div>
      <DataTable<T> object="ticket" endpoint="tickets" columns={cols} board={board} groupOptions={groupOptions} onCreate={editable ? create : undefined} onDuplicate={can("ticket", "create") ? duplicate : undefined} onRowClick={(t) => nav(`/tickets/${t.id}`)} refreshKey={refresh} emptyText="No hay tickets" defaultSort={{ field: "created_at", dir: "desc" }} onNew={can("ticket", "create") ? () => setCreating(true) : undefined} newLabel="Nuevo ticket" />
      {creating && <TicketForm onClose={() => setCreating(false)} onSaved={(t) => { setRefresh((r) => r + 1); nav(`/tickets/${t.id}`); }} />}
    </div>
  );
}

function TicketForm({ onClose, onSaved, initial }: { onClose: () => void; onSaved: (t: { id: string }) => void; initial?: Partial<Record<string, unknown>> }) {
  const { users, me } = useApp();
  const toast = useToast();
  const [f, setF] = useState<Record<string, unknown>>({ subject: "", description: "", contact_id: null, company_id: null, priority: "normal", category: "", channel: "manual", assignee_id: me.id, ...(initial ?? {}) });
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => { try { const t = await api.post<{ id: string }>("tickets", { ...f, category: f.category || null, description: f.description || null }); toast("Ticket creado", "ok"); onSaved(t); onClose(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <Modal title="Nuevo ticket" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Crear ticket</button></>}>
      <div className="form-grid">
        <Field label="Asunto *" full><input className="input" autoFocus value={String(f.subject)} onChange={(e) => set("subject", e.target.value)} /></Field>
        <Field label="Contacto"><Picker kind="contact" value={f.contact_id as string | null} onChange={(id) => set("contact_id", id)} /></Field>
        <Field label="Empresa"><Picker kind="company" value={f.company_id as string | null} onChange={(id) => set("company_id", id)} /></Field>
        <Field label="Prioridad"><select className="input" value={String(f.priority)} onChange={(e) => set("priority", e.target.value)}>{["low", "normal", "high", "urgent"].map((k) => <option key={k} value={k}>{PRIORITY[k]}</option>)}</select></Field>
        <Field label="Canal"><select className="input" value={String(f.channel)} onChange={(e) => set("channel", e.target.value)}>{["manual", "email", "phone", "form", "chat"].map((k) => <option key={k} value={k}>{k}</option>)}</select></Field>
        <Field label="Categoría"><input className="input" value={String(f.category ?? "")} onChange={(e) => set("category", e.target.value)} placeholder="Técnico, Facturación…" /></Field>
        <Field label="Asignado a"><select className="input" value={String(f.assignee_id ?? "")} onChange={(e) => set("assignee_id", e.target.value || null)}><option value="">Sin asignar</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <Field label="Descripción" full><textarea className="input" value={String(f.description ?? "")} onChange={(e) => set("description", e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

interface TicketFull extends T { description: string | null; contact_id: string | null; contact_email: string | null; company_id: string | null; assignee_id: string | null; resolved_at: string | null; tasks: Task[]; tags: string[] }

export function TicketDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { users } = useApp();
  const toast = useToast();
  const [t, setT] = useState<TicketFull | null>(null);
  const [reply, setReply] = useState("");
  const [internal, setInternal] = useState(false);
  const [tl, setTl] = useState(0);
  const [tab, setTab] = useState("timeline");
  const [taskForm, setTaskForm] = useState<Task | "new" | null>(null);
  const load = useCallback(() => api.get<TicketFull>(`tickets/${id}`).then(setT).catch((e) => { toast(errorMessage(e), "error"); nav("/tickets"); }), [id, nav, toast]);
  useEffect(() => { load(); }, [load]);
  if (!t) return <Spinner />;
  const refreshAll = () => { load(); setTl((x) => x + 1); };
  const patch = async (p: Record<string, unknown>) => { try { await api.put(`tickets/${t.id}`, p); refreshAll(); } catch (e) { toast(errorMessage(e), "error"); } };
  const send = async () => { if (!reply.trim()) return; try { await api.post(`tickets/${t.id}/reply`, { body: reply, internal }); toast(internal ? "Nota interna añadida" : "Respuesta enviada", "ok"); setReply(""); refreshAll(); } catch (e) { toast(errorMessage(e), "error"); } };
  const slaBreached = !t.first_response_at && !["resolved", "closed"].includes(t.status) && isOverdue(t.sla_due_at);
  return (
    <div>
      <div className="row small muted mb8"><Link to="/tickets">Tickets</Link><span>/</span><span>#{t.number}</span></div>
      <div className="record" style={{ gridTemplateColumns: "minmax(0,1fr) 320px" }}>
        <section>
          <div className="card mb16">
            <div className="row wrap"><h1>#{t.number} {t.subject}</h1><span className={`badge ${t.priority === "urgent" ? "risk" : t.priority === "high" ? "warn" : ""}`}>{PRIORITY[t.priority]}</span>{slaBreached && <span className="badge risk">SLA incumplido</span>}</div>
            {t.description && <p className="sub mt8" style={{ whiteSpace: "pre-wrap" }}>{t.description}</p>}
            <div className="composer mt16">
              <div className="ctabs"><button className={!internal ? "active" : ""} onClick={() => setInternal(false)}>Responder al cliente</button><button className={internal ? "active" : ""} onClick={() => setInternal(true)}>Nota interna</button></div>
              <div className="cbody"><textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder={internal ? "Nota visible solo para el equipo" : t.contact_email ? `Se enviará por email a ${t.contact_email}` : "El contacto no tiene email: se registrará como respuesta"} /><div className="row"><span className="muted xs">{internal ? "Interna" : "Pública"}</span><button className="btn primary sm right" onClick={send}><Send />{internal ? "Añadir nota" : "Enviar respuesta"}</button></div></div>
            </div>
          </div>
          <Tabs items={[{ key: "timeline", label: "Conversación" }, { key: "tasks", label: "Tareas", count: t.tasks.length }]} value={tab} onChange={setTab} />
          {tab === "timeline" && <Timeline link={{ ticket_id: t.id }} refreshKey={tl} />}
          {tab === "tasks" && <div>{t.tasks.map((x) => <TaskRow key={x.id} task={x} onChanged={refreshAll} onEdit={(y) => setTaskForm(y)} />)}<button className="btn sm mt12" onClick={() => setTaskForm("new")}>+ Nueva tarea</button></div>}
        </section>
        <aside className="side r">
          <div className="card"><dl className="kv">
            <dt>Estado</dt><dd><select className="input sm" value={t.status} onChange={(e) => patch({ status: e.target.value })}>{Object.entries(TICKET_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></dd>
            <dt>Prioridad</dt><dd><select className="input sm" value={t.priority} onChange={(e) => patch({ priority: e.target.value })}>{["low", "normal", "high", "urgent"].map((k) => <option key={k} value={k}>{PRIORITY[k]}</option>)}</select></dd>
            <dt>Asignado</dt><dd><select className="input sm" value={t.assignee_id ?? ""} onChange={(e) => patch({ assignee_id: e.target.value || null })}><option value="">Sin asignar</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></dd>
            <dt>Categoría</dt><dd><input className="input sm" defaultValue={t.category ?? ""} key={t.category} onBlur={(e) => e.target.value !== (t.category ?? "") && patch({ category: e.target.value })} /></dd>
            <dt>Contacto</dt><dd>{t.contact_id ? <Link to={`/contactos/${t.contact_id}`}>{t.contact_name}</Link> : "—"}</dd>
            <dt>Empresa</dt><dd>{t.company_id ? <Link to={`/empresas/${t.company_id}`}>{t.company_name}</Link> : "—"}</dd>
            <dt>Canal</dt><dd>{t.channel}</dd>
            <dt>Creado</dt><dd className="small">{fmtDateTime(t.created_at)}</dd>
            <dt>SLA 1ª resp.</dt><dd className="small" style={slaBreached ? { color: "var(--risk)" } : undefined}>{t.first_response_at ? `respondido ${relTime(t.first_response_at)}` : fmtDateTime(t.sla_due_at)}</dd>
            {t.resolved_at && <><dt>Resuelto</dt><dd className="small">{fmtDateTime(t.resolved_at)}</dd></>}
            <dt>CSAT</dt><dd><select className="input sm" value={t.csat ?? ""} onChange={(e) => patch({ csat: e.target.value ? Number(e.target.value) : null })}><option value="">—</option>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{"★".repeat(n)}</option>)}</select></dd>
          </dl></div>
        </aside>
      </div>
      {taskForm && <TaskForm task={taskForm === "new" ? null : taskForm} defaults={{ ticket_id: t.id, contact_id: t.contact_id, company_id: t.company_id }} onClose={() => setTaskForm(null)} onSaved={refreshAll} />}
    </div>
  );
}
