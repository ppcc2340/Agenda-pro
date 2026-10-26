import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { Plus, Trash2, Download } from "lucide-react";
import { api, qs } from "../api";
import { Modal, Field, Spinner, Empty, useToast, useConfirm, errorMessage, Pager, Picker } from "../components/ui";
import { FilterBuilder, describeFilters, type FilterGroup } from "../components/FilterBuilder";
import { fmtDate, LIFECYCLE, relTime } from "../lib/format";

interface L { id: string; object: string; name: string; kind: "static" | "dynamic"; filters: FilterGroup; members: number; created_at: string }

export function ListsPage() {
  const nav = useNavigate();
  const [items, setItems] = useState<L[] | null>(null);
  const [creating, setCreating] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();
  const load = () => api.get<{ items: L[] }>("lists").then((r) => setItems(r.items));
  useEffect(() => { load(); }, []);
  const del = async (l: L) => { if (!(await confirm({ title: `¿Borrar la lista «${l.name}»?`, danger: true, confirmText: "Borrar" }))) return; await api.del(`lists/${l.id}`); toast("Lista borrada", "ok"); load(); };
  return (
    <div>
      <div className="page-head"><div><h1>Listas y segmentos</h1><p className="sub">Listas estáticas (manuales) y dinámicas (se actualizan solas según reglas). Alimentan campañas, automatizaciones e informes.</p></div><button className="btn primary" onClick={() => setCreating(true)}><Plus />Nueva lista</button></div>
      {!items ? <Spinner /> : items.length === 0 ? <div className="card"><Empty title="Aún no hay listas" text="Crea un segmento dinámico (ej. leads MQL de Madrid) o una lista manual." action={<button className="btn primary" onClick={() => setCreating(true)}>Crear lista</button>} /></div> : (
        <div className="card tight"><table className="table"><thead><tr><th>Nombre</th><th>Tipo</th><th>Objeto</th><th>Criterio</th><th className="r">Miembros</th><th>Creada</th><th></th></tr></thead><tbody>
          {items.map((l) => <tr key={l.id} className="clickable" onClick={() => nav(`/listas/${l.id}`)}><td className="bold">{l.name}</td><td><span className={`badge ${l.kind === "dynamic" ? "sea" : ""}`}>{l.kind === "dynamic" ? "dinámica" : "estática"}</span></td><td>{l.object === "contact" ? "Contactos" : l.object === "company" ? "Empresas" : "Negocios"}</td><td className="small muted">{l.kind === "dynamic" ? describeFilters(l.filters) || "todos" : "manual"}</td><td className="r num">{l.kind === "static" ? l.members : "—"}</td><td>{fmtDate(l.created_at)}</td><td className="r"><button className="iconbtn" onClick={(e) => { e.stopPropagation(); del(l); }} aria-label="Borrar"><Trash2 size={15} /></button></td></tr>)}
        </tbody></table></div>
      )}
      {creating && <ListForm onClose={() => setCreating(false)} onSaved={(l) => nav(`/listas/${l.id}`)} />}
    </div>
  );
}

function ListForm({ onClose, onSaved, initial }: { onClose: () => void; onSaved: (l: L) => void; initial?: L }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<"static" | "dynamic">(initial?.kind ?? "dynamic");
  const [object, setObject] = useState(initial?.object ?? "contact");
  const [filters, setFilters] = useState<FilterGroup>(initial?.filters?.conditions ? initial.filters : { logic: "and", conditions: [] });
  const toast = useToast();
  const save = async () => { try { const l = initial ? await api.put<L>(`lists/${initial.id}`, { name, filters }) : await api.post<L>("lists", { name, kind, object, filters }); toast("Lista guardada", "ok"); onSaved(l); onClose(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <Modal title={initial ? "Editar lista" : "Nueva lista"} size="lg" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!name.trim()} onClick={save}>Guardar</button></>}>
      <div className="col" style={{ gap: 12 }}>
        <Field label="Nombre"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Leads calientes de Madrid" /></Field>
        {!initial && <div className="form-grid"><Field label="Tipo"><select className="input" value={kind} onChange={(e) => setKind(e.target.value as "static")}><option value="dynamic">Dinámica (reglas)</option><option value="static">Estática (manual)</option></select></Field><Field label="Objeto"><select className="input" value={object} onChange={(e) => setObject(e.target.value)}><option value="contact">Contactos</option><option value="company">Empresas</option><option value="deal">Negocios</option></select></Field></div>}
        {kind === "dynamic" && <Field label="Reglas"><FilterBuilder object={object} value={filters} onChange={setFilters} /></Field>}
      </div>
    </Modal>
  );
}

export function ListDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState<{ list: L; items: Record<string, unknown>[]; total: number; page: number; page_size: number } | null>(null);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const toast = useToast();
  const load = () => api.get<typeof data>(`lists/${id}/members${qs({ page, page_size: 50 })}`).then(setData).catch((e) => toast(errorMessage(e), "error"));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id, page]);
  if (!data) return <Spinner />;
  const l = data.list;
  const remove = async (rid: string) => { await api.del(`lists/${l.id}/members/${rid}`); load(); };
  const link = (r: Record<string, unknown>) => (l.object === "contact" ? `/contactos/${r.id}` : l.object === "company" ? `/empresas/${r.id}` : `/negocios/${r.id}`);
  const label = (r: Record<string, unknown>) => (l.object === "contact" ? `${r.first_name} ${r.last_name}` : String(r.name));
  const exportCsv = () => { const rows = data.items.map((r) => [label(r), r.email ?? "", r.phone ?? "", r.company_name ?? ""].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")); const csv = "nombre,email,telefono,empresa\n" + rows.join("\n"); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" })); a.download = `${l.name}.csv`; a.click(); };
  return (
    <div>
      <div className="row small muted mb8"><Link to="/listas">Listas</Link><span>/</span><span>{l.name}</span></div>
      <div className="page-head"><div><h1>{l.name}</h1><p className="sub"><span className={`badge ${l.kind === "dynamic" ? "sea" : ""}`}>{l.kind === "dynamic" ? "dinámica" : "estática"}</span> {l.kind === "dynamic" ? describeFilters(l.filters) : `${data.total} miembros`}</p></div><div className="row"><button className="btn" onClick={exportCsv}><Download />Exportar</button>{l.kind === "dynamic" ? <button className="btn" onClick={() => setEditing(true)}>Editar reglas</button> : <button className="btn primary" onClick={() => setAdding(true)}><Plus />Añadir</button>}</div></div>
      <div className="card tight"><table className="table"><thead><tr><th>Nombre</th>{l.object === "contact" && <><th>Email</th><th>Empresa</th><th>Etapa</th></>}{l.object === "company" && <><th>Dominio</th><th>Ciudad</th></>}{l.object === "deal" && <><th>Importe</th><th>Estado</th></>}<th>Actualizado</th>{l.kind === "static" && <th></th>}</tr></thead><tbody>
        {data.items.map((r) => <tr key={String(r.id)}><td><Link to={link(r)} className="bold">{label(r)}</Link></td>{l.object === "contact" && <><td>{String(r.email ?? "")}</td><td>{String(r.company_name ?? "")}</td><td><span className="badge">{LIFECYCLE[String(r.lifecycle_stage)]}</span></td></>}{l.object === "company" && <><td>{String(r.domain ?? "")}</td><td>{String(r.city ?? "")}</td></>}{l.object === "deal" && <><td className="num">{String(r.amount)}</td><td>{String(r.status)}</td></>}<td className="muted small">{relTime(String(r.updated_at))}</td>{l.kind === "static" && <td className="r"><button className="btn xs ghost" onClick={() => remove(String(r.id))}>Quitar</button></td>}</tr>)}
        {data.items.length === 0 && <tr><td colSpan={6}><Empty title="La lista está vacía" /></td></tr>}
      </tbody></table><Pager page={data.page} pageSize={data.page_size} total={data.total} onPage={setPage} /></div>
      {editing && <ListForm initial={l} onClose={() => setEditing(false)} onSaved={() => load()} />}
      {adding && <Modal title="Añadir a la lista" onClose={() => setAdding(false)}><Picker kind={l.object as "contact"} value={null} autoFocus onChange={async (rid) => { if (rid) { await api.post(`lists/${l.id}/members`, { ids: [rid] }); toast("Añadido", "ok"); load(); } }} /></Modal>}
    </div>
  );
}
