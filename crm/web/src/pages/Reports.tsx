import { useEffect, useState } from "react";
import { api, qs } from "../api";
import { useApp } from "../lib/app";
import { Tabs, Spinner } from "../components/ui";
import { Bars, Lines, Donut, Funnel, PALETTE } from "../components/Charts";
import { fmtMoney, fmtNum, fmtDate, LIFECYCLE, LEAD_STATUS, SOURCES, TICKET_STATUS } from "../lib/format";

type Any = Record<string, unknown>;
const Stat = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => <div className="stat"><div className="label">{label}</div><div className="value num">{value}</div>{sub && <div className="delta">{sub}</div>}</div>;

export function ReportsPage() {
  const { users, teams, isAdmin, me } = useApp();
  const [tab, setTab] = useState("sales");
  const [from, setFrom] = useState(new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [owner, setOwner] = useState("");
  const [team, setTeam] = useState("");
  const [data, setData] = useState<Any | null>(null);
  const ep: Record<string, string> = { sales: "sales", pipeline: "pipeline", funnel: "funnel", activity: "activity", leads: "leads", emails: "emails", tickets: "tickets", quality: "data-quality" };
  useEffect(() => { setData(null); api.get<Any>(`reports/${ep[tab]}${qs({ from, to, owner_id: owner, team_id: team })}`).then(setData).catch(() => setData({})); }, [tab, from, to, owner, team]);
  const canFilter = isAdmin || me.role.visibility !== "own";
  return (
    <div>
      <div className="page-head"><div><h1>Informes</h1><p className="sub">Ventas, pipeline, embudo, actividad, leads, emails, soporte y calidad de datos.</p></div>
        <div className="row wrap"><input className="input sm" style={{ width: "auto" }} type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><span className="muted">→</span><input className="input sm" style={{ width: "auto" }} type="date" value={to} onChange={(e) => setTo(e.target.value)} />{canFilter && <>{teams.length > 0 && <select className="input sm" style={{ width: "auto" }} value={team} onChange={(e) => setTeam(e.target.value)}><option value="">Todos los equipos</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}<select className="input sm" style={{ width: "auto" }} value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Todos</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></>}</div></div>
      <Tabs items={[{ key: "sales", label: "Ventas" }, { key: "pipeline", label: "Pipeline" }, { key: "funnel", label: "Embudo" }, { key: "activity", label: "Actividad" }, { key: "leads", label: "Leads" }, { key: "emails", label: "Emails" }, { key: "tickets", label: "Soporte" }, { key: "quality", label: "Calidad de datos" }]} value={tab} onChange={setTab} />
      {!data ? <Spinner /> : tab === "sales" ? <Sales d={data} /> : tab === "pipeline" ? <PipelineR d={data} /> : tab === "funnel" ? <FunnelR d={data} /> : tab === "activity" ? <ActivityR d={data} /> : tab === "leads" ? <LeadsR d={data} /> : tab === "emails" ? <EmailsR d={data} /> : tab === "tickets" ? <TicketsR d={data} /> : <QualityR d={data} />}
    </div>
  );
}

function Sales({ d }: { d: Any }) {
  const t = (d.totals ?? {}) as Any;
  const total = Number(t.won ?? 0) + Number(t.lost ?? 0);
  return (<>
    <div className="grid c4 mb16"><Stat label="Ganados" value={fmtNum(t.won as number)} sub={fmtMoney(t.won_amount as number)} /><Stat label="Perdidos" value={fmtNum(t.lost as number)} /><Stat label="Tasa de conversión" value={total ? `${Math.round((100 * Number(t.won)) / total)}%` : "—"} sub="ganados / cerrados" /><Stat label="Ticket medio" value={fmtMoney(t.avg_deal as number)} sub={t.avg_cycle_days ? `ciclo medio ${Math.round(Number(t.avg_cycle_days))} días` : ""} /></div>
    <div className="grid c2 mb16"><div className="card"><h2 className="mb12">Ganado vs perdido por mes</h2><Bars data={d.by_month as Any[]} x="month" bars={[{ key: "won_amount", label: "Ganado", color: PALETTE[4] }, { key: "lost_amount", label: "Perdido", color: PALETTE[5] }]} money /></div><div className="card"><h2 className="mb12">Motivos de pérdida</h2>{(d.loss_reasons as Any[]).length ? <Donut data={d.loss_reasons as Any[]} nameKey="label" valueKey="count" /> : <p className="muted">Sin negocios perdidos en el periodo.</p>}</div></div>
    <div className="grid c2"><div className="card tight"><table className="table"><thead><tr><th>Comercial</th><th className="r">Ganados</th><th className="r">Perdidos</th><th className="r">Importe</th></tr></thead><tbody>{(d.by_owner as Any[]).map((r, i) => <tr key={i}><td>{String(r.name ?? "Sin propietario")}</td><td className="r num">{String(r.won)}</td><td className="r num">{String(r.lost)}</td><td className="r num">{fmtMoney(r.won_amount as number)}</td></tr>)}</tbody></table></div><div className="card tight"><table className="table"><thead><tr><th>Origen</th><th className="r">Ganados</th><th className="r">Perdidos</th><th className="r">Importe</th></tr></thead><tbody>{(d.by_source as Any[]).map((r, i) => <tr key={i}><td>{SOURCES[String(r.source)] ?? String(r.source)}</td><td className="r num">{String(r.won)}</td><td className="r num">{String(r.lost)}</td><td className="r num">{fmtMoney(r.won_amount as number)}</td></tr>)}</tbody></table></div></div>
  </>);
}
function PipelineR({ d }: { d: Any }) {
  return (<>
    <div className="card mb16"><h2 className="mb12">Pipeline abierto por etapa</h2><Bars data={d.by_stage as Any[]} x="stage" bars={[{ key: "amount", label: "Importe" }, { key: "weighted", label: "Ponderado", color: PALETTE[7] }]} money /></div>
    <div className="grid c2"><div className="card tight"><table className="table"><thead><tr><th>Etapa</th><th className="r">Negocios</th><th className="r">Importe</th><th className="r">Ponderado</th><th className="r">Días medios</th></tr></thead><tbody>{(d.by_stage as Any[]).map((r, i) => <tr key={i}><td><span className="badge dot" style={{ color: String(r.color) }}>{String(r.stage)}</span> <span className="muted xs">{String(r.pipeline)}</span></td><td className="r num">{String(r.count)}</td><td className="r num">{fmtMoney(r.amount as number)}</td><td className="r num">{fmtMoney(r.weighted as number)}</td><td className="r num">{r.avg_days ? Math.round(Number(r.avg_days)) : "—"}</td></tr>)}</tbody></table></div><div className="card tight"><table className="table"><thead><tr><th>Propietario</th><th className="r">Negocios</th><th className="r">Importe</th><th className="r">Ponderado</th></tr></thead><tbody>{(d.by_owner as Any[]).map((r, i) => <tr key={i}><td>{String(r.name)}</td><td className="r num">{String(r.count)}</td><td className="r num">{fmtMoney(r.amount as number)}</td><td className="r num">{fmtMoney(r.weighted as number)}</td></tr>)}</tbody></table></div></div>
  </>);
}
function FunnelR({ d }: { d: Any }) {
  const stages = (d.stages as Any[]) ?? [];
  const life = (d.lifecycle as Any[]) ?? [];
  const order = ["subscriber", "lead", "mql", "sql", "opportunity", "customer"];
  return (<div className="grid c2"><div className="card"><h2 className="mb12">Embudo etapa a etapa (negocios que entraron en el periodo)</h2><Funnel steps={stages.map((s) => ({ label: String(s.name), value: Number(s.entered), color: String(s.color) }))} /><table className="table mt16"><thead><tr><th>Etapa</th><th className="r">Entraron</th><th className="r">Días medios</th></tr></thead><tbody>{stages.map((s, i) => <tr key={i}><td>{String(s.name)}</td><td className="r num">{String(s.entered)}</td><td className="r num">{s.avg_days ? Number(s.avg_days).toFixed(1) : "—"}</td></tr>)}</tbody></table></div><div className="card"><h2 className="mb12">Ciclo de vida de contactos</h2><Funnel steps={order.map((k) => ({ label: LIFECYCLE[k]!, value: Number(life.find((l) => l.stage === k)?.count ?? 0) }))} /></div></div>);
}
function ActivityR({ d }: { d: Any }) {
  const t = (d.tasks ?? {}) as Any;
  return (<>
    <div className="grid c3 mb16"><Stat label="Tareas completadas" value={fmtNum(t.done as number)} /><Stat label="Tareas abiertas" value={fmtNum(t.open as number)} /><Stat label="Tareas vencidas" value={fmtNum(t.overdue as number)} /></div>
    <div className="card mb16"><h2 className="mb12">Actividades por día</h2><Lines data={d.by_day as Any[]} x="day" lines={[{ key: "n", label: "Actividades" }]} /></div>
    <div className="card tight"><table className="table"><thead><tr><th>Usuario</th><th className="r">Emails</th><th className="r">Llamadas</th><th className="r">Reuniones</th><th className="r">Notas</th><th className="r">Tareas</th><th className="r">Total</th></tr></thead><tbody>{(d.by_user as Any[]).map((r, i) => <tr key={i}><td>{String(r.name)}</td><td className="r num">{String(r.emails ?? 0)}</td><td className="r num">{String(r.calls ?? 0)}</td><td className="r num">{String(r.meetings ?? 0)}</td><td className="r num">{String(r.notes ?? 0)}</td><td className="r num">{String(r.tasks ?? 0)}</td><td className="r num bold">{String(r.total ?? 0)}</td></tr>)}</tbody></table></div>
  </>);
}
function LeadsR({ d }: { d: Any }) {
  const r = (d.response ?? {}) as Any;
  return (<>
    <div className="grid c3 mb16"><Stat label="Tiempo medio de primera respuesta" value={r.avg_hours ? `${Number(r.avg_hours).toFixed(1)} h` : "—"} /><Stat label="Leads nuevos sin contactar" value={fmtNum(r.uncontacted as number)} /><Stat label="Formularios recibidos" value={fmtNum((d.forms as Any[]).reduce((a, f) => a + Number(f.submissions), 0))} /></div>
    <div className="grid c2 mb16"><div className="card"><h2 className="mb12">Leads por mes</h2><Bars data={d.by_month as Any[]} x="month" bars={[{ key: "leads", label: "Leads" }]} /></div><div className="card"><h2 className="mb12">Estado de los leads</h2><Donut data={(d.by_status as Any[]).map((x) => ({ ...x, label: LEAD_STATUS[String(x.status)] ?? x.status }))} nameKey="label" valueKey="n" /></div></div>
    <div className="card tight"><table className="table"><thead><tr><th>Origen</th><th className="r">Leads</th><th className="r">Convertidos</th><th className="r">Clientes</th><th className="r">Conversión</th></tr></thead><tbody>{(d.by_source as Any[]).map((x, i) => <tr key={i}><td>{SOURCES[String(x.source)] ?? String(x.source)}</td><td className="r num">{String(x.leads)}</td><td className="r num">{String(x.converted)}</td><td className="r num">{String(x.customers)}</td><td className="r num">{Number(x.leads) ? `${Math.round((100 * Number(x.converted)) / Number(x.leads))}%` : "—"}</td></tr>)}</tbody></table></div>
  </>);
}
function EmailsR({ d }: { d: Any }) {
  const t = (d.totals ?? {}) as Any;
  const sent = Number(t.sent ?? 0);
  return (<>
    <div className="grid c4 mb16"><Stat label="Enviados" value={fmtNum(sent)} /><Stat label="Abiertos" value={sent ? `${Math.round((100 * Number(t.opened)) / sent)}%` : "—"} sub={`${fmtNum(t.opened as number)} emails`} /><Stat label="Con clic" value={sent ? `${Math.round((100 * Number(t.clicked)) / sent)}%` : "—"} /><Stat label="Fallidos" value={fmtNum(t.failed as number)} /></div>
    <div className="grid c2"><div className="card tight"><table className="table"><thead><tr><th>Usuario</th><th className="r">Enviados</th><th className="r">Abiertos</th><th className="r">Clics</th></tr></thead><tbody>{(d.by_user as Any[]).map((r, i) => <tr key={i}><td>{String(r.name ?? "sistema")}</td><td className="r num">{String(r.sent)}</td><td className="r num">{String(r.opened)}</td><td className="r num">{String(r.clicked)}</td></tr>)}</tbody></table></div><div className="card tight"><table className="table"><thead><tr><th>Plantilla</th><th className="r">Usos</th></tr></thead><tbody>{(d.templates as Any[]).map((r, i) => <tr key={i}><td>{String(r.name)}</td><td className="r num">{String(r.uses)}</td></tr>)}</tbody></table></div></div>
  </>);
}
function TicketsR({ d }: { d: Any }) {
  const t = (d.totals ?? {}) as Any;
  return (<>
    <div className="grid c4 mb16"><Stat label="Tickets" value={fmtNum(t.total as number)} sub={`${fmtNum(t.open as number)} abiertos`} /><Stat label="1ª respuesta media" value={t.avg_first_response_h ? `${Number(t.avg_first_response_h).toFixed(1)} h` : "—"} /><Stat label="Resolución media" value={t.avg_resolution_h ? `${Number(t.avg_resolution_h).toFixed(1)} h` : "—"} sub={`${fmtNum(t.sla_breached as number)} SLA incumplidos`} /><Stat label="CSAT" value={t.csat ? `${Number(t.csat).toFixed(1)} / 5` : "—"} /></div>
    <div className="grid c3"><div className="card"><h2 className="mb12">Por estado</h2><Donut data={(d.by_status as Any[]).map((x) => ({ ...x, label: TICKET_STATUS[String(x.status)] }))} nameKey="label" valueKey="n" /></div><div className="card tight"><table className="table"><thead><tr><th>Agente</th><th className="r">Tickets</th><th className="r">Resueltos</th></tr></thead><tbody>{(d.by_assignee as Any[]).map((r, i) => <tr key={i}><td>{String(r.name ?? "Sin asignar")}</td><td className="r num">{String(r.n)}</td><td className="r num">{String(r.resolved)}</td></tr>)}</tbody></table></div><div className="card tight"><table className="table"><thead><tr><th>Categoría</th><th className="r">Tickets</th></tr></thead><tbody>{(d.by_category as Any[]).map((r, i) => <tr key={i}><td>{String(r.category)}</td><td className="r num">{String(r.n)}</td></tr>)}</tbody></table></div></div>
  </>);
}
function QualityR({ d }: { d: Any }) {
  const items: [string, string, string][] = [["contacts_without_email", "Contactos sin email", "/contactos?filters=" + encodeURIComponent(JSON.stringify({ logic: "and", conditions: [{ field: "email", op: "empty" }] }))], ["contacts_without_owner", "Contactos sin propietario", "/contactos?filters=" + encodeURIComponent(JSON.stringify({ logic: "and", conditions: [{ field: "owner_id", op: "empty" }] }))], ["contacts_inactive_90d", "Contactos sin actividad en 90 días", "/contactos"], ["companies_without_contacts", "Empresas sin contactos", "/empresas"], ["deals_without_close_date", "Negocios abiertos sin fecha de cierre", "/negocios?view=table&filters=" + encodeURIComponent(JSON.stringify({ logic: "and", conditions: [{ field: "status", op: "eq", value: "open" }, { field: "expected_close_date", op: "empty" }] }))], ["deals_without_contacts", "Negocios abiertos sin contacto", "/negocios?view=table"], ["probable_duplicates", "Duplicados probables (email)", "/contactos/duplicados"]];
  return <div className="grid c3">{items.map(([k, label, link]) => <a key={k} href={link} className="stat" style={{ color: "inherit" }}><div className="label">{label}</div><div className="value num" style={{ color: Number(d[k]) ? "var(--warn)" : "var(--ok)" }}>{fmtNum(d[k] as number)}</div><div className="delta">{Number(d[k]) ? "Revisar" : "Todo correcto"}</div></a>)}<div className="stat"><div className="label">Última revisión</div><div className="value" style={{ fontSize: 16 }}>{fmtDate(new Date().toISOString())}</div><div className="delta">La normalización (emails, teléfonos, nombres, dominios) se aplica automáticamente al guardar.</div></div></div>;
}
