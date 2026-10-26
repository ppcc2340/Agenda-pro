/**
 * Analítica: paneles con widgets (arrastrar, redimensionar, filtros globales), constructor de informes guardables y
 * compartibles, embudo/previsión/cuotas/motivos de pérdida, e informes programados y alertas de métricas.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { Plus, Trash2, Copy, Save, Download, Pencil, X, Play, Bell, CalendarClock, LayoutDashboard, GripVertical, Check, BarChart3, LineChart as LineIcon, PieChart as PieIcon, Table2, Hash, Layers } from "lucide-react";
import { api, qs, downloadFile } from "../api";
import { useApp } from "../lib/app";
import { Tabs, Spinner, Modal, Field, useToast, errorMessage, useConfirm, Empty } from "../components/ui";
import { FilterBuilder, type FilterGroup } from "../components/FilterBuilder";
import { ReportChart, ReportTable, fmtMetric, type ReportResult } from "../components/ReportChart";
import { Bars, Donut, Funnel, PALETTE } from "../components/Charts";
import { fmtMoney, fmtNum, fmtDate } from "../lib/format";
import "./analytics.css";

type Any = Record<string, unknown>;
interface Global { from?: string; to?: string; owner_id?: string; team_id?: string; pipeline_id?: string }
interface Meta { objects: Record<string, { fields: { field: string; label: string; kind: string }[]; date_field: string; label?: string; custom_object?: boolean }>; kpis: Record<string, { label: string; money?: boolean; pct?: boolean }> }
interface Dim { field: string; bucket?: string }
interface Metric { fn: string; field?: string; label?: string }
interface Config { filters?: FilterGroup; dims: Dim[]; metrics: Metric[]; chart: string; sort: { by: "dim" | "metric"; dir: "asc" | "desc" }; limit: number; date_field?: string }
interface SavedReport { id: string; name: string; description?: string | null; object: string; config: Config; visibility: string; owner_id: string | null; owner_name?: string }
interface Widget { id: string; kind: "report" | "kpi" | "funnel" | "forecast" | "quota" | "loss_reasons"; report_id?: string; kpi?: string; title?: string; w: number; h: number; chart?: string }
interface Dashboard { id: string; name: string; visibility: string; role_key: string | null; is_default: number; owner_id: string | null; widgets: Widget[]; filters: Global }

const OBJECTS: Record<string, string> = { deal: "Negocios", contact: "Contactos", company: "Empresas", ticket: "Tickets", task: "Tareas", contract: "Contratos", activity: "Actividades" };
const BUCKETS: Record<string, string> = { day: "Día", week: "Semana", month: "Mes", quarter: "Trimestre", year: "Año" };
const FNS: Record<string, string> = { count: "Recuento", sum: "Suma", avg: "Media", min: "Mínimo", max: "Máximo" };
const CHARTS: [string, string, typeof BarChart3][] = [["bar", "Barras", BarChart3], ["stacked", "Apiladas", Layers], ["line", "Líneas", LineIcon], ["pie", "Tarta", PieIcon], ["table", "Tabla", Table2], ["kpi", "Número", Hash]];
const VIS: Record<string, string> = { private: "Solo yo", team: "Mi equipo", all: "Todo el equipo", role: "Por rol" };
const KIND_LABEL: Record<string, string> = { funnel: "Embudo por etapas", forecast: "Previsión vs real", quota: "Cuotas", loss_reasons: "Motivos de pérdida" };
const ROLE_LABEL: Record<string, string> = { admin: "Administración", manager: "Managers", sales: "Comerciales", marketing: "Marketing", support: "Soporte", readonly: "Solo lectura" };
const EMPTY_CFG: Config = { dims: [{ field: "stage_id" }], metrics: [{ fn: "count" }, { fn: "sum", field: "amount" }], chart: "bar", sort: { by: "metric", dir: "desc" }, limit: 50 };
const isoToday = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

export function AnalyticsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "paneles";
  const [meta, setMeta] = useState<Meta | null>(null);
  // los objetos personalizados llegan en /meta con su nombre: se añaden al selector «Datos de»
  useEffect(() => { api.get<Meta>("analytics/meta").then((m) => { for (const [k, o] of Object.entries(m.objects)) if (o.label) OBJECTS[k] = o.label; setMeta(m); }).catch(() => undefined); }, []);
  return (
    <div className="an">
      <div className="page-head"><div><h1>Analítica</h1><p className="sub">Paneles, constructor de informes, previsión y alertas. Todo respeta lo que tu rol puede ver.</p></div><Link className="btn ghost" to="/informes">Informes fijos</Link></div>
      <Tabs items={[{ key: "paneles", label: "Paneles" }, { key: "constructor", label: "Constructor de informes" }, { key: "comercial", label: "Embudo, previsión y cuotas" }, { key: "alertas", label: "Programados y alertas" }]} value={tab} onChange={(t) => setParams({ tab: t }, { replace: true })} />
      {!meta ? <Spinner /> : tab === "paneles" ? <Dashboards meta={meta} /> : tab === "constructor" ? <Builder meta={meta} /> : tab === "comercial" ? <Commercial /> : <SchedulesAlerts meta={meta} />}
    </div>
  );
}

/* ================================================================== filtros globales */
function GlobalBar({ value, onChange, extra }: { value: Global; onChange: (g: Global) => void; extra?: ReactNode }) {
  const { users, teams, pipelines, isAdmin, me } = useApp();
  const canFilter = isAdmin || me.role.visibility !== "own";
  const set = (p: Partial<Global>) => onChange({ ...value, ...p });
  const preset = (n: number) => set({ from: daysAgo(n), to: isoToday() });
  return (
    <div className="an-global">
      <span className="xs muted">Periodo</span>
      <input className="input sm" type="date" aria-label="Desde" value={value.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined })} />
      <span className="muted">→</span>
      <input className="input sm" type="date" aria-label="Hasta" value={value.to ?? ""} onChange={(e) => set({ to: e.target.value || undefined })} />
      {[[7, "7 d"], [30, "30 d"], [90, "90 d"], [365, "12 m"]].map(([n, l]) => <button key={l} className="tag" onClick={() => preset(Number(n))}>{l}</button>)}
      {canFilter && <select className="input sm" aria-label="Propietario" value={value.owner_id ?? ""} onChange={(e) => set({ owner_id: e.target.value || undefined })}><option value="">Todos los propietarios</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
      {canFilter && teams.length > 0 && <select className="input sm" aria-label="Equipo" value={value.team_id ?? ""} onChange={(e) => set({ team_id: e.target.value || undefined })}><option value="">Todos los equipos</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
      {pipelines.length > 1 && <select className="input sm" aria-label="Pipeline" value={value.pipeline_id ?? ""} onChange={(e) => set({ pipeline_id: e.target.value || undefined })}><option value="">Todos los pipelines</option>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}
      {(value.from || value.to || value.owner_id || value.team_id || value.pipeline_id) && <button className="btn ghost sm" onClick={() => onChange({})}><X />Quitar filtros</button>}
      <span className="grow" />{extra}
    </div>
  );
}

/* ================================================================== paneles */
function Dashboards({ meta }: { meta: Meta }) {
  const { isAdmin, me } = useApp();
  const toast = useToast(); const confirm = useConfirm();
  const [list, setList] = useState<Dashboard[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Dashboard | null>(null);
  const [global, setGlobal] = useState<Global>({});
  const [adding, setAdding] = useState(false);
  const [reports, setReports] = useState<SavedReport[]>([]);
  const load = useCallback(async (keep?: string) => { const r = await api.get<{ items: Dashboard[] }>("analytics/dashboards"); setList(r.items); setSel((s) => keep ?? s ?? r.items[0]?.id ?? null); }, []);
  useEffect(() => { load().catch((e) => toast(errorMessage(e), "error")); api.get<{ items: SavedReport[] }>("analytics/reports").then((r) => setReports(r.items)).catch(() => undefined); }, [load]);
  const dash = list?.find((d) => d.id === sel) ?? null;
  useEffect(() => { setGlobal(dash?.filters ?? {}); setDraft(null); }, [dash?.id]);
  const view = draft ?? dash;
  const canEdit = !!dash && (isAdmin || dash.owner_id === me.id);
  const save = async () => { if (!draft) return; try { const d = await api.put<Dashboard>(`analytics/dashboards/${draft.id}`, { name: draft.name, visibility: draft.visibility, role_key: draft.role_key, widgets: draft.widgets, filters: global }); toast("Panel guardado", "ok"); setDraft(null); await load(d.id); } catch (e) { toast(errorMessage(e), "error"); } };
  const create = async () => { try { const d = await api.post<Dashboard>("analytics/dashboards", { name: "Nuevo panel", widgets: [{ id: "k1", kind: "kpi", kpi: "won_amount", w: 4, h: 1 }] }); await load(d.id); setDraft(d); } catch (e) { toast(errorMessage(e), "error"); } };
  const dup = async () => { if (!dash) return; try { const d = await api.post<Dashboard>(`analytics/dashboards/${dash.id}/duplicate`); toast("Copia creada: ya puedes personalizarla", "ok"); await load(d.id); } catch (e) { toast(errorMessage(e), "error"); } };
  const del = async () => { if (!dash || !(await confirm({ title: `¿Borrar el panel «${dash.name}»?`, danger: true, confirmText: "Borrar" }))) return; try { await api.del(`analytics/dashboards/${dash.id}`); setSel(null); await load(); } catch (e) { toast(errorMessage(e), "error"); } };
  if (!list) return <Spinner />;
  return (
    <div>
      <div className="an-dash-head">
        <select className="input" aria-label="Panel" value={sel ?? ""} onChange={(e) => setSel(e.target.value)}>{list.map((d) => <option key={d.id} value={d.id}>{d.name}{d.role_key ? ` · ${ROLE_LABEL[d.role_key] ?? d.role_key}` : d.visibility !== "private" ? ` · ${VIS[d.visibility]}` : ""}</option>)}</select>
        {draft ? <>
          <input className="input" aria-label="Nombre del panel" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} style={{ maxWidth: 240 }} />
          <select className="input" aria-label="Visibilidad" style={{ width: "auto" }} value={draft.visibility} onChange={(e) => setDraft({ ...draft, visibility: e.target.value })}>{Object.entries(VIS).filter(([k]) => isAdmin || k === "private" || k === "team").map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          {draft.visibility === "role" && <select className="input" aria-label="Rol" style={{ width: "auto" }} value={draft.role_key ?? ""} onChange={(e) => setDraft({ ...draft, role_key: e.target.value })}>{Object.entries(ROLE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
          <button className="btn" onClick={() => setAdding(true)}><Plus />Añadir widget</button>
          <button className="btn primary" onClick={save}><Save />Guardar panel</button>
          <button className="btn ghost" onClick={() => setDraft(null)}>Cancelar</button>
        </> : <>
          {canEdit && <button className="btn" onClick={() => dash && setDraft(structuredClone(dash))}><Pencil />Editar</button>}
          <button className="btn ghost" onClick={dup} disabled={!dash}><Copy />Duplicar</button>
          <button className="btn ghost" onClick={create}><Plus />Nuevo panel</button>
          {canEdit && !dash?.is_default && <button className="btn ghost" onClick={del}><Trash2 />Borrar</button>}
        </>}
      </div>
      <GlobalBar value={global} onChange={setGlobal} extra={draft ? <span className="xs muted">Los filtros se guardan con el panel</span> : undefined} />
      {!view ? <Empty title="No hay paneles" /> : !view.widgets.length ? <div className="card"><Empty title="Panel vacío" text="Pulsa Editar y añade widgets: KPIs, tus informes guardados, embudo, previsión, cuotas o motivos de pérdida." /></div> : (
        <WidgetGrid widgets={view.widgets} editing={!!draft} onChange={(w) => draft && setDraft({ ...draft, widgets: w })} render={(w) => <WidgetBody w={w} global={global} meta={meta} reports={reports} />} reports={reports} meta={meta} />
      )}
      {adding && draft && <AddWidget meta={meta} reports={reports} onClose={() => setAdding(false)} onAdd={(w) => { setDraft({ ...draft, widgets: [...draft.widgets, w] }); setAdding(false); }} />}
    </div>
  );
}

function widgetTitle(w: Widget, meta: Meta, reports: SavedReport[]) {
  return w.title || (w.kind === "kpi" ? meta.kpis[w.kpi ?? ""]?.label ?? "KPI" : w.kind === "report" ? reports.find((r) => r.id === w.report_id)?.name ?? "Informe" : KIND_LABEL[w.kind] ?? w.kind);
}

/** Rejilla de 12 columnas: arrastrar para reordenar, tirador para redimensionar (ancho en columnas, alto en filas). */
function WidgetGrid({ widgets, editing, onChange, render, reports, meta }: { widgets: Widget[]; editing: boolean; onChange: (w: Widget[]) => void; render: (w: Widget) => ReactNode; reports: SavedReport[]; meta: Meta }) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const move = (from: string, to: string) => { const a = [...widgets]; const i = a.findIndex((x) => x.id === from), j = a.findIndex((x) => x.id === to); if (i < 0 || j < 0) return; const [m] = a.splice(i, 1); a.splice(j, 0, m!); onChange(a); };
  const resize = (e: React.MouseEvent, w: Widget) => {
    e.preventDefault(); e.stopPropagation();
    const el = ref.current; if (!el) return;
    const colW = el.clientWidth / 12; const rowH = 160;
    const x0 = e.clientX, y0 = e.clientY, w0 = w.w, h0 = w.h;
    const mv = (ev: MouseEvent) => { const nw = Math.max(2, Math.min(12, Math.round(w0 + (ev.clientX - x0) / colW))); const nh = Math.max(1, Math.min(4, Math.round(h0 + (ev.clientY - y0) / rowH))); if (nw !== w.w || nh !== w.h) onChange(widgets.map((x) => (x.id === w.id ? { ...x, w: nw, h: nh } : x))); };
    const up = () => { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up); };
    document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
  };
  return (
    <div ref={ref} className={`an-grid ${editing ? "editing" : ""}`}>
      {widgets.map((w) => (
        <div key={w.id} className={`an-w ${drag === w.id ? "drag" : ""}`} style={{ gridColumn: `span ${w.w}`, gridRow: `span ${w.h}` }}
          draggable={editing} onDragStart={() => setDrag(w.id)} onDragEnd={() => setDrag(null)} onDragOver={(e) => { if (drag && drag !== w.id) { e.preventDefault(); move(drag, w.id); } }}>
          <div className="an-w-head">
            {editing && <GripVertical size={14} className="muted an-grip" aria-hidden />}
            {editing ? <input className="input sm grow" aria-label="Título del widget" value={w.title ?? ""} placeholder={widgetTitle(w, meta, reports)} onChange={(e) => onChange(widgets.map((x) => (x.id === w.id ? { ...x, title: e.target.value } : x)))} /> : <h3>{widgetTitle(w, meta, reports)}</h3>}
            {editing && w.kind === "report" && <select className="input sm" aria-label="Gráfico" style={{ width: "auto" }} value={w.chart ?? ""} onChange={(e) => onChange(widgets.map((x) => (x.id === w.id ? { ...x, chart: e.target.value || undefined } : x)))}><option value="">Gráfico del informe</option>{CHARTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
            {editing && <button className="iconbtn" title="Quitar widget" onClick={() => onChange(widgets.filter((x) => x.id !== w.id))} aria-label="Quitar widget"><X size={14} /></button>}
          </div>
          <div className="an-w-body">{render(w)}</div>
          {editing && <span className="an-resize" title="Arrastra para cambiar el tamaño" onMouseDown={(e) => resize(e, w)} />}
        </div>
      ))}
    </div>
  );
}

function AddWidget({ meta, reports, onClose, onAdd }: { meta: Meta; reports: SavedReport[]; onClose: () => void; onAdd: (w: Widget) => void }) {
  const [kind, setKind] = useState<Widget["kind"]>("kpi");
  const [kpi, setKpi] = useState("won_amount");
  const [rid, setRid] = useState(reports[0]?.id ?? "");
  const [w, setW] = useState(4);
  const add = () => onAdd({ id: Math.random().toString(36).slice(2, 9), kind, kpi: kind === "kpi" ? kpi : undefined, report_id: kind === "report" ? rid : undefined, w: kind === "kpi" ? Math.min(w, 4) : Math.max(w, 4), h: kind === "kpi" ? 1 : 2 });
  return (
    <Modal title="Añadir widget" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={kind === "report" && !rid} onClick={add}>Añadir</button></>}>
      <Field label="Tipo"><div className="type-grid">{([["kpi", "KPI"], ["report", "Informe guardado"], ["funnel", KIND_LABEL.funnel], ["forecast", KIND_LABEL.forecast], ["quota", KIND_LABEL.quota], ["loss_reasons", KIND_LABEL.loss_reasons]] as [Widget["kind"], string][]).map(([k, l]) => <button key={k} className={`type-btn ${kind === k ? "active" : ""}`} onClick={() => setKind(k)}><b>{l}</b></button>)}</div></Field>
      {kind === "kpi" && <Field label="Indicador"><select className="input" value={kpi} onChange={(e) => setKpi(e.target.value)}>{Object.entries(meta.kpis).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>}
      {kind === "report" && (reports.length ? <Field label="Informe"><select className="input" value={rid} onChange={(e) => setRid(e.target.value)}>{reports.map((r) => <option key={r.id} value={r.id}>{r.name} · {OBJECTS[r.object]}</option>)}</select></Field> : <p className="small">Aún no tienes informes guardados: créalos en «Constructor de informes».</p>)}
      <Field label="Ancho (columnas de 12)"><input className="input" type="number" min={2} max={12} value={w} onChange={(e) => setW(Number(e.target.value))} /></Field>
    </Modal>
  );
}

function useLoad<T>(url: string | null, body?: unknown): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<string | null>(null);
  const key = `${url}|${JSON.stringify(body ?? null)}`;
  useEffect(() => { if (!url) return; let alive = true; setData(null); setError(null); (body !== undefined ? api.post<T>(url, body) : api.get<T>(url)).then((d) => alive && setData(d)).catch((e) => alive && setError(errorMessage(e))); return () => { alive = false; }; /* eslint-disable-next-line */ }, [key]);
  return { data, error };
}
const gq = (g: Global) => qs({ from: g.from, to: g.to, owner_id: g.owner_id, team_id: g.team_id, pipeline_id: g.pipeline_id });

function WidgetBody({ w, global, meta }: { w: Widget; global: Global; meta: Meta; reports: SavedReport[] }) {
  if (w.kind === "kpi") return <KpiWidget k={w.kpi ?? ""} global={global} meta={meta} />;
  if (w.kind === "report") return <ReportWidget id={w.report_id ?? ""} global={global} chart={w.chart} h={w.h} />;
  if (w.kind === "funnel") return <FunnelView global={global} compact />;
  if (w.kind === "forecast") return <ForecastView global={global} compact h={w.h} />;
  if (w.kind === "quota") return <QuotaView global={global} compact />;
  return <LossView global={global} compact h={w.h} />;
}
function KpiWidget({ k, global }: { k: string; global: Global; meta: Meta }) {
  const { data, error } = useLoad<{ value: number; previous: number | null; money?: boolean; pct?: boolean }>(`analytics/kpi/${k}${gq(global)}`);
  if (error) return <div className="rc-empty">{error}</div>;
  if (!data) return <Spinner />;
  const fmt = (v: number) => (data.money ? fmtMoney(v) : data.pct ? `${fmtNum(v)} %` : fmtNum(v));
  const delta = data.previous === null ? null : data.previous ? Math.round(((data.value - data.previous) / Math.abs(data.previous)) * 100) : null;
  return <div className="an-kpi"><div className="v num">{fmt(data.value)}</div>{data.previous !== null && <div className={`d ${delta !== null && delta < 0 ? "down" : "up"}`}>{delta === null ? `antes: ${fmt(data.previous)}` : `${delta > 0 ? "+" : ""}${delta} % vs periodo anterior`}</div>}</div>;
}
function ReportWidget({ id, global, chart, h }: { id: string; global: Global; chart?: string; h: number }) {
  const { data, error } = useLoad<{ result: ReportResult }>(`analytics/reports/${id}/run`, { global });
  if (error) return <div className="rc-empty">{error}</div>;
  if (!data) return <Spinner />;
  return <ReportChart res={data.result} chart={chart} height={h * 160 - 70} compact />;
}

/* ================================================================== constructor */
function Builder({ meta }: { meta: Meta }) {
  const toast = useToast(); const confirm = useConfirm();
  const { me, isAdmin, can } = useApp();
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [cur, setCur] = useState<SavedReport | null>(null);
  const [name, setName] = useState("Nuevo informe");
  const [object, setObject] = useState("deal");
  const [cfg, setCfg] = useState<Config>(EMPTY_CFG);
  const [vis, setVis] = useState("private");
  const [global, setGlobal] = useState<Global>({});
  const [res, setRes] = useState<ReportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [toDash, setToDash] = useState(false);
  const [sched, setSched] = useState(false);
  const loadList = () => api.get<{ items: SavedReport[] }>("analytics/reports").then((r) => setReports(r.items));
  useEffect(() => { loadList().catch(() => undefined); }, []);
  const fields = meta.objects[object]?.fields ?? [];
  const numeric = fields.filter((f) => f.kind === "number");
  const kindOf = (f: string) => fields.find((x) => x.field === f)?.kind;
  useEffect(() => {
    const t = setTimeout(() => { api.post<ReportResult>("analytics/run", { object, config: cfg, global }).then((r) => { setRes(r); setErr(null); }).catch((e) => { setErr(errorMessage(e)); setRes(null); }); }, 250);
    return () => clearTimeout(t);
  }, [object, JSON.stringify(cfg), JSON.stringify(global)]);
  const open = (r: SavedReport) => { setCur(r); setName(r.name); setObject(r.object); setCfg({ ...EMPTY_CFG, ...r.config }); setVis(r.visibility); };
  const fresh = () => { setCur(null); setName("Nuevo informe"); setObject("deal"); setCfg(EMPTY_CFG); setVis("private"); };
  const setObj = (o: string) => { setObject(o); const f = meta.objects[o]?.fields ?? []; const firstText = f.find((x) => ["owner_id", "assignee_id", "user_id", "type", "status"].includes(x.field)) ?? f[0]; setCfg({ ...cfg, filters: undefined, dims: firstText ? [{ field: firstText.field }] : [], metrics: [{ fn: "count" }], date_field: undefined }); };
  const mine = !cur || cur.owner_id === me.id || isAdmin;
  const canShare = isAdmin || can("report", "create") || can("report", "update");
  const save = async (asNew = false) => {
    try {
      const body = { name, object, config: cfg, visibility: vis };
      const r = cur && !asNew && mine ? await api.put<SavedReport>(`analytics/reports/${cur.id}`, body) : await api.post<SavedReport>("analytics/reports", { ...body, name: asNew && cur ? `${name} (copia)` : name });
      toast("Informe guardado", "ok"); await loadList(); open(r);
    } catch (e) { toast(errorMessage(e), "error"); }
  };
  const del = async () => { if (!cur || !(await confirm({ title: `¿Borrar «${cur.name}»?`, text: "También se borran sus envíos programados.", danger: true, confirmText: "Borrar" }))) return; try { await api.del(`analytics/reports/${cur.id}`); toast("Borrado", "ok"); fresh(); await loadList(); } catch (e) { toast(errorMessage(e), "error"); } };
  const exportCsv = async () => { try { await downloadFile(cur ? `/api/analytics/reports/${cur.id}/export.csv${gq(global)}` : `/api/analytics/run.csv${qs({ object, config: JSON.stringify(cfg), name, ...global })}`); toast("CSV descargado (se abre en Excel)", "ok"); } catch (e) { toast(errorMessage(e), "error"); } };
  const setDim = (i: number, d: Dim | null) => { const dims = [...cfg.dims]; if (d) dims[i] = d; else dims.splice(i, 1); setCfg({ ...cfg, dims, sort: d?.bucket ? { by: "dim", dir: "asc" } : cfg.sort }); };
  const setMetric = (i: number, m: Metric | null) => { const metrics = [...cfg.metrics]; if (m) metrics[i] = m; else metrics.splice(i, 1); setCfg({ ...cfg, metrics: metrics.length ? metrics : [{ fn: "count" }] }); };
  return (
    <div className="an-builder">
      <aside className="card an-list">
        <div className="row mb8"><b className="grow">Mis informes</b><button className="btn sm primary" onClick={fresh}><Plus />Nuevo</button></div>
        {!reports.length && <p className="xs muted">Aún no hay informes guardados.</p>}
        {reports.map((r) => <button key={r.id} className={`an-item ${cur?.id === r.id ? "on" : ""}`} onClick={() => open(r)}><b>{r.name}</b><span className="xs muted">{OBJECTS[r.object]} · {VIS[r.visibility] ?? r.visibility}{r.owner_id !== me.id && r.owner_name ? ` · ${r.owner_name}` : ""}</span></button>)}
      </aside>
      <section className="an-main">
        <div className="card mb12">
          <div className="an-form">
            <Field label="Nombre"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Datos de"><select className="input" value={object} onChange={(e) => setObj(e.target.value)}>{Object.entries(OBJECTS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="Compartir"><select className="input" value={vis} onChange={(e) => setVis(e.target.value)}>{["private", "team", "all"].filter((k) => canShare || k === "private").map((k) => <option key={k} value={k}>{VIS[k]}</option>)}</select></Field>
            <Field label="Fecha para el periodo"><select className="input" value={cfg.date_field ?? ""} onChange={(e) => setCfg({ ...cfg, date_field: e.target.value || undefined })}><option value="">{fields.find((f) => f.field === meta.objects[object]?.date_field)?.label ?? "Fecha de creación"} (por defecto)</option>{fields.filter((f) => f.kind === "date" && !f.field.startsWith("custom.")).map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}</select></Field>
          </div>
          <div className="an-section"><b className="small">Filtros</b><FilterBuilder object={object} value={cfg.filters ?? { logic: "and", conditions: [] }} onChange={(f) => setCfg({ ...cfg, filters: f })} /></div>
          <div className="an-cols">
            <div className="an-section"><b className="small">Agrupar por</b>
              {cfg.dims.map((d, i) => <div key={i} className="row mt8"><select className="input sm" aria-label={`Agrupación ${i + 1}`} value={d.field} onChange={(e) => setDim(i, { field: e.target.value, bucket: kindOf(e.target.value) === "date" ? "month" : undefined })}>{fields.filter((f) => f.kind !== "number" || f.field.startsWith("custom.")).map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}</select>{kindOf(d.field) === "date" && <select className="input sm" aria-label="Intervalo" style={{ width: 120 }} value={d.bucket ?? "month"} onChange={(e) => setDim(i, { ...d, bucket: e.target.value })}>{Object.entries(BUCKETS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}<button className="iconbtn" title="Quitar" onClick={() => setDim(i, null)} aria-label="Quitar"><X size={14} /></button></div>)}
              {cfg.dims.length < 2 && <button className="btn ghost sm mt8" onClick={() => setDim(cfg.dims.length, { field: fields[0]?.field ?? "created_at" })}><Plus />{cfg.dims.length ? "Segunda agrupación" : "Agrupación"}</button>}
            </div>
            <div className="an-section"><b className="small">Métricas</b>
              {cfg.metrics.map((m, i) => <div key={i} className="row mt8"><select className="input sm" aria-label={`Función ${i + 1}`} style={{ width: 120 }} value={m.fn} onChange={(e) => setMetric(i, { fn: e.target.value, field: e.target.value === "count" ? undefined : m.field ?? numeric[0]?.field })}>{Object.entries(FNS).map(([k, l]) => <option key={k} value={k} disabled={k !== "count" && !numeric.length}>{l}</option>)}</select>{m.fn !== "count" && <select className="input sm" aria-label="Campo" value={m.field ?? ""} onChange={(e) => setMetric(i, { ...m, field: e.target.value })}>{numeric.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}</select>}{cfg.metrics.length > 1 && <button className="iconbtn" title="Quitar" onClick={() => setMetric(i, null)} aria-label="Quitar"><X size={14} /></button>}</div>)}
              {cfg.metrics.length < 4 && <button className="btn ghost sm mt8" onClick={() => setMetric(cfg.metrics.length, numeric[0] ? { fn: "sum", field: numeric[0].field } : { fn: "count" })}><Plus />Métrica</button>}
            </div>
            <div className="an-section"><b className="small">Orden y límite</b>
              <div className="row mt8"><select className="input sm" aria-label="Ordenar por" value={`${cfg.sort.by}:${cfg.sort.dir}`} onChange={(e) => { const [by, dir] = e.target.value.split(":") as ["dim", "asc"]; setCfg({ ...cfg, sort: { by, dir } }); }}><option value="metric:desc">Mayor valor primero</option><option value="metric:asc">Menor valor primero</option><option value="dim:asc">Por agrupación (A→Z, antiguo→reciente)</option><option value="dim:desc">Por agrupación (Z→A, reciente→antiguo)</option></select><input className="input sm" aria-label="Límite de filas" type="number" min={1} max={500} style={{ width: 80 }} value={cfg.limit} onChange={(e) => setCfg({ ...cfg, limit: Math.max(1, Math.min(500, Number(e.target.value) || 50)) })} /></div>
            </div>
          </div>
          <div className="an-charts" role="radiogroup" aria-label="Tipo de gráfico">{CHARTS.map(([k, l, I]) => <button key={k} role="radio" aria-checked={cfg.chart === k} className={`an-chartbtn ${cfg.chart === k ? "on" : ""}`} onClick={() => setCfg({ ...cfg, chart: k })}><I size={16} />{l}</button>)}</div>
          <div className="row wrap mt12" style={{ gap: 6 }}>
            <button className="btn primary" onClick={() => save(false)}><Save />{cur && mine ? "Guardar" : "Guardar informe"}</button>
            {cur && <button className="btn" onClick={() => save(true)}><Copy />Guardar como copia</button>}
            <button className="btn" onClick={exportCsv} disabled={!res}><Download />Exportar CSV</button>
            {cur && <button className="btn" onClick={() => setToDash(true)}><LayoutDashboard />Añadir a un panel</button>}
            {cur && <button className="btn" onClick={() => setSched(true)}><CalendarClock />Programar envío</button>}
            {cur && mine && <button className="btn ghost" onClick={del}><Trash2 />Borrar</button>}
            {cur && !mine && <span className="xs muted">Informe de {cur.owner_name}: «Guardar como copia» para tener el tuyo.</span>}
          </div>
        </div>
        <GlobalBar value={global} onChange={setGlobal} />
        <div className="card an-preview">
          {err ? <div className="alert error">{err}</div> : !res ? <Spinner /> : <>
            <div className="row mb8"><h2 className="grow">{name}</h2>{res.metrics.map((m) => <span key={m.key} className="badge">{m.label}: <b>{fmtMetric(m, res.totals[m.key])}</b></span>)}</div>
            <ReportChart res={res} height={320} />
            {cfg.chart !== "table" && cfg.chart !== "kpi" && res.dims.length > 0 && <details className="mt12"><summary className="small">Ver datos</summary><ReportTable res={res} compact /></details>}
          </>}
        </div>
      </section>
      {toDash && cur && <AddToDashboard report={cur} chart={cfg.chart} onClose={() => setToDash(false)} />}
      {sched && cur && <ScheduleDialog reports={[cur]} initial={cur.id} onClose={() => setSched(false)} onSaved={() => { setSched(false); toast("Envío programado: lo verás en «Programados y alertas»", "ok"); }} />}
    </div>
  );
}

function AddToDashboard({ report, chart, onClose }: { report: SavedReport; chart: string; onClose: () => void }) {
  const toast = useToast(); const { isAdmin, me } = useApp();
  const [list, setList] = useState<Dashboard[]>([]);
  const [sel, setSel] = useState("");
  useEffect(() => { api.get<{ items: Dashboard[] }>("analytics/dashboards").then((r) => { const own = r.items.filter((d) => isAdmin || d.owner_id === me.id); setList(own); setSel(own[0]?.id ?? "new"); }); }, []);
  const add = async () => {
    try {
      const w: Widget = { id: Math.random().toString(36).slice(2, 9), kind: "report", report_id: report.id, w: chart === "kpi" ? 4 : 6, h: chart === "kpi" ? 1 : 2 };
      if (sel === "new") await api.post("analytics/dashboards", { name: `Panel de ${me.name.split(" ")[0]}`, widgets: [w] });
      else { const d = list.find((x) => x.id === sel)!; await api.put(`analytics/dashboards/${d.id}`, { name: d.name, visibility: d.visibility, role_key: d.role_key, widgets: [...d.widgets, w], filters: d.filters }); }
      toast("Añadido al panel", "ok"); onClose();
    } catch (e) { toast(errorMessage(e), "error"); }
  };
  return <Modal title={`Añadir «${report.name}» a un panel`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={add}>Añadir</button></>}><Field label="Panel"><select className="input" value={sel} onChange={(e) => setSel(e.target.value)}>{list.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}<option value="new">+ Panel nuevo</option></select></Field></Modal>;
}

/* ================================================================== comercial */
function Commercial() {
  const [global, setGlobal] = useState<Global>({});
  return (
    <div>
      <GlobalBar value={global} onChange={setGlobal} />
      <div className="an-2"><div className="card"><h2 className="mb12">Embudo etapa a etapa</h2><FunnelView global={global} /></div><div className="card"><h2 className="mb12">Motivos de pérdida</h2><LossView global={global} h={2} /></div></div>
      <div className="card mt16"><h2 className="mb12">Previsión vs real</h2><ForecastView global={global} h={2} /></div>
      <div className="card mt16"><h2 className="mb12">Cumplimiento de cuota</h2><QuotaView global={global} editable /></div>
    </div>
  );
}
interface FunnelData { stages: { id: string; name: string; color: string; entered: number; advanced: number; conversion: number; avg_days: number; expected_days: number; over_expected: boolean; next: string }[]; entered: number; won: number; win_rate: number }
function FunnelView({ global, compact }: { global: Global; compact?: boolean }) {
  const { data, error } = useLoad<FunnelData>(`analytics/funnel${gq(global)}`);
  if (error) return <div className="rc-empty">{error}</div>;
  if (!data) return <Spinner />;
  if (!data.entered) return <div className="rc-empty">Ningún negocio entró en el embudo en este periodo</div>;
  return (<>
    <Funnel steps={data.stages.map((s) => ({ label: s.name, value: s.entered, color: s.color }))} />
    <p className="small mt8">{data.entered} negocios entraron · {data.won} ganados · tasa de cierre <b>{data.win_rate} %</b></p>
    {!compact && <table className="table mt8"><thead><tr><th>Etapa</th><th className="r">Entraron</th><th className="r">Avanzaron</th><th className="r">Conversión</th><th className="r">Días medios</th></tr></thead><tbody>{data.stages.map((s) => <tr key={s.id}><td><span className="gdot" style={{ background: s.color }} />{s.name} <span className="xs muted">→ {s.next}</span></td><td className="r num">{s.entered}</td><td className="r num">{s.advanced}</td><td className="r num"><b>{s.conversion} %</b></td><td className="r num" style={{ color: s.over_expected ? "var(--risk)" : undefined }} title={`Previsto: ${s.expected_days} días`}>{fmtNum(s.avg_days)}</td></tr>)}</tbody></table>}
  </>);
}
interface ForecastData { months: { month: string; committed: number; best_case: number; pipeline: number; weighted: number; won: number; quota: number; past: boolean; gap: number | null }[]; by_owner: { owner_id: string | null; name: string; committed: number; best_case: number; pipeline: number; weighted: number; won: number; quota: number }[]; current: string }
function ForecastView({ global, compact, h = 2 }: { global: Global; compact?: boolean; h?: number }) {
  const { data, error } = useLoad<ForecastData>(`analytics/forecast${gq({ ...global, from: global.from, to: global.to })}`);
  if (error) return <div className="rc-empty">{error}</div>;
  if (!data) return <Spinner />;
  const rows = data.months.map((m) => ({ ...m, label: fmtDate(`${m.month}-01`, { month: "short", year: "2-digit" }) + (m.month === data.current ? " ·hoy" : "") }));
  return (<>
    <Bars data={rows} x="label" money height={compact ? h * 160 - 70 : 280} stacked bars={[{ key: "won", label: "Ganado (real)", color: PALETTE[2] }, { key: "committed", label: "Comprometido ≥70 %", color: PALETTE[0] }, { key: "best_case", label: "Mejor caso 40–69 %", color: PALETTE[5] }, { key: "pipeline", label: "Pipeline <40 %", color: "#c4c4c4" }]} />
    {!compact && <div className="an-2 mt12">
      <table className="table"><thead><tr><th>Mes</th><th className="r">Ganado</th><th className="r">Cuota</th><th className="r">Diferencia</th><th className="r">Ponderado</th></tr></thead><tbody>{rows.map((m) => <tr key={m.month}><td>{m.label}</td><td className="r num">{fmtMoney(m.won)}</td><td className="r num">{m.quota ? fmtMoney(m.quota) : "—"}</td><td className="r num" style={{ color: m.gap !== null && m.gap < 0 ? "var(--risk)" : undefined }}>{m.gap === null || !m.quota ? "—" : fmtMoney(m.gap)}</td><td className="r num">{fmtMoney(m.weighted)}</td></tr>)}</tbody></table>
      <table className="table"><thead><tr><th>Comercial</th><th className="r">Ganado</th><th className="r">Comprometido</th><th className="r">Mejor caso</th><th className="r">Pipeline</th></tr></thead><tbody>{data.by_owner.map((o, i) => <tr key={i}><td>{o.name}</td><td className="r num">{fmtMoney(o.won)}</td><td className="r num">{fmtMoney(o.committed)}</td><td className="r num">{fmtMoney(o.best_case)}</td><td className="r num">{fmtMoney(o.pipeline)}</td></tr>)}</tbody></table>
    </div>}
  </>);
}
interface QuotaData { month: string; users: { user_id: string; name: string; quota: number; won: number; attainment: number | null }[]; totals: { quota: number; won: number; attainment: number | null } }
function QuotaView({ global, compact, editable }: { global: Global; compact?: boolean; editable?: boolean }) {
  const { isAdmin, me } = useApp(); const toast = useToast();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [tick, setTick] = useState(0);
  const { data, error } = useLoad<QuotaData>(`analytics/quota${qs({ month, owner_id: global.owner_id, team_id: global.team_id, pipeline_id: global.pipeline_id, t: tick })}`);
  const canSet = editable && (isAdmin || me.role.visibility === "team");
  const setQuota = async (uid: string, v: string) => { try { await api.put("analytics/quota", { user_id: uid, month, amount: v === "" ? null : Number(v) }); setTick((x) => x + 1); toast("Cuota guardada", "ok"); } catch (e) { toast(errorMessage(e), "error"); } };
  if (error) return <div className="rc-empty">{error}</div>;
  if (!data) return <Spinner />;
  return (<>
    {!compact && <div className="row mb8"><span className="small">Mes</span><input className="input sm" style={{ width: "auto" }} type="month" aria-label="Mes" value={month} onChange={(e) => setMonth(e.target.value)} /><span className="grow" /><span className="small">Equipo: <b>{fmtMoney(data.totals.won)}</b> de {fmtMoney(data.totals.quota)} {data.totals.attainment !== null && <b>({data.totals.attainment} %)</b>}</span></div>}
    <div className="an-quota">{data.users.filter((u) => !compact || u.quota || u.won).map((u) => {
      const pct = u.attainment ?? 0;
      return <div key={u.user_id} className="an-q-row"><span className="an-q-name">{u.name}</span><div className="an-q-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Cuota de ${u.name}`}><i style={{ width: `${Math.min(100, pct)}%`, background: pct >= 100 ? "var(--c-green)" : pct >= 70 ? "var(--c-orange)" : "var(--c-red)" }} /></div><span className="num small an-q-val">{fmtMoney(u.won)} / {canSet ? <input className="input sm an-q-in" aria-label={`Cuota de ${u.name}`} type="number" min={0} defaultValue={u.quota || ""} placeholder="cuota" onBlur={(e) => { if (e.target.value !== String(u.quota || "")) setQuota(u.user_id, e.target.value); }} /> : fmtMoney(u.quota)}</span><b className="num small" style={{ width: 52, textAlign: "right" }}>{u.attainment === null ? "—" : `${u.attainment} %`}</b></div>;
    })}{!data.users.length && <div className="rc-empty">Sin usuarios</div>}</div>
  </>);
}
interface LossData { total: number; reasons: { reason: string | null; label: string; count: number; amount: number; pct: number }[]; competitors: { name: string; count: number; amount: number }[] }
function LossView({ global, compact, h = 2 }: { global: Global; compact?: boolean; h?: number }) {
  const { data, error } = useLoad<LossData>(`analytics/loss-reasons${gq(global)}`);
  if (error) return <div className="rc-empty">{error}</div>;
  if (!data) return <Spinner />;
  if (!data.total) return <div className="rc-empty">No hay negocios perdidos en el periodo</div>;
  return (<>
    <Donut data={data.reasons} nameKey="label" valueKey="count" height={compact ? h * 160 - 70 : 220} />
    {!compact && <table className="table mt8"><thead><tr><th>Motivo</th><th className="r">Negocios</th><th className="r">%</th><th className="r">Importe perdido</th></tr></thead><tbody>{data.reasons.map((r, i) => <tr key={i}><td>{r.label}</td><td className="r num">{r.count}</td><td className="r num">{r.pct} %</td><td className="r num">{fmtMoney(r.amount)}</td></tr>)}</tbody></table>}
    {!compact && data.competitors.length > 0 && <p className="small mt8">Competidores más citados: {data.competitors.map((c) => `${c.name} (${c.count})`).join(", ")}</p>}
  </>);
}

/* ================================================================== programados y alertas */
interface Schedule { id: string; report_id: string; report_name: string; frequency: string; hour: number; weekday: number; monthday: number; recipients: string[]; period_days: number; active: number; last_run_at: string | null; last_error: string | null; created_by_name?: string }
interface Alert { id: string; name: string; metric: string; report_id: string | null; period: string; op: string; threshold: number; notify_user_ids: string[]; active: number; last_value: number | null; last_checked_at: string | null; last_triggered_at: string | null; last_error: string | null }
const DAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const FREQ = (s: Schedule) => (s.frequency === "daily" ? "Cada día" : s.frequency === "weekly" ? `Cada ${DAYS[s.weekday]}` : `El día ${s.monthday} de cada mes`) + ` a las ${String(s.hour).padStart(2, "0")}:00`;
const OPS: Record<string, string> = { lt: "menor que", lte: "menor o igual que", gt: "mayor que", gte: "mayor o igual que" };
const PERIODS: Record<string, string> = { day: "hoy", week: "esta semana", month: "este mes" };

function SchedulesAlerts({ meta }: { meta: Meta }) {
  const toast = useToast(); const confirm = useConfirm(); const { users, settings } = useApp();
  const [reports, setReports] = useState<SavedReport[]>([]);
  const [scheds, setScheds] = useState<Schedule[] | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [newSched, setNewSched] = useState(false);
  const [newAlert, setNewAlert] = useState(false);
  const load = () => Promise.all([api.get<{ items: SavedReport[] }>("analytics/reports").then((r) => setReports(r.items)), api.get<{ items: Schedule[] }>("analytics/schedules").then((r) => setScheds(r.items)), api.get<{ items: Alert[] }>("analytics/alerts").then((r) => setAlerts(r.items))]).catch((e) => toast(errorMessage(e), "error"));
  useEffect(() => { load(); }, []);
  const runNow = async (s: Schedule) => { try { const r = await api.post<{ rows: number; recipients: string[] }>(`analytics/schedules/${s.id}/run`); toast(`Enviado a ${r.recipients.join(", ")} (${r.rows} filas)`, "ok"); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  const toggleS = async (s: Schedule) => { await api.put(`analytics/schedules/${s.id}`, { active: !s.active }); load(); };
  const delS = async (s: Schedule) => { if (await confirm({ title: "¿Quitar este envío programado?", danger: true, confirmText: "Quitar" })) { await api.del(`analytics/schedules/${s.id}`); load(); } };
  const check = async (a: Alert) => { try { const r = await api.post<{ value: number; triggered: boolean }>(`analytics/alerts/${a.id}/check`, { force: true }); toast(r.triggered ? `Se cumple (valor ${fmtNum(r.value)}): avisos enviados` : `No se cumple: valor actual ${fmtNum(r.value)}`, r.triggered ? "ok" : "info" as never); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  const toggleA = async (a: Alert) => { await api.put(`analytics/alerts/${a.id}`, { active: !a.active }); load(); };
  const delA = async (a: Alert) => { if (await confirm({ title: `¿Borrar la alerta «${a.name}»?`, danger: true, confirmText: "Borrar" })) { await api.del(`analytics/alerts/${a.id}`); load(); } };
  if (!scheds || !alerts) return <Spinner />;
  return (
    <div>
      <div className="card mb16">
        <div className="row mb8"><CalendarClock size={18} /><h2 className="grow">Informes programados</h2><button className="btn primary sm" disabled={!reports.length} onClick={() => setNewSched(true)}><Plus />Programar envío</button></div>
        <p className="xs muted mb8">Se envían por email con el CSV adjunto, a la hora de la zona {settings.timezone}, con lo que puede ver quien los programó.{!reports.length && " Guarda primero un informe en el constructor."}</p>
        {!scheds.length ? <p className="small muted">No hay envíos programados.</p> : <table className="table"><thead><tr><th>Informe</th><th>Cuándo</th><th>Destinatarios</th><th>Último envío</th><th /></tr></thead><tbody>{scheds.map((s) => <tr key={s.id} className={s.active ? "" : "muted"}><td><b>{s.report_name}</b>{s.period_days ? <div className="xs muted">últimos {s.period_days} días</div> : null}</td><td className="small">{FREQ(s)}</td><td className="small">{s.recipients.join(", ")}</td><td className="small">{s.last_run_at ? fmtDate(s.last_run_at, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}{s.last_error && <div className="xs" style={{ color: "var(--risk-ink)" }}>{s.last_error}</div>}</td><td className="r nowrap"><button className="btn ghost sm" onClick={() => runNow(s)}><Play />Enviar ahora</button><button className="btn ghost sm" onClick={() => toggleS(s)}>{s.active ? "Pausar" : "Activar"}</button><button className="iconbtn" title="Quitar" onClick={() => delS(s)} aria-label="Quitar"><Trash2 size={14} /></button></td></tr>)}</tbody></table>}
      </div>
      <div className="card">
        <div className="row mb8"><Bell size={18} /><h2 className="grow">Alertas de métricas</h2><button className="btn primary sm" onClick={() => setNewAlert(true)}><Plus />Nueva alerta</button></div>
        <p className="xs muted mb8">Se comprueban cada hora; si se cumple la condición avisan una sola vez por periodo en la campana de notificaciones.</p>
        {!alerts.length ? <p className="small muted">Ejemplo: «si la tasa de conversión de esta semana es menor que 20 %, avisar a dirección».</p> : <table className="table"><thead><tr><th>Alerta</th><th>Condición</th><th className="r">Último valor</th><th>Último aviso</th><th /></tr></thead><tbody>{alerts.map((a) => <tr key={a.id} className={a.active ? "" : "muted"}><td><b>{a.name}</b><div className="xs muted">avisa a {a.notify_user_ids.length ? a.notify_user_ids.map((id) => users.find((u) => u.id === id)?.name ?? "?").join(", ") : "quien la creó"}</div></td><td className="small">{a.metric === "report" ? `Total de «${reports.find((r) => r.id === a.report_id)?.name ?? "informe"}»` : meta.kpis[a.metric]?.label} de {PERIODS[a.period]} {OPS[a.op]} {fmtNum(a.threshold)}</td><td className="r num">{a.last_value === null ? "—" : fmtNum(a.last_value)}</td><td className="small">{a.last_triggered_at ? fmtDate(a.last_triggered_at, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—"}{a.last_error && <div className="xs" style={{ color: "var(--risk-ink)" }}>{a.last_error}</div>}</td><td className="r nowrap"><button className="btn ghost sm" onClick={() => check(a)}><Check />Comprobar ahora</button><button className="btn ghost sm" onClick={() => toggleA(a)}>{a.active ? "Pausar" : "Activar"}</button><button className="iconbtn" title="Borrar" onClick={() => delA(a)} aria-label="Borrar"><Trash2 size={14} /></button></td></tr>)}</tbody></table>}
      </div>
      {newSched && <ScheduleDialog reports={reports} onClose={() => setNewSched(false)} onSaved={() => { setNewSched(false); load(); }} />}
      {newAlert && <AlertDialog meta={meta} reports={reports} onClose={() => setNewAlert(false)} onSaved={() => { setNewAlert(false); load(); }} />}
    </div>
  );
}
function ScheduleDialog({ reports, initial, onClose, onSaved }: { reports: SavedReport[]; initial?: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast(); const { me } = useApp();
  const [f, setF] = useState({ report_id: initial ?? reports[0]?.id ?? "", frequency: "weekly", hour: 8, weekday: 1, monthday: 1, recipients: me.email, period_days: 7 });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const save = async () => { try { await api.post("analytics/schedules", { ...f, recipients: f.recipients.split(/[,;\s]+/).filter(Boolean) }); onSaved(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <Modal title="Programar envío por email" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Programar</button></>}>
      <div className="form-grid" style={{ padding: 0 }}>
        <Field label="Informe" full><select className="input" value={f.report_id} onChange={(e) => set({ report_id: e.target.value })}>{reports.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        <Field label="Frecuencia"><select className="input" value={f.frequency} onChange={(e) => set({ frequency: e.target.value })}><option value="daily">Diaria</option><option value="weekly">Semanal</option><option value="monthly">Mensual</option></select></Field>
        {f.frequency === "weekly" && <Field label="Día"><select className="input" value={f.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}</select></Field>}
        {f.frequency === "monthly" && <Field label="Día del mes"><input className="input" type="number" min={1} max={28} value={f.monthday} onChange={(e) => set({ monthday: Number(e.target.value) })} /></Field>}
        <Field label="Hora"><input className="input" type="number" min={0} max={23} value={f.hour} onChange={(e) => set({ hour: Number(e.target.value) })} /></Field>
        <Field label="Periodo de datos" hint="0 = sin límite de fechas"><input className="input" type="number" min={0} max={366} value={f.period_days} onChange={(e) => set({ period_days: Number(e.target.value) })} /></Field>
        <Field label="Destinatarios" full hint="Emails separados por comas"><input className="input" value={f.recipients} onChange={(e) => set({ recipients: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
function AlertDialog({ meta, reports, onClose, onSaved }: { meta: Meta; reports: SavedReport[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast(); const { users } = useApp();
  const [f, setF] = useState({ name: "Conversión baja", metric: "conversion_rate", report_id: reports[0]?.id ?? "", period: "week", op: "lt", threshold: 20, notify_user_ids: [] as string[] });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const save = async () => { try { await api.post("analytics/alerts", { ...f, report_id: f.metric === "report" ? f.report_id : null }); onSaved(); } catch (e) { toast(errorMessage(e), "error"); } };
  const unit = meta.kpis[f.metric]?.pct ? "%" : meta.kpis[f.metric]?.money ? "€" : "";
  return (
    <Modal title="Nueva alerta de métrica" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Crear alerta</button></>}>
      <div className="form-grid" style={{ padding: 0 }}>
        <Field label="Nombre" full><input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Métrica"><select className="input" value={f.metric} onChange={(e) => set({ metric: e.target.value })}>{Object.entries(meta.kpis).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}<option value="report" disabled={!reports.length}>Total de un informe guardado</option></select></Field>
        {f.metric === "report" && <Field label="Informe"><select className="input" value={f.report_id} onChange={(e) => set({ report_id: e.target.value })}>{reports.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>}
        <Field label="Periodo"><select className="input" value={f.period} onChange={(e) => set({ period: e.target.value })}>{Object.entries(PERIODS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <Field label="Condición"><div className="row"><select className="input" value={f.op} onChange={(e) => set({ op: e.target.value })}>{Object.entries(OPS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select><input className="input" type="number" style={{ width: 110 }} value={f.threshold} onChange={(e) => set({ threshold: Number(e.target.value) })} /><span className="small">{unit}</span></div></Field>
        <Field label="Avisar a" full hint="Vacío = a ti"><div className="row wrap" style={{ gap: 4 }}>{users.filter((u) => u.active).map((u) => <label key={u.id} className={`tag ${f.notify_user_ids.includes(u.id) ? "on" : ""}`}><input type="checkbox" checked={f.notify_user_ids.includes(u.id)} onChange={(e) => set({ notify_user_ids: e.target.checked ? [...f.notify_user_ids, u.id] : f.notify_user_ids.filter((x) => x !== u.id) })} /> {u.name}</label>)}</div></Field>
      </div>
    </Modal>
  );
}

