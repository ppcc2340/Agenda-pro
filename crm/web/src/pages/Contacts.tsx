import { useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { Upload, Copy } from "lucide-react";
import { DataTable, type Column } from "../components/DataTable";
import { ContactForm } from "../components/RecordForms";
import { ScoreBar, useToast, useConfirm, Modal, Field } from "../components/ui";
import { api } from "../api";
import { useApp } from "../lib/app";
import { LIFECYCLE, SOURCES, relTime, fmtDate } from "../lib/format";
import { LIFECYCLE_OPTS, LEAD_STATUS_OPTS } from "../lib/colors";

interface C { id: string; first_name: string; last_name: string; email: string | null; phone: string | null; job_title: string | null; company_id: string | null; company_name: string | null; lifecycle_stage: string; lead_status: string; source: string | null; owner_id: string | null; owner_name: string | null; score: number; tags: string[]; last_activity_at: string | null; created_at: string; city: string | null; open_deals: number; custom: Record<string, unknown> }

export function ContactsPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(!!params.get("new"));
  const [refresh, setRefresh] = useState(0);
  const { users, customFields, can } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [bulk, setBulk] = useState<{ ids: string[]; clear: () => void } | null>(null);
  const [bulkOwner, setBulkOwner] = useState("");
  const [bulkStage, setBulkStage] = useState("");
  const [bulkTag, setBulkTag] = useState("");
  const patch = (c: C, body: Record<string, unknown>) => api.patch(`contacts/${c.id}`, body).then(() => undefined);
  const editable = can("contact", "update");
  const cols: Column<C>[] = [
    { key: "name", label: "Contacto", type: "name", value: (c) => `${c.first_name} ${c.last_name}`, sub: (c) => c.job_title, render: (c) => <Link to={`/contactos/${c.id}`} onClick={(e) => e.stopPropagation()}>{c.first_name} {c.last_name}</Link> },
    { key: "company_name", label: "Empresa", className: "l", render: (c) => c.company_id ? <Link to={`/empresas/${c.company_id}`} onClick={(e) => e.stopPropagation()}>{c.company_name}</Link> : <span className="muted">—</span> },
    { key: "lifecycle_stage", label: "Etapa", sortable: true, type: "status", options: LIFECYCLE_OPTS, onEdit: editable ? (c, v) => patch(c, { lifecycle_stage: v }) : undefined },
    { key: "lead_status", label: "Estado lead", sortable: true, type: "status", options: LEAD_STATUS_OPTS, onEdit: editable ? (c, v) => patch(c, { lead_status: v }) : undefined },
    { key: "owner_name", label: "Propietario", type: "person", onEdit: editable ? (c, v) => patch(c, { owner_id: v }) : undefined },
    { key: "email", label: "Email", sortable: true, className: "l", onEdit: editable ? (c, v) => patch(c, { email: v }) : undefined, render: (c) => c.email ? <a href={`mailto:${c.email}`} onClick={(e) => e.stopPropagation()}>{c.email}</a> : <span className="muted">—</span> },
    { key: "phone", label: "Teléfono", className: "l", onEdit: editable ? (c, v) => patch(c, { phone: v }) : undefined },
    { key: "score", label: "Score", sortable: true, type: "number", agg: "avg", width: 120, render: (c) => <ScoreBar value={c.score} /> },
    { key: "source", label: "Origen", sortable: true, className: "c", render: (c) => SOURCES[c.source ?? ""] ?? c.source ?? "", default: false },
    { key: "open_deals", label: "Negocios", type: "number", default: false },
    { key: "tags", label: "Etiquetas", type: "tags", default: false },
    { key: "city", label: "Ciudad", sortable: true, className: "l", default: false, onEdit: editable ? (c, v) => patch(c, { city: v }) : undefined },
    { key: "last_activity_at", label: "Última actividad", sortable: true, className: "c", render: (c) => <span className="muted" title={fmtDate(c.last_activity_at)}>{relTime(c.last_activity_at) || "nunca"}</span> },
    { key: "created_at", label: "Creado", sortable: true, type: "date", render: (c) => fmtDate(c.created_at), default: false },
    ...customFields.filter((f) => f.object === "contact").map<Column<C>>((f) => ({ key: `custom.${f.key}`, label: f.label, sortable: true, default: false, className: "l", render: (c) => String(c.custom?.[f.key] ?? "") })),
  ];
  const groupBy = { get: (c: C) => (["customer", "evangelist"].includes(c.lifecycle_stage) ? "customer" : c.lifecycle_stage === "lost" ? "lost" : ["sql", "opportunity"].includes(c.lifecycle_stage) ? "qualified" : "lead"), groups: [{ key: "lead", label: "Leads", color: "var(--c-blue)" }, { key: "qualified", label: "Cualificados", color: "var(--c-purple)" }, { key: "customer", label: "Clientes", color: "var(--c-green)" }, { key: "lost", label: "Perdidos", color: "var(--c-red)" }] };
  const runBulk = async (body: Record<string, unknown>) => { if (!bulk) return; const r = await api.post<{ affected: number }>("contacts/bulk", { ids: bulk.ids, ...body }); toast(`${r.affected} contactos actualizados`, "ok"); bulk.clear(); setBulk(null); };
  return (
    <div>
      <div className="page-head"><div><h1>Contactos</h1><p className="sub">Personas: leads, clientes y todo lo que sabes de ellas.</p></div><div className="row"><Link to="/contactos/duplicados" className="btn ghost"><Copy />Duplicados</Link><Link to="/ajustes/importar?object=contact" className="btn ghost"><Upload />Importar</Link></div></div>
      <DataTable<C> object="contact" endpoint="contacts" columns={cols} groupBy={groupBy} onRowClick={(c) => nav(`/contactos/${c.id}`)} exportUrl="contacts/export" refreshKey={refresh} emptyText="No hay contactos" onNew={can("contact", "create") ? () => setCreating(true) : undefined} newLabel="Nuevo contacto"
        onDelete={can("contact", "delete") ? async (ids) => { if (await confirm({ title: `¿Borrar ${ids.length === 1 ? "este contacto" : ids.length + " contactos"}?`, text: "Irán a la papelera 30 días.", danger: true, confirmText: "Borrar" })) { await api.post("contacts/bulk", { ids, action: "delete" }); toast("Borrado", "ok"); setRefresh((r) => r + 1); } } : undefined}
        bulkActions={(ids, clear) => (<>
          <button className="btn sm" onClick={() => setBulk({ ids, clear })}>Editar en masa</button>
          <button className="btn sm danger" onClick={async () => { if (await confirm({ title: `¿Borrar ${ids.length} contactos?`, text: "Irán a la papelera 30 días.", danger: true, confirmText: "Borrar" })) { await api.post("contacts/bulk", { ids, action: "delete" }); toast("Borrados", "ok"); clear(); } }}>Borrar</button>
        </>)} />
      {creating && <ContactForm onClose={() => { setCreating(false); const p = new URLSearchParams(params); p.delete("new"); setParams(p, { replace: true }); }} onSaved={(c) => nav(`/contactos/${c.id}`)} />}
      {bulk && (
        <Modal title={`Editar ${bulk.ids.length} contactos`} onClose={() => setBulk(null)}>
          <div className="col" style={{ gap: 14 }}>
            <Field label="Cambiar propietario"><div className="row"><select className="input" value={bulkOwner} onChange={(e) => setBulkOwner(e.target.value)}><option value="">—</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select><button className="btn" disabled={!bulkOwner} onClick={() => runBulk({ action: "update", patch: { owner_id: bulkOwner } })}>Aplicar</button></div></Field>
            <Field label="Cambiar etapa del ciclo de vida"><div className="row"><select className="input" value={bulkStage} onChange={(e) => setBulkStage(e.target.value)}><option value="">—</option>{Object.entries(LIFECYCLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><button className="btn" disabled={!bulkStage} onClick={() => runBulk({ action: "update", patch: { lifecycle_stage: bulkStage } })}>Aplicar</button></div></Field>
            <Field label="Añadir etiqueta"><div className="row"><input className="input" value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} /><button className="btn" disabled={!bulkTag} onClick={() => runBulk({ action: "add_tag", tag: bulkTag })}>Añadir</button></div></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function DuplicatesPage() {
  const [groups, setGroups] = useState<{ key: string; reason: string; contacts: { id: string; first_name: string; last_name: string; email: string | null; phone: string | null; updated_at: string }[] }[] | null>(null);
  const [merges, setMerges] = useState<{ id: string; survivor_name: string; created_at: string; user_name: string }[]>([]);
  const toast = useToast();
  const confirm = useConfirm();
  const load = () => { api.get<{ groups: typeof groups }>("contacts/duplicates").then((r) => setGroups(r.groups)); api.get<{ items: typeof merges }>("contacts/merges").then((r) => setMerges(r.items)); };
  useState(() => { load(); });
  const merge = async (survivorId: string, mergedId: string) => { if (!(await confirm({ title: "¿Fusionar contactos?", text: "Las actividades, negocios y tickets pasarán al contacto conservado. Se puede deshacer durante 30 días.", confirmText: "Fusionar" }))) return; await api.post("contacts/merge", { survivor_id: survivorId, merged_id: mergedId }); toast("Contactos fusionados", "ok"); load(); };
  return (
    <div>
      <div className="page-head"><div><h1>Duplicados probables</h1><p className="sub">Contactos con el mismo email, teléfono o nombre y empresa.</p></div><Link to="/contactos" className="btn">Volver a contactos</Link></div>
      {!groups ? null : groups.length === 0 ? <div className="card"><p className="muted">No se han detectado duplicados. 🎉</p></div> : groups.map((g) => (
        <div key={g.key + g.reason} className="card mb12">
          <div className="small muted mb8">Coinciden por <strong>{g.reason}</strong>: {g.key}</div>
          <table className="table"><thead><tr><th>Contacto</th><th>Email</th><th>Teléfono</th><th>Actualizado</th><th></th></tr></thead><tbody>
            {g.contacts.map((c, i) => <tr key={c.id}><td><Link to={`/contactos/${c.id}`}>{c.first_name} {c.last_name}</Link></td><td>{c.email}</td><td>{c.phone}</td><td>{fmtDate(c.updated_at)}</td><td className="r">{i > 0 && <button className="btn sm" onClick={() => merge(g.contacts[0]!.id, c.id)}>Fusionar en el primero</button>}{i === 0 && <span className="badge ok">se conserva</span>}</td></tr>)}
          </tbody></table>
        </div>
      ))}
      {merges.length > 0 && <div className="card mt16"><h2 className="mb8">Fusiones recientes (reversibles 30 días)</h2>{merges.map((m) => <div key={m.id} className="row" style={{ padding: "6px 0", borderBottom: "1px solid var(--rule2)" }}><span className="grow">{m.survivor_name} <span className="muted small">· {m.user_name} · {relTime(m.created_at)}</span></span><button className="btn sm" onClick={async () => { await api.post(`contacts/merges/${m.id}/undo`); toast("Fusión deshecha", "ok"); load(); }}>Deshacer</button></div>)}</div>}
    </div>
  );
}
