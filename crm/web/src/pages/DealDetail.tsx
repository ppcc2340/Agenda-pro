import { RecordAutomations } from "./AutomationCenter";
import { useEffect, useState, useCallback, Fragment } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Pencil, Trash2, MoreHorizontal, Trophy, XCircle, RotateCcw, Plus, FileText, Send, ExternalLink, Users, CheckSquare, FileDown } from "lucide-react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { Timeline, Composer } from "../components/Timeline";
import { TaskRow, TaskForm, type Task } from "../components/Tasks";
import { DealForm } from "../components/RecordForms";
import { Modal, Field, Menu, Tabs, Spinner, Picker, useToast, useConfirm, errorMessage } from "../components/ui";
import { HistoryList } from "./ContactDetail";
import { formatCustom } from "../components/CustomFields";
import { fmtMoney, fmtMoney2, fmtDate, fmtDateTime, relTime, LOSS_REASONS, ROLE_LABEL, QUOTE_STATUS, todayISO } from "../lib/format";
import { inkOn } from "../lib/colors";

type Rec = Record<string, unknown>;
interface Deal extends Rec { id: string; name: string; company_id: string | null; company_name: string | null; pipeline_id: string; pipeline_name: string; stage_id: string; stage_name: string; stage_color: string; stage_expected_days: number; status: string; amount: number; currency: string; probability: number; weighted_amount: number; expected_close_date: string | null; closed_at: string | null; loss_reason: string | null; competitor: string | null; owner_id: string | null; owner_name: string | null; source: string | null; tags: string[]; custom: Rec; days_in_stage: number; created_at: string; last_activity_at: string | null; next_activity_at: string | null; contacts: { id: string; first_name: string; last_name: string; email: string | null; phone: string | null; job_title: string | null; role: string }[]; products: Line[]; stage_history: { id: string; stage_name: string; user_name: string | null; entered_at: string; left_at: string | null }[]; tasks: Task[]; quotes: { id: string; number: string; version: number; status: string; total: number; date: string; valid_until: string | null; views: number; token: string }[] }
interface Line { id?: string; product_id: string | null; name: string; quantity: number; unit_price: number; discount: number; billing_period: string; total?: number }

export function DealDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { pipelines, users, customFields, userName, can } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [d, setD] = useState<Deal | null>(null);
  const [tab, setTab] = useState("timeline");
  const [editing, setEditing] = useState(false);
  const [closing, setClosing] = useState<"won" | "lost" | null>(null);
  const [taskForm, setTaskForm] = useState<Task | "new" | null>(null);
  const [products, setProducts] = useState(false);
  const [quote, setQuote] = useState(false);
  const [sendQuote, setSendQuote] = useState<Deal["quotes"][0] | null>(null);
  const [addContact, setAddContact] = useState(false);
  const [tl, setTl] = useState(0);
  const [history, setHistory] = useState<Parameters<typeof HistoryList>[0]["items"]>(null);
  const load = useCallback(() => api.get<Deal>(`deals/${id}`).then(setD).catch((e) => { toast(errorMessage(e), "error"); nav("/negocios"); }), [id, nav, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (tab === "history") api.get<{ items: NonNullable<typeof history> }>(`deals/${id}/history`).then((r) => setHistory(r.items)); }, [tab, id, tl]);
  if (!d) return <Spinner />;
  const refreshAll = () => { load(); setTl((t) => t + 1); };
  const pipe = pipelines.find((p) => p.id === d.pipeline_id);
  const openStages = pipe?.stages.filter((s) => s.kind === "open") ?? [];
  const curIdx = openStages.findIndex((s) => s.id === d.stage_id);
  const moveTo = async (stageId: string) => { try { await api.post(`deals/${d.id}/stage`, { stage_id: stageId }); toast("Etapa actualizada", "ok"); refreshAll(); } catch (e) { toast(errorMessage(e), "error"); } };
  const patch = async (p: Rec) => { try { await api.patch(`deals/${d.id}`, p); refreshAll(); } catch (e) { toast(errorMessage(e), "error"); } };
  const del = async () => { if (!(await confirm({ title: "¿Borrar este negocio?", text: "Irá a la papelera 30 días.", danger: true, confirmText: "Borrar" }))) return; await api.del(`deals/${d.id}`); toast("Negocio borrado", "ok"); nav("/negocios"); };
  const reopen = async () => { await api.post(`deals/${d.id}/reopen`); toast("Negocio reabierto", "ok"); refreshAll(); };
  const setRole = async (cid: string, role: string) => patch({ contacts: d.contacts.map((c) => ({ contact_id: c.id, role: c.id === cid ? role : c.role })) });
  const removeContact = async (cid: string) => patch({ contacts: d.contacts.filter((c) => c.id !== cid).map((c) => ({ contact_id: c.id, role: c.role })) });
  const stale = d.status === "open" && d.days_in_stage > d.stage_expected_days;
  return (
    <div>
      <div className="row small muted mb8"><Link to="/negocios">Negocios</Link><span>/</span><span>{d.name}</span></div>
      <div className="card mb16">
        <div className="row wrap between" style={{ alignItems: "flex-start" }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row wrap"><h1>{d.name}</h1>{d.status === "won" && <span className="badge ok">Ganado {fmtDate(d.closed_at)}</span>}{d.status === "lost" && <span className="badge risk">Perdido · {LOSS_REASONS[d.loss_reason ?? ""] ?? d.loss_reason}{d.competitor ? ` (${d.competitor})` : ""}</span>}{stale && <span className="badge warn">{d.days_in_stage} d en etapa (esperado {d.stage_expected_days})</span>}</div>
            <div className="sub row wrap mt8" style={{ gap: 14 }}>
              {d.company_id && <Link to={`/empresas/${d.company_id}`}>{d.company_name}</Link>}
              <span className="num bold" style={{ color: "var(--ink)", fontSize: 16 }}>{fmtMoney2(d.amount, d.currency)}</span>
              <span className="num">{d.probability}% · pond. {fmtMoney(d.weighted_amount, d.currency)}</span>
              {d.expected_close_date && <span>Cierre: {fmtDate(d.expected_close_date)}</span>}
              <span>{d.owner_name}</span>
            </div>
          </div>
          <div className="row">
            {d.status === "open" ? (<><button className="btn" style={{ color: "var(--ok-ink)" }} onClick={() => setClosing("won")}><Trophy />Ganado</button><button className="btn" style={{ color: "var(--risk-ink)" }} onClick={() => setClosing("lost")}><XCircle />Perdido</button></>) : <button className="btn" onClick={reopen}><RotateCcw />Reabrir</button>}
            <Menu trigger={<button className="iconbtn" aria-label="Más acciones"><MoreHorizontal size={18} /></button>}><button onClick={() => setEditing(true)}><Pencil />Editar</button><button onClick={() => setProducts(true)}><Plus />Líneas de producto</button><button onClick={() => setQuote(true)}><FileText />Nuevo presupuesto</button><button onClick={() => nav(`/contratos?new=1&deal=${d.id}`)}><FileText />Generar contrato</button><div className="sep" />{can("deal", "delete") && <button className="danger" onClick={del}><Trash2 />Borrar</button>}</Menu>
          </div>
        </div>
        {d.status === "open" && openStages.length > 0 && (
          <div className="stage-steps mt16">{openStages.map((s, i) => <button key={s.id} className={i < curIdx ? "done" : i === curIdx ? "current" : ""} style={{ "--stage": s.color, "--stage-ink": inkOn(s.color) } as React.CSSProperties} onClick={() => s.id !== d.stage_id && moveTo(s.id)} title={`${s.name} · ${s.probability}%${s.required_fields.length ? ` · requiere: ${s.required_fields.join(", ")}` : ""}`}>{s.name}</button>)}</div>
        )}
      </div>
      <div className="record" style={{ gridTemplateColumns: "minmax(0,1fr) 320px" }}>
        <section>
          <Composer link={{ deal_id: d.id, contact_id: d.contacts[0]?.id }} contactEmail={d.contacts[0]?.email} dealId={d.id} onDone={refreshAll} />
          <div className="mt16">
            <Tabs items={[{ key: "timeline", label: "Línea temporal" }, { key: "tasks", label: "Tareas", count: d.tasks.length }, { key: "products", label: "Productos", count: d.products.length }, { key: "quotes", label: "Presupuestos", count: d.quotes.length }, { key: "stages", label: "Etapas" }, { key: "history", label: "Historial" }, { key: "auto", label: "Automatizaciones" }]} value={tab} onChange={setTab} />
            {tab === "timeline" && <Timeline link={{ deal_id: d.id }} refreshKey={tl} onChanged={load} />}
            {tab === "tasks" && <div>{d.tasks.length === 0 ? <p className="muted">Sin tareas pendientes. Un negocio sin próxima actividad se marca en amarillo en el kanban.</p> : d.tasks.map((t) => <TaskRow key={t.id} task={t} onChanged={refreshAll} onEdit={(x) => setTaskForm(x)} showLinks={false} />)}<button className="btn sm mt12" onClick={() => setTaskForm("new")}><CheckSquare />Nueva tarea</button></div>}
            {tab === "products" && <div className="card tight"><table className="table"><thead><tr><th>Producto</th><th className="r">Cant.</th><th className="r">Precio</th><th className="r">Dto.</th><th className="r">Total</th></tr></thead><tbody>{d.products.map((l) => <tr key={l.id}><td>{l.name}{l.billing_period !== "one_time" && <span className="badge" style={{ marginLeft: 6 }}>{l.billing_period === "monthly" ? "mensual" : "anual"}</span>}</td><td className="r num">{l.quantity}</td><td className="r num">{fmtMoney2(l.unit_price, d.currency)}</td><td className="r num">{l.discount}%</td><td className="r num">{fmtMoney2(l.total, d.currency)}</td></tr>)}{d.products.length === 0 && <tr><td colSpan={5} className="muted">Sin líneas. El importe se introduce a mano.</td></tr>}</tbody></table><div className="pager"><button className="btn sm" onClick={() => setProducts(true)}><Pencil />Editar líneas</button><span className="right bold num">Total: {fmtMoney2(d.products.reduce((a, l) => a + (l.total ?? 0), 0), d.currency)}</span></div></div>}
            {tab === "quotes" && <div className="card tight"><table className="table"><thead><tr><th>Número</th><th>Estado</th><th className="r">Total</th><th>Fecha</th><th>Validez</th><th className="r">Vistas</th><th></th></tr></thead><tbody>{d.quotes.map((q) => <tr key={q.id}><td className="bold">{q.number} <span className="muted">v{q.version}</span></td><td><span className={`badge ${q.status === "accepted" ? "ok" : q.status === "rejected" || q.status === "expired" ? "risk" : q.status === "viewed" ? "sea" : ""}`}>{QUOTE_STATUS[q.status]}</span></td><td className="r num">{fmtMoney2(q.total, d.currency)}</td><td>{fmtDate(q.date)}</td><td>{fmtDate(q.valid_until)}</td><td className="r num">{q.views}</td><td className="r row" style={{ justifyContent: "flex-end" }}><a className="btn xs" href={`/q/${q.token}`} target="_blank" rel="noreferrer"><ExternalLink />Ver</a><a className="btn xs" href={`/api/quotes/${q.id}/pdf`} download title="Descargar el presupuesto en PDF"><FileDown />PDF</a>{["draft", "sent", "viewed"].includes(q.status) && <button className="btn xs" onClick={() => setSendQuote(q)}><Send />Enviar</button>}{q.status !== "accepted" && <button className="btn xs" onClick={async () => { await api.post(`quotes/${q.id}/status`, { status: "accepted" }); toast("Marcado como aceptado", "ok"); refreshAll(); }}>Aceptado</button>}</td></tr>)}{d.quotes.length === 0 && <tr><td colSpan={7} className="muted">Sin presupuestos.</td></tr>}</tbody></table><div className="pager"><button className="btn sm" onClick={() => setQuote(true)}><Plus />Nuevo presupuesto</button></div></div>}
            {tab === "stages" && <div className="card tight"><table className="table"><thead><tr><th>Etapa</th><th>Entrada</th><th>Salida</th><th className="r">Duración</th><th>Usuario</th></tr></thead><tbody>{d.stage_history.map((h) => { const dur = Math.round((new Date(h.left_at ?? new Date().toISOString()).getTime() - new Date(h.entered_at).getTime()) / 86400000); return <tr key={h.id}><td className="bold">{h.stage_name}</td><td>{fmtDateTime(h.entered_at)}</td><td>{h.left_at ? fmtDateTime(h.left_at) : <span className="badge sea">actual</span>}</td><td className="r num">{dur} d</td><td>{h.user_name}</td></tr>; })}</tbody></table></div>}
            {tab === "history" && <HistoryList items={history} />}
            {tab === "auto" && <RecordAutomations object="deal" id={id!} />}
          </div>
        </section>
        <aside className="side r">
          <div className="card">
            <div className="card-title"><h3>Detalles</h3><button className="btn xs ghost" onClick={() => setEditing(true)} aria-label="Editar"><Pencil /></button></div>
            <dl className="kv">
              <dt>Pipeline</dt><dd>{d.pipeline_name}</dd>
              <dt>Etapa</dt><dd><span className="badge dot" style={{ color: d.stage_color }}>{d.stage_name}</span></dd>
              <dt>Importe</dt><dd className="num">{fmtMoney2(d.amount, d.currency)}{d.products.length > 0 && <div className="xs muted">calculado de {d.products.length} líneas</div>}</dd>
              <dt>Probabilidad</dt><dd><input aria-label="Probabilidad" className="input sm num" type="number" min={0} max={100} style={{ width: 80 }} defaultValue={d.probability} key={d.probability} onBlur={(e) => Number(e.target.value) !== d.probability && patch({ probability: Number(e.target.value) })} disabled={d.status !== "open"} /></dd>
              <dt>Cierre previsto</dt><dd><input aria-label="Cierre previsto" className="input sm" type="date" min={d.status === "open" ? todayISO() : undefined} value={d.expected_close_date ?? ""} onChange={(e) => patch({ expected_close_date: e.target.value || null })} /></dd>
              <dt>Propietario</dt><dd><select aria-label="Propietario" className="input sm" value={d.owner_id ?? ""} onChange={(e) => patch({ owner_id: e.target.value || null })}><option value="">Sin asignar</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></dd>
              <dt>Origen</dt><dd>{d.source ?? "—"}</dd>
              <dt>Etiquetas</dt><dd className="row wrap" style={{ gap: 3 }}>{d.tags.length ? d.tags.map((t) => <span key={t} className="tag">{t}</span>) : <span className="muted">—</span>}</dd>
              <dt>Creado</dt><dd className="small">{fmtDate(d.created_at)}</dd>
              <dt>Últ. actividad</dt><dd className="small">{d.last_activity_at ? relTime(d.last_activity_at) : "nunca"}</dd>
              <dt>Próx. actividad</dt><dd className="small">{d.next_activity_at ? fmtDateTime(d.next_activity_at) : <span style={{ color: "var(--warn-ink)" }}>ninguna programada</span>}</dd>
              {customFields.filter((f) => f.object === "deal").map((f) => <Fragment key={f.id}><dt>{f.label}</dt><dd>{formatCustom(f, d.custom?.[f.key], (uid) => userName(uid)) || <span className="muted">—</span>}</dd></Fragment>)}
            </dl>
          </div>
          <div className="card">
            <div className="card-title"><h3>Contactos</h3><button className="btn xs" onClick={() => setAddContact(true)}><Users />Añadir</button></div>
            {d.contacts.map((c) => <div key={c.id} style={{ padding: "6px 0", borderBottom: "1px solid var(--rule2)" }}><Link to={`/contactos/${c.id}`} className="bold">{c.first_name} {c.last_name}</Link><div className="xs muted">{c.job_title ?? c.email}</div><div className="row mt8"><select aria-label={`Rol de ${c.first_name} ${c.last_name}`} className="input sm" style={{ width: "auto" }} value={c.role} onChange={(e) => setRole(c.id, e.target.value)}>{Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><button className="btn xs ghost" onClick={() => removeContact(c.id)}>Quitar</button></div></div>)}
            {d.contacts.length === 0 && <p className="muted small">Añade al decisor: algunas etapas lo requieren.</p>}
          </div>
        </aside>
      </div>
      {editing && <DealForm initial={d} onClose={() => setEditing(false)} onSaved={refreshAll} />}
      {closing && <CloseDealDialog dealId={d.id} dealName={d.name} status={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); refreshAll(); }} />}
      {taskForm && <TaskForm task={taskForm === "new" ? null : taskForm} defaults={{ deal_id: d.id, company_id: d.company_id, contact_id: d.contacts[0]?.id ?? null }} onClose={() => setTaskForm(null)} onSaved={refreshAll} />}
      {products && <ProductLinesDialog deal={d} onClose={() => setProducts(false)} onSaved={refreshAll} />}
      {quote && <QuoteDialog deal={d} onClose={() => setQuote(false)} onSaved={() => { setQuote(false); setTab("quotes"); refreshAll(); }} />}
      {sendQuote && <SendQuoteDialog quote={sendQuote} defaultEmail={d.contacts[0]?.email ?? ""} onClose={() => setSendQuote(null)} onDone={refreshAll} />}
      {addContact && <Modal title="Añadir contacto al negocio" onClose={() => setAddContact(false)}><Picker kind="contact" value={null} autoFocus onChange={async (cid) => { if (cid) { await patch({ contacts: [...d.contacts.map((c) => ({ contact_id: c.id, role: c.role })), { contact_id: cid, role: d.contacts.length ? "influencer" : "decision_maker" }] }); setAddContact(false); } }} /></Modal>}
    </div>
  );
}

export function CloseDealDialog({ dealId, dealName, status, onClose, onDone }: { dealId: string; dealName: string; status: "won" | "lost"; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("price");
  const [competitor, setCompetitor] = useState("");
  const [note, setNote] = useState("");
  const toast = useToast();
  const go = async () => { try { await api.post(`deals/${dealId}/close`, { status, loss_reason: status === "lost" ? reason : undefined, competitor: competitor || null, note: note || null }); toast(status === "won" ? "¡Negocio ganado! 🎉" : "Negocio marcado como perdido", "ok"); onDone(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <Modal title={status === "won" ? `Marcar como ganado: ${dealName}` : `Marcar como perdido: ${dealName}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className={`btn ${status === "won" ? "primary" : "danger"}`} onClick={go}>{status === "won" ? "Confirmar ganado" : "Confirmar perdido"}</button></>}>
      {status === "won" ? <p className="sub small mb12">Los contactos pasan a «Cliente», la empresa a tipo cliente y se disparan las automatizaciones de onboarding.</p> : <div className="col" style={{ gap: 12 }}><Field label="Motivo de pérdida *"><select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>{Object.entries(LOSS_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field><Field label="Competidor (si aplica)"><input className="input" value={competitor} onChange={(e) => setCompetitor(e.target.value)} /></Field></div>}
      <Field label="Nota"><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Contexto del cierre…" /></Field>
    </Modal>
  );
}

function ProductLinesDialog({ deal, onClose, onSaved }: { deal: Deal; onClose: () => void; onSaved: () => void }) {
  const [lines, setLines] = useState<Line[]>(deal.products.map((l) => ({ ...l })));
  const [catalog, setCatalog] = useState<{ id: string; name: string; unit_price: number; billing_period: string; active: number }[]>([]);
  const toast = useToast();
  useEffect(() => { api.get<{ items: typeof catalog }>("products").then((r) => setCatalog(r.items.filter((p) => p.active))); }, []);
  const upd = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const total = lines.reduce((a, l) => a + l.quantity * l.unit_price * (1 - l.discount / 100), 0);
  const save = async () => { try { await api.put(`deals/${deal.id}/products`, lines.map(({ product_id, name, quantity, unit_price, discount, billing_period }) => ({ product_id, name, quantity, unit_price, discount, billing_period }))); toast("Líneas guardadas", "ok"); onSaved(); onClose(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <Modal title="Líneas de producto" size="lg" onClose={onClose} footer={<><span className="grow bold num">Total: {fmtMoney2(total, deal.currency)}</span><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}>
      <div className="row mb12"><select className="input" defaultValue="" onChange={(e) => { const p = catalog.find((x) => x.id === e.target.value); if (p) setLines((ls) => [...ls, { product_id: p.id, name: p.name, quantity: 1, unit_price: p.unit_price, discount: 0, billing_period: p.billing_period }]); e.target.value = ""; }}><option value="">Añadir del catálogo…</option>{catalog.map((p) => <option key={p.id} value={p.id}>{p.name} · {fmtMoney2(p.unit_price)}</option>)}</select><button className="btn" onClick={() => setLines((ls) => [...ls, { product_id: null, name: "", quantity: 1, unit_price: 0, discount: 0, billing_period: "one_time" }])}><Plus />Línea libre</button></div>
      <table className="table"><thead><tr><th>Concepto</th><th>Cant.</th><th>Precio</th><th>Dto. %</th><th>Periodo</th><th></th></tr></thead><tbody>
        {lines.map((l, i) => <tr key={i}><td><input className="input sm" value={l.name} onChange={(e) => upd(i, { name: e.target.value })} /></td><td><input className="input sm num" type="number" style={{ width: 70 }} value={l.quantity} onChange={(e) => upd(i, { quantity: Number(e.target.value) })} /></td><td><input className="input sm num" type="number" style={{ width: 100 }} value={l.unit_price} onChange={(e) => upd(i, { unit_price: Number(e.target.value) })} /></td><td><input className="input sm num" type="number" style={{ width: 70 }} value={l.discount} onChange={(e) => upd(i, { discount: Number(e.target.value) })} /></td><td><select className="input sm" value={l.billing_period} onChange={(e) => upd(i, { billing_period: e.target.value })}><option value="one_time">único</option><option value="monthly">mensual</option><option value="yearly">anual</option></select></td><td><button className="iconbtn" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Borrar"><Trash2 size={14} /></button></td></tr>)}
        {lines.length === 0 && <tr><td colSpan={6} className="muted">Sin líneas: el importe se mantiene manual.</td></tr>}
      </tbody></table>
    </Modal>
  );
}

function QuoteDialog({ deal, onClose, onSaved }: { deal: Deal; onClose: () => void; onSaved: () => void }) {
  const [lines, setLines] = useState<{ product_id: string | null; name: string; description: string; quantity: number; unit_price: number; discount: number; tax_rate: number }[]>(deal.products.length ? deal.products.map((l) => ({ product_id: l.product_id, name: l.name, description: "", quantity: l.quantity, unit_price: l.unit_price, discount: l.discount, tax_rate: 21 })) : [{ product_id: null, name: deal.name, description: "", quantity: 1, unit_price: deal.amount, discount: 0, tax_rate: 21 }]);
  const [validDays, setValidDays] = useState(30);
  const [discount, setDiscount] = useState(0);
  const [notes, setNotes] = useState("Validez del presupuesto según fecha indicada. Precios sin IVA salvo indicación.");
  const [catalog, setCatalog] = useState<{ id: string; name: string; unit_price: number; tax_rate: number; active: number; description: string | null }[]>([]);
  const toast = useToast();
  useEffect(() => { api.get<{ items: typeof catalog }>("products").then((r) => setCatalog(r.items.filter((p) => p.active))); }, []);
  const upd = (i: number, p: Partial<(typeof lines)[0]>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const subtotal = lines.reduce((a, l) => a + l.quantity * l.unit_price * (1 - l.discount / 100), 0) * (1 - discount / 100);
  const tax = lines.reduce((a, l) => a + l.quantity * l.unit_price * (1 - l.discount / 100) * (1 - discount / 100) * (l.tax_rate / 100), 0);
  const save = async () => { try { await api.post("quotes", { deal_id: deal.id, valid_days: validDays, lines, discount, notes }); toast("Presupuesto creado", "ok"); onSaved(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <Modal title="Nuevo presupuesto" size="xl" onClose={onClose} footer={<><span className="grow small num">Subtotal {fmtMoney2(subtotal, deal.currency)} · Impuestos {fmtMoney2(tax, deal.currency)} · <strong>Total {fmtMoney2(subtotal + tax, deal.currency)}</strong></span><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Crear presupuesto</button></>}>
      <div className="row mb12"><select className="input" defaultValue="" onChange={(e) => { const p = catalog.find((x) => x.id === e.target.value); if (p) setLines((ls) => [...ls, { product_id: p.id, name: p.name, description: p.description ?? "", quantity: 1, unit_price: p.unit_price, discount: 0, tax_rate: p.tax_rate }]); e.target.value = ""; }}><option value="">Añadir del catálogo…</option>{catalog.map((p) => <option key={p.id} value={p.id}>{p.name} · {fmtMoney2(p.unit_price)}</option>)}</select><button className="btn" onClick={() => setLines((ls) => [...ls, { product_id: null, name: "", description: "", quantity: 1, unit_price: 0, discount: 0, tax_rate: 21 }])}><Plus />Línea</button></div>
      <table className="table"><thead><tr><th>Concepto</th><th>Cant.</th><th>Precio</th><th>Dto.%</th><th>IVA%</th><th></th></tr></thead><tbody>
        {lines.map((l, i) => <tr key={i}><td><input className="input sm" value={l.name} onChange={(e) => upd(i, { name: e.target.value })} placeholder="Concepto" /><input className="input sm mt8" value={l.description} onChange={(e) => upd(i, { description: e.target.value })} placeholder="Descripción (opcional)" /></td><td><input className="input sm num" type="number" style={{ width: 70 }} value={l.quantity} onChange={(e) => upd(i, { quantity: Number(e.target.value) })} /></td><td><input className="input sm num" type="number" style={{ width: 100 }} value={l.unit_price} onChange={(e) => upd(i, { unit_price: Number(e.target.value) })} /></td><td><input className="input sm num" type="number" style={{ width: 65 }} value={l.discount} onChange={(e) => upd(i, { discount: Number(e.target.value) })} /></td><td><input className="input sm num" type="number" style={{ width: 65 }} value={l.tax_rate} onChange={(e) => upd(i, { tax_rate: Number(e.target.value) })} /></td><td><button className="iconbtn" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Borrar"><Trash2 size={14} /></button></td></tr>)}
      </tbody></table>
      <div className="form-grid mt12"><Field label="Validez (días)"><input className="input" type="number" value={validDays} onChange={(e) => setValidDays(Number(e.target.value))} /></Field><Field label="Descuento global %"><input className="input" type="number" value={discount} onChange={(e) => setDiscount(Number(e.target.value))} /></Field><Field label="Condiciones" full><textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field></div>
    </Modal>
  );
}

function SendQuoteDialog({ quote, defaultEmail, onClose, onDone }: { quote: { id: string; number: string }; defaultEmail: string; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState(defaultEmail);
  const [message, setMessage] = useState("Hola,<br/>te enviamos el presupuesto {{number}}. Puedes verlo y aceptarlo en el enlace.");
  const toast = useToast();
  const go = async () => { try { const r = await api.post<{ link: string }>(`quotes/${quote.id}/send`, { to, message }); toast(`Enviado. Enlace: ${r.link}`, "ok"); onDone(); onClose(); } catch (e) { toast(errorMessage(e), "error"); } };
  return <Modal title={`Enviar presupuesto ${quote.number}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={go}><Send />Enviar</button></>}><div className="col"><Field label="Para"><input className="input" type="email" value={to} onChange={(e) => setTo(e.target.value)} /></Field><Field label="Mensaje" hint="Se añade automáticamente el enlace de visualización y aceptación con seguimiento de aperturas."><textarea className="input" value={message} onChange={(e) => setMessage(e.target.value)} /></Field></div></Modal>;
}
