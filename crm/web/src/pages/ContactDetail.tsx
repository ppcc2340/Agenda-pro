import { ChannelList, type Channel } from "../components/ChannelList";
import { RecordAutomations } from "./AutomationCenter";
import { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Phone, Mail, StickyNote, CheckSquare, Pencil, Trash2, ArrowRightLeft, Shield, Download, MoreHorizontal, Building2, ExternalLink } from "lucide-react";
import { api, downloadFile } from "../api";
import { useApp } from "../lib/app";
import { Timeline, Composer } from "../components/Timeline";
import { TaskRow, TaskForm, type Task } from "../components/Tasks";
import { ContactForm } from "../components/RecordForms";
import { Modal, Field, Menu, Tabs, Spinner, ScoreBar, useToast, useConfirm, errorMessage, Avatar } from "../components/ui";
import { formatCustom } from "../components/CustomFields";
import { LIFECYCLE, LEAD_STATUS, SOURCES, fmtMoney, fmtDate, relTime, fmtDateTime, todayISO } from "../lib/format";

type Rec = Record<string, unknown>;
interface Contact extends Rec { id: string; first_name: string; last_name: string; email: string | null; phone: string | null; job_title: string | null; company_id: string | null; company_name: string | null; lifecycle_stage: string; lead_status: string; disqualify_reason: string | null; source: string | null; owner_id: string | null; owner_name: string | null; score: number; tags: string[]; custom: Rec; qualification: Rec; consent_marketing: number; consent_date: string | null; consent_source: string | null; do_not_contact: number; created_at: string; last_activity_at: string | null; last_contacted_at: string | null; city: string | null; country: string | null; linkedin: string | null; birthday: string | null; anonymized_at: string | null; utm: Rec; deals: { id: string; name: string; amount: number; currency: string; status: string; stage_name: string; stage_color: string; role: string }[]; tasks: Task[]; tickets: { id: string; number: number; subject: string; status: string }[]; lists: { id: string; name: string }[]; submissions: { id: string; created_at: string; form_name: string; data: string }[] }

const BANT = [["budget", "Presupuesto confirmado"], ["authority", "Habla con el decisor"], ["need", "Necesidad identificada"], ["timing", "Plazo definido"]] as const;

export function ContactDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { customFields, userName, can, users } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [c, setC] = useState<Contact | null>(null);
  const [tab, setTab] = useState("timeline");
  const [editing, setEditing] = useState(false);
  const [converting, setConverting] = useState(false);
  const [taskForm, setTaskForm] = useState<Task | "new" | null>(null);
  const [tl, setTl] = useState(0);
  const [history, setHistory] = useState<{ id: string; action: string; changes: Record<string, [unknown, unknown]>; user_name: string | null; created_at: string }[] | null>(null);
  const [composerTab, setComposerTab] = useState<string | undefined>(undefined);
  const load = useCallback(() => api.get<Contact>(`contacts/${id}`).then(setC).catch((e) => { toast(errorMessage(e), "error"); nav("/contactos"); }), [id, nav, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === "history") api.get<{ items: NonNullable<typeof history> }>(`contacts/${id}/history`).then((r) => setHistory(r.items)); }, [tab, id, tl]);
  const refreshAll = () => { load(); setTl((t) => t + 1); };
  if (!c) return <Spinner />;
  const patch = async (p: Rec) => { try { await api.patch(`contacts/${c.id}`, p); refreshAll(); } catch (e) { toast(errorMessage(e), "error"); } };
  const del = async () => { if (!(await confirm({ title: "¿Borrar este contacto?", text: "Irá a la papelera durante 30 días; después se elimina.", danger: true, confirmText: "Borrar" }))) return; await api.del(`contacts/${c.id}`); toast("Contacto borrado", "ok"); nav("/contactos"); };
  const anonymize = async () => { if (!(await confirm({ title: "¿Anonimizar datos personales (RGPD)?", text: "Se borran nombre, email, teléfono y contenido de comunicaciones. Las estadísticas se conservan. No se puede deshacer.", danger: true, confirmText: "Anonimizar" }))) return; await api.post(`contacts/${c.id}/anonymize`); toast("Datos anonimizados", "ok"); refreshAll(); };
  const quick = (t: string) => { setComposerTab(t); setTab("timeline"); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const name = `${c.first_name} ${c.last_name}`.trim();
  return (
    <div>
      <div className="row small muted mb8"><Link to="/contactos">Contactos</Link><span>/</span><span>{name}</span></div>
      <div className="record">
        <aside className="side">
          <div className="card">
            <div className="row" style={{ alignItems: "flex-start" }}>
              <Avatar name={name} size="lg" />
              <div className="grow" style={{ minWidth: 0 }}>
                <h1 style={{ fontSize: 18 }}>{name}</h1>
                {c.job_title && <div className="sub small">{c.job_title}</div>}
                {c.company_id && <div className="small row"><Building2 size={13} className="muted" /><Link to={`/empresas/${c.company_id}`}>{c.company_name}</Link></div>}
              </div>
              <Menu trigger={<button className="iconbtn"><MoreHorizontal size={18} /></button>}>
                <button onClick={() => setEditing(true)}><Pencil />Editar</button>
                <button onClick={() => setConverting(true)}><ArrowRightLeft />Convertir en oportunidad</button>
                <button onClick={() => downloadFile(`/api/contacts/${c.id}/gdpr-export`).then(() => toast("Datos exportados", "ok"))}><Download />Exportar datos (RGPD)</button>
                <button onClick={anonymize}><Shield />Anonimizar (RGPD)</button>
                <div className="sep" />
                {can("contact", "delete") && <button className="danger" onClick={del}><Trash2 />Borrar</button>}
              </Menu>
            </div>
            <div className="quick-actions mt12">
              <button onClick={() => quick("call")}><Phone />Llamar</button>
              <button onClick={() => quick("email")}><Mail />Email</button>
              <button onClick={() => quick("note")}><StickyNote />Nota</button>
              <button onClick={() => setTaskForm("new")}><CheckSquare />Tarea</button>
            </div>
            {c.do_not_contact ? <div className="alert error mt12 small">Ha pedido no ser contactado.</div> : null}
            {c.anonymized_at ? <div className="alert warn mt12 small">Datos anonimizados el {fmtDate(c.anonymized_at)}.</div> : null}
            <dl className="kv mt16">
              <dt>Email</dt><dd><ChannelList kind="email" items={c.emails as Channel[] | undefined} fallback={c.email} onSave={(list) => patch({ emails: list })} /></dd>
              <dt>Teléfono</dt><dd><ChannelList kind="phone" items={c.phones as Channel[] | undefined} fallback={c.phone} onSave={(list) => patch({ phones: list })} /></dd>
              <dt>Etapa</dt><dd><select className="input sm" value={c.lifecycle_stage} onChange={(e) => patch({ lifecycle_stage: e.target.value })}>{Object.entries(LIFECYCLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></dd>
              <dt>Estado lead</dt><dd><select className="input sm" value={c.lead_status} onChange={(e) => { if (e.target.value === "unqualified") { const r = prompt("Motivo de descalificación"); if (!r) return; patch({ lead_status: "unqualified", disqualify_reason: r }); } else patch({ lead_status: e.target.value }); }}>{Object.entries(LEAD_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>{c.disqualify_reason && c.lead_status === "unqualified" && <div className="xs muted">{c.disqualify_reason}</div>}</dd>
              <dt>Puntuación</dt><dd><ScoreBar value={c.score} /></dd>
              <dt>Propietario</dt><dd><select className="input sm" value={c.owner_id ?? ""} onChange={(e) => patch({ owner_id: e.target.value || null })}><option value="">Sin asignar</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></dd>
              <dt>Origen</dt><dd>{SOURCES[c.source ?? ""] ?? c.source ?? "—"}{Object.keys(c.utm ?? {}).length > 0 && <div className="xs muted">{Object.entries(c.utm).map(([k, v]) => `${k.replace("utm_", "")}: ${v}`).join(" · ")}</div>}</dd>
              {(c.city || c.country) && <><dt>Ubicación</dt><dd>{[c.city, c.country].filter(Boolean).join(", ")}</dd></>}
              {c.linkedin && <><dt>LinkedIn</dt><dd><a href={c.linkedin} target="_blank" rel="noreferrer">Perfil <ExternalLink size={11} /></a></dd></>}
              {c.birthday && <><dt>Cumpleaños</dt><dd>{fmtDate(c.birthday)}</dd></>}
              <dt>Etiquetas</dt><dd className="row wrap" style={{ gap: 3 }}>{c.tags.length ? c.tags.map((t) => <span key={t} className="tag">{t}</span>) : <span className="muted">—</span>}</dd>
              <dt>RGPD</dt><dd className="small">{c.consent_marketing ? <span className="badge ok">consentimiento</span> : <span className="badge">sin consentimiento</span>}{c.consent_date && <div className="xs muted">{fmtDate(c.consent_date)} · {c.consent_source}</div>}</dd>
              <dt>Creado</dt><dd className="small">{fmtDate(c.created_at)}</dd>
              <dt>Últ. actividad</dt><dd className="small">{c.last_activity_at ? relTime(c.last_activity_at) : "nunca"}</dd>
              {customFields.filter((f) => f.object === "contact").map((f) => <span key={f.id} style={{ display: "contents" }}><dt>{f.label}</dt><dd>{formatCustom(f, c.custom?.[f.key], (uid) => userName(uid)) || <span className="muted">—</span>}</dd></span>)}
            </dl>
            <button className="btn sm mt12" style={{ width: "100%" }} onClick={() => setEditing(true)}><Pencil />Editar todos los campos</button>
          </div>
          <div className="card">
            <div className="card-title"><h3>Cualificación (BANT)</h3></div>
            {BANT.map(([k, l]) => <label key={k} className="checkbox small" style={{ display: "flex", padding: "3px 0" }}><input type="checkbox" checked={!!c.qualification?.[k]} onChange={(e) => patch({ qualification: { ...c.qualification, [k]: e.target.checked } })} />{l}</label>)}
          </div>
        </aside>
        <section>
          <Composer link={{ contact_id: c.id }} contactEmail={c.email} onDone={refreshAll} initial={composerTab} key={composerTab} />
          <div className="mt16">
            <Tabs items={[{ key: "timeline", label: "Línea temporal" }, { key: "tasks", label: "Tareas", count: c.tasks.length }, { key: "forms", label: "Formularios", count: c.submissions.length }, { key: "history", label: "Historial de cambios" }, { key: "auto", label: "Automatizaciones" }]} value={tab} onChange={setTab} />
            {tab === "timeline" && <Timeline link={{ contact_id: c.id }} refreshKey={tl} onChanged={load} />}
            {tab === "tasks" && <div>{c.tasks.length === 0 ? <p className="muted">Sin tareas pendientes.</p> : c.tasks.map((t) => <TaskRow key={t.id} task={t} onChanged={refreshAll} onEdit={(x) => setTaskForm(x)} showLinks={false} />)}<button className="btn sm mt12" onClick={() => setTaskForm("new")}>+ Nueva tarea</button></div>}
            {tab === "forms" && <div>{c.submissions.length === 0 ? <p className="muted">No ha enviado ningún formulario.</p> : c.submissions.map((s) => <div key={s.id} className="card mb8"><div className="row between"><strong>{s.form_name}</strong><span className="muted small">{fmtDateTime(s.created_at)}</span></div><pre className="mt8 small">{(() => { try { return Object.entries(JSON.parse(s.data) as Rec).map(([k, v]) => `${k}: ${v}`).join("\n"); } catch { return s.data; } })()}</pre></div>)}</div>}
            {tab === "history" && <HistoryList items={history} />}
            {tab === "auto" && <RecordAutomations object="contact" id={id!} />}
          </div>
        </section>
        <aside className="side r">
          <div className="card">
            <div className="card-title"><h3>Negocios</h3><button className="btn xs" onClick={() => setConverting(true)}>+ Negocio</button></div>
            {c.deals.length === 0 ? <p className="muted small">Sin negocios asociados.</p> : c.deals.map((d) => <div key={d.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--rule2)" }}><Link to={`/negocios/${d.id}`} className="bold ell" style={{ display: "block" }}>{d.name}</Link><div className="xs row"><span className="badge dot" style={{ color: d.stage_color }}>{d.status === "open" ? d.stage_name : d.status === "won" ? "Ganado" : "Perdido"}</span><span className="num muted">{fmtMoney(d.amount, d.currency)}</span></div></div>)}
          </div>
          {c.tickets.length > 0 && <div className="card"><div className="card-title"><h3>Tickets</h3></div>{c.tickets.map((t) => <div key={t.id} className="small" style={{ padding: "4px 0" }}><Link to={`/tickets/${t.id}`}>#{t.number} {t.subject}</Link> <span className="badge">{t.status}</span></div>)}</div>}
          {c.lists.length > 0 && <div className="card"><div className="card-title"><h3>Listas</h3></div><div className="row wrap">{c.lists.map((l) => <Link key={l.id} to={`/listas/${l.id}`} className="tag">{l.name}</Link>)}</div></div>}
        </aside>
      </div>
      {editing && <ContactForm initial={c} onClose={() => setEditing(false)} onSaved={refreshAll} />}
      {converting && <ConvertDialog contact={c} onClose={() => setConverting(false)} onDone={(dealId) => { setConverting(false); if (dealId) nav(`/negocios/${dealId}`); else refreshAll(); }} />}
      {taskForm && <TaskForm task={taskForm === "new" ? null : taskForm} defaults={{ contact_id: c.id, company_id: c.company_id }} onClose={() => setTaskForm(null)} onSaved={refreshAll} />}
    </div>
  );
}

function ConvertDialog({ contact, onClose, onDone }: { contact: Contact; onClose: () => void; onDone: (dealId?: string) => void }) {
  const { pipelines } = useApp();
  const toast = useToast();
  const [companyName, setCompanyName] = useState(contact.company_name ?? "");
  const [createDeal, setCreateDeal] = useState(true);
  const [name, setName] = useState(`${contact.company_name ?? `${contact.first_name} ${contact.last_name}`} · Nuevo negocio`);
  const [pipeline, setPipeline] = useState(pipelines.find((p) => p.is_default)?.id ?? pipelines[0]?.id ?? "");
  const [amount, setAmount] = useState("");
  const [close, setClose] = useState("");
  const go = async () => {
    try {
      const r = await api.post<{ deal: { id: string } | null }>(`contacts/${contact.id}/convert`, { company: contact.company_id ? { id: contact.company_id } : companyName ? { name: companyName } : undefined, deal: createDeal ? { name, pipeline_id: pipeline, amount: Number(amount) || 0, expected_close_date: close || null } : undefined });
      toast("Contacto convertido en oportunidad", "ok"); onDone(r.deal?.id);
    } catch (e) { toast(errorMessage(e), "error"); }
  };
  return (
    <Modal title="Convertir en oportunidad" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={go}>Convertir</button></>}>
      <p className="sub small mb12">El contacto pasa a etapa «Oportunidad». Se vincula (o crea) la empresa y, si quieres, se abre un negocio en el pipeline con todo el historial.</p>
      <div className="col" style={{ gap: 12 }}>
        <Field label="Empresa">{contact.company_id ? <input className="input" disabled value={contact.company_name ?? ""} /> : <input className="input" value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Nombre de la empresa (se crea si no existe)" />}</Field>
        <label className="checkbox"><input type="checkbox" checked={createDeal} onChange={(e) => setCreateDeal(e.target.checked)} />Crear un negocio</label>
        {createDeal && <>
          <Field label="Nombre del negocio"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="form-grid">
            <Field label="Pipeline"><select className="input" value={pipeline} onChange={(e) => setPipeline(e.target.value)}>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
            <Field label="Importe"><input className="input" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
            <Field label="Cierre previsto"><input className="input" type="date" min={todayISO()} value={close} onChange={(e) => setClose(e.target.value)} /></Field>
          </div>
        </>}
      </div>
    </Modal>
  );
}

export function HistoryList({ items }: { items: { id: string; action: string; changes: Record<string, unknown>; user_name: string | null; created_at: string }[] | null }) {
  if (!items) return <Spinner />;
  if (!items.length) return <p className="muted">Sin cambios registrados.</p>;
  const ACTION: Record<string, string> = { create: "Creado", update: "Actualizado", delete: "Borrado", restore: "Restaurado", merge: "Fusionado", anonymize: "Anonimizado", export: "Exportado", stage_change: "Cambio de etapa" };
  return (
    <div className="timeline">{items.map((h) => (
      <div key={h.id} className="tl-item"><div className="tl-icon system"><Pencil size={13} /></div><div className="tl-body">
        <div className="tl-head"><strong>{ACTION[h.action] ?? h.action}</strong><span className="muted small">{h.user_name ?? "sistema"} · {fmtDateTime(h.created_at)}</span></div>
        <div className="small sub">{Object.entries(h.changes).map(([k, v]) => <div key={k}><span className="muted">{k}:</span> {Array.isArray(v) ? <><s className="muted">{fmtVal(v[0])}</s> → <strong>{fmtVal(v[1])}</strong></> : fmtVal(v)}</div>)}</div>
      </div></div>
    ))}</div>
  );
}
function fmtVal(v: unknown): string { if (v === null || v === undefined || v === "") return "vacío"; if (typeof v === "object") return JSON.stringify(v); return String(v); }
