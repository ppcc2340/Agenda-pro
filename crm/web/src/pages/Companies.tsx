import { PicklistSelect, picklistPatch } from "../components/PicklistSelect";
import { RecordAutomations } from "./AutomationCenter";
import { useState, useEffect, useCallback, Fragment } from "react";
import { useNavigate, useParams, Link, useSearchParams } from "react-router-dom";
import { Plus, Upload, Pencil, Trash2, MoreHorizontal, Globe, Phone, MapPin, Building2, StickyNote, CheckSquare, Handshake, Users } from "lucide-react";
import { DataTable, type Column, type GroupOption } from "../components/DataTable";
import { useBoard, customColumns } from "../lib/board";
import { CompanyForm, ContactForm, DealForm } from "../components/RecordForms";
import { Timeline, Composer } from "../components/Timeline";
import { TaskRow, TaskForm, type Task } from "../components/Tasks";
import { Menu, Tabs, Spinner, useToast, useConfirm, errorMessage } from "../components/ui";
import { HistoryList } from "./ContactDetail";
import { formatCustom } from "../components/CustomFields";
import { api } from "../api";
import { useApp } from "../lib/app";
import { COMPANY_TYPES, LIFECYCLE, fmtMoney, fmtNum, fmtDate, relTime } from "../lib/format";
import { COMPANY_TYPE_OPTS } from "../lib/colors";

type Rec = Record<string, unknown>;
interface Co { id: string; name: string; domain: string | null; sector: string | null; size: number | null; city: string | null; country: string | null; type: string; owner_id: string | null; owner_name: string | null; contacts_count: number; open_deals: number; tags: string[]; last_activity_at: string | null; created_at: string; custom: Rec; revenue: number | null }

export function CompaniesPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [creating, setCreating] = useState(!!params.get("new"));
  const { customFields, can, users, userName } = useApp();
  const board = useBoard("company");
  const toast = useToast();
  const confirm = useConfirm();
  const patch = (c: Co, body: Record<string, unknown>) => api.patch(`companies/${c.id}`, body).then(() => undefined);
  const editable = can("company", "update");
  const cols: Column<Co>[] = [
    { key: "name", label: "Empresa", type: "name", field: editable ? "name" : undefined, sub: (c) => c.domain, render: (c) => <Link to={`/empresas/${c.id}`} onClick={(e) => e.stopPropagation()}>{c.name}</Link> },
    { key: "type", label: "Tipo", sortable: true, type: "status", fixedOptions: true, field: "type", options: COMPANY_TYPE_OPTS, onEdit: editable ? (c, v) => patch(c, { type: v }) : undefined },
    { key: "owner_name", label: "Propietario", type: "person", field: "owner_id", onEdit: editable ? (c, v) => patch(c, { owner_id: v }) : undefined },
    { key: "sector", label: "Sector", sortable: true, className: "l", field: "sector", onEdit: editable ? (c, v) => patch(c, { sector: v }) : undefined },
    { key: "size", label: "Empleados", sortable: true, type: "number", field: "size", onEdit: editable ? (c, v) => patch(c, { size: v }) : undefined },
    { key: "revenue", label: "Facturación", sortable: true, type: "money", default: false, field: "revenue", onEdit: editable ? (c, v) => patch(c, { revenue: v }) : undefined },
    { key: "city", label: "Ciudad", sortable: true, className: "l", field: "city", onEdit: editable ? (c, v) => patch(c, { city: v }) : undefined },
    { key: "country", label: "País", sortable: true, className: "l", default: false, field: editable ? "country" : undefined },
    { key: "contacts_count", label: "Contactos", type: "number" },
    { key: "open_deals", label: "Negocios abiertos", type: "number" },
    { key: "tags", label: "Etiquetas", type: "tags", default: false, field: editable ? "tags" : undefined },
    { key: "last_activity_at", label: "Última actividad", sortable: true, className: "c", render: (c) => <span className="muted">{relTime(c.last_activity_at) || "nunca"}</span> },
    { key: "created_at", label: "Creada", sortable: true, type: "date", default: false, render: (c) => fmtDate(c.created_at) },
    ...customColumns<Co>(customFields, "company", board, editable ? (c, k, v) => patch(c, { custom: { [k]: v } }) : undefined, userName),
  ];
  const groupOptions: GroupOption<Co>[] = [
    { key: "type", label: "Tipo", get: (c) => c.type, groups: Object.entries(COMPANY_TYPE_OPTS).map(([key, o]) => ({ key, label: o.label + "s", color: o.color })), setValue: (c, g) => patch(c, { type: g }), createValue: (g) => ({ type: g }) },
    { key: "owner_id", label: "Propietario", get: (c) => c.owner_id ?? "", groups: users.filter((u) => u.active).map((u) => ({ key: u.id, label: u.name, color: "var(--c-purple)" })), other: "Sin propietario", setValue: (c, g) => patch(c, { owner_id: g }), createValue: (g) => ({ owner_id: g }) },
    ...customFields.filter((f) => f.object === "company" && f.type === "select").map<GroupOption<Co>>((f) => ({ key: `custom.${f.key}`, label: f.label, get: (c) => String(c.custom?.[f.key] ?? ""), groups: Object.entries(cols.find((c) => c.key === `custom.${f.key}`)?.options ?? {}).map(([key, o]) => ({ key, label: o.label, color: o.color })), other: "Sin valor", setValue: (c, g) => patch(c, { custom: { [f.key]: g } }), createValue: (g) => ({ custom: { [f.key]: g } }) })),
  ];
  const create = async (name: string, extra: Record<string, unknown>) => { return api.post("companies", { name, force: true, ...extra }); };
  const duplicate = async (c: Co) => { await api.post("companies", { name: `${c.name} (copia)`, sector: c.sector, size: c.size, city: c.city, country: c.country, type: c.type, owner_id: c.owner_id, tags: c.tags, custom: c.custom, revenue: c.revenue, force: true }); };
  return (
    <div>
      <div className="page-head"><div><h1>Empresas</h1><p className="sub">Cuentas: prospectos, clientes, partners y proveedores.</p></div><div className="row"><Link to="/ajustes/importar?object=company" className="btn ghost"><Upload />Importar</Link></div></div>
      <DataTable<Co> object="company" endpoint="companies" columns={cols} board={board} groupOptions={groupOptions} onCreate={editable ? create : undefined} onDuplicate={can("company", "create") ? duplicate : undefined} onRowClick={(c) => nav(`/empresas/${c.id}`)} exportUrl="companies/export" emptyText="No hay empresas" onNew={can("company", "create") ? () => setCreating(true) : undefined} newLabel="Nueva empresa"
        onDelete={can("company", "delete") ? async (ids) => { if (await confirm({ title: `¿Borrar ${ids.length === 1 ? "esta empresa" : ids.length + " empresas"}?`, danger: true, confirmText: "Borrar" })) { await api.post("companies/bulk", { ids, action: "delete" }); toast("Borrado", "ok"); nav("/empresas", { replace: true }); } } : undefined}
        bulkActions={(ids, clear) => <button className="btn sm danger" onClick={async () => { if (await confirm({ title: `¿Borrar ${ids.length} empresas?`, danger: true, confirmText: "Borrar" })) { await api.post("companies/bulk", { ids, action: "delete" }); toast("Borradas", "ok"); clear(); } }}>Borrar</button>} />
      {creating && <CompanyForm onClose={() => setCreating(false)} onSaved={(c) => nav(`/empresas/${c.id}`)} />}
    </div>
  );
}

interface CompanyFull extends Rec { id: string; name: string; domain: string | null; website: string | null; sector: string | null; size: number | null; revenue: number | null; tax_id: string | null; address: string | null; city: string | null; country: string | null; phone: string | null; parent_id: string | null; parent_name: string | null; owner_id: string | null; owner_name: string | null; type: string; tags: string[]; custom: Rec; created_at: string; last_activity_at: string | null; contacts: { id: string; first_name: string; last_name: string; email: string | null; phone: string | null; job_title: string | null; lifecycle_stage: string }[]; deals: { id: string; name: string; amount: number; currency: string; status: string; stage_name: string; stage_color: string; owner_name: string | null; expected_close_date: string | null }[]; tasks: Task[]; tickets: { id: string; number: number; subject: string; status: string }[]; children: { id: string; name: string; type: string }[]; stats: { won_amount: number; won_count: number; open_amount: number } }

export function CompanyDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { customFields, userName, users, can } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [c, setC] = useState<CompanyFull | null>(null);
  const [tab, setTab] = useState("timeline");
  const [editing, setEditing] = useState(false);
  const [newContact, setNewContact] = useState(false);
  const [newDeal, setNewDeal] = useState(false);
  const [taskForm, setTaskForm] = useState<Task | "new" | null>(null);
  const [tl, setTl] = useState(0);
  const [history, setHistory] = useState<Parameters<typeof HistoryList>[0]["items"]>(null);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const load = useCallback(() => api.get<CompanyFull>(`companies/${id}`).then(setC).catch((e) => { toast(errorMessage(e), "error"); nav("/empresas"); }), [id, nav, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === "history") api.get<{ items: NonNullable<typeof history> }>(`companies/${id}/history`).then((r) => setHistory(r.items)); if (tab === "tree") api.get<TreeNode>(`companies/${id}/tree`).then(setTree); }, [tab, id, tl]);
  if (!c) return <Spinner />;
  const refreshAll = () => { load(); setTl((t) => t + 1); };
  const patch = async (p: Rec) => { try { await api.patch(`companies/${c.id}`, p); refreshAll(); } catch (e) { toast(errorMessage(e), "error"); } };
  const del = async () => { if (!(await confirm({ title: "¿Borrar esta empresa?", text: "Los contactos y negocios se conservan. Papelera 30 días.", danger: true, confirmText: "Borrar" }))) return; await api.del(`companies/${c.id}`); toast("Empresa borrada", "ok"); nav("/empresas"); };
  return (
    <div>
      <div className="row small muted mb8"><Link to="/empresas">Empresas</Link><span>/</span><span>{c.name}</span></div>
      <div className="record">
        <aside className="side">
          <div className="card">
            <div className="row" style={{ alignItems: "flex-start" }}>
              <span className="avatar lg" style={{ borderRadius: 10, background: "var(--info)" }}><Building2 size={22} /></span>
              <div className="grow" style={{ minWidth: 0 }}><h1 style={{ fontSize: 18 }}>{c.name}</h1><div className="row wrap mt8" style={{ gap: 4 }}><span className={`badge ${c.type === "customer" ? "ok" : ""}`}>{COMPANY_TYPES[c.type]}</span>{c.sector && <span className="badge">{c.sector}</span>}</div></div>
              <Menu trigger={<button className="iconbtn" aria-label="Más acciones"><MoreHorizontal size={18} /></button>}><button onClick={() => setEditing(true)}><Pencil />Editar</button><div className="sep" />{can("company", "delete") && <button className="danger" onClick={del}><Trash2 />Borrar</button>}</Menu>
            </div>
            <div className="quick-actions mt12">
              <button onClick={() => setNewContact(true)}><Users />Contacto</button>
              <button onClick={() => setNewDeal(true)}><Handshake />Negocio</button>
              <button onClick={() => { setTab("timeline"); window.scrollTo({ top: 0 }); }}><StickyNote />Nota</button>
              <button onClick={() => setTaskForm("new")}><CheckSquare />Tarea</button>
            </div>
            <dl className="kv mt16">
              {c.domain && <><dt><Globe size={13} /></dt><dd><a href={`https://${c.domain}`} target="_blank" rel="noreferrer">{c.domain}</a></dd></>}
              {c.phone && <><dt><Phone size={13} /></dt><dd><a href={`tel:${c.phone}`}>{c.phone}</a></dd></>}
              {(c.address || c.city) && <><dt><MapPin size={13} /></dt><dd>{[c.address, c.city, c.country].filter(Boolean).join(", ")}</dd></>}
              <dt>Tipo</dt><dd><PicklistSelect pkey="company.type" label="Tipo" value={c.type} custom={c.custom as Record<string, unknown>} onChange={(role, lbl) => patch(picklistPatch("type", role, lbl))} /></dd>
              <dt>Propietario</dt><dd><select aria-label="Propietario" className="input sm" value={c.owner_id ?? ""} onChange={(e) => patch({ owner_id: e.target.value || null })}><option value="">Sin asignar</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></dd>
              {c.size != null && <><dt>Empleados</dt><dd>{fmtNum(c.size)}</dd></>}
              {c.revenue != null && <><dt>Facturación</dt><dd>{fmtMoney(c.revenue)}</dd></>}
              {c.tax_id && <><dt>CIF</dt><dd>{c.tax_id}</dd></>}
              {c.parent_id && <><dt>Matriz</dt><dd><Link to={`/empresas/${c.parent_id}`}>{c.parent_name}</Link></dd></>}
              <dt>Etiquetas</dt><dd className="row wrap" style={{ gap: 3 }}>{c.tags.length ? c.tags.map((t) => <span key={t} className="tag">{t}</span>) : <span className="muted">—</span>}</dd>
              <dt>Creada</dt><dd className="small">{fmtDate(c.created_at)}</dd>
              {customFields.filter((f) => f.object === "company").map((f) => <Fragment key={f.id}><dt>{f.label}</dt><dd>{formatCustom(f, c.custom?.[f.key], (uid) => userName(uid)) || <span className="muted">—</span>}</dd></Fragment>)}
            </dl>
            <button className="btn sm mt12" style={{ width: "100%" }} onClick={() => setEditing(true)}><Pencil />Editar todos los campos</button>
          </div>
          <div className="card"><div className="card-title"><h3>Resumen comercial</h3></div><dl className="kv"><dt>Ganado</dt><dd className="num">{fmtMoney(c.stats.won_amount)} <span className="muted">({c.stats.won_count})</span></dd><dt>Abierto</dt><dd className="num">{fmtMoney(c.stats.open_amount)}</dd></dl></div>
        </aside>
        <section>
          <Composer link={{ company_id: c.id }} onDone={refreshAll} />
          <div className="mt16">
            <Tabs items={[{ key: "timeline", label: "Línea temporal" }, { key: "contacts", label: "Contactos", count: c.contacts.length }, { key: "deals", label: "Negocios", count: c.deals.length }, { key: "tasks", label: "Tareas", count: c.tasks.length }, ...(c.parent_id || c.children.length ? [{ key: "tree", label: "Grupo" }] : []), { key: "history", label: "Historial" }, { key: "auto", label: "Automatizaciones" }]} value={tab} onChange={setTab} />
            {tab === "timeline" && <Timeline link={{ company_id: c.id }} refreshKey={tl} onChanged={load} />}
            {tab === "contacts" && <div className="card tight"><table className="table"><thead><tr><th>Nombre</th><th>Cargo</th><th>Email</th><th>Teléfono</th><th>Etapa</th></tr></thead><tbody>{c.contacts.map((p) => <tr key={p.id} className="clickable" onClick={() => nav(`/contactos/${p.id}`)}><td className="bold">{p.first_name} {p.last_name}</td><td>{p.job_title}</td><td>{p.email}</td><td>{p.phone}</td><td><span className="badge">{LIFECYCLE[p.lifecycle_stage]}</span></td></tr>)}{c.contacts.length === 0 && <tr><td colSpan={5} className="muted">Sin contactos. <button className="btn xs" onClick={() => setNewContact(true)}>Añadir</button></td></tr>}</tbody></table></div>}
            {tab === "deals" && <div className="card tight"><table className="table"><thead><tr><th>Negocio</th><th>Etapa</th><th className="r">Importe</th><th>Cierre</th><th>Propietario</th></tr></thead><tbody>{c.deals.map((d) => <tr key={d.id} className="clickable" onClick={() => nav(`/negocios/${d.id}`)}><td className="bold">{d.name}</td><td><span className="badge dot" style={{ color: d.stage_color }}>{d.status === "open" ? d.stage_name : d.status === "won" ? "Ganado" : "Perdido"}</span></td><td className="r num">{fmtMoney(d.amount, d.currency)}</td><td>{fmtDate(d.expected_close_date)}</td><td>{d.owner_name}</td></tr>)}{c.deals.length === 0 && <tr><td colSpan={5} className="muted">Sin negocios. <button className="btn xs" onClick={() => setNewDeal(true)}>Crear</button></td></tr>}</tbody></table></div>}
            {tab === "tasks" && <div>{c.tasks.length === 0 ? <p className="muted">Sin tareas pendientes.</p> : c.tasks.map((t) => <TaskRow key={t.id} task={t} onChanged={refreshAll} onEdit={(x) => setTaskForm(x)} />)}<button className="btn sm mt12" onClick={() => setTaskForm("new")}>+ Nueva tarea</button></div>}
            {tab === "tree" && (tree ? <div className="card"><Tree node={tree} current={c.id} /></div> : <Spinner />)}
            {tab === "history" && <HistoryList items={history} />}
            {tab === "auto" && <RecordAutomations object="company" id={id!} />}
          </div>
        </section>
        <aside className="side r">
          <div className="card"><div className="card-title"><h3>Contactos clave</h3><button className="btn xs" onClick={() => setNewContact(true)}>+</button></div>{c.contacts.slice(0, 6).map((p) => <div key={p.id} className="small" style={{ padding: "5px 0", borderBottom: "1px solid var(--rule2)" }}><Link to={`/contactos/${p.id}`} className="bold">{p.first_name} {p.last_name}</Link><div className="xs muted">{p.job_title ?? p.email}</div></div>)}{c.contacts.length === 0 && <p className="muted small">Ninguno todavía.</p>}</div>
          <div className="card"><div className="card-title"><h3>Negocios abiertos</h3><button className="btn xs" onClick={() => setNewDeal(true)}>+</button></div>{c.deals.filter((d) => d.status === "open").map((d) => <div key={d.id} style={{ padding: "5px 0", borderBottom: "1px solid var(--rule2)" }}><Link to={`/negocios/${d.id}`} className="bold ell small" style={{ display: "block" }}>{d.name}</Link><div className="xs row"><span className="badge dot" style={{ color: d.stage_color }}>{d.stage_name}</span><span className="num muted">{fmtMoney(d.amount, d.currency)}</span></div></div>)}{c.deals.filter((d) => d.status === "open").length === 0 && <p className="muted small">Ninguno abierto.</p>}</div>
          <CompanyContracts companyId={c.id} />
          {c.tickets.length > 0 && <div className="card"><div className="card-title"><h3>Tickets</h3></div>{c.tickets.slice(0, 5).map((t) => <div key={t.id} className="small" style={{ padding: "4px 0" }}><Link to={`/tickets/${t.id}`}>#{t.number} {t.subject}</Link></div>)}</div>}
        </aside>
      </div>
      {editing && <CompanyForm initial={c} onClose={() => setEditing(false)} onSaved={refreshAll} />}
      {newContact && <ContactForm initial={{ company_id: c.id, owner_id: c.owner_id }} onClose={() => setNewContact(false)} onSaved={refreshAll} />}
      {newDeal && <DealForm defaults={{ company_id: c.id, owner_id: c.owner_id, name: `${c.name} · ` }} onClose={() => setNewDeal(false)} onSaved={(d) => nav(`/negocios/${d.id}`)} />}
      {taskForm && <TaskForm task={taskForm === "new" ? null : taskForm} defaults={{ company_id: c.id }} onClose={() => setTaskForm(null)} onSaved={refreshAll} />}
    </div>
  );
}
type TreeNode = { id: string; name: string; type: string; open_deals: number; open_amount: number; children: TreeNode[] };
function Tree({ node, current, depth = 0 }: { node: TreeNode; current: string; depth?: number }) {
  return (<div style={{ marginLeft: depth * 18 }}><div className="row" style={{ padding: "4px 0" }}><Building2 size={14} className="muted" /><Link to={`/empresas/${node.id}`} className={node.id === current ? "bold" : ""}>{node.name}</Link><span className="badge">{COMPANY_TYPES[node.type]}</span><span className="muted small num">{node.open_deals} negocios · {fmtMoney(node.open_amount)}</span></div>{node.children.map((ch) => <Tree key={ch.id} node={ch} current={current} depth={depth + 1} />)}</div>);
}

function CompanyContracts({ companyId }: { companyId: string }) {
  const [items, setItems] = useState<{ id: string; number: string; title: string; status: string; annual_value: number; currency: string; end_date: string | null; risk_level: string }[]>([]);
  useEffect(() => { api.get<{ items: typeof items }>(`clm/contracts?counterparty=${companyId}&page_size=20`).then((r) => setItems(r.items)).catch(() => undefined); }, [companyId]);
  const LABEL: Record<string, string> = { DRAFT: "Borrador", INTERNAL_REVIEW: "Revisión", NEGOTIATION: "Negociación", PENDING_APPROVAL: "Aprobación", APPROVED: "Aprobado", OUT_FOR_SIGNATURE: "En firma", PARTIALLY_SIGNED: "Firma parcial", ACTIVE: "Activo", EXPIRED: "Vencido", TERMINATED: "Terminado", RENEWED: "Renovado", CANCELLED: "Cancelado", REJECTED: "Rechazado", ON_HOLD: "En pausa", ARCHIVED: "Archivado" };
  const active = items.filter((x) => x.status === "ACTIVE");
  return (
    <div className="card"><div className="card-title"><h3>Contratos</h3><Link to={`/contratos?new=1&company=${companyId}`} className="btn xs">+</Link></div>
      {items.length === 0 ? <p className="muted small">Sin contratos.</p> : <>
        <div className="small sub mb8">{active.length} activos · exposición {fmtMoney(active.reduce((a, x) => a + Number(x.annual_value), 0))} /año</div>
        {items.slice(0, 6).map((x) => <div key={x.id} className="small" style={{ padding: "5px 0", borderBottom: "1px solid var(--rule2)" }}><Link to={`/contratos/${x.id}`}>{x.title}</Link><div className="xs muted">{x.number} · {LABEL[x.status] ?? x.status}{x.end_date ? ` · hasta ${fmtDate(x.end_date)}` : ""} · {fmtMoney(x.annual_value, x.currency)}</div></div>)}
      </>}
    </div>
  );
}
