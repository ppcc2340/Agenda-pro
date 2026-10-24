import { useEffect, useState, useCallback } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { Plus, Upload } from "lucide-react";
import { api, qs } from "../api";
import { useApp } from "../lib/app";
import { Kanban, type BoardStage } from "../components/Kanban";
import { DataTable, type Column, type GroupOption } from "../components/DataTable";
import { useBoard, customColumns } from "../lib/board";
import { DealForm } from "../components/RecordForms";
import { Seg, Spinner, useToast, errorMessage, Modal } from "../components/ui";
import { fmtMoney, fmtDate, relTime } from "../lib/format";
import { DEAL_STATUS_OPTS } from "../lib/colors";
import { Bars } from "../components/Charts";
import { CloseDealDialog } from "./DealDetail";

interface D { id: string; name: string; company_id: string | null; company_name: string | null; pipeline_id: string; pipeline_name: string; stage_id: string; stage_name: string; stage_color: string; status: string; amount: number; currency: string; probability: number; weighted_amount: number; expected_close_date: string | null; owner_id: string | null; owner_name: string | null; closed_at: string | null; loss_reason: string | null; last_activity_at: string | null; created_at: string; custom: Record<string, unknown>; tags: string[] }

export function DealsPage() {
  const nav = useNavigate();
  const { pipelines, users, me, isAdmin, customFields, can, userName, refresh: refreshApp } = useApp();
  const board = useBoard("deal");
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<"board" | "table" | "forecast">((params.get("view") as "board") || "board");
  const [pipelineId, setPipelineId] = useState(params.get("pipeline") || "");
  const [owner, setOwner] = useState("");
  const [q, setQ] = useState("");
  const [kb, setKb] = useState<{ stages: BoardStage[] } | null>(null);
  const [creating, setCreating] = useState(!!params.get("new"));
  const [closing, setClosing] = useState<{ id: string; name: string; stage: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const toast = useToast();
  const pid = pipelineId || pipelines.find((p) => p.is_default)?.id || pipelines[0]?.id || "";
  const loadBoard = useCallback(() => { if (!pid) return; api.get<{ stages: BoardStage[] }>(`deals/board/${pid}${qs({ owner_id: owner, q })}`).then(setKb).catch((e) => toast(errorMessage(e), "error")); }, [pid, owner, q, toast]);
  useEffect(() => { if (view === "board") loadBoard(); }, [view, loadBoard, refresh]);
  useEffect(() => { const p = new URLSearchParams(params); p.set("view", view); if (pid) p.set("pipeline", pid); setParams(p, { replace: true }); /* eslint-disable-next-line */ }, [view, pid]);
  const move = async (dealId: string, stageId: string) => {
    const stage = kb?.stages.find((s) => s.id === stageId);
    const deal = kb?.stages.flatMap((s) => s.deals).find((d) => d.id === dealId);
    if (stage?.kind === "lost") { setClosing({ id: dealId, name: deal?.name ?? "", stage: "lost" }); return; }
    if (stage?.kind === "won") { setClosing({ id: dealId, name: deal?.name ?? "", stage: "won" }); return; }
    // optimistic
    setKb((b) => { if (!b) return b; const from = b.stages.find((s) => s.deals.some((d) => d.id === dealId)); const d = from?.deals.find((x) => x.id === dealId); if (!from || !d) return b; return { stages: b.stages.map((s) => (s.id === from.id ? { ...s, deals: s.deals.filter((x) => x.id !== dealId) } : s.id === stageId ? { ...s, deals: [{ ...d, days_in_stage: 0, stale: false }, ...s.deals] } : s)) }; });
    try { await api.post(`deals/${dealId}/stage`, { stage_id: stageId }); toast(`Movido a ${stage?.name}`, "ok"); } catch (e) { toast(errorMessage(e), "error"); }
    loadBoard();
  };
  const openStages = kb?.stages.filter((s) => s.kind === "open") ?? [];
  const totals = openStages.reduce((a, s) => ({ count: a.count + s.count, amount: a.amount + s.amount, weighted: a.weighted + s.weighted }), { count: 0, amount: 0, weighted: 0 });
  const patch = (d: D, body: Record<string, unknown>) => api.patch(`deals/${d.id}`, body).then(() => undefined);
  const editable = can("deal", "update");
  const pipeline = pipelines.find((p) => p.id === pid);
  const stageOpts = Object.fromEntries((pipeline?.stages ?? []).map((s) => [s.id, { label: s.name, color: s.color }]));
  const toStage = async (d: D, v: string) => { const st = pipeline?.stages.find((s) => s.id === v); if (st && st.kind !== "open") { setClosing({ id: d.id, name: d.name, stage: st.kind }); return; } await api.post(`deals/${d.id}/stage`, { stage_id: v }); };
  const cols: Column<D>[] = [
    { key: "name", label: "Negocio", type: "name", sub: (d) => (d.company_name && !d.name.includes(d.company_name) ? d.company_name : null), render: (d) => <Link to={`/negocios/${d.id}`} onClick={(e) => e.stopPropagation()}>{d.name}</Link> },
    { key: "stage_id", label: "Etapa", sortable: true, type: "status", fixedOptions: true, options: stageOpts, value: (d) => d.stage_id, onEdit: editable ? (d, v) => toStage(d, String(v)) : undefined },
    { key: "status", label: "Estado", sortable: true, type: "status", fixedOptions: true, options: DEAL_STATUS_OPTS },
    { key: "owner_name", label: "Propietario", type: "person", onEdit: editable ? (d, v) => patch(d, { owner_id: v }) : undefined },
    { key: "amount", label: "Importe", sortable: true, type: "money", onEdit: editable ? (d, v) => patch(d, { amount: v }) : undefined, render: (d) => <span className="num">{fmtMoney(d.amount, d.currency)}</span> },
    { key: "probability", label: "Prob.", sortable: true, type: "number", agg: "avg", width: 90, render: (d) => `${d.probability}%`, onEdit: editable ? (d, v) => patch(d, { probability: Math.max(0, Math.min(100, Number(v))) }) : undefined },
    { key: "weighted_amount", label: "Ponderado", type: "money", default: false, render: (d) => <span className="num">{fmtMoney(d.weighted_amount, d.currency)}</span> },
    { key: "expected_close_date", label: "Cierre previsto", sortable: true, type: "date", onEdit: editable ? (d, v) => patch(d, { expected_close_date: v }) : undefined },
    { key: "company_name", label: "Empresa", className: "l", default: false, render: (d) => d.company_id ? <Link to={`/empresas/${d.company_id}`} onClick={(e) => e.stopPropagation()}>{d.company_name}</Link> : "" },
    { key: "pipeline_id", label: "Pipeline", className: "l", default: false, render: (d) => d.pipeline_name },
    { key: "last_activity_at", label: "Últ. actividad", sortable: true, className: "c", render: (d) => <span className="muted">{relTime(d.last_activity_at) || "nunca"}</span> },
    { key: "created_at", label: "Creado", sortable: true, type: "date", default: false, render: (d) => fmtDate(d.created_at) },
    { key: "closed_at", label: "Cerrado", sortable: true, type: "date", default: false, render: (d) => fmtDate(d.closed_at) },
    ...customColumns<D>(customFields, "deal", board, editable ? (d, k, v) => patch(d, { custom: { [k]: v } }) : undefined, userName),
  ];
  const stageGroups = [...(pipeline?.stages ?? []).filter((s) => s.kind === "open").map((s) => ({ key: s.id, label: s.name, color: s.color })), { key: "won", label: "Ganados", color: "var(--c-green)" }, { key: "lost", label: "Perdidos", color: "var(--c-red)" }];
  const groupOptions: GroupOption<D>[] = [
    { key: "stage", label: "Etapa", get: (d) => (d.status === "open" ? d.stage_id : d.status), groups: stageGroups, other: "Otros pipelines", setValue: (d, g) => (g === "won" || g === "lost" ? toStage(d, pipeline?.stages.find((s) => s.kind === g)?.id ?? g) : toStage(d, g)), createValue: (g) => (g === "won" || g === "lost" ? { pipeline_id: pid } : { pipeline_id: pid, stage_id: g }) },
    { key: "owner_id", label: "Propietario", get: (d) => d.owner_id ?? "", groups: users.filter((u) => u.active).map((u) => ({ key: u.id, label: u.name, color: "var(--c-green)" })), other: "Sin propietario", setValue: (d, g) => patch(d, { owner_id: g }), createValue: (g) => ({ pipeline_id: pid, owner_id: g }) },
    ...customFields.filter((f) => f.object === "deal" && f.type === "select").map<GroupOption<D>>((f) => ({ key: `custom.${f.key}`, label: f.label, get: (d) => String(d.custom?.[f.key] ?? ""), groups: Object.entries(cols.find((c) => c.key === `custom.${f.key}`)?.options ?? {}).map(([key, o]) => ({ key, label: o.label, color: o.color })), other: "Sin valor", setValue: (d, g) => patch(d, { custom: { [f.key]: g } }), createValue: (g) => ({ pipeline_id: pid, custom: { [f.key]: g } }) })),
  ];
  const create = async (name: string, extra: Record<string, unknown>) => { await api.post("deals", { name, pipeline_id: pid, ...extra }); };
  const duplicate = async (d: D) => { await api.post("deals", { name: `${d.name} (copia)`, company_id: d.company_id, pipeline_id: d.pipeline_id, stage_id: d.status === "open" ? d.stage_id : undefined, amount: d.amount, currency: d.currency, expected_close_date: d.expected_close_date, owner_id: d.owner_id, tags: d.tags, custom: d.custom }); };
  return (
    <div>
      <div className="page-head">
        <div><h1>Negocios</h1><p className="sub">{view === "board" && kb ? `${totals.count} abiertos · ${fmtMoney(totals.amount)} · ponderado ${fmtMoney(totals.weighted)}` : "Pipeline de ventas."}</p></div>
        <div className="row wrap">
          <Seg items={[{ key: "board", label: "Kanban" }, { key: "table", label: "Tabla" }, { key: "forecast", label: "Previsión" }]} value={view} onChange={setView} />
          {pipelines.length > 1 && <select className="input sm" style={{ width: "auto" }} value={pid} onChange={(e) => setPipelineId(e.target.value)}>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
          <Link to="/ajustes/importar?object=deal" className="btn ghost" title="Importar"><Upload /></Link>
          {can("deal", "create") && <button className="btn primary" onClick={() => setCreating(true)}><Plus />Nuevo negocio</button>}
        </div>
      </div>
      {view === "board" && (<>
        <div className="filterbar"><input className="input sm" style={{ maxWidth: 240 }} placeholder="Buscar negocio o empresa…" value={q} onChange={(e) => setQ(e.target.value)} />{(isAdmin || me.role.visibility !== "own") && <select className="input sm" style={{ width: "auto" }} value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Todos los propietarios</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}<span className="muted small right hide-mobile">Arrastra para cambiar de etapa · <span className="light green" style={{ display: "inline-block" }} /> actividad programada · <span className="light yellow" style={{ display: "inline-block" }} /> sin actividad · <span className="light red" style={{ display: "inline-block" }} /> tarea vencida</span></div>
        {!kb ? <Spinner /> : <Kanban stages={kb.stages} pipelineId={pid} editable={editable} onMove={move} onOpen={(d) => nav(`/negocios/${d.id}`)} onStagesChanged={async () => { await refreshApp(); loadBoard(); }} />}
      </>)}
      {view === "table" && <DataTable<D> object="deal" endpoint="deals" columns={cols} board={board} groupOptions={groupOptions} onCreate={editable ? create : undefined} onDuplicate={can("deal", "create") ? duplicate : undefined} extraParams={{ pipeline_id: pid }} onRowClick={(d) => nav(`/negocios/${d.id}`)} exportUrl="deals/export" refreshKey={refresh} emptyText="No hay negocios" defaultSort={{ field: "expected_close_date", dir: "asc" }} />}
      {view === "forecast" && <Forecast pipelineId={pid} />}
      {creating && <DealForm defaults={{ pipeline_id: pid }} onClose={() => setCreating(false)} onSaved={(d) => nav(`/negocios/${d.id}`)} />}
      {closing && <CloseDealDialog dealId={closing.id} dealName={closing.name} status={closing.stage as "won" | "lost"} onClose={() => setClosing(null)} onDone={() => { setClosing(null); setRefresh((r) => r + 1); loadBoard(); }} />}
    </div>
  );
}

function Forecast({ pipelineId }: { pipelineId: string }) {
  const [months, setMonths] = useState<{ month: string; count: number; amount: number; weighted: number; committed: number; best_case: number; deals: { id: string; name: string; company_name: string | null; stage_name: string; amount: number; probability: number; weighted: number; expected_close_date: string | null }[] }[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { api.get<{ months: NonNullable<typeof months> }>(`deals/forecast${qs({ pipeline_id: pipelineId })}`).then((r) => setMonths(r.months)); }, [pipelineId]);
  if (!months) return <Spinner />;
  const label = (m: string) => (m === "sin fecha" ? m : fmtDate(m + "-01", { month: "short", year: "numeric" }));
  return (
    <div>
      <div className="card mb16"><h2 className="mb12">Previsión por mes de cierre</h2><Bars data={months.map((m) => ({ ...m, label: label(m.month) }))} x="label" bars={[{ key: "committed", label: "Comprometido (≥70%)", color: "#00c875" }, { key: "weighted", label: "Ponderado", color: "#0073ea" }, { key: "amount", label: "Pipeline total", color: "#c5e0fb" }]} money /></div>
      <div className="card tight"><table className="table"><thead><tr><th>Mes</th><th className="r">Negocios</th><th className="r">Pipeline</th><th className="r">Ponderado</th><th className="r">Comprometido</th><th className="r">Mejor caso</th></tr></thead><tbody>
        {months.map((m) => (<><tr key={m.month} className="clickable" onClick={() => setOpen(open === m.month ? null : m.month)}><td className="bold">{label(m.month)}</td><td className="r num">{m.count}</td><td className="r num">{fmtMoney(m.amount)}</td><td className="r num">{fmtMoney(m.weighted)}</td><td className="r num">{fmtMoney(m.committed)}</td><td className="r num">{fmtMoney(m.best_case)}</td></tr>
          {open === m.month && m.deals.map((d) => <tr key={d.id}><td colSpan={2} style={{ paddingLeft: 28 }}><Link to={`/negocios/${d.id}`}>{d.name}</Link><div className="xs muted">{d.company_name} · {d.stage_name} · {fmtDate(d.expected_close_date)}</div></td><td className="r num">{fmtMoney(d.amount)}</td><td className="r num">{fmtMoney(d.weighted)} <span className="muted">({d.probability}%)</span></td><td colSpan={2} /></tr>)}</>))}
        {months.length === 0 && <tr><td colSpan={6} className="muted">No hay negocios abiertos.</td></tr>}
      </tbody></table></div>
    </div>
  );
}

