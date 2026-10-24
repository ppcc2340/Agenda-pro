import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, CalendarDays } from "lucide-react";
import { api } from "../api";
import { TaskRow, TaskForm, type Task } from "../components/Tasks";
import { Spinner } from "../components/ui";
import { fmtDateTime } from "../lib/format";

interface MyDay { overdue: Task[]; today: Task[]; upcoming: Task[]; no_date: Task[]; meetings: { id: string; subject: string; occurred_at: string; contact_name: string | null; company_name: string | null; contact_id: string | null; duration_min: number | null }[]; completed_today: number }

export function MyDayPage() {
  const [d, setD] = useState<MyDay | null>(null);
  const [editing, setEditing] = useState<Task | null | "new">(null);
  const load = () => api.get<MyDay>("tasks/my-day").then(setD).catch(() => undefined);
  useEffect(() => { load(); }, []);
  if (!d) return <Spinner />;
  const total = d.overdue.length + d.today.length;
  const Section = ({ title, items, tone }: { title: string; items: Task[]; tone?: string }) => (
    <div className="card mb16"><div className="card-title"><h2 style={tone ? { color: tone } : undefined}>{title}</h2><span className="badge">{items.length}</span></div>{items.length === 0 ? <p className="muted small">Nada por aquí.</p> : items.map((t) => <TaskRow key={t.id} task={t} onChanged={load} onEdit={(x) => setEditing(x)} />)}</div>
  );
  return (
    <div>
      <div className="page-head"><div><h1>Mi día</h1><p className="sub">{total === 0 ? "Todo al día. Cuando venza una tarea, aparecerá aquí." : `${total} tareas para hoy${d.overdue.length ? `, ${d.overdue.length} vencidas` : ""}`} · {d.completed_today} completadas hoy</p></div><button className="btn primary" onClick={() => setEditing("new")}><Plus />Nueva tarea</button></div>
      <div className="grid c2" style={{ alignItems: "start" }}>
        <div>
          {d.overdue.length > 0 && <Section title="Vencidas" items={d.overdue} tone="var(--risk)" />}
          <Section title="Hoy" items={d.today} />
          <Section title="Próximos 7 días" items={d.upcoming} />
          {d.no_date.length > 0 && <Section title="Sin fecha" items={d.no_date} />}
        </div>
        <div className="card"><div className="card-title"><h2>Agenda (7 días)</h2><CalendarDays size={16} className="muted" /></div>
          {d.meetings.length === 0 ? <p className="muted small">No tienes reuniones registradas. Regístralas desde la ficha del contacto (pestaña Reunión).</p> : d.meetings.map((m) => <div key={m.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--rule2)" }}><div className="bold">{m.subject}</div><div className="small muted">{fmtDateTime(m.occurred_at)}{m.duration_min ? ` · ${m.duration_min} min` : ""} {m.contact_id && <>· <Link to={`/contactos/${m.contact_id}`}>{m.contact_name}</Link></>}{m.company_name ? ` · ${m.company_name}` : ""}</div></div>)}
        </div>
      </div>
      {editing && <TaskForm task={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}
