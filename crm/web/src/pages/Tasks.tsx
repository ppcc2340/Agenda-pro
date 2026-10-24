import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { api, qs } from "../api";
import { TaskRow, TaskForm, type Task } from "../components/Tasks";
import { Seg, Spinner, Empty } from "../components/ui";
import { useApp } from "../lib/app";

export function TasksPage() {
  const { users, me, isAdmin } = useApp();
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<"open" | "overdue" | "done" | "all">("open");
  const [assignee, setAssignee] = useState(me.role.visibility === "own" ? me.id : "");
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ items: Task[]; total: number } | null>(null);
  const [editing, setEditing] = useState<Task | null | "new">(params.get("new") ? "new" : null);
  const load = () => api.get<{ items: Task[]; total: number }>(`tasks${qs({ status: status === "all" ? "" : status, assignee_id: assignee, q, page_size: 200 })}`).then(setData).catch(() => undefined);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [status, assignee, q]);
  useEffect(() => { const id = params.get("task"); if (id) api.get<Task>(`tasks/${id}`).then((t) => { setEditing(t); const p = new URLSearchParams(params); p.delete("task"); setParams(p, { replace: true }); }).catch(() => undefined); /* eslint-disable-next-line */ }, []);
  return (
    <div>
      <div className="page-head"><div><h1>Tareas</h1><p className="sub">Llamadas, emails, reuniones y seguimientos pendientes.</p></div><button className="btn primary" onClick={() => setEditing("new")}><Plus />Nueva tarea</button></div>
      <div className="filterbar">
        <Seg items={[{ key: "open", label: "Pendientes" }, { key: "overdue", label: "Vencidas" }, { key: "done", label: "Completadas" }, { key: "all", label: "Todas" }]} value={status} onChange={setStatus} />
        {(isAdmin || me.role.visibility !== "own") && <select className="input sm" style={{ width: "auto" }} value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">Todos</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
        <input className="input sm" style={{ maxWidth: 240 }} placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="card">{!data ? <Spinner /> : data.items.length === 0 ? <Empty title="No hay tareas" text="Crea una tarea o cambia el filtro." /> : data.items.map((t) => <TaskRow key={t.id} task={t} onChanged={load} onEdit={(x) => setEditing(x)} />)}</div>
      {editing && <TaskForm task={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}
