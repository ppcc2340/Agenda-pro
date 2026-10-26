import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { Plus, Upload, Settings2, FileSignature, AlertTriangle, ClipboardCheck, Scale } from "lucide-react";
import { api, qs } from "../api";
import { useApp } from "../lib/app";
import { DataTable, type Column, type GroupOption } from "../components/DataTable";
import { useBoard, customColumns } from "../lib/board";
import { Modal, Field, Picker, Seg, Spinner, useToast, useConfirm, errorMessage } from "../components/ui";
import { Bars } from "../components/Charts";
import { fmtMoney, fmtDate, relTime } from "../lib/format";
import { CSTATUS, RISK, RENEWAL, PAPER, URGENCY, PAYMENT_MODEL, KIND, OBL_STATUS, OBL_TYPE, MS_TYPE, FAMILY, daysUntil, type ClmMeta, type ContractType } from "../lib/clm";

export interface ContractRow { id: string; number: string; title: string; type_id: string; type_name: string; type_code: string; type_color: string; direction: string; status: string; substatus: string | null; kind: string; parent_id: string | null; counterparty_company_id: string | null; counterparty_name: string | null; owner_id: string | null; owner_name: string | null; legal_owner_id: string | null; legal_owner_name: string | null; total_value: number; annual_value: number; currency: string; effective_date: string | null; end_date: string | null; notice_deadline: string | null; renewal_type: string; risk_level: string; risk_score: number; paper_origin: string; urgency: string; payment_model: string; payment_terms_days: number; signed_at: string | null; requested_at: string | null; created_at: string; updated_at: string; deviations: number; pending_approvals: number; open_obligations: number; breached_obligations: number; version_label: string | null; children: number; sla_hours_left: number | null; contains_personal_data: number; tags: string[]; custom: Record<string, unknown>; legal_hold: number; deal_id: string | null }

export function useClmMeta() {
  const [meta, setMeta] = useState<ClmMeta | null>(null);
  const load = () => api.get<ClmMeta>("clm/meta").then(setMeta).catch(() => undefined);
  useEffect(() => { load(); }, []);
  return { meta, reload: load };
}

export function ContractsPage() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const { users, customFields, can, userName } = useApp();
  const board = useBoard("contract");
  const toast = useToast();
  const confirm = useConfirm();
  const { meta } = useClmMeta();
  const [view, setView] = useState<"table" | "kanban" | "queue" | "calendar" | "obligations" | "approvals" | "reports">((params.get("view") as "table") || "table");
  const [creating, setCreating] = useState(!!params.get("new"));
  const [refresh, setRefresh] = useState(0);
  useEffect(() => { const p = new URLSearchParams(params); p.set("view", view); setParams(p, { replace: true }); /* eslint-disable-next-line */ }, [view]);
  const editable = can("contract", "update");
  const patch = (c: ContractRow, body: Record<string, unknown>) => api.patch(`clm/contracts/${c.id}`, body).then(() => undefined);
  const typeOpts = Object.fromEntries((meta?.types ?? []).map((t) => [t.id, { label: t.name, color: t.color }]));
  const cols: Column<ContractRow>[] = [
    { key: "title", label: "Contrato", type: "name", field: editable ? "title" : undefined, sub: (c) => `${c.number}${c.kind !== "master" ? ` · ${KIND[c.kind]}` : ""}${c.legal_hold ? " · 🔒 bloqueo legal" : ""}`, render: (c) => <Link to={`/contratos/${c.id}`} onClick={(e) => e.stopPropagation()}>{c.title}</Link> },
    { key: "status", label: "Estado", sortable: true, type: "status", fixedOptions: true, options: CSTATUS, readOnlyReason: "El estado avanza con el ciclo de vida (revisión, aprobación, firma…)" },
    { key: "type_id", label: "Tipo", sortable: true, type: "status", fixedOptions: true, options: typeOpts, value: (c) => c.type_id },
    { key: "counterparty_company_id", label: "Contraparte", className: "l", render: (c) => c.counterparty_company_id ? <Link to={`/empresas/${c.counterparty_company_id}`} onClick={(e) => e.stopPropagation()}>{c.counterparty_name}</Link> : <span className="muted">—</span> },
    { key: "owner_name", label: "Propietario", type: "person", field: "owner_id", onEdit: editable ? (c, v) => patch(c, { owner_id: v }) : undefined },
    { key: "legal_owner_name", label: "Legal", type: "person", field: "legal_owner_id", onEdit: editable ? (c, v) => patch(c, { legal_owner_id: v }) : undefined },
    { key: "risk_level", label: "Riesgo", sortable: true, type: "status", fixedOptions: true, options: RISK },
    { key: "annual_value", label: "Valor anual", sortable: true, type: "money", render: (c) => <span className="num">{fmtMoney(c.annual_value, c.currency)}</span> },
    { key: "total_value", label: "Valor total", sortable: true, type: "money", default: false, render: (c) => <span className="num">{fmtMoney(c.total_value, c.currency)}</span> },
    { key: "end_date", label: "Fin", sortable: true, type: "date", field: editable ? "end_date" : undefined },
    { key: "notice_deadline", label: "Preaviso", sortable: true, type: "date", render: (c) => c.notice_deadline ? <><i className={`ddot ${(daysUntil(c.notice_deadline) ?? 99) < 0 ? "late" : (daysUntil(c.notice_deadline) ?? 99) <= 30 ? "soon" : ""}`} />{fmtDate(c.notice_deadline, { day: "2-digit", month: "short" })}<span className="xs muted"> ({daysUntil(c.notice_deadline)} d)</span></> : <span className="muted">—</span> },
    { key: "renewal_type", label: "Renovación", sortable: true, type: "status", fixedOptions: true, options: RENEWAL, default: false },
    { key: "deviations", label: "Desviaciones", type: "number", agg: "sum", render: (c) => c.deviations ? <span className="badge warn">{c.deviations}</span> : <span className="muted">0</span> },
    { key: "open_obligations", label: "Obligaciones", type: "number", agg: "sum", render: (c) => <span className={c.breached_obligations ? "badge risk" : ""}>{c.breached_obligations ? `${c.breached_obligations} incumplidas` : c.open_obligations}</span> },
    { key: "paper_origin", label: "Papel", type: "status", fixedOptions: true, options: PAPER, default: false },
    { key: "urgency", label: "Urgencia", type: "status", fixedOptions: true, field: "urgency", options: URGENCY, default: false, onEdit: editable ? (c, v) => patch(c, { urgency: v }) : undefined },
    { key: "sla_hours_left", label: "SLA legal", className: "c", default: false, render: (c) => c.sla_hours_left == null ? <span className="muted">—</span> : <span style={{ color: c.sla_hours_left < 0 ? "var(--risk)" : c.sla_hours_left < 24 ? "var(--warn)" : "var(--ink2)" }}>{c.sla_hours_left < 0 ? `vencido ${-c.sla_hours_left} h` : `${c.sla_hours_left} h`}</span> },
    { key: "version_label", label: "Versión", className: "c", default: false },
    { key: "signed_at", label: "Firmado", sortable: true, type: "date", default: false },
    { key: "tags", label: "Etiquetas", type: "tags", default: false },
    { key: "updated_at", label: "Actualizado", sortable: true, className: "c", render: (c) => <span className="muted">{relTime(c.updated_at)}</span> },
    ...customColumns<ContractRow>(customFields, "contract", board, editable ? (c, k, v) => patch(c, { custom: { [k]: v } }) : undefined, userName),
  ];
  const groupOptions: GroupOption<ContractRow>[] = [
    { key: "status", label: "Estado", get: (c) => c.status, groups: Object.entries(CSTATUS).map(([key, o]) => ({ key, label: o.label, color: o.color })) },
    { key: "type_id", label: "Tipo", get: (c) => c.type_id, groups: (meta?.types ?? []).map((t) => ({ key: t.id, label: t.name, color: t.color })), createValue: (g) => ({ type_id: g }) },
    { key: "risk_level", label: "Riesgo", get: (c) => c.risk_level, groups: Object.entries(RISK).map(([key, o]) => ({ key, label: o.label, color: o.color })) },
    { key: "owner_id", label: "Propietario", get: (c) => c.owner_id ?? "", groups: users.filter((u) => u.active).map((u) => ({ key: u.id, label: u.name, color: "#175a63" })), other: "Sin propietario", setValue: (c, g) => patch(c, { owner_id: g }), createValue: (g) => ({ owner_id: g }) },
    { key: "renewal_type", label: "Renovación", get: (c) => c.renewal_type, groups: Object.entries(RENEWAL).map(([key, o]) => ({ key, label: o.label, color: o.color })) },
    ...customFields.filter((f) => f.object === "contract" && f.type === "select").map<GroupOption<ContractRow>>((f) => ({ key: `custom.${f.key}`, label: f.label, get: (c) => String(c.custom?.[f.key] ?? ""), groups: Object.entries(cols.find((c) => c.key === `custom.${f.key}`)?.options ?? {}).map(([key, o]) => ({ key, label: o.label, color: o.color })), other: "Sin valor", setValue: (c, g) => patch(c, { custom: { [f.key]: g } }), createValue: (g) => ({ custom: { [f.key]: g } }) })),
  ];
  const defaultType = meta?.types.find((t) => t.code === "MSA")?.id ?? meta?.types[0]?.id;
  const create = async (title: string, extra: Record<string, unknown>) => { return api.post("clm/contracts", { title, type_id: defaultType, term_months: 12, ...extra }); };
  return (
    <div>
      <div className="page-head">
        <div><h1>Contratos</h1><p className="sub">Ciclo de vida completo: solicitud, redacción, negociación, aprobación, firma, obligaciones y renovación.</p></div>
        <div className="row wrap">
          <Seg items={[{ key: "table", label: "Tabla" }, { key: "kanban", label: "Kanban" }, { key: "queue", label: "Cola de legal" }, { key: "approvals", label: "Aprobaciones" }, { key: "calendar", label: "Vencimientos" }, { key: "obligations", label: "Obligaciones" }, { key: "reports", label: "Informes" }]} value={view} onChange={setView} />
          <Link to="/contratos/configuracion" className="btn ghost" title="Tipos, cláusulas, plantillas, playbooks y poderes"><Settings2 />Configurar CLM</Link>
          {can("contract", "create") && <button className="btn primary" onClick={() => setCreating(true)}><Plus />Nuevo contrato</button>}
        </div>
      </div>
      {view === "table" && <DataTable<ContractRow> object="contract" endpoint="clm/contracts" columns={cols} board={board} groupOptions={groupOptions} onRowClick={(c) => nav(`/contratos/${c.id}`)} exportUrl="clm/contracts/export" refreshKey={refresh} emptyText="No hay contratos" defaultSort={{ field: "updated_at", dir: "desc" }} onCreate={can("contract", "create") ? create : undefined} onDelete={can("contract", "delete") ? async (ids) => { if (await confirm({ title: `¿Borrar ${ids.length} contratos?`, text: "Solo se pueden borrar contratos no firmados.", danger: true, confirmText: "Borrar" })) { for (const i of ids) await api.del(`clm/contracts/${i}`).catch((e) => toast(errorMessage(e), "error")); setRefresh((r) => r + 1); } } : undefined} toolbar={<Link to="/ajustes/importar?object=contract" className="btn ghost" title="Importar heredados"><Upload /></Link>} />}
      {view === "kanban" && <ContractsKanban refreshKey={refresh} />}
      {view === "queue" && <LegalQueue />}
      {view === "approvals" && <MyApprovals onChanged={() => setRefresh((r) => r + 1)} />}
      {view === "calendar" && <Expirations />}
      {view === "obligations" && <ObligationsBoard />}
      {view === "reports" && <ClmReports />}
      {creating && meta && <IntakeWizard meta={meta} onClose={() => { setCreating(false); const p = new URLSearchParams(params); p.delete("new"); setParams(p, { replace: true }); }} onSaved={(c) => nav(`/contratos/${c.id}`)} defaults={{ deal_id: params.get("deal") ?? undefined, counterparty_company_id: params.get("company") ?? undefined }} />}
    </div>
  );
}

function ContractsKanban({ refreshKey }: { refreshKey: number }) {
  const [items, setItems] = useState<ContractRow[] | null>(null);
  const nav = useNavigate();
  useEffect(() => { api.get<{ items: ContractRow[] }>(`clm/contracts${qs({ page_size: 500, sort: "updated_at", dir: "desc" })}`).then((r) => setItems(r.items)); }, [refreshKey]);
  if (!items) return <Spinner />;
  const lanes = ["DRAFT", "INTERNAL_REVIEW", "NEGOTIATION", "PENDING_APPROVAL", "APPROVED", "OUT_FOR_SIGNATURE", "PARTIALLY_SIGNED", "ACTIVE", "EXPIRED", "TERMINATED"];
  return (
    <div className="kanban">
      {lanes.map((s) => { const its = items.filter((c) => c.status === s); return (
        <div key={s} className="kcol" style={{ "--stage": CSTATUS[s]?.color } as React.CSSProperties}>
          <div className="kcol-head"><div className="t"><span className="ell">{CSTATUS[s]?.label}</span><span className="num">{its.length}</span></div><div className="m num">{fmtMoney(its.reduce((a, c) => a + Number(c.annual_value), 0))} anual</div></div>
          <div className="kcol-body">{its.map((c) => (
            <div key={c.id} className="kcard" onClick={() => nav(`/contratos/${c.id}`)} style={{ cursor: "pointer" }}>
              <div className="c ell" style={{ color: c.type_color }}>{c.type_name}</div>
              <div className="n ell" title={c.title}>{c.title}</div>
              <div className="f"><span className="num bold" style={{ color: "var(--ink)" }}>{fmtMoney(c.annual_value, c.currency)}</span><span className="ell">{c.counterparty_name}</span></div>
              <div className="f" style={{ marginTop: 5 }}><span className="badge" style={{ background: RISK[c.risk_level]?.color, color: "#fff" }}>riesgo {c.risk_score}</span>{c.deviations > 0 && <span className="badge warn">{c.deviations} desv.</span>}{c.notice_deadline && c.status === "ACTIVE" && <span className="xs" style={{ color: (daysUntil(c.notice_deadline) ?? 99) <= 30 ? "var(--risk)" : "var(--ink2)" }}>preaviso {daysUntil(c.notice_deadline)} d</span>}{c.owner_name && <span className="right avatar sm" title={c.owner_name}>{c.owner_name.split(" ").map((x) => x[0]).slice(0, 2).join("")}</span>}</div>
            </div>))}{its.length === 0 && <div className="muted small" style={{ textAlign: "center", padding: 12 }}>Vacío</div>}</div>
        </div>); })}
    </div>
  );
}

function LegalQueue() {
  const [items, setItems] = useState<ContractRow[] | null>(null);
  const nav = useNavigate();
  const { users } = useApp();
  const toast = useToast();
  const load = () => api.get<{ items: ContractRow[] }>(`clm/contracts${qs({ queue: "legal", page_size: 200, sort: "requested_at", dir: "asc" })}`).then((r) => setItems(r.items));
  useEffect(() => { load(); }, []);
  if (!items) return <Spinner />;
  const breached = items.filter((c) => (c.sla_hours_left ?? 1) < 0).length;
  const avg = items.length ? Math.round(items.reduce((a, c) => a + (Date.now() - new Date(c.requested_at ?? c.created_at).getTime()) / 864e5, 0) / items.length) : 0;
  return (
    <div>
      <div className="kpis mb12"><div className="kpi"><div className="l">Abiertas</div><div className="v num">{items.length}</div></div><div className="kpi"><div className="l">SLA vencido</div><div className="v num" style={{ color: breached ? "var(--risk)" : undefined }}>{breached}</div></div><div className="kpi"><div className="l">Antigüedad media</div><div className="v num">{avg} d</div></div><div className="kpi"><div className="l">Riesgo alto o crítico</div><div className="v num">{items.filter((c) => ["high", "critical"].includes(c.risk_level)).length}</div></div></div>
      <div className="card tight"><table className="table"><thead><tr><th>Número</th><th>Título</th><th>Tipo</th><th>Contraparte</th><th>Solicitante</th><th className="r">Valor</th><th>Urgencia</th><th>Riesgo</th><th>Estado</th><th className="r">Antigüedad</th><th>SLA</th><th>Legal</th></tr></thead><tbody>
        {items.map((c) => <tr key={c.id} className="clickable" onClick={() => nav(`/contratos/${c.id}`)}><td className="num">{c.number}</td><td className="bold">{c.title}</td><td><span className="badge" style={{ background: c.type_color, color: "#fff" }}>{c.type_code}</span></td><td>{c.counterparty_name}</td><td>{c.owner_name}</td><td className="r num">{fmtMoney(c.total_value, c.currency)}</td><td><span className="badge" style={{ background: URGENCY[c.urgency]?.color, color: "#fff" }}>{URGENCY[c.urgency]?.label}</span></td><td><span className="badge" style={{ background: RISK[c.risk_level]?.color, color: "#fff" }}>{c.risk_score}</span></td><td><span className="badge" style={{ background: CSTATUS[c.status]?.color, color: "#fff" }}>{CSTATUS[c.status]?.label}</span></td><td className="r num">{Math.round((Date.now() - new Date(c.requested_at ?? c.created_at).getTime()) / 864e5)} d</td><td>{c.sla_hours_left == null ? <span className="muted">pausado</span> : <span style={{ color: c.sla_hours_left < 0 ? "var(--risk)" : c.sla_hours_left < 24 ? "var(--warn)" : "var(--ok)" }}>● {c.sla_hours_left < 0 ? `${-c.sla_hours_left} h tarde` : `${c.sla_hours_left} h`}</span>}</td><td onClick={(e) => e.stopPropagation()}><select className="input sm" value={c.legal_owner_id ?? ""} onChange={async (e) => { try { await api.patch(`clm/contracts/${c.id}`, { legal_owner_id: e.target.value || null }); toast("Asignado", "ok"); load(); } catch (err) { toast(errorMessage(err), "error"); } }}><option value="">—</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></td></tr>)}
        {items.length === 0 && <tr><td colSpan={12} className="muted">La cola de legal está vacía.</td></tr>}
      </tbody></table></div>
    </div>
  );
}

function MyApprovals({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<Record<string, unknown>[] | null>(null);
  const toast = useToast();
  const nav = useNavigate();
  const [reject, setReject] = useState<Record<string, unknown> | null>(null);
  const [comment, setComment] = useState("");
  const load = () => api.get<{ items: Record<string, unknown>[] }>("clm/approvals/pending").then((r) => setItems(r.items));
  useEffect(() => { load(); }, []);
  const decide = async (a: Record<string, unknown>, decision: "approved" | "rejected", c?: string) => { try { await api.post(`clm/approvals/${a.id}/decide`, { decision, comment: c ?? null }); toast(decision === "approved" ? "Aprobado" : "Rechazado", "ok"); setReject(null); setComment(""); load(); onChanged(); } catch (e) { toast(errorMessage(e), "error"); } };
  if (!items) return <Spinner />;
  return (
    <div>
      {items.length === 0 && <div className="card"><p className="muted">No tienes aprobaciones pendientes. 🎉</p></div>}
      {items.map((a) => (
        <div key={String(a.id)} className="card mb12">
          <div className="row wrap between">
            <div className="grow"><div className="row wrap"><span className="num muted">{String(a.number)}</span><b>{String(a.title)}</b><span className="badge" style={{ background: RISK[String(a.risk_level)]?.color, color: "#fff" }}>riesgo {String(a.risk_score)}</span></div><div className="small sub mt8">Paso: <b>{String(a.step_name)}</b> · {String(a.reason ?? "")} · contraparte {String(a.counterparty_name ?? "—")} · {fmtMoney(Number(a.total_value), String(a.currency))}{a.due_at ? ` · vence ${relTime(String(a.due_at))}` : ""}</div></div>
            <div className="row"><button className="btn" onClick={() => nav(`/contratos/${a.contract_id}?tab=clauses`)}>Ver hallazgos</button><button className="btn" style={{ color: "var(--risk)" }} onClick={() => setReject(a)}>Rechazar</button><button className="btn primary" onClick={() => decide(a, "approved")}><ClipboardCheck />Aprobar</button></div>
          </div>
        </div>))}
      {reject && <Modal title="Motivo del rechazo" onClose={() => setReject(null)} footer={<><button className="btn" onClick={() => setReject(null)}>Cancelar</button><button className="btn danger" disabled={!comment.trim()} onClick={() => decide(reject, "rejected", comment)}>Rechazar</button></>}><textarea className="input" autoFocus value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Explica qué debe cambiar" /></Modal>}
    </div>
  );
}

function Expirations() {
  const [items, setItems] = useState<Record<string, unknown>[] | null>(null);
  const nav = useNavigate();
  const [horizon, setHorizon] = useState<"30" | "90" | "180" | "365">("180");
  useEffect(() => { const to = new Date(Date.now() + Number(horizon) * 864e5).toISOString().slice(0, 10); api.get<{ items: Record<string, unknown>[] }>(`clm/calendar${qs({ from: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), to })}`).then((r) => setItems(r.items)); }, [horizon]);
  if (!items) return <Spinner />;
  const byMonth = new Map<string, Record<string, unknown>[]>();
  items.forEach((i) => { const k = String(i.date).slice(0, 7); byMonth.set(k, [...(byMonth.get(k) ?? []), i]); });
  const color = (i: Record<string, unknown>) => (i.kind === "payment" ? "var(--c-blue)" : i.kind === "obligation" ? (i.status === "breached" ? "var(--c-red)" : "var(--c-orange)") : i.type === "notice_deadline" ? "var(--c-red)" : i.type === "end" ? "var(--c-dark)" : "var(--c-purple)");
  return (
    <div>
      <div className="filterbar"><Seg items={[{ key: "30", label: "30 días" }, { key: "90", label: "90 días" }, { key: "180", label: "180 días" }, { key: "365", label: "12 meses" }]} value={horizon} onChange={setHorizon} /><span className="small sub right"><i className="gdot" style={{ background: "var(--c-red)" }} /> preaviso · <i className="gdot" style={{ background: "var(--c-dark)" }} /> fin · <i className="gdot" style={{ background: "var(--c-purple)" }} /> hito · <i className="gdot" style={{ background: "var(--c-orange)" }} /> obligación · <i className="gdot" style={{ background: "var(--c-blue)" }} /> pago</span></div>
      {Array.from(byMonth.entries()).map(([m, its]) => (
        <div key={m} className="mgroup" style={{ "--gc": "var(--c-indigo)" } as React.CSSProperties}>
          <div className="ghead"><h2>{fmtDate(m + "-01", { month: "long", year: "numeric" })}</h2><span className="count">{its.length} eventos</span></div>
          <div className="card tight"><table className="table"><tbody>{its.map((i) => <tr key={String(i.kind) + i.id} className="clickable" onClick={() => nav(`/contratos/${i.contract_id}?tab=${i.kind === "payment" ? "milestones" : i.kind === "obligation" ? "obligations" : "milestones"}`)}><td style={{ width: 110 }} className="num"><i className="gdot" style={{ background: color(i) }} />{fmtDate(String(i.date), { day: "2-digit", month: "short" })}</td><td style={{ width: 90 }} className="num muted">{(daysUntil(String(i.date)) ?? 0) < 0 ? `hace ${-(daysUntil(String(i.date)) ?? 0)} d` : `en ${daysUntil(String(i.date))} d`}</td><td className="bold">{String(i.label)}{i.amount != null && <span className="muted num"> · {fmtMoney(Number(i.amount))}</span>}</td><td><span className="muted">{String(i.number)}</span> {String(i.title)}</td><td style={{ width: 120 }}><span className="badge">{i.kind === "milestone" ? MS_TYPE[String(i.type)] ?? String(i.type) : i.kind === "obligation" ? OBL_STATUS[String(i.status)]?.label : String(i.status)}</span></td></tr>)}</tbody></table></div>
        </div>))}
      {items.length === 0 && <div className="card"><p className="muted">Nada vence en este horizonte.</p></div>}
    </div>
  );
}

function ObligationsBoard() {
  const [items, setItems] = useState<Record<string, unknown>[] | null>(null);
  const [status, setStatus] = useState("pending,in_progress,breached");
  const toast = useToast();
  const nav = useNavigate();
  const load = () => api.get<{ items: Record<string, unknown>[] }>(`clm/obligations${qs({ status })}`).then((r) => setItems(r.items));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [status]);
  if (!items) return <Spinner />;
  const groups = [["breached", "Incumplidas"], ["pending", "Pendientes"], ["in_progress", "En curso"], ["fulfilled", "Cumplidas"]] as const;
  return (
    <div>
      <div className="filterbar"><Seg items={[{ key: "pending,in_progress,breached", label: "Abiertas" }, { key: "fulfilled", label: "Cumplidas" }, { key: "pending,in_progress,breached,fulfilled,waived,na", label: "Todas" }]} value={status} onChange={setStatus} /></div>
      {groups.filter(([k]) => items.some((o) => o.status === k)).map(([k, label]) => { const its = items.filter((o) => o.status === k); return (
        <div key={k} className="mgroup" style={{ "--gc": OBL_STATUS[k]?.color } as React.CSSProperties}>
          <div className="ghead"><h2>{label}</h2><span className="count">{its.length}</span></div>
          <div className="card tight"><table className="table"><thead><tr><th>Obligación</th><th>Tipo</th><th>Quién</th><th>Contrato</th><th>Responsable</th><th>Vence</th><th>Recurrencia</th><th /></tr></thead><tbody>
            {its.map((o) => <tr key={String(o.id)}><td className="bold">{String(o.title)}{o.evidence_required ? <span className="xs muted"> · requiere evidencia</span> : null}</td><td>{OBL_TYPE[String(o.type)] ?? String(o.type)}</td><td>{o.obligor === "us" ? "Nosotros" : "Contraparte"}</td><td><Link to={`/contratos/${o.contract_id}?tab=obligations`}>{String(o.number)}</Link> <span className="muted small">{String(o.contract_title)}</span></td><td>{String(o.owner_name ?? "")}</td><td className="num" style={{ color: o.status === "breached" ? "var(--risk)" : undefined }}>{fmtDate(o.due_date as string)}</td><td className="muted">{o.recurrence === "none" ? "—" : String(o.recurrence)}</td><td className="r">{["pending", "in_progress", "breached"].includes(String(o.status)) && <button className="btn sm" onClick={async () => { const note = o.evidence_required ? prompt("Evidencia (nota o enlace)") : null; if (o.evidence_required && !note) return; try { await api.patch(`clm/obligations/${o.id}`, { status: "fulfilled", evidence_note: note ?? undefined }); toast("Cumplida", "ok"); load(); } catch (e) { toast(errorMessage(e), "error"); } }}>Marcar cumplida</button>}<button className="btn sm ghost" onClick={() => nav(`/contratos/${o.contract_id}?tab=obligations`)}>Abrir</button></td></tr>)}
          </tbody></table></div>
        </div>); })}
      {items.length === 0 && <div className="card"><p className="muted">Sin obligaciones en este filtro.</p></div>}
    </div>
  );
}

function ClmReports() {
  const [r, setR] = useState<Record<string, unknown> | null>(null);
  useEffect(() => { api.get<Record<string, unknown>>("clm/reports").then(setR); }, []);
  if (!r) return <Spinner />;
  const value = r.value as Record<string, number>; const risk = r.risk as Record<string, number>; const obl = r.obligations as { fulfilled: number; breached: number; open: number }; const queue = r.queue as Record<string, number>; const cycle = r.cycle_days as Record<string, number>; const comp = r.compliance as { no_dpa: { id: string; number: string; title: string }[]; payment_gt_60: { id: string; number: string; title: string; days?: number }[]; unlimited_liability: { id: string; number: string; title: string }[] };
  const byStatus = r.by_status as Record<string, number>;
  return (
    <div>
      <div className="kpis mb12">
        <div className="kpi"><div className="l">Contratos activos</div><div className="v num">{String(r.active)}</div><div className="s">{String(r.total)} en total · {String(r.auto_renew_pct)} % con renovación automática</div></div>
        <div className="kpi"><div className="l">Valor anual contratado</div><div className="v num" style={{ color: "var(--c-green)" }}>{fmtMoney(value.income_annual)}</div><div className="s">ingresos · gastos {fmtMoney(value.expense_annual)}</div></div>
        <div className="kpi"><div className="l">Vence en 12 meses</div><div className="v num">{fmtMoney(value.expiring_12m)}</div><div className="s">{value.expiring_12m_count} contratos · concentración top 5: {value.concentration_top5} %</div></div>
        <div className="kpi"><div className="l">Tiempo de ciclo</div><div className="v num">{cycle.median} d</div><div className="s">mediana · p90 {cycle.p90} d · {cycle.n} firmados</div></div>
      </div>
      <div className="charts">
        <div className="card"><h2 className="mb12">Contratos por estado</h2><Bars data={Object.entries(byStatus).filter(([, n]) => n > 0).map(([k, n]) => ({ label: CSTATUS[k]?.label ?? k, n }))} x="label" bars={[{ key: "n", label: "Contratos", color: "#0073ea" }]} /></div>
        <div className="card"><h2 className="mb12">Valor que vence por mes</h2><Bars data={(r.expiring_by_month as { month: string; value: number }[]).map((m) => ({ label: fmtDate(m.month + "-01", { month: "short", year: "2-digit" }), value: m.value }))} x="label" bars={[{ key: "value", label: "Valor anual", color: "#a25ddc" }]} money /></div>
        <div className="card"><h2 className="mb12">Cartera por riesgo</h2><div className="col">{Object.entries(RISK).map(([k, o]) => <div key={k} className="row"><span className="badge" style={{ background: o.color, color: "#fff", width: 80, justifyContent: "center" }}>{o.label}</span><div className="grow" style={{ background: "var(--panel)", height: 14, borderRadius: 4 }}><div style={{ width: `${Math.round((100 * (risk[k] ?? 0)) / Math.max(1, Number(r.active)))}%`, background: o.color, height: 14, borderRadius: 4 }} /></div><b className="num" style={{ width: 30, textAlign: "right" }}>{risk[k] ?? 0}</b></div>)}</div><h3 className="mt16 mb8">Obligaciones</h3><div className="row wrap small"><span className="badge ok">{obl.fulfilled} cumplidas</span><span className="badge risk">{obl.breached} incumplidas</span><span className="badge">{obl.open} abiertas</span><span className="muted">· cumplimiento {Math.round((100 * obl.fulfilled) / Math.max(1, obl.fulfilled + obl.breached))} %</span></div><h3 className="mt16 mb8">Cola de legal</h3><div className="small">{queue.open} abiertas · {queue.sla_breached} con SLA vencido · {queue.avg_days} días de media</div></div>
        <div className="card"><h2 className="mb12"><Scale size={16} /> Cumplimiento</h2>
          <h3 className="mb8">Contratos con datos sin DPA <span className="badge risk">{comp.no_dpa.length}</span></h3>{comp.no_dpa.slice(0, 5).map((c) => <div key={c.id} className="small"><Link to={`/contratos/${c.id}`}>{c.number}</Link> {c.title}</div>)}
          <h3 className="mt12 mb8">Plazo de pago &gt; 60 días (Ley 3/2004) <span className="badge warn">{comp.payment_gt_60.length}</span></h3>{comp.payment_gt_60.slice(0, 5).map((c) => <div key={c.id} className="small"><Link to={`/contratos/${c.id}`}>{c.number}</Link> {c.title} · {c.days} d</div>)}
          <h3 className="mt12 mb8">Responsabilidad ilimitada <span className="badge risk">{comp.unlimited_liability.length}</span></h3>{comp.unlimited_liability.slice(0, 5).map((c) => <div key={c.id} className="small"><Link to={`/contratos/${c.id}`}>{c.number}</Link> {c.title}</div>)}
          <h3 className="mt12 mb8">Renovaciones automáticas por inacción <span className="badge">{(r.auto_renewals as unknown[]).length}</span></h3>{(r.auto_renewals as { number: string; title: string; decided_at: string; annual_value: number }[]).slice(0, 5).map((x, i) => <div key={i} className="small">{x.number} {x.title} · {fmtDate(x.decided_at)} · {fmtMoney(x.annual_value)}</div>)}
        </div>
        <div className="card"><h2 className="mb12">Valor activo por tipo</h2><div className="card tight"><table className="table"><thead><tr><th>Tipo</th><th className="r">Contratos</th><th className="r">Valor anual</th></tr></thead><tbody>{(r.by_type as { name: string; n: number; value: number }[]).sort((a, b) => b.value - a.value).map((t) => <tr key={t.name}><td>{t.name}</td><td className="r num">{t.n}</td><td className="r num">{fmtMoney(t.value)}</td></tr>)}</tbody></table></div></div>
      </div>
    </div>
  );
}

/* ---------- formulario de intake (asistente) ---------- */
export function IntakeWizard({ meta, onClose, onSaved, defaults }: { meta: ClmMeta; onClose: () => void; onSaved: (c: { id: string }) => void; defaults?: Record<string, unknown> }) {
  const { users, me } = useApp();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const typeDefault = meta.types.find((t) => t.code === "MSA") ?? meta.types[0];
  const [f, setF] = useState<Record<string, unknown>>({ type_id: typeDefault?.id, paper_origin: "ours", title: "", counterparty_company_id: defaults?.counterparty_company_id ?? null, counterparty_name: "", deal_id: defaults?.deal_id ?? null, counterparty_outside_eea: false, description: "", total_value: 0, annual_value: 0, currency: "EUR", payment_model: "recurring", payment_terms_days: 30, effective_date: "", term_type: "fixed", term_months: 12, renewal_type: "auto", renewal_period_months: 12, notice_period_days: 60, contains_personal_data: false, data_role: "processor", international_transfer: false, has_ip: false, exclusivity: false, subcontracting: false, department: "", urgency: "normal", justification: "", owner_id: me.id, body: "", file_name: "", template_id: "" });
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const type = meta.types.find((t) => t.id === f.type_id) as ContractType | undefined;
  const isNda = type?.code === "NDA" || type?.code === "LOI";
  const templates = meta.templates.filter((t) => t.kind === "contract" && t.status === "approved" && (!t.type_id || t.type_id === f.type_id));
  useEffect(() => { if (type?.default_template_id) set("template_id", type.default_template_id); else set("template_id", templates[0]?.id ?? ""); /* eslint-disable-next-line */ }, [f.type_id]);
  useEffect(() => { if (f.deal_id && !f.counterparty_company_id) api.get<{ company_id: string | null; name: string; amount: number }>(`deals/${f.deal_id}`).then((d) => { setF((x) => ({ ...x, counterparty_company_id: d.company_id, title: x.title || `${type?.name ?? "Contrato"} · ${d.name}`, total_value: d.amount, annual_value: d.amount })); }).catch(() => undefined); /* eslint-disable-next-line */ }, [f.deal_id]);
  const warnings: string[] = [];
  if (Number(f.payment_terms_days) > 60) warnings.push("Plazo de pago superior a 60 días: cláusula nula según la Ley 3/2004 salvo justificación.");
  if (Number(f.total_value) >= 50000) warnings.push("Valor ≥ 50.000 €: requerirá aprobación de Finanzas.");
  if (f.contains_personal_data && (f.counterparty_outside_eea || f.international_transfer)) warnings.push("Datos personales con contraparte o transferencia fuera del EEE: cláusulas contractuales tipo (SCC) obligatorias y aprobación del DPO.");
  if (f.contains_personal_data && f.data_role === "processor") warnings.push("Tratamiento como encargado: se incluirá la cláusula DPA (art. 28 RGPD).");
  if (f.exclusivity) warnings.push("Exclusividad: desviación mayor del playbook, requerirá Dirección.");
  if (f.urgency === "critical" && !String(f.justification).trim()) warnings.push("Urgencia crítica: indica la justificación.");
  if (f.effective_date && String(f.effective_date) < new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)) warnings.push("Fecha de inicio anterior a 30 días: se marcará como regularización.");
  const steps = ["Qué necesitas", "Con quién", "Condiciones", "Contexto"];
  const valid = step === 0 ? !!f.type_id && String(f.title).trim().length > 0 && (f.paper_origin === "ours" || String(f.body).trim().length > 20) : step === 1 ? !!(f.counterparty_company_id || String(f.counterparty_name).trim()) : step === 2 ? (Number(f.payment_terms_days) <= 60 || String(f.justification).trim().length > 0) && (!f.contains_personal_data || f.data_role) : f.urgency !== "critical" || String(f.justification).trim().length > 0;
  const save = async () => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { title: f.title, type_id: f.type_id, counterparty_company_id: f.counterparty_company_id || undefined, counterparty_name: f.counterparty_company_id ? undefined : f.counterparty_name || undefined, deal_id: f.deal_id || null, owner_id: f.owner_id, department: f.department || null, paper_origin: f.paper_origin, effective_date: f.effective_date || null, term_type: f.term_type, term_months: Number(f.term_months) || null, renewal_type: isNda ? "none" : f.renewal_type, renewal_period_months: Number(f.renewal_period_months) || null, notice_period_days: Number(f.notice_period_days) || null, total_value: isNda ? 0 : Number(f.total_value) || 0, annual_value: isNda ? 0 : Number(f.annual_value || f.total_value) || 0, currency: f.currency, payment_model: f.payment_model, payment_terms_days: Number(f.payment_terms_days) || 30, contains_personal_data: !!f.contains_personal_data, data_role: f.contains_personal_data ? f.data_role : null, international_transfer: !!f.international_transfer, counterparty_outside_eea: !!f.counterparty_outside_eea, urgency: f.urgency, description: f.description || null, justification: f.justification || null, intake: { has_ip: !!f.has_ip, exclusivity: !!f.exclusivity, subcontracting: !!f.subcontracting, users: f.users ?? null, deadline: f.deadline ?? null, regularization: !!(f.effective_date && String(f.effective_date) < new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10)) }, template_id: f.paper_origin === "ours" ? f.template_id || null : null, body: f.paper_origin === "theirs" ? f.body : undefined, file_name: f.paper_origin === "theirs" ? f.file_name || null : null };
      const c = await api.post<{ id: string }>("clm/contracts", body);
      toast("Solicitud creada", "ok"); onClose(); onSaved(c);
    } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  };
  return (
    <Modal title={<span className="row"><FileSignature size={18} /> Nueva solicitud de contrato</span>} size="xl" onClose={onClose} footer={<><span className="grow small sub">{warnings.length ? `${warnings.length} avisos` : ""}</span><button className="btn" onClick={onClose}>Cancelar</button>{step > 0 && <button className="btn" onClick={() => setStep(step - 1)}>Anterior</button>}{step < 3 ? <button className="btn primary" disabled={!valid} onClick={() => setStep(step + 1)}>Siguiente</button> : <button className="btn primary" disabled={!valid || busy} onClick={save}>Crear solicitud</button>}</>}>
      <div className="wiz-steps">{steps.map((s, i) => <button key={s} className={i === step ? "cur" : i < step ? "done" : ""} onClick={() => i < step && setStep(i)}><span className="n">{i < step ? "✓" : i + 1}</span>{s}</button>)}</div>
      {step === 0 && <div className="form-grid">
        <Field label="Tipo de contrato" full><div className="type-grid">{meta.types.filter((t) => t.active).map((t) => <button key={t.id} className={`type-btn ${f.type_id === t.id ? "active" : ""}`} onClick={() => set("type_id", t.id)} style={{ borderLeft: `4px solid ${t.color}` }}><b>{t.name}</b><span>{FAMILY[t.family]} · {t.direction === "income" ? "ingreso" : t.direction === "expense" ? "gasto" : "neutral"} · firma {t.min_signature_level} · SLA {t.sla_hours} h</span></button>)}</div></Field>
        <Field label="Título del contrato" full><input className="input" value={String(f.title)} onChange={(e) => set("title", e.target.value)} placeholder={`Ej. ${type?.name ?? "Contrato"} · Nombre de la contraparte`} /></Field>
        <Field label="¿Quién aporta el texto?"><Seg items={[{ key: "ours", label: "Nuestra plantilla" }, { key: "theirs", label: "Papel de la contraparte" }]} value={String(f.paper_origin) as "ours"} onChange={(v) => set("paper_origin", v)} /></Field>
        {f.paper_origin === "ours" && <Field label="Plantilla"><select className="input" value={String(f.template_id)} onChange={(e) => set("template_id", e.target.value)}><option value="">Sin generar (subiré el texto)</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}
        {f.paper_origin === "theirs" && <><Field label="Nombre del archivo recibido"><input className="input" value={String(f.file_name)} onChange={(e) => set("file_name", e.target.value)} placeholder="propuesta-proveedor.docx" /></Field><Field label="Texto del contrato recibido (pégalo aquí; se clasifica y analiza automáticamente contra el playbook)" full><textarea className="input" style={{ minHeight: 180, fontFamily: "ui-monospace, monospace", fontSize: 12.5 }} value={String(f.body)} onChange={(e) => set("body", e.target.value)} /></Field></>}
      </div>}
      {step === 1 && <div className="form-grid">
        <Field label="Contraparte (empresa del CRM)"><Picker kind="company" value={f.counterparty_company_id as string | null} onChange={(id) => set("counterparty_company_id", id)} /></Field>
        <Field label="…o crear nueva (razón social)"><input className="input" value={String(f.counterparty_name)} onChange={(e) => set("counterparty_name", e.target.value)} disabled={!!f.counterparty_company_id} placeholder="Nueva empresa S.L." /></Field>
        <Field label="Negocio del CRM asociado"><Picker kind="deal" value={f.deal_id as string | null} onChange={(id) => set("deal_id", id)} /></Field>
        <Field label="Propietario del contrato"><select className="input" value={String(f.owner_id)} onChange={(e) => set("owner_id", e.target.value)}>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <label className="checkbox" style={{ gridColumn: "1 / -1" }}><input type="checkbox" checked={!!f.counterparty_outside_eea} onChange={(e) => set("counterparty_outside_eea", e.target.checked)} />La contraparte está fuera del Espacio Económico Europeo</label>
      </div>}
      {step === 2 && <div className="form-grid">
        <Field label={isNda ? "Finalidad del acuerdo" : "Objeto"} full><input className="input" value={String(f.description)} onChange={(e) => set("description", e.target.value)} placeholder={isNda ? "evaluar una posible colaboración en…" : "Servicios de…"} /></Field>
        <Field label="Fecha de inicio deseada"><input className="input" type="date" value={String(f.effective_date)} onChange={(e) => set("effective_date", e.target.value)} /></Field>
        <Field label="Duración"><div className="row"><select className="input" style={{ width: 130 }} value={String(f.term_type)} onChange={(e) => set("term_type", e.target.value)}><option value="fixed">Fija</option><option value="indefinite">Indefinida</option><option value="milestone">Por hito</option></select>{f.term_type === "fixed" && <input className="input" type="number" min={1} value={String(f.term_months)} onChange={(e) => set("term_months", Number(e.target.value))} />}{f.term_type === "fixed" && <span className="small">meses</span>}</div></Field>
        {!isNda && <>
          <Field label="Valor total estimado"><div className="row"><input className="input" type="number" min={0} value={String(f.total_value)} onChange={(e) => { set("total_value", Number(e.target.value)); set("annual_value", Number(e.target.value)); }} /><select className="input" style={{ width: 90 }} value={String(f.currency)} onChange={(e) => set("currency", e.target.value)}><option>EUR</option><option>USD</option><option>GBP</option></select></div></Field>
          <Field label="Valor anual"><input className="input" type="number" min={0} value={String(f.annual_value)} onChange={(e) => set("annual_value", Number(e.target.value))} /></Field>
          <Field label="Modelo de pago"><select className="input" value={String(f.payment_model)} onChange={(e) => set("payment_model", e.target.value)}>{Object.entries(PAYMENT_MODEL).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}</select></Field>
          <Field label="Plazo de pago (días)" error={Number(f.payment_terms_days) > 60 ? "Máximo legal 60 días (Ley 3/2004)" : undefined}><input className="input" type="number" min={0} value={String(f.payment_terms_days)} onChange={(e) => set("payment_terms_days", Number(e.target.value))} /></Field>
          <Field label="Renovación"><select className="input" value={String(f.renewal_type)} onChange={(e) => set("renewal_type", e.target.value)}>{Object.entries(RENEWAL).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}</select></Field>
          {f.renewal_type !== "none" && <Field label="Periodo de renovación (meses) y preaviso (días)"><div className="row"><input className="input" type="number" min={1} value={String(f.renewal_period_months)} onChange={(e) => set("renewal_period_months", Number(e.target.value))} /><input className="input" type="number" min={0} value={String(f.notice_period_days)} onChange={(e) => set("notice_period_days", Number(e.target.value))} /></div></Field>}
          {type?.code === "SAAS" && <Field label="Nº de usuarios"><input className="input" type="number" value={String(f.users ?? "")} onChange={(e) => set("users", Number(e.target.value))} /></Field>}
          <div className="col" style={{ gridColumn: "1 / -1", gap: 6 }}>
            <label className="checkbox"><input type="checkbox" checked={!!f.contains_personal_data} onChange={(e) => set("contains_personal_data", e.target.checked)} />Se tratan datos personales</label>
            {!!f.contains_personal_data && <div className="row wrap" style={{ paddingLeft: 24 }}><select className="input" style={{ width: 240 }} value={String(f.data_role)} onChange={(e) => set("data_role", e.target.value)}><option value="controller">Somos responsables del tratamiento</option><option value="processor">Somos / son encargados (DPA)</option><option value="joint">Corresponsables</option></select><label className="checkbox"><input type="checkbox" checked={!!f.international_transfer} onChange={(e) => set("international_transfer", e.target.checked)} />Hay transferencias internacionales</label></div>}
            <label className="checkbox"><input type="checkbox" checked={!!f.has_ip} onChange={(e) => set("has_ip", e.target.checked)} />Hay desarrollos o propiedad intelectual a medida</label>
            <label className="checkbox"><input type="checkbox" checked={!!f.exclusivity} onChange={(e) => set("exclusivity", e.target.checked)} />Se pide exclusividad</label>
            <label className="checkbox"><input type="checkbox" checked={!!f.subcontracting} onChange={(e) => set("subcontracting", e.target.checked)} />Habrá subcontratación</label>
          </div>
        </>}
        {Number(f.payment_terms_days) > 60 && <Field label="Justificación económica del plazo de pago" full><input className="input" value={String(f.justification)} onChange={(e) => set("justification", e.target.value)} /></Field>}
      </div>}
      {step === 3 && <div className="form-grid">
        <Field label="Departamento"><input className="input" value={String(f.department)} onChange={(e) => set("department", e.target.value)} placeholder="Ventas, Compras, IT…" /></Field>
        <Field label="Urgencia"><Seg items={[{ key: "normal", label: "Normal" }, { key: "high", label: "Alta" }, { key: "critical", label: "Crítica" }]} value={String(f.urgency) as "normal"} onChange={(v) => set("urgency", v)} /></Field>
        <Field label="Fecha límite de negocio"><input className="input" type="date" value={String(f.deadline ?? "")} onChange={(e) => set("deadline", e.target.value)} /></Field>
        {(f.urgency === "critical" || Number(f.payment_terms_days) > 60) && <Field label="Justificación"><input className="input" value={String(f.justification)} onChange={(e) => set("justification", e.target.value)} /></Field>}
        <div style={{ gridColumn: "1 / -1" }} className="card" >
          <h3 className="mb8">Resumen</h3>
          <div className="small"><b>{String(f.title)}</b> · {type?.name} · {f.paper_origin === "ours" ? "nuestra plantilla" : "papel de la contraparte"} · {isNda ? `${f.term_months} meses` : `${fmtMoney(Number(f.total_value), String(f.currency))} · ${PAYMENT_MODEL[String(f.payment_model)]?.label} · pago a ${f.payment_terms_days} días · ${f.term_type === "fixed" ? `${f.term_months} meses` : "indefinido"} · renovación ${RENEWAL[String(f.renewal_type)]?.label.toLowerCase()}`}{f.contains_personal_data ? " · datos personales" : ""}</div>
          <div className="small sub mt8">Al crear la solicitud: número automático, propietario {userNameOf(users, String(f.owner_id))}, asignación a legal por carga de trabajo, SLA de {type?.sla_hours} h{f.urgency === "critical" ? " (reducido a la mitad)" : ""}, {f.paper_origin === "ours" && f.template_id ? "generación del documento desde la plantilla" : "análisis del texto recibido"} y revisión automática contra el playbook.</div>
          {warnings.length > 0 && <div className="mt12 col" style={{ gap: 4 }}>{warnings.map((w) => <div key={w} className="small row" style={{ color: "var(--warn)" }}><AlertTriangle size={14} /> {w}</div>)}</div>}
        </div>
      </div>}
    </Modal>
  );
}
const userNameOf = (users: { id: string; name: string }[], id: string) => users.find((u) => u.id === id)?.name ?? "";
