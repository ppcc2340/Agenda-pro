import { RecordAutomations } from "./AutomationCenter";
import { useEffect, useState, useCallback, type ReactNode, Fragment } from "react";
import { useParams, useNavigate, Link, useSearchParams } from "react-router-dom";
import { Pencil, MoreHorizontal, Send, FileText, GitCompare, ShieldAlert, ClipboardCheck, PenTool, CalendarClock, GitBranch, MessageSquare, History as HistoryIcon, Sparkles, Plus, Trash2, Lock, Unlock, RefreshCw, Bell, XCircle, Check, ExternalLink, Copy } from "lucide-react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { Modal, Field, Tabs, Spinner, Menu, Picker, Avatar, useToast, useConfirm, errorMessage, Seg } from "../components/ui";
import { fmtMoney, fmtDate, fmtDateTime, relTime } from "../lib/format";
import { CSTATUS, RISK, RENEWAL, PAPER, URGENCY, PAYMENT_MODEL, KIND, DEVIATION, OBL_STATUS, OBL_TYPE, MS_TYPE, PAY_STATUS, APPROVAL_STATUS, SIGNER_STATUS, ENV_STATUS, TERMINATION_CAUSES, TIMELINE_ICON, daysUntil } from "../lib/clm";
import { useClmMeta } from "./Contracts";
import { pillStyle } from "../lib/colors";
import { LayoutPanel } from "../components/LayoutPanel";
import { ShareButton } from "../components/ShareButton";

type Any = Record<string, unknown>;
interface Detail extends Any { id: string; number: string; title: string; status: string; substatus: string | null; kind: string; type_name: string; type_code: string; type_color: string; direction: string; min_signature_level: string; counterparty_company_id: string | null; counterparty_name: string | null; owner_id: string | null; owner_name: string | null; legal_owner_id: string | null; legal_owner_name: string | null; total_value: number; annual_value: number; currency: string; effective_date: string | null; end_date: string | null; notice_deadline: string | null; next_renewal_date: string | null; renewal_type: string; renewal_period_months: number | null; notice_period_days: number | null; term_type: string; term_months: number | null; payment_model: string; payment_terms_days: number; risk_level: string; risk_score: number; risk_factors: { factor: string; weight: number; value: number; contribution: number; explanation: string }[]; risk_override: string | null; paper_origin: string; urgency: string; governing_law: string; jurisdiction: string | null; contains_personal_data: number; data_role: string | null; international_transfer: number; confidentiality: string; description: string | null; signed_at: string | null; requested_at: string | null; sla_due_at: string | null; sla_paused: number; parent_id: string | null; parent_number: string | null; parent_title: string | null; deal_id: string | null; deal_name: string | null; legal_hold: number; legal_hold_reason: string | null; retention_until: string | null; termination_date: string | null; termination_cause: string | null; effective_values: Any; intake: Any; current_version_id: string | null; signed_version_id: string | null; tags: string[]; transitions: string[]; versions: Any[]; current_body: string; clauses: Any[]; approvals: Any[]; envelopes: Any[]; obligations: Any[]; milestones: Any[]; payments: Any[]; children: Any[]; timeline: Any[]; comments: Any[]; renewals: Any[]; audits: Any[]; pending_for_me: number; approval_preview: { name: string; reason: string; approver_user_id: string | null; approver_role: string; sla_hours: number }[]; checklist: { errors: string[]; warnings: string[] } | null }

const pill = (opts: Record<string, { label: string; color: string }>, k: string | null | undefined, extra?: string) => <span className="badge" style={pillStyle(opts[k ?? ""]?.color ?? "#c4c4c4")}>{opts[k ?? ""]?.label ?? k ?? "—"}{extra}</span>;

export function ContractDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const { can, users, me } = useApp();
  const { meta } = useClmMeta();
  const toast = useToast();
  const confirm = useConfirm();
  const [c, setC] = useState<Detail | null>(null);
  const [tab, setTab] = useState(params.get("tab") ?? "summary");
  const [modal, setModal] = useState<{ kind: string; data?: Any } | null>(null);
  const load = useCallback(() => api.get<Detail>(`clm/contracts/${id}`).then(setC).catch((e) => { toast(errorMessage(e), "error"); nav("/contratos"); }), [id, nav, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const p = new URLSearchParams(params); p.set("tab", tab); setParams(p, { replace: true }); /* eslint-disable-next-line */ }, [tab]);
  if (!c) return <Spinner />;
  const editable = can("contract", "update");
  const act = async (fn: () => Promise<unknown>, ok?: string) => { try { await fn(); if (ok) toast(ok, "ok"); setModal(null); await load(); } catch (e) { toast(errorMessage(e), "error"); } };
  const transition = (event: string, payload: Any = {}) => act(() => api.post(`clm/contracts/${c.id}/transitions`, { event, payload }), undefined);
  const T = meta?.transitions ?? {};
  const quick = (ev: string) => { if (["cancel", "put_on_hold", "return_to_requester", "send_to_counterparty", "counterparty_version_received", "terminate"].includes(ev)) setModal({ kind: ev }); else if (ev === "send_for_signature") setTab("signature"); else if (ev === "request_approval") act(() => api.post(`clm/contracts/${c.id}/approvals/request`), "Aprobación solicitada"); else transition(ev); };
  const nd = daysUntil(c.notice_deadline);
  const tabs = [{ key: "summary", label: "Resumen" }, { key: "document", label: "Documento" }, { key: "versions", label: "Versiones", count: c.versions.length }, { key: "clauses", label: "Cláusulas y playbook", count: c.clauses.filter((x) => x.deviation_level !== "none").length }, { key: "approvals", label: "Aprobaciones", count: c.approvals.filter((a) => a.status === "pending").length }, { key: "signature", label: "Firma" }, { key: "obligations", label: "Obligaciones", count: c.obligations.filter((o) => ["pending", "in_progress", "breached"].includes(String(o.status))).length }, { key: "milestones", label: "Hitos y pagos", count: c.milestones.filter((m) => m.status !== "passed").length }, { key: "family", label: "Enmiendas y familia", count: c.children.length }, { key: "activity", label: "Actividad" }, { key: "audit", label: "Auditoría" }, { key: "auto", label: "Automatizaciones" }];
  return (
    <div>
      <div className="row small muted mb8"><Link to="/contratos">Contratos</Link><span>/</span>{c.parent_id && <><Link to={`/contratos/${c.parent_id}`}>{c.parent_number}</Link><span>/</span></>}<span>{c.number}</span></div>
      <div className="card mb12" style={{ borderTop: `4px solid ${c.type_color}` }}>
        <div className="row wrap" style={{ alignItems: "flex-start" }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="row wrap"><span className="badge" style={pillStyle(c.type_color)}>{c.type_name}</span>{c.kind !== "master" && <span className="badge">{KIND[c.kind]} de {c.parent_number}</span>}{pill(CSTATUS, c.status)}{c.substatus && <span className="badge warn">{c.substatus === "UNDER_AMENDMENT" ? "Enmienda en curso" : c.substatus === "SLA_BREACHED" ? "SLA vencido" : String(c.substatus)}</span>}{pill(RISK, c.risk_level, ` · ${c.risk_score}`)}{!!c.legal_hold && <span className="badge risk"><Lock size={11} /> bloqueo legal</span>}{c.pending_for_me > 0 && <span className="badge sea">Tienes {c.pending_for_me} aprobación pendiente</span>}</div>
            <h1 className="mt8">{c.title}</h1>
            <ShareButton object="contract" id={c.id} />
            <div className="sub row wrap mt8" style={{ gap: 14 }}>
              <span className="num">{c.number}</span>
              {c.counterparty_company_id && <Link to={`/empresas/${c.counterparty_company_id}`}>{c.counterparty_name}</Link>}
              <span className="num bold" style={{ color: "var(--ink)", fontSize: 16 }}>{fmtMoney(c.annual_value, c.currency)}<span className="small sub"> /año</span></span>
              {c.effective_date && <span>{fmtDate(c.effective_date)} → {c.end_date ? fmtDate(c.end_date) : "indefinido"}</span>}
              {c.notice_deadline && c.status === "ACTIVE" && <span style={{ color: (nd ?? 99) < 0 ? "var(--risk)" : (nd ?? 99) <= 30 ? "var(--warn)" : undefined }}>Preaviso: {fmtDate(c.notice_deadline)} ({nd} d)</span>}
              <span>{c.owner_name}{c.legal_owner_name ? ` · legal: ${c.legal_owner_name}` : ""}</span>
            </div>
          </div>
          <div className="row wrap">
            {c.transitions.filter((t) => !["archive"].includes(t) || true).slice(0, 4).map((t) => <button key={t} className={`btn ${["request_approval", "send_for_signature", "submit_for_review"].includes(t) ? "primary" : ""}`} onClick={() => quick(t)} disabled={!editable}>{t === "send_for_signature" ? <PenTool /> : t === "request_approval" ? <ClipboardCheck /> : t === "submit_for_review" ? <Send /> : null}{T[t]?.label ?? t}</button>)}
            <Menu trigger={<button className="iconbtn" aria-label="Más acciones"><MoreHorizontal size={18} /></button>}>
              {editable && <button onClick={() => setModal({ kind: "edit" })}><Pencil />Editar datos</button>}
              {c.transitions.slice(4).map((t) => <button key={t} onClick={() => quick(t)}>{T[t]?.label ?? t}</button>)}
              {c.status === "ACTIVE" && <button onClick={() => setModal({ kind: "amendment" })}><GitBranch />Nueva enmienda</button>}
              {["ACTIVE", "EXPIRED"].includes(c.status) && <button onClick={() => setModal({ kind: "renewal" })}><RefreshCw />Preparar renovación</button>}
              <button onClick={() => act(() => api.post(`clm/contracts/${c.id}/analyze`), "Análisis actualizado")}><Sparkles />Re-analizar contra el playbook</button>
              <div className="sep" />
              {me.role.permissions.admin && (c.legal_hold ? <button onClick={() => act(() => api.del(`clm/contracts/${c.id}/legal-hold`), "Bloqueo retirado")}><Unlock />Retirar bloqueo legal</button> : <button onClick={() => { const r = prompt("Motivo del bloqueo legal (litigio, auditoría…)"); if (r) act(() => api.post(`clm/contracts/${c.id}/legal-hold`, { reason: r }), "Bloqueo legal activado"); }}><Lock />Bloqueo legal</button>)}
              {can("contract", "delete") && !c.signed_version_id && <button className="danger" onClick={async () => { if (await confirm({ title: "¿Borrar este contrato?", danger: true, confirmText: "Borrar" })) act(() => api.del(`clm/contracts/${c.id}`).then(() => nav("/contratos")), "Borrado"); }}><Trash2 />Borrar</button>}
            </Menu>
          </div>
        </div>
        <StatusSteps status={c.status} />
      </div>
      <Tabs items={tabs} value={tab} onChange={setTab} />
      <div className="mt12">
        {tab === "summary" && <><div className="card mb12"><div className="card-title"><h3>Ficha</h3></div><LayoutPanel object="contract" record={c as unknown as Record<string, unknown>} editable={editable} onPatch={(p) => act(() => api.patch(`clm/contracts/${c.id}`, p))} /></div><Summary c={c} onEdit={() => setModal({ kind: "edit" })} onRisk={() => setModal({ kind: "risk" })} /></>}
        {tab === "document" && <DocumentTab c={c} meta={meta} reload={load} editable={editable} />}
        {tab === "versions" && <VersionsTab c={c} />}
        {tab === "clauses" && <ClausesTab c={c} reload={load} editable={editable} />}
        {tab === "approvals" && <ApprovalsTab c={c} reload={load} />}
        {tab === "signature" && <SignatureTab c={c} reload={load} editable={editable} />}
        {tab === "obligations" && <ObligationsTab c={c} reload={load} editable={editable} />}
        {tab === "milestones" && <MilestonesTab c={c} reload={load} editable={editable} />}
        {tab === "family" && <FamilyTab c={c} reload={load} onAmend={() => setModal({ kind: "amendment" })} onRenew={() => setModal({ kind: "renewal" })} onTerminate={() => setModal({ kind: "terminate" })} />}
        {tab === "activity" && <ActivityTab c={c} reload={load} />}
        {tab === "auto" && <div className="card"><RecordAutomations object="contract" id={String(c.id)} /></div>}
        {tab === "audit" && <div className="card tight"><table className="table"><thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Cambios</th></tr></thead><tbody>{c.audits.map((a) => <tr key={String(a.id)}><td className="small num">{fmtDateTime(String(a.created_at))}</td><td className="small">{String(a.user_name ?? "sistema")}</td><td><span className="badge">{String(a.action)}</span></td><td className="small muted" style={{ fontFamily: "ui-monospace, monospace", fontSize: 11.5 }}>{JSON.stringify(a.changes).slice(0, 180)}</td></tr>)}</tbody></table></div>}
      </div>
      {modal?.kind === "edit" && <EditContract c={c} onClose={() => setModal(null)} onSaved={load} />}
      {modal?.kind === "risk" && <RiskOverride c={c} onClose={() => setModal(null)} onSaved={load} />}
      {["cancel", "put_on_hold", "return_to_requester"].includes(modal?.kind ?? "") && <NoteModal title={T[modal!.kind]?.label ?? ""} label="Motivo" onClose={() => setModal(null)} onOk={(note) => transition(modal!.kind, { note })} />}
      {modal?.kind === "send_to_counterparty" && <SendToCounterparty c={c} onClose={() => setModal(null)} onOk={(p) => transition("send_to_counterparty", p)} />}
      {modal?.kind === "counterparty_version_received" && <ReceiveVersion onClose={() => setModal(null)} onOk={(p) => transition("counterparty_version_received", p)} />}
      {modal?.kind === "terminate" && <Terminate c={c} onClose={() => setModal(null)} onOk={(p) => transition("terminate", p)} />}
      {modal?.kind === "amendment" && <AmendmentModal c={c} meta={meta} onClose={() => setModal(null)} onSaved={(a) => { setModal(null); nav(`/contratos/${a.id}`); }} />}
      {modal?.kind === "renewal" && <RenewalModal c={c} onClose={() => setModal(null)} onSaved={(a) => { setModal(null); if (a) nav(`/contratos/${a.id}`); else load(); }} />}
    </div>
  );
}

function StatusSteps({ status }: { status: string }) {
  const flow = ["DRAFT", "INTERNAL_REVIEW", "NEGOTIATION", "PENDING_APPROVAL", "APPROVED", "OUT_FOR_SIGNATURE", "ACTIVE"];
  const map: Record<string, string> = { PARTIALLY_SIGNED: "OUT_FOR_SIGNATURE", RENEWED: "ACTIVE", EXPIRED: "ACTIVE", TERMINATED: "ACTIVE", ARCHIVED: "ACTIVE" };
  const cur = flow.indexOf(map[status] ?? status);
  if (cur < 0) return <div className="mt12 small sub">Estado: {CSTATUS[status]?.label}</div>;
  return <div className="stage-steps mt16">{flow.map((s, i) => <button key={s} className={i < cur ? "done" : i === cur ? "current" : ""} style={{ "--stage": CSTATUS[s]?.color } as React.CSSProperties} disabled>{CSTATUS[s]?.label}</button>)}</div>;
}

function Summary({ c, onEdit, onRisk }: { c: Detail; onEdit: () => void; onRisk: () => void }) {
  const eff = c.effective_values as Record<string, unknown>;
  const kv = (k: string, v: ReactNode) => <><dt>{k}</dt><dd>{v ?? <span className="muted">—</span>}</dd></>;
  const ev = (field: string, v: ReactNode) => eff[field] !== undefined ? <span>{v} <span className="xs muted" title={`Valor vigente tras enmienda; original ${String(((eff.__history as Any[]) ?? []).find((h) => h.field === field)?.from ?? "")}`}>(vigente por enmienda)</span></span> : v;
  const open = c.obligations.filter((o) => ["pending", "in_progress"].includes(String(o.status))).length, breached = c.obligations.filter((o) => o.status === "breached").length;
  const nextMs = c.milestones.filter((m) => m.status !== "passed" && String(m.date) >= new Date().toISOString().slice(0, 10)).slice(0, 4);
  return (
    <div className="record">
      <section className="grow" style={{ minWidth: 0 }}>
        <div className="charts">
          <div className="card"><div className="card-title"><h3>Condiciones</h3><button className="btn xs ghost" onClick={onEdit} aria-label="Editar"><Pencil /></button></div><dl className="kv">
            {kv("Dirección", c.direction === "income" ? "Ingreso" : c.direction === "expense" ? "Gasto" : "Neutral")}{kv("Papel", pill(PAPER, c.paper_origin))}{kv("Valor total", ev("total_value", fmtMoney(c.total_value, c.currency)))}{kv("Valor anual", ev("annual_value", fmtMoney(c.annual_value, c.currency)))}{kv("Modelo de pago", `${PAYMENT_MODEL[c.payment_model]?.label} · ${c.payment_terms_days} días`)}{kv("Duración", c.term_type === "fixed" ? `${c.term_months} meses` : c.term_type === "indefinite" ? "Indefinida" : "Por hito")}{kv("Renovación", <>{pill(RENEWAL, c.renewal_type)}{c.renewal_type !== "none" && <span className="small"> cada {c.renewal_period_months ?? c.term_months} meses · preaviso {c.notice_period_days ?? 0} d</span>}</>)}{kv("Ley y fuero", `${c.governing_law}${c.jurisdiction ? ` · ${c.jurisdiction}` : ""}`)}{kv("Datos personales", c.contains_personal_data ? `Sí · ${c.data_role === "processor" ? "encargado" : c.data_role === "controller" ? "responsable" : "corresponsable"}${c.international_transfer ? " · transferencias internacionales" : ""}` : "No")}{kv("Confidencialidad", c.confidentiality)}{kv("Urgencia", pill(URGENCY, c.urgency))}{kv("Negocio CRM", c.deal_id ? <Link to={`/negocios/${c.deal_id}`}>{c.deal_name}</Link> : null)}{kv("Solicitado", c.requested_at ? fmtDateTime(c.requested_at) : null)}{kv("Firmado", c.signed_at ? fmtDateTime(c.signed_at) : null)}{kv("Retención hasta", c.retention_until ? fmtDate(c.retention_until) : null)}{c.termination_date && kv("Terminación", `${fmtDate(c.termination_date)} · ${TERMINATION_CAUSES[c.termination_cause ?? ""] ?? c.termination_cause}`)}
          </dl>{c.description && <p className="small mt12">{c.description}</p>}</div>
          <div className="card"><div className="card-title"><h3>Riesgo {pill(RISK, c.risk_level, ` · ${c.risk_score}/100`)}</h3><button className="btn xs ghost" onClick={onRisk} title="Sobrescribir nivel" aria-label="Sobrescribir nivel"><Pencil /></button></div>
            {c.risk_override && <p className="small warn mb8">Nivel fijado manualmente: {String(c.risk_override)}. {String(c.risk_override_reason ?? "")}</p>}
            <div className="col" style={{ gap: 6 }}>{c.risk_factors.map((f) => <div key={f.factor} className="row small"><span style={{ width: 200 }} className="ell" title={f.explanation}>{f.factor}</span><div className="grow" style={{ background: "var(--panel)", height: 10, borderRadius: 3 }}><div style={{ width: `${(100 * f.contribution) / 25}%`, maxWidth: "100%", height: 10, borderRadius: 3, background: f.contribution >= 10 ? "var(--c-red)" : f.contribution >= 4 ? "var(--c-orange)" : "var(--c-green)" }} /></div><b className="num" style={{ width: 36, textAlign: "right" }}>{f.contribution}</b></div>)}</div>
            <p className="xs muted mt8">Fórmula explicable: suma de factores ponderados (desviaciones prohibidas 25, mayores 15, ausentes 15, valor 10, datos 8…). 0-25 bajo, 26-50 medio, 51-75 alto, 76-100 crítico.</p>
          </div>
          <div className="card"><h3 className="mb8">Próximos hitos</h3>{nextMs.length === 0 ? <p className="muted small">Sin hitos próximos.</p> : nextMs.map((m) => <div key={String(m.id)} className="row small" style={{ padding: "5px 0", borderBottom: "1px solid var(--rule2)" }}><i className={`ddot ${(daysUntil(String(m.date)) ?? 99) <= 7 ? "late" : (daysUntil(String(m.date)) ?? 99) <= 30 ? "soon" : ""}`} /><span className="grow">{String(m.label)}</span><span className="num">{fmtDate(String(m.date))} · {daysUntil(String(m.date))} d</span></div>)}
            <h3 className="mt16 mb8">Obligaciones</h3><div className="row wrap small"><span className="badge">{open} abiertas</span>{breached > 0 && <span className="badge risk">{breached} incumplidas</span>}<span className="badge ok">{c.obligations.filter((o) => o.status === "fulfilled").length} cumplidas</span></div>
            {c.approval_preview.length > 0 && <><h3 className="mt16 mb8">Aprobaciones que se pedirán</h3>{c.approval_preview.map((s, i) => <div key={i} className="small" style={{ padding: "3px 0" }}><b>{s.name}</b> <span className="muted">· {s.reason}</span></div>)}</>}
            {c.approval_preview.length === 0 && ["DRAFT", "INTERNAL_REVIEW", "NEGOTIATION"].includes(c.status) && <p className="small ok mt12">Sin pasos de aprobación aplicables: se aprobará automáticamente por política.</p>}
          </div>
          <div className="card"><h3 className="mb8">Datos de la solicitud</h3><dl className="kv">{Object.entries(c.intake ?? {}).filter(([k, v]) => v !== null && v !== "" && v !== false && k !== "before" && k !== "changes").map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{typeof v === "object" ? JSON.stringify(v) : String(v as string)}</dd></Fragment>)}{c.tags.length > 0 && <><dt>Etiquetas</dt><dd>{c.tags.map((t) => <span key={t} className="tag">{t}</span>)}</dd></>}</dl></div>
        </div>
      </section>
    </div>
  );
}

function DocumentTab({ c, meta, reload, editable }: { c: Detail; meta: ReturnType<typeof useClmMeta>["meta"]; reload: () => Promise<unknown>; editable: boolean }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.current_body);
  const [comment, setComment] = useState("");
  const [tpl, setTpl] = useState("");
  useEffect(() => { setText(c.current_body); }, [c.current_body]);
  const locked = !!c.signed_version_id || ["OUT_FOR_SIGNATURE", "PARTIALLY_SIGNED", "ARCHIVED"].includes(c.status);
  const cur = c.versions.find((v) => v.id === c.current_version_id);
  const save = async () => { try { await api.post(`clm/contracts/${c.id}/versions`, { body: text, comment: comment || "Edición manual", source: "uploaded" }); toast("Nueva versión guardada", "ok"); setEditing(false); setComment(""); await reload(); } catch (e) { toast(errorMessage(e), "error"); } };
  const gen = async () => { try { const r = await api.post<{ unresolved: string[] }>(`clm/contracts/${c.id}/generate`, { template_id: tpl }); toast(r.unresolved.length ? `Generado con ${r.unresolved.length} variables sin resolver` : "Documento generado", r.unresolved.length ? "warn" as never : "ok"); await reload(); } catch (e) { toast(errorMessage(e), "error"); } };
  const templates = (meta?.templates ?? []).filter((t) => t.kind === (c.kind === "amendment" ? "amendment" : "contract") && t.status === "approved" && (!t.type_id || t.type_id === c.type_id));
  const highlight = (body: string) => { const cats = c.clauses.filter((x) => x.source_text && x.deviation_level !== "none" && x.deviation_level !== "missing"); return body.split("\n").map((line, i) => { const hit = cats.find((x) => line && String(x.source_text).includes(line.slice(0, 60).trim()) && line.trim().length > 20); return <div key={i} className={hit ? `hl-${hit.deviation_level}` : ""} title={hit ? `${DEVIATION[String(hit.deviation_level)]?.label}: ${hit.deviation_summary}` : undefined}>{line || " "}</div>; }); };
  return (
    <div>
      <div className="filterbar">
        {cur && <span className="small sub">Versión <b>{String(cur.label)}</b> · {cur.branch === "external" ? "externa" : "interna"} · {String(cur.source)} · {fmtDateTime(String(cur.created_at))}{cur.is_signed ? " · 🔏 firmada e inmutable" : cur.locked ? " · bloqueada" : ""} · SHA-256 <span className="num" title={String(cur.sha256)}>{String(cur.sha256).slice(0, 12)}…</span></span>}
        <span className="right row">
          {!locked && editable && !editing && <><select className="input sm" style={{ width: "auto" }} value={tpl} onChange={(e) => setTpl(e.target.value)}><option value="">Generar desde plantilla…</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select><button className="btn sm" disabled={!tpl} onClick={gen}><FileText />Generar</button><button className="btn sm" onClick={() => setEditing(true)}><Pencil />Editar texto</button></>}
          {locked && <span className="badge"><Lock size={11} /> {c.signed_version_id ? "Documento firmado: inmutable (crea una enmienda)" : "Bloqueado durante la firma"}</span>}
          <button className="btn sm ghost" onClick={() => { navigator.clipboard.writeText(c.current_body); toast("Copiado", "ok"); }}><Copy />Copiar</button>
        </span>
      </div>
      {editing ? <div className="card"><textarea className="input doc-editor" value={text} onChange={(e) => setText(e.target.value)} /><div className="row mt8"><input aria-label="Comentario de la versión (ej. ajuste de la cláusula 8)" className="input grow" placeholder="Comentario de la versión (ej. ajuste de la cláusula 8)" value={comment} onChange={(e) => setComment(e.target.value)} /><button className="btn" onClick={() => { setEditing(false); setText(c.current_body); }}>Cancelar</button><button className="btn primary" onClick={save}>Guardar como nueva versión</button></div><p className="xs muted mt8">Guardar crea la versión {cur ? `${cur.major}.${Number(cur.minor) + 1}` : "1.0"} con su hash. Si el contrato estaba aprobado o en firma, las aprobaciones se invalidan y vuelve a revisión interna.</p></div>
        : <div className="card doc-view">{c.current_body ? highlight(c.current_body) : <p className="muted">Sin documento. Genera uno desde una plantilla o pega el texto recibido.</p>}</div>}
      <p className="xs muted mt8">Resaltado: <span className="hl-minor" style={{ padding: "0 4px" }}>desviación menor</span> <span className="hl-major" style={{ padding: "0 4px" }}>mayor</span> <span className="hl-prohibited" style={{ padding: "0 4px" }}>prohibida</span>. Las versiones DOCX/PDF se representan como texto en esta instalación.</p>
    </div>
  );
}

function VersionsTab({ c }: { c: Detail }) {
  const [cmp, setCmp] = useState<{ from: Any; to: Any; html: string; summary: Any } | null>(null);
  const [against, setAgainst] = useState<string>("");
  const toast = useToast();
  const compare = async (vid: string) => { try { const r = await api.get<typeof cmp>(`clm/versions/${vid}/compare${against ? `?against=${against}` : ""}`); setCmp(r); } catch (e) { toast(errorMessage(e), "error"); } };
  const lanes = [["internal", "Rama interna (nunca sale)"], ["external", "Rama externa (intercambiada con la contraparte)"]] as const;
  return (
    <div>
      <div className="charts">{lanes.map(([k, label]) => (
        <div key={k} className="card"><h3 className="mb8">{label}</h3>{c.versions.filter((v) => v.branch === k).length === 0 && <p className="muted small">Sin versiones.</p>}
          {c.versions.filter((v) => v.branch === k).map((v) => <div key={String(v.id)} className={`vrow ${v.id === c.current_version_id ? "cur" : ""}`}><div className="vlabel">{String(v.label)}</div><div className="grow"><div className="bold small">{String(v.comment ?? v.source)} {v.is_signed ? <span className="badge ok">firmada</span> : v.is_final ? <span className="badge">final</span> : null}{v.locked ? <Lock size={11} /> : null}</div><div className="xs muted">{String(v.source)} · {String(v.author_name ?? "contraparte")} · {fmtDateTime(String(v.created_at))} · {Math.round(Number(v.size) / 1024)} KB · {String(v.sha256).slice(0, 10)}…</div></div><div className="row"><select className="input sm" style={{ width: "auto" }} value={against} onChange={(e) => setAgainst(e.target.value)}><option value="">vs anterior</option>{c.versions.filter((x) => x.id !== v.id).map((x) => <option key={String(x.id)} value={String(x.id)}>vs {String(x.label)}</option>)}</select><button className="btn sm" onClick={() => compare(String(v.id))}><GitCompare />Comparar</button></div></div>)}
        </div>))}</div>
      {cmp && <div className="card mt12"><div className="card-title"><h3>Comparación {String(cmp.from.label)} → {String(cmp.to.label)}</h3><span className="small sub">{String((cmp.summary as Any).added)} añadidos · {String((cmp.summary as Any).removed)} eliminados · {String((cmp.summary as Any).modified)} modificados · {String((cmp.summary as Any).pct)} % del texto</span><button className="btn xs ghost" onClick={() => setCmp(null)}><XCircle /></button></div><div className="diff" dangerouslySetInnerHTML={{ __html: cmp.html }} /></div>}
    </div>
  );
}

function ClausesTab({ c, reload, editable }: { c: Detail; reload: () => Promise<unknown>; editable: boolean }) {
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const apply = async (cl: Any) => {
    if (!cl.suggested_body || !cl.source_text) return;
    const body = c.current_body.includes(String(cl.source_text)) ? c.current_body.replace(String(cl.source_text), `${cl.suggested_title}\n${String(cl.suggested_body)}`) : c.current_body + `\n\n[PROPUESTA ${cl.category}] ${cl.suggested_title}\n${String(cl.suggested_body)}`;
    try { await api.post(`clm/contracts/${c.id}/versions`, { body, comment: `Redline propuesto: ${cl.category} → ${cl.suggested_code}`, source: "uploaded" }); toast("Redline aplicado en una nueva versión", "ok"); await reload(); } catch (e) { toast(errorMessage(e), "error"); }
  };
  const groups = ["prohibited", "missing", "major", "minor", "none"];
  return (
    <div>
      <div className="card mb12 small"><b>Revisión contra el playbook</b> de {c.type_name} ({c.direction === "income" ? "venta" : "compra"}). Cada hallazgo indica la cita del contrato, nuestra política, el riesgo, la variante propuesta y quién debe aprobar la desviación. {editable && <button className="btn xs right" onClick={() => api.post(`clm/contracts/${c.id}/analyze`).then(reload)}><Sparkles />Re-analizar</button>}</div>
      {groups.filter((g) => c.clauses.some((x) => x.deviation_level === g)).map((g) => (
        <div key={g} className="mgroup" style={{ "--gc": DEVIATION[g]?.color } as React.CSSProperties}>
          <div className="ghead"><h2>{g === "none" ? "Conformes" : DEVIATION[g]?.label}</h2><span className="count">{c.clauses.filter((x) => x.deviation_level === g).length}</span></div>
          <div className="card tight"><table className="table"><thead><tr><th style={{ width: 70 }}>Cód.</th><th>Cláusula</th><th>Lo que dice el contrato</th><th>Hallazgo</th><th>Aprueba</th><th /></tr></thead><tbody>
            {c.clauses.filter((x) => x.deviation_level === g).map((x) => <><tr key={String(x.id)} className="clickable" onClick={() => setOpen(open === x.id ? null : String(x.id))}><td className="num"><span className="badge" style={pillStyle(DEVIATION[String(x.deviation_level)]?.color)}>{String(x.category)}</span></td><td className="bold">{String(x.heading)}{x.clause_id ? <span className="xs muted"> · biblioteca</span> : null}</td><td className="small muted ell" style={{ maxWidth: 360 }}>{x.source_text ? `«${String(x.source_text).slice(0, 140)}…»` : "—"}</td><td className="small">{String(x.deviation_summary ?? "Conforme")}</td><td className="small">{x.approver_role ? <span className="badge">{String(x.approver_role)}</span> : ""}</td><td className="r">{!!x.suggested_body && x.deviation_level !== "none" && editable && !c.signed_version_id && <button className="btn xs" onClick={(e) => { e.stopPropagation(); apply(x); }}>Proponer {String(x.suggested_code)}</button>}</td></tr>
              {open === x.id && <tr key={String(x.id) + "d"}><td colSpan={6} style={{ background: "var(--panel)" }}><div className="charts"><div><div className="xs muted mb8">TEXTO DEL CONTRATO</div><div className="small" style={{ whiteSpace: "pre-wrap" }}>{String(x.source_text ?? x.text_final ?? "—")}</div>{Object.keys(x.params as Any ?? {}).length > 0 && <div className="xs muted mt8">Parámetros extraídos: {JSON.stringify(x.params)}</div>}</div><div><div className="xs muted mb8">NUESTRA POSICIÓN {x.suggested_code ? `(${String(x.suggested_code)})` : ""}</div><div className="small" style={{ whiteSpace: "pre-wrap" }}>{String(x.suggested_body ?? "Sin variante sugerida en la biblioteca.")}</div></div></div></td></tr>}</>)}
          </tbody></table></div>
        </div>))}
      {c.clauses.length === 0 && <div className="card"><p className="muted">Todavía no hay cláusulas analizadas: genera o sube el documento.</p></div>}
    </div>
  );
}

function ApprovalsTab({ c, reload }: { c: Detail; reload: () => Promise<unknown> }) {
  const { me, users } = useApp();
  const toast = useToast();
  const [reject, setReject] = useState<Any | null>(null);
  const [comment, setComment] = useState("");
  const [cond, setCond] = useState("");
  const decide = async (a: Any, decision: "approved" | "rejected") => { try { await api.post(`clm/approvals/${a.id}/decide`, { decision, comment: comment || null, conditions: cond || null }); toast(decision === "approved" ? "Aprobado" : "Rechazado", "ok"); setReject(null); setComment(""); setCond(""); await reload(); } catch (e) { toast(errorMessage(e), "error"); } };
  const delegate = async (a: Any) => { const to = prompt("Email del usuario al que delegar"); const u = users.find((x) => x.email === to?.trim()); if (!u) return toast("Usuario no encontrado", "error"); const reason = prompt("Motivo") ?? ""; try { await api.post(`clm/approvals/${a.id}/delegate`, { to_user_id: u.id, reason }); await reload(); } catch (e) { toast(errorMessage(e), "error"); } };
  const rounds = Array.from(new Set(c.approvals.map((a) => String(a.version_sha256))));
  return (
    <div>
      {c.approvals.length === 0 && <div className="card"><p className="muted">Aún no se ha pedido aprobación.</p>{c.approval_preview.length > 0 && <><h3 className="mt12 mb8">Pasos que se pedirán</h3>{c.approval_preview.map((s, i) => <div key={i} className="small" style={{ padding: "3px 0" }}>{i + 1}. <b>{s.name}</b> · {s.reason} · {users.find((u) => u.id === s.approver_user_id)?.name ?? s.approver_role} · SLA {s.sla_hours} h</div>)}</>}</div>}
      {rounds.map((sha, ri) => (
        <div key={sha} className="card mb12"><div className="card-title"><h3>Ronda {rounds.length - ri} · versión {String(c.versions.find((v) => v.sha256 === sha)?.label ?? sha.slice(0, 8))}</h3><span className="xs muted">hash {sha.slice(0, 12)}…</span></div>
          <div className="flow">{c.approvals.filter((a) => a.version_sha256 === sha).map((a) => (
            <div key={String(a.id)} className={`fstep ${String(a.status)}`}>
              <div className="row between"><b>{String(a.step_name)}</b>{pill(APPROVAL_STATUS, String(a.status))}</div>
              <div className="xs muted">{String(a.reason ?? "")}</div>
              <div className="row small mt8"><Avatar name={String(a.approver_name ?? "política")} size="sm" /><span>{String(a.approver_name ?? "Automática")}</span>{!!a.due_at && a.status === "pending" && <span className="right xs" style={{ color: String(a.due_at) < new Date().toISOString() ? "var(--risk)" : undefined }}>vence {relTime(String(a.due_at))}</span>}</div>
              {!!a.decided_at && <div className="xs muted mt8">{String(a.decided_by_name ?? "")} · {fmtDateTime(String(a.decided_at))}{a.comment ? ` · ${String(a.comment)}` : ""}{a.conditions ? ` · condición: ${String(a.conditions)}` : ""}</div>}
              {a.status === "pending" && (a.approver_user_id === me.id || me.role.permissions.admin) && <div className="row mt8"><button className="btn sm primary" onClick={() => decide(a, "approved")}><Check />Aprobar</button><button className="btn sm" onClick={() => setReject(a)}>Rechazar / condicionar</button><button className="btn sm ghost" onClick={() => delegate(a)}>Delegar</button></div>}
            </div>))}</div>
        </div>))}
      {reject && <Modal title={`${String(reject.step_name)}: decisión`} onClose={() => setReject(null)} footer={<><button className="btn" onClick={() => setReject(null)}>Cancelar</button><button className="btn primary" disabled={!cond.trim()} onClick={() => decide(reject, "approved")}>Aprobar con condición</button><button className="btn danger" disabled={!comment.trim()} onClick={() => decide(reject, "rejected")}>Rechazar</button></>}><div className="col" style={{ gap: 12 }}><Field label="Condición (aprobar si…)" hint="Crea una tarea para legal; ej. «cambiar E01 a ALT1»"><input className="input" value={cond} onChange={(e) => setCond(e.target.value)} /></Field><Field label="Motivo del rechazo"><textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} /></Field></div></Modal>}
    </div>
  );
}

function SignatureTab({ c, reload, editable }: { c: Detail; reload: () => Promise<unknown>; editable: boolean }) {
  const { users, me } = useApp();
  const toast = useToast();
  const [signers, setSigners] = useState<Any[]>(() => [{ name: me.name, email: me.email, party: "us", role: "signer", user_id: me.id, title: "" }]);
  const [level, setLevel] = useState(c.min_signature_level);
  const [message, setMessage] = useState("");
  const [check, setCheck] = useState<{ errors: string[]; warnings: string[] } | null>(null);
  const [contacts, setContacts] = useState<Any[]>([]);
  useEffect(() => { if (c.counterparty_company_id) api.get<{ contacts: Any[] }>(`companies/${c.counterparty_company_id}`).then((r) => { setContacts(r.contacts ?? []); const first = (r.contacts ?? []).find((x) => x.email); if (first && !signers.some((s) => s.party === "them")) setSigners((s) => [...s, { name: `${first.first_name} ${first.last_name}`, email: first.email, party: "them", role: "signer", contact_id: first.id, title: first.job_title ?? "" }]); }).catch(() => undefined); /* eslint-disable-next-line */ }, [c.counterparty_company_id]);
  useEffect(() => { if (c.status === "APPROVED") api.post<{ errors: string[]; warnings: string[] }>(`clm/contracts/${c.id}/checklist`, { signers }).then(setCheck).catch(() => undefined); }, [signers, c.id, c.status]);
  const send = async () => { try { await api.post(`clm/contracts/${c.id}/envelopes`, { signers, level, message: message || undefined }); toast("Sobre de firma enviado", "ok"); await reload(); } catch (e) { toast(errorMessage(e), "error"); } };
  const upd = (i: number, p: Any) => setSigners((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const current = c.envelopes[0];
  return (
    <div>
      {c.status === "APPROVED" && editable && (
        <div className="card mb12"><h3 className="mb8"><PenTool size={15} /> Preparar sobre de firma</h3>
          <div className="row wrap mb8"><Field label="Nivel de firma (mínimo del tipo: {c.min_signature_level})"><select className="input sm" value={level} onChange={(e) => setLevel(e.target.value)}><option value="SES">SES · simple con OTP</option><option value="AdES">AdES · avanzada</option><option value="QES">QES · cualificada</option></select></Field><Field label="Mensaje para los firmantes"><input className="input sm" style={{ width: 360 }} value={message} onChange={(e) => setMessage(e.target.value)} /></Field></div>
          <table className="table"><thead><tr><th>Orden</th><th>Parte</th><th>Nombre</th><th>Email</th><th>Cargo</th><th>Rol</th><th /></tr></thead><tbody>
            {signers.map((s, i) => <tr key={i}><td className="num">{i + 1}</td><td><select className="input sm" value={String(s.party)} onChange={(e) => upd(i, { party: e.target.value })}><option value="us">Nosotros</option><option value="them">Contraparte</option></select></td><td>{s.party === "us" ? <select className="input sm" value={String(s.user_id ?? "")} onChange={(e) => { const u = users.find((x) => x.id === e.target.value); upd(i, { user_id: u?.id ?? null, name: u?.name ?? s.name, email: u?.email ?? s.email }); }}><option value="">— externo —</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select> : <input className="input sm" list={`cts${i}`} value={String(s.name)} onChange={(e) => { const ct = contacts.find((x) => `${x.first_name} ${x.last_name}` === e.target.value); upd(i, { name: e.target.value, ...(ct ? { email: ct.email, contact_id: ct.id, title: ct.job_title ?? "" } : {}) }); }} />}<datalist id={`cts${i}`}>{contacts.map((x) => <option key={String(x.id)} value={`${x.first_name} ${x.last_name}`} />)}</datalist></td><td><input className="input sm" value={String(s.email)} onChange={(e) => upd(i, { email: e.target.value })} /></td><td><input className="input sm" value={String(s.title ?? "")} onChange={(e) => upd(i, { title: e.target.value })} /></td><td><select className="input sm" value={String(s.role)} onChange={(e) => upd(i, { role: e.target.value })}><option value="signer">Firmante</option><option value="approver">Visto bueno</option><option value="witness">Testigo</option><option value="cc">Copia</option></select></td><td><button className="iconbtn" onClick={() => setSigners((x) => x.filter((_, j) => j !== i))} aria-label="Borrar"><Trash2 size={14} /></button></td></tr>)}
          </tbody></table>
          <div className="row mt8"><button className="btn sm" onClick={() => setSigners((s) => [...s, { name: "", email: "", party: "them", role: "signer", title: "" }])}><Plus />Firmante</button><span className="xs muted">Orden: la contraparte firma tras nosotros. Los firmantes internos deben tener poderes vigentes (Configurar CLM → Poderes).</span></div>
          {check && <div className="mt12">{check.errors.map((e) => <div key={e} className="small row" style={{ color: "var(--risk-ink)" }}><XCircle size={14} /> {e}</div>)}{check.warnings.map((w) => <div key={w} className="small row" style={{ color: "var(--warn-ink)" }}><ShieldAlert size={14} /> {w}</div>)}{check.errors.length === 0 && <div className="small row ok"><Check size={14} /> Checklist pre-firma superado</div>}</div>}
          <div className="row mt12"><button className="btn primary" disabled={!!check?.errors.length || !signers.length} onClick={send}><Send />Enviar a firma</button></div>
        </div>)}
      {c.envelopes.length === 0 && c.status !== "APPROVED" && <div className="card"><p className="muted">{["ACTIVE", "EXPIRED", "TERMINATED", "RENEWED"].includes(c.status) ? "Contrato firmado en papel o importado: sin sobre electrónico." : "El contrato debe estar aprobado para enviarlo a firma."}</p></div>}
      {c.envelopes.map((e, i) => (
        <div key={String(e.id)} className="card mb12">
          <div className="card-title"><h3>Sobre {i === 0 ? "actual" : "anterior"} · {pill(ENV_STATUS, String(e.status))} · nivel {String(e.level)}</h3><span className="small sub">enviado {e.sent_at ? fmtDateTime(String(e.sent_at)) : "—"}{e.completed_at ? ` · completado ${fmtDateTime(String(e.completed_at))}` : e.expires_at ? ` · caduca ${fmtDate(String(e.expires_at))}` : ""}</span>{["sent", "in_progress"].includes(String(e.status)) && editable && <span className="row"><button className="btn xs" onClick={() => api.post(`clm/envelopes/${e.id}/remind`).then(() => toast("Recordatorio enviado", "ok"))}><Bell />Recordar</button><button className="btn xs" onClick={() => { const r = prompt("Motivo de cancelación"); if (r) api.post(`clm/envelopes/${e.id}/cancel`, { reason: r }).then(reload); }}><XCircle />Cancelar</button></span>}</div>
          <table className="table"><thead><tr><th>#</th><th>Firmante</th><th>Parte</th><th>Estado</th><th>Visto</th><th>Firmado</th><th>IP</th><th>Enlace</th></tr></thead><tbody>
            {(e.signers as Any[]).map((s) => <tr key={String(s.id)}><td className="num">{String(s.order_no)}</td><td><b>{String(s.name)}</b><div className="xs muted">{String(s.email)}{s.title ? ` · ${String(s.title)}` : ""}</div></td><td>{s.party === "us" ? "Nosotros" : "Contraparte"}</td><td>{pill(SIGNER_STATUS, String(s.status))}{s.declined_reason ? <div className="xs muted">{String(s.declined_reason)}</div> : null}</td><td className="small">{s.viewed_at ? relTime(String(s.viewed_at)) : "—"}</td><td className="small">{s.signed_at ? fmtDateTime(String(s.signed_at)) : "—"}</td><td className="xs muted">{String(s.ip ?? "")}</td><td>{s.status === "pending" && ["sent", "in_progress"].includes(String(e.status)) && <a className="btn xs" href={`/s/${s.token}`} target="_blank" rel="noreferrer"><ExternalLink />Página de firma</a>}</td></tr>)}
          </tbody></table>
          {!!e.final_sha256 && <p className="small mt8 ok"><Lock size={12} /> Documento final sellado · SHA-256 <span className="num">{String(e.final_sha256)}</span> · evidencias conservadas (identidad por OTP, IP, dispositivo, sello de tiempo) · copia enviada a todas las partes.</p>}
          <details className="mt8"><summary className="small sub" style={{ cursor: "pointer" }}>Registro de evidencias ({(e.events as Any[]).length})</summary><table className="table mt8"><tbody>{(e.events as Any[]).map((ev) => <tr key={String(ev.id)}><td className="xs num">{fmtDateTime(String(ev.at))}</td><td className="xs">{String(ev.signer_name ?? "")}</td><td className="xs"><span className="badge">{String(ev.type)}</span></td><td className="xs muted">{String(ev.ip ?? "")}</td></tr>)}</tbody></table></details>
        </div>))}
    </div>
  );
}

function ObligationsTab({ c, reload, editable }: { c: Detail; reload: () => Promise<unknown>; editable: boolean }) {
  const toast = useToast();
  const { users } = useApp();
  const [form, setForm] = useState<Any | null>(null);
  const [fulfil, setFulfil] = useState<Any | null>(null);
  const [note, setNote] = useState("");
  const save = async () => { if (!form) return; try { if (form.id) await api.patch(`clm/obligations/${form.id}`, form); else await api.post(`clm/contracts/${c.id}/obligations`, form); toast("Guardado", "ok"); setForm(null); await reload(); } catch (e) { toast(errorMessage(e), "error"); } };
  const done = async () => { if (!fulfil) return; try { await api.patch(`clm/obligations/${fulfil.id}`, { status: "fulfilled", evidence_note: note || null }); toast("Obligación cumplida", "ok"); setFulfil(null); setNote(""); await reload(); } catch (e) { toast(errorMessage(e), "error"); } };
  const groups = [["breached", "Incumplidas"], ["pending", "Pendientes"], ["in_progress", "En curso"], ["fulfilled", "Cumplidas"], ["waived", "Dispensadas"], ["na", "No aplican"]] as const;
  return (
    <div>
      <div className="filterbar"><span className="small sub">Catálogo: pagos, entregas, informes, SLA, seguros, auditoría, confidencialidad, preavisos… Las recurrentes generan la siguiente instancia al cumplirse. Las supervivientes siguen tras la terminación.</span>{editable && <button className="btn primary right" onClick={() => setForm({ title: "", type: "other", obligor: "us", owner_id: c.owner_id, due_date: "", recurrence: "none", evidence_required: false, survives_termination: false })}><Plus />Obligación</button>}</div>
      {groups.filter(([k]) => c.obligations.some((o) => o.status === k)).map(([k, label]) => (
        <div key={k} className="mgroup" style={{ "--gc": OBL_STATUS[k]?.color } as React.CSSProperties}><div className="ghead"><h2>{label}</h2><span className="count">{c.obligations.filter((o) => o.status === k).length}</span></div>
          <div className="card tight"><table className="table"><thead><tr><th>Obligación</th><th>Tipo</th><th>Quién</th><th>Responsable</th><th>Vence</th><th>Recurrencia</th><th>Evidencia</th><th /></tr></thead><tbody>
            {c.obligations.filter((o) => o.status === k).map((o) => <tr key={String(o.id)}><td><b>{String(o.title)}</b>{o.source_clause ? <span className="xs muted"> · {String(o.source_clause)}</span> : null}{o.ai_extracted ? <span className="xs muted" title="Propuesta automáticamente a partir de las cláusulas"> · auto</span> : null}{o.survives_termination ? <span className="badge xs" style={{ marginLeft: 4 }}>superviviente</span> : null}{o.description ? <div className="xs muted">{String(o.description)}</div> : null}</td><td>{OBL_TYPE[String(o.type)]}</td><td>{o.obligor === "us" ? "Nosotros" : "Contraparte"}</td><td>{String(o.owner_name ?? "")}</td><td className="num" style={{ color: o.status === "breached" ? "var(--risk)" : undefined }}>{o.due_date ? fmtDate(String(o.due_date)) : "—"}{o.amount ? <div className="xs muted">{fmtMoney(Number(o.amount), String(o.currency ?? c.currency))}</div> : null}</td><td className="muted">{o.recurrence === "none" ? "—" : String(o.recurrence)}</td><td className="small">{o.evidence_note ? String(o.evidence_note) : o.evidence_required ? <span className="muted">requerida</span> : "—"}</td><td className="r nowrap">{["pending", "in_progress", "breached"].includes(String(o.status)) && editable && <button className="btn xs primary" onClick={() => setFulfil(o)}>Cumplir</button>}{editable && <button className="iconbtn" onClick={() => setForm({ ...o, evidence_required: !!o.evidence_required, survives_termination: !!o.survives_termination })} aria-label="Editar"><Pencil size={14} /></button>}{editable && <button className="iconbtn" onClick={() => api.del(`clm/obligations/${o.id}`).then(reload)} aria-label="Borrar"><Trash2 size={14} /></button>}</td></tr>)}
          </tbody></table></div></div>))}
      {c.obligations.length === 0 && <div className="card"><p className="muted">Sin obligaciones. Se proponen automáticamente al activar el contrato a partir de sus cláusulas.</p></div>}
      {form && <Modal title={form.id ? "Editar obligación" : "Nueva obligación"} onClose={() => setForm(null)} footer={<><button className="btn" onClick={() => setForm(null)}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}><div className="form-grid">
        <Field label="Título" full><input className="input" value={String(form.title)} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        <Field label="Tipo"><select className="input" value={String(form.type)} onChange={(e) => setForm({ ...form, type: e.target.value })}>{Object.entries(OBL_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Obligado"><select className="input" value={String(form.obligor)} onChange={(e) => setForm({ ...form, obligor: e.target.value })}><option value="us">Nosotros</option><option value="them">La contraparte</option></select></Field>
        <Field label="Responsable"><select className="input" value={String(form.owner_id ?? "")} onChange={(e) => setForm({ ...form, owner_id: e.target.value || null })}>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <Field label="Vencimiento"><input className="input" type="date" value={String(form.due_date ?? "").slice(0, 10)} onChange={(e) => setForm({ ...form, due_date: e.target.value || null })} /></Field>
        <Field label="Recurrencia"><select className="input" value={String(form.recurrence)} onChange={(e) => setForm({ ...form, recurrence: e.target.value })}><option value="none">Sin recurrencia</option><option value="weekly">Semanal</option><option value="monthly">Mensual</option><option value="quarterly">Trimestral</option><option value="yearly">Anual</option></select></Field>
        <Field label="Importe"><input className="input" type="number" value={String(form.amount ?? "")} onChange={(e) => setForm({ ...form, amount: e.target.value === "" ? null : Number(e.target.value) })} /></Field>
        <Field label="Descripción" full><input className="input" value={String(form.description ?? "")} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        <label className="checkbox"><input type="checkbox" checked={!!form.evidence_required} onChange={(e) => setForm({ ...form, evidence_required: e.target.checked })} />Exige evidencia al cumplir</label>
        <label className="checkbox"><input type="checkbox" checked={!!form.survives_termination} onChange={(e) => setForm({ ...form, survives_termination: e.target.checked })} />Sobrevive a la terminación</label>
        {!!form.survives_termination && <Field label="Vigente hasta"><input className="input" type="date" value={String(form.survival_until ?? "").slice(0, 10)} onChange={(e) => setForm({ ...form, survival_until: e.target.value || null })} /></Field>}
      </div></Modal>}
      {fulfil && <Modal title={`Cumplir: ${String(fulfil.title)}`} onClose={() => setFulfil(null)} footer={<><button className="btn" onClick={() => setFulfil(null)}>Cancelar</button><button className="btn primary" disabled={!!fulfil.evidence_required && !note.trim()} onClick={done}>Marcar cumplida</button></>}><Field label={fulfil.evidence_required ? "Evidencia (obligatoria): referencia de factura, enlace, descripción…" : "Evidencia (opcional)"}><textarea className="input" autoFocus value={note} onChange={(e) => setNote(e.target.value)} /></Field></Modal>}
    </div>
  );
}

function MilestonesTab({ c, reload, editable }: { c: Detail; reload: () => Promise<unknown>; editable: boolean }) {
  const toast = useToast();
  const [form, setForm] = useState<Any | null>(null);
  const action = async (m: Any) => { const a = prompt("Acción tomada (renovar / no renovar / renegociar / posponer / visto)", m.type === "notice_deadline" ? "renovar" : "visto"); if (!a) return; try { await api.post(`clm/milestones/${m.id}/action`, { action: a }); await reload(); } catch (e) { toast(errorMessage(e), "error"); } };
  const save = async () => { if (!form) return; try { await api.post(`clm/contracts/${c.id}/milestones`, { ...form, alert_offsets: String(form.offsets).split(",").map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n)) }); setForm(null); await reload(); } catch (e) { toast(errorMessage(e), "error"); } };
  const setPay = async (p: Any, status: string) => { try { await api.patch(`clm/payments/${p.id}`, { status, invoice_ref: status === "invoiced" ? prompt("Referencia de factura") ?? undefined : undefined }); await reload(); } catch (e) { toast(errorMessage(e), "error"); } };
  const paid = c.payments.filter((p) => p.status === "paid").reduce((a, p) => a + Number(p.amount), 0), total = c.payments.reduce((a, p) => a + Number(p.amount), 0);
  return (
    <div className="charts">
      <div className="card"><div className="card-title"><h3><CalendarClock size={15} /> Hitos y alertas</h3>{editable && <button className="btn xs" onClick={() => setForm({ type: "custom", label: "", date: "", offsets: "30,7,1" })}><Plus />Hito</button>}</div>
        {c.milestones.length === 0 && <p className="muted small">Los hitos (inicio, fin, preaviso, renovación) se calculan al activar el contrato.</p>}
        {c.milestones.map((m) => <div key={String(m.id)} className="row small" style={{ padding: "7px 0", borderBottom: "1px solid var(--rule2)" }}><i className={`ddot ${m.status === "passed" ? "" : (daysUntil(String(m.date)) ?? 99) < 0 ? "late" : (daysUntil(String(m.date)) ?? 99) <= 30 ? "soon" : ""}`} style={m.status === "passed" ? { background: "var(--c-grey)" } : undefined} /><div className="grow"><b>{String(m.label)}</b> <span className="muted">· {MS_TYPE[String(m.type)]}{m.computed ? " · calculado" : ""}</span><div className="xs muted">Alertas a {(m.alert_offsets as number[]).join(", ")} días{(m.alerted as number[]).length ? ` · enviadas: ${(m.alerted as number[]).join(", ")}` : ""}{m.action_taken ? ` · acción: ${String(m.action_taken)}` : ""}</div></div><span className="num">{fmtDate(String(m.date))}</span><span className="badge">{m.status === "passed" ? "pasado" : m.status === "actioned" ? "gestionado" : m.status === "alerted" ? "alertado" : `${daysUntil(String(m.date))} d`}</span>{["upcoming", "alerted"].includes(String(m.status)) && editable && <button className="btn xs" onClick={() => action(m)}>Gestionar</button>}</div>)}
        {c.renewals.length > 0 && <><h3 className="mt16 mb8">Decisiones de renovación</h3>{c.renewals.map((r) => <div key={String(r.id)} className="small" style={{ padding: "3px 0" }}><span className="badge">{String(r.decision)}</span> {fmtDateTime(String(r.decided_at))} · {String(r.decided_by_name ?? "sistema")}{r.reason ? ` · ${String(r.reason)}` : ""}</div>)}</>}
      </div>
      <div className="card"><div className="card-title"><h3>Calendario de pagos</h3><span className="small sub">{fmtMoney(paid, c.currency)} cobrado/pagado de {fmtMoney(total, c.currency)}</span></div>
        {c.payments.length === 0 ? <p className="muted small">Se genera al activar el contrato según el modelo de pago.</p> : <table className="table"><thead><tr><th>Concepto</th><th>Vence</th><th className="r">Importe</th><th>Estado</th><th>Factura</th><th /></tr></thead><tbody>{c.payments.map((p) => <tr key={String(p.id)}><td>{String(p.label)}</td><td className="num">{fmtDate(String(p.due_date))}</td><td className="r num">{fmtMoney(Number(p.amount), String(p.currency))}</td><td>{pill(PAY_STATUS, String(p.status))}</td><td className="small muted">{String(p.invoice_ref ?? "")}</td><td className="r nowrap">{editable && p.status !== "paid" && <><button className="btn xs" onClick={() => setPay(p, "invoiced")}>Facturado</button><button className="btn xs primary" onClick={() => setPay(p, "paid")}>Pagado</button></>}</td></tr>)}</tbody></table>}
      </div>
      {form && <Modal title="Nuevo hito" onClose={() => setForm(null)} footer={<><button className="btn" onClick={() => setForm(null)}>Cancelar</button><button className="btn primary" disabled={!form.label || !form.date} onClick={save}>Guardar</button></>}><div className="form-grid"><Field label="Tipo"><select className="input" value={String(form.type)} onChange={(e) => setForm({ ...form, type: e.target.value })}>{Object.entries(MS_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field><Field label="Fecha"><input className="input" type="date" value={String(form.date)} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field><Field label="Etiqueta" full><input className="input" value={String(form.label)} onChange={(e) => setForm({ ...form, label: e.target.value })} /></Field><Field label="Alertas (días antes, separados por comas)" full><input className="input" value={String(form.offsets)} onChange={(e) => setForm({ ...form, offsets: e.target.value })} /></Field></div></Modal>}
    </div>
  );
}

function FamilyTab({ c, reload, onAmend, onRenew, onTerminate }: { c: Detail; reload: () => Promise<unknown>; onAmend: () => void; onRenew: () => void; onTerminate: () => void }) {
  const toast = useToast();
  const hist = ((c.effective_values?.__history as Any[]) ?? []);
  const decide = async (decision: string) => { const reason = prompt("Motivo (opcional)") ?? ""; try { await api.post(`clm/contracts/${c.id}/renewal-decision`, { decision, reason }); toast("Decisión registrada", "ok"); await reload(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <div className="charts">
      <div className="card"><div className="card-title"><h3><GitBranch size={15} /> Familia</h3><div className="row">{c.status === "ACTIVE" && <button className="btn xs" onClick={onAmend}><Plus />Enmienda</button>}{["ACTIVE", "EXPIRED"].includes(c.status) && <button className="btn xs" onClick={onRenew}><RefreshCw />Renovación</button>}{c.status === "ACTIVE" && <button className="btn xs" style={{ color: "var(--risk-ink)" }} onClick={onTerminate}><XCircle />Terminar</button>}</div></div>
        {c.parent_id && <div className="small mb8">Padre: <Link to={`/contratos/${c.parent_id}`}>{c.parent_number} · {c.parent_title}</Link></div>}
        {c.children.length === 0 ? <p className="muted small">Sin enmiendas ni renovaciones.</p> : <table className="table"><thead><tr><th>Número</th><th>Tipo</th><th>Título</th><th>Estado</th><th className="r">Valor</th><th>Vigencia</th></tr></thead><tbody>{c.children.map((k) => <tr key={String(k.id)}><td><Link to={`/contratos/${k.id}`}>{String(k.number)}</Link></td><td>{KIND[String(k.kind)]}{k.amendment_type ? ` · ${String(k.amendment_type)}` : ""}</td><td>{String(k.title)}</td><td>{pill(CSTATUS, String(k.status))}</td><td className="r num">{fmtMoney(Number(k.total_value), c.currency)}</td><td className="small">{k.effective_date ? fmtDate(String(k.effective_date)) : "—"}{k.end_date ? ` → ${fmtDate(String(k.end_date))}` : ""}</td></tr>)}</tbody></table>}
        {hist.length > 0 && <><h3 className="mt16 mb8">Valores vigentes (historial)</h3><table className="table"><thead><tr><th>Campo</th><th>Original</th><th>Vigente</th><th>Desde</th><th>Origen</th></tr></thead><tbody>{hist.map((h, i) => <tr key={i}><td>{String(h.field)}</td><td className="muted">{String(h.from ?? "—")}</td><td className="bold">{String(h.to)}</td><td className="small">{fmtDate(String(h.since))}</td><td className="small">{String(h.source)}</td></tr>)}</tbody></table></>}
      </div>
      <div className="card"><h3 className="mb8"><RefreshCw size={15} /> Expediente de renovación</h3>
        {c.status !== "ACTIVE" ? <p className="muted small">Solo para contratos activos.</p> : <>
          <dl className="kv"><dt>Fin de vigencia</dt><dd>{c.end_date ? `${fmtDate(c.end_date)} (${daysUntil(c.end_date)} d)` : "indefinido"}</dd><dt>Límite de preaviso</dt><dd>{c.notice_deadline ? `${fmtDate(c.notice_deadline)} (${daysUntil(c.notice_deadline)} d)` : "—"}</dd><dt>Tipo de renovación</dt><dd>{RENEWAL[c.renewal_type]?.label}</dd><dt>Valor vigente</dt><dd>{fmtMoney(c.annual_value, c.currency)} /año</dd><dt>Obligaciones</dt><dd>{c.obligations.filter((o) => o.status === "fulfilled").length} cumplidas · {c.obligations.filter((o) => o.status === "breached").length} incumplidas</dd><dt>Enmiendas</dt><dd>{c.children.filter((k) => k.kind === "amendment").length}</dd><dt>Desviaciones del playbook actual</dt><dd>{c.clauses.filter((x) => x.deviation_level !== "none").length}</dd></dl>
          <p className="small sub mt8">Recomendación: {c.obligations.some((o) => o.status === "breached") ? "renegociar (hay incumplimientos registrados)" : c.clauses.some((x) => ["major", "prohibited"].includes(String(x.deviation_level))) ? "renegociar (cláusulas fuera del playbook vigente)" : c.renewal_type === "auto" ? "renovar igual, registrando la decisión consciente" : "renovar por acuerdo"}.</p>
          <div className="row wrap mt12"><button className="btn sm primary" onClick={() => decide("renew")}>Renovar igual</button><button className="btn sm" onClick={onRenew}>Renegociar (abrir renovación)</button><button className="btn sm" style={{ color: "var(--risk-ink)" }} onClick={() => decide("not_renew")}>No renovar (carta de preaviso)</button><button className="btn sm ghost" onClick={() => decide("postpone")}>Posponer</button></div>
          <p className="xs muted mt8">Si llega el fin sin decisión y la renovación es automática, el sistema registra «renovación automática por inacción», avisa escalando y crea una tarea de revisión.</p>
        </>}
      </div>
    </div>
  );
}

function ActivityTab({ c, reload }: { c: Detail; reload: () => Promise<unknown> }) {
  const [body, setBody] = useState("");
  const [vis, setVis] = useState<"internal" | "external">("internal");
  const toast = useToast();
  const post = async () => { if (!body.trim()) return; try { await api.post(`clm/contracts/${c.id}/comments`, { body, visibility: vis }); setBody(""); await reload(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <div className="charts">
      <div className="card"><h3 className="mb8"><HistoryIcon size={15} /> Memoria de negociación</h3>
        <div className="tl">{c.timeline.map((t) => <div key={String(t.id)} className={`tlrow ${String(t.actor_type)}`}><span className="tlico">{TIMELINE_ICON[String(t.type)] ?? "•"}</span><div className="grow"><div className="small"><b>{String(t.title)}</b></div>{!!t.body && <div className="small muted" style={{ whiteSpace: "pre-wrap" }}>{String(t.body)}</div>}<div className="xs muted">{String(t.actor_name ?? "")}{t.actor_type === "agent" ? " (agente)" : t.actor_type === "external" ? " (externo)" : ""} · {relTime(String(t.at))}</div></div></div>)}</div>
      </div>
      <div className="card"><h3 className="mb8"><MessageSquare size={15} /> Comentarios</h3>
        <div className="row mb8"><Seg items={[{ key: "internal", label: "Interno" }, { key: "external", label: "Visible para la contraparte" }]} value={vis} onChange={setVis} /></div>
        <textarea className="input" placeholder="Escribe un comentario…" value={body} onChange={(e) => setBody(e.target.value)} /><div className="row mt8"><button className="btn primary sm" onClick={post}>Comentar</button></div>
        <div className="mt12">{c.comments.map((m) => <div key={String(m.id)} className="small" style={{ padding: "8px 0", borderBottom: "1px solid var(--rule2)" }}><div className="row"><Avatar name={String(m.author_name)} size="sm" /><b>{String(m.author_name)}</b><span className={`badge xs ${m.visibility === "external" ? "warn" : ""}`}>{m.visibility === "external" ? "externo" : "interno"}</span><span className="xs muted right">{relTime(String(m.created_at))}</span></div><div className="mt8" style={{ whiteSpace: "pre-wrap" }}>{String(m.body)}</div></div>)}</div>
      </div>
    </div>
  );
}

/* ---------- modales ---------- */
function NoteModal({ title, label, onClose, onOk }: { title: string; label: string; onClose: () => void; onOk: (note: string) => void }) {
  const [v, setV] = useState("");
  return <Modal title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!v.trim()} onClick={() => onOk(v)}>Confirmar</button></>}><Field label={label}><textarea className="input" autoFocus value={v} onChange={(e) => setV(e.target.value)} /></Field></Modal>;
}
function SendToCounterparty({ c, onClose, onOk }: { c: Detail; onClose: () => void; onOk: (p: Any) => void }) {
  const [email, setEmail] = useState(""); const [note, setNote] = useState("");
  useEffect(() => { if (c.counterparty_company_id) api.get<{ contacts: Any[] }>(`companies/${c.counterparty_company_id}`).then((r) => setEmail(String(r.contacts?.find((x) => x.email)?.email ?? ""))).catch(() => undefined); }, [c.counterparty_company_id]);
  return <Modal title="Enviar a la contraparte" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={() => onOk({ contact_email: email || undefined, note })}><Send />Enviar</button></>}><div className="col" style={{ gap: 12 }}><p className="small sub">Se crea una versión externa (rama de intercambio), se bloquea el SLA interno y se envía el documento por email.</p><Field label="Email del contacto de negociación"><input className="input" value={email} onChange={(e) => setEmail(e.target.value)} /></Field><Field label="Mensaje"><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field></div></Modal>;
}
function ReceiveVersion({ onClose, onOk }: { onClose: () => void; onOk: (p: Any) => void }) {
  const [body, setBody] = useState(""); const [file, setFile] = useState(""); const [note, setNote] = useState("");
  return <Modal title="Registrar versión recibida de la contraparte" size="lg" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={body.trim().length < 20} onClick={() => onOk({ body, file_name: file || undefined, note })}>Registrar y analizar</button></>}><div className="col" style={{ gap: 12 }}><p className="small sub">Se calcula el hash (sin duplicados), se compara con la última versión enviada, se extraen cláusulas y se evalúa contra el playbook.</p><Field label="Nombre del archivo"><input className="input" value={file} onChange={(e) => setFile(e.target.value)} placeholder="contrato-v2-cliente.docx" /></Field><Field label="Texto recibido"><textarea className="input" style={{ minHeight: 220, fontFamily: "ui-monospace, monospace", fontSize: 12.5 }} value={body} onChange={(e) => setBody(e.target.value)} /></Field><Field label="Nota"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field></div></Modal>;
}
function Terminate({ c, onClose, onOk }: { c: Detail; onClose: () => void; onOk: (p: Any) => void }) {
  const [cause, setCause] = useState("convenience"); const [date, setDate] = useState(new Date(Date.now() + (c.notice_period_days ?? 0) * 864e5).toISOString().slice(0, 10)); const [note, setNote] = useState("");
  return <Modal title="Terminar el contrato" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn danger" onClick={() => onOk({ cause, date, note })}>Terminar y generar carta</button></>}><div className="form-grid"><Field label="Causa"><select className="input" value={cause} onChange={(e) => setCause(e.target.value)}>{Object.entries(TERMINATION_CAUSES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field><Field label="Fecha de efectos" hint={c.notice_period_days ? `Preaviso contractual: ${c.notice_period_days} días` : undefined}><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field><Field label="Nota / requerimiento previo" full><textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={cause === "breach" ? "Obligatorio: requerimiento previo y plazo de subsanación" : ""} /></Field><p className="xs muted" style={{ gridColumn: "1 / -1" }}>Se genera la carta de terminación desde la plantilla, se cierran las obligaciones no supervivientes, se crean las obligaciones de salida (datos, accesos, pagos) y se programa la retención.</p></div></Modal>;
}
function AmendmentModal({ c, meta, onClose, onSaved }: { c: Detail; meta: ReturnType<typeof useClmMeta>["meta"]; onClose: () => void; onSaved: (a: { id: string }) => void }) {
  const toast = useToast();
  const [type, setType] = useState("amendment"); const [changes, setChanges] = useState<Any>({}); const [clause, setClause] = useState(""); const [tpl, setTpl] = useState("");
  const set = (k: string, v: unknown) => setChanges((x) => { const n = { ...x }; if (v === "" || v === null || v === undefined) delete n[k]; else n[k] = v; return n; });
  const save = async () => { try { const a = await api.post<{ id: string }>(`clm/contracts/${c.id}/amendments`, { type, changes, clause_text: clause || undefined, template_id: tpl || null }); toast("Enmienda creada en borrador", "ok"); onSaved(a); } catch (e) { toast(errorMessage(e), "error"); } };
  const tpls = (meta?.templates ?? []).filter((t) => t.kind === "amendment");
  return <Modal title={`Nueva modificación de ${c.number}`} size="lg" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!Object.keys(changes).length && !clause.trim()} onClick={save}>Crear enmienda</button></>}><div className="form-grid">
    <Field label="Tipo"><select className="input" value={type} onChange={(e) => setType(e.target.value)}><option value="amendment">Enmienda / adenda</option><option value="change_order">Orden de cambio (alcance y precio)</option><option value="extension">Prórroga</option><option value="price_update">Actualización de precio</option><option value="assignment">Cesión</option><option value="novation">Novación</option><option value="side_letter">Carta complementaria</option></select></Field>
    <Field label="Plantilla"><select className="input" value={tpl} onChange={(e) => setTpl(e.target.value)}><option value="">Enmienda genérica</option>{tpls.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
    <Field label="Nueva fecha de fin"><input className="input" type="date" onChange={(e) => set("end_date", e.target.value)} /></Field>
    <Field label="Nuevo valor anual"><input className="input" type="number" placeholder={String(c.annual_value)} onChange={(e) => { set("annual_value", e.target.value === "" ? "" : Number(e.target.value)); set("total_value", e.target.value === "" ? "" : Number(e.target.value)); }} /></Field>
    <Field label="Nuevo preaviso (días)"><input className="input" type="number" placeholder={String(c.notice_period_days ?? "")} onChange={(e) => set("notice_period_days", e.target.value === "" ? "" : Number(e.target.value))} /></Field>
    <Field label="Nuevo plazo de pago (días)"><input className="input" type="number" placeholder={String(c.payment_terms_days)} onChange={(e) => set("payment_terms_days", e.target.value === "" ? "" : Number(e.target.value))} /></Field>
    <Field label="Nueva redacción de cláusulas" full><textarea className="input" value={clause} onChange={(e) => setClause(e.target.value)} placeholder="La cláusula X queda redactada como sigue: …" /></Field>
    <p className="xs muted" style={{ gridColumn: "1 / -1" }}>La enmienda nace como contrato hijo ({c.number}-A0n) con su propio flujo de aprobación y firma. Al activarse, los valores vigentes del padre se actualizan y se regeneran hitos y pagos.</p>
  </div></Modal>;
}
function RenewalModal({ c, onClose, onSaved }: { c: Detail; onClose: () => void; onSaved: (a: { id: string } | null) => void }) {
  const toast = useToast();
  const [term, setTerm] = useState(c.term_months ?? 12); const [value, setValue] = useState(c.annual_value); const [notice, setNotice] = useState(c.notice_period_days ?? 60);
  const save = async () => { try { const a = await api.post<{ id: string }>(`clm/contracts/${c.id}/renewals`, { term_months: term, annual_value: value, total_value: value, notice_period_days: notice }); toast("Renovación creada en borrador", "ok"); onSaved(a); } catch (e) { toast(errorMessage(e), "error"); } };
  return <Modal title={`Renovación de ${c.number}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Crear renovación</button></>}><div className="form-grid"><Field label="Duración (meses)"><input className="input" type="number" value={term} onChange={(e) => setTerm(Number(e.target.value))} /></Field><Field label="Valor anual"><input className="input" type="number" value={value} onChange={(e) => setValue(Number(e.target.value))} /></Field><Field label="Preaviso (días)"><input className="input" type="number" value={notice} onChange={(e) => setNotice(Number(e.target.value))} /></Field><p className="xs muted" style={{ gridColumn: "1 / -1" }}>Se crea el contrato {c.number}-R0n con inicio {c.end_date ? fmtDate(new Date(new Date(c.end_date).getTime() + 864e5).toISOString()) : "hoy"}, generado desde la misma plantilla con los valores vigentes. Al firmarse, el contrato actual pasa a «Renovado».</p></div></Modal>;
}
function EditContract({ c, onClose, onSaved }: { c: Detail; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const toast = useToast(); const { users } = useApp();
  const [f, setF] = useState<Any>({ title: c.title, description: c.description ?? "", owner_id: c.owner_id, legal_owner_id: c.legal_owner_id, counterparty_company_id: c.counterparty_company_id, total_value: c.total_value, annual_value: c.annual_value, currency: c.currency, payment_model: c.payment_model, payment_terms_days: c.payment_terms_days, effective_date: c.effective_date ?? "", end_date: c.end_date ?? "", term_type: c.term_type, term_months: c.term_months ?? 12, renewal_type: c.renewal_type, renewal_period_months: c.renewal_period_months ?? 12, notice_period_days: c.notice_period_days ?? 0, governing_law: c.governing_law, jurisdiction: c.jurisdiction ?? "", contains_personal_data: !!c.contains_personal_data, data_role: c.data_role ?? "processor", international_transfer: !!c.international_transfer, confidentiality: c.confidentiality, urgency: c.urgency, tags: c.tags.join(", "), department: c.department ?? "" });
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const active = c.status === "ACTIVE";
  const save = async () => { try { await api.patch(`clm/contracts/${c.id}`, { ...f, effective_date: f.effective_date || null, end_date: f.end_date || null, jurisdiction: f.jurisdiction || null, department: f.department || null, description: f.description || null, tags: String(f.tags).split(",").map((t) => t.trim()).filter(Boolean), data_role: f.contains_personal_data ? f.data_role : null, term_months: Number(f.term_months) || null, renewal_period_months: Number(f.renewal_period_months) || null, notice_period_days: Number(f.notice_period_days) || null, total_value: Number(f.total_value), annual_value: Number(f.annual_value), payment_terms_days: Number(f.payment_terms_days) }); toast("Guardado", "ok"); onClose(); await onSaved(); } catch (e) { toast(errorMessage(e), "error"); } };
  return <Modal title="Editar datos del contrato" size="lg" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}><div className="form-grid">
    <Field label="Título" full><input className="input" value={String(f.title)} onChange={(e) => set("title", e.target.value)} /></Field>
    <Field label="Contraparte"><Picker kind="company" value={f.counterparty_company_id as string | null} onChange={(id) => set("counterparty_company_id", id)} /></Field>
    <Field label="Propietario"><select className="input" value={String(f.owner_id ?? "")} onChange={(e) => set("owner_id", e.target.value || null)}>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
    <Field label="Responsable legal"><select className="input" value={String(f.legal_owner_id ?? "")} onChange={(e) => set("legal_owner_id", e.target.value || null)}><option value="">—</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
    <Field label="Departamento"><input className="input" value={String(f.department)} onChange={(e) => set("department", e.target.value)} /></Field>
    {active && <p className="small warn" style={{ gridColumn: "1 / -1" }}>Contrato activo: valor, fechas, preaviso y renovación solo cambian mediante una enmienda.</p>}
    <Field label="Valor total"><input className="input" type="number" disabled={active} value={String(f.total_value)} onChange={(e) => set("total_value", e.target.value)} /></Field><Field label="Valor anual"><input className="input" type="number" disabled={active} value={String(f.annual_value)} onChange={(e) => set("annual_value", e.target.value)} /></Field>
    <Field label="Modelo de pago"><select className="input" value={String(f.payment_model)} onChange={(e) => set("payment_model", e.target.value)}>{Object.entries(PAYMENT_MODEL).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}</select></Field><Field label="Plazo de pago (días)"><input className="input" type="number" value={String(f.payment_terms_days)} onChange={(e) => set("payment_terms_days", e.target.value)} /></Field>
    <Field label="Inicio"><input className="input" type="date" disabled={active} value={String(f.effective_date).slice(0, 10)} onChange={(e) => set("effective_date", e.target.value)} /></Field><Field label="Fin (vacío = calculado por duración)"><input className="input" type="date" disabled={active} value={String(f.end_date).slice(0, 10)} onChange={(e) => set("end_date", e.target.value)} /></Field>
    <Field label="Duración"><div className="row"><select className="input" disabled={active} value={String(f.term_type)} onChange={(e) => set("term_type", e.target.value)}><option value="fixed">Fija</option><option value="indefinite">Indefinida</option><option value="milestone">Por hito</option></select><input className="input" type="number" disabled={active} value={String(f.term_months)} onChange={(e) => set("term_months", e.target.value)} /></div></Field>
    <Field label="Renovación"><div className="row"><select className="input" disabled={active} value={String(f.renewal_type)} onChange={(e) => set("renewal_type", e.target.value)}>{Object.entries(RENEWAL).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}</select><input className="input" type="number" disabled={active} title="Periodo (meses)" value={String(f.renewal_period_months)} onChange={(e) => set("renewal_period_months", e.target.value)} /><input className="input" type="number" disabled={active} title="Preaviso (días)" value={String(f.notice_period_days)} onChange={(e) => set("notice_period_days", e.target.value)} /></div></Field>
    <Field label="Ley aplicable (ISO)"><input className="input" value={String(f.governing_law)} onChange={(e) => set("governing_law", e.target.value.toUpperCase())} /></Field><Field label="Jurisdicción"><input className="input" value={String(f.jurisdiction)} onChange={(e) => set("jurisdiction", e.target.value)} /></Field>
    <Field label="Confidencialidad"><select className="input" value={String(f.confidentiality)} onChange={(e) => set("confidentiality", e.target.value)}><option value="normal">Normal</option><option value="confidential">Confidencial</option><option value="restricted">Restringido</option></select></Field><Field label="Urgencia"><select className="input" value={String(f.urgency)} onChange={(e) => set("urgency", e.target.value)}>{Object.entries(URGENCY).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}</select></Field>
    <label className="checkbox"><input type="checkbox" checked={!!f.contains_personal_data} onChange={(e) => set("contains_personal_data", e.target.checked)} />Trata datos personales</label>{!!f.contains_personal_data && <Field label="Rol"><select className="input" value={String(f.data_role)} onChange={(e) => set("data_role", e.target.value)}><option value="controller">Responsable</option><option value="processor">Encargado</option><option value="joint">Corresponsable</option></select></Field>}
    <Field label="Etiquetas (coma)" full><input className="input" value={String(f.tags)} onChange={(e) => set("tags", e.target.value)} /></Field>
    <Field label="Descripción / objeto" full><textarea className="input" value={String(f.description)} onChange={(e) => set("description", e.target.value)} /></Field>
  </div></Modal>;
}
function RiskOverride({ c, onClose, onSaved }: { c: Detail; onClose: () => void; onSaved: () => Promise<unknown> }) {
  const toast = useToast(); const [level, setLevel] = useState<string>(c.risk_override ?? ""); const [reason, setReason] = useState("");
  const save = async () => { try { await api.post(`clm/contracts/${c.id}/risk-override`, { level: level || null, reason }); onClose(); await onSaved(); } catch (e) { toast(errorMessage(e), "error"); } };
  return <Modal title="Sobrescribir nivel de riesgo" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!reason.trim()} onClick={save}>Guardar</button></>}><div className="col" style={{ gap: 12 }}><Field label="Nivel"><select className="input" value={level} onChange={(e) => setLevel(e.target.value)}><option value="">Calculado automáticamente ({RISK[c.risk_level]?.label})</option>{Object.entries(RISK).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}</select></Field><Field label="Motivo (queda registrado)"><textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field></div></Modal>;
}
