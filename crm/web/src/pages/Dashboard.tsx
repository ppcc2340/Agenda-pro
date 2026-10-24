import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, qs } from "../api";
import { useApp } from "../lib/app";
import { fmtMoney, fmtNum, fmtDate, ACTIVITY_TYPES } from "../lib/format";
import { Bars, Lines } from "../components/Charts";
import { Spinner, Avatar } from "../components/ui";

interface Dash { pipeline: { id: string; name: string; color: string; count: number; amount: number; weighted: number }[]; open: { count: number; amount: number; weighted: number }; won_month: { count: number; amount: number }; lost_month: { count: number; amount: number }; conversion: number; new_leads_30d: number; activity: { type: string; n: number }[]; won_by_month: { month: string; count: number; amount: number }[]; stale: { id: string; name: string; amount: number; currency: string; stage_name: string; expected_days: number; days: number; company_name: string | null }[]; my_tasks: { overdue: number; today: number }; quota: { target: number | null; won: number }; leaderboard: { id: string; name: string; count: number; amount: number }[]; tickets: { open: number; sla_breached: number }; upcoming: { id: string; name: string; amount: number; currency: string; expected_close_date: string; probability: number; company_name: string | null }[] }

export function Dashboard() {
  const { me, users, teams, isAdmin, settings } = useApp();
  const [d, setD] = useState<Dash | null>(null);
  const [owner, setOwner] = useState("");
  const [team, setTeam] = useState("");
  useEffect(() => { api.get<Dash>(`reports/dashboard${qs({ owner_id: owner, team_id: team })}`).then(setD).catch(() => undefined); }, [owner, team]);
  const hour = new Date().getHours();
  const greet = hour < 13 ? "Buenos días" : hour < 20 ? "Buenas tardes" : "Buenas noches";
  const canFilter = isAdmin || me.role.visibility !== "own";
  return (
    <div>
      <div className="page-head">
        <div><h1>{greet}, {me.name.split(" ")[0]}</h1><p className="sub">Resumen de {settings.company_name} · {fmtDate(new Date().toISOString(), { weekday: "long", day: "numeric", month: "long" })}</p></div>
        {canFilter && <div className="row">
          {teams.length > 0 && <select className="input sm" style={{ width: "auto" }} value={team} onChange={(e) => setTeam(e.target.value)}><option value="">Todos los equipos</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>}
          <select className="input sm" style={{ width: "auto" }} value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Todos los comerciales</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
        </div>}
      </div>
      {!d ? <Spinner /> : (<>
        <div className="grid c4 mb16">
          <Link to="/negocios" className="stat" style={{ color: "inherit" }}><div className="label">Pipeline abierto</div><div className="value num">{fmtMoney(d.open.amount)}</div><div className="delta">{d.open.count} negocios · ponderado {fmtMoney(d.open.weighted)}</div></Link>
          <div className="stat"><div className="label">Ganado este mes</div><div className="value num" style={{ color: "var(--ok)" }}>{fmtMoney(d.won_month.amount)}</div><div className="delta">{d.won_month.count} ganados · {d.lost_month.count} perdidos ({fmtMoney(d.lost_month.amount)})</div></div>
          <div className="stat"><div className="label">Tasa de conversión (90 d)</div><div className="value num">{d.conversion}%</div><div className="delta">ganados / cerrados</div></div>
          <Link to="/contactos?filters=%7B%22logic%22%3A%22and%22%2C%22conditions%22%3A%5B%7B%22field%22%3A%22created_at%22%2C%22op%22%3A%22last_days%22%2C%22value%22%3A30%7D%5D%7D" className="stat" style={{ color: "inherit" }}><div className="label">Nuevos leads (30 d)</div><div className="value num">{fmtNum(d.new_leads_30d)}</div><div className="delta">{d.my_tasks.overdue ? <span style={{ color: "var(--risk)" }}>{d.my_tasks.overdue} tareas vencidas</span> : "sin tareas vencidas"} · {d.my_tasks.today ?? 0} para hoy</div></Link>
        </div>
        <div className="grid c2 mb16">
          <div className="card"><div className="card-title"><h2>Pipeline por etapa</h2><Link to="/negocios" className="small">Ver kanban</Link></div><Bars data={d.pipeline} x="name" bars={[{ key: "amount", label: "Importe" }, { key: "weighted", label: "Ponderado", color: "#66ccff" }]} money height={220} /></div>
          <div className="card"><div className="card-title"><h2>Ganado por mes</h2><Link to="/informes" className="small">Informes</Link></div>{d.won_by_month.length ? <Lines data={d.won_by_month} x="month" lines={[{ key: "amount", label: "Importe ganado" }]} height={220} money /> : <p className="muted">Aún no hay negocios ganados.</p>}</div>
        </div>
        <div className="grid c3">
          <div className="card">
            <div className="card-title"><h2>Negocios estancados</h2><span className="badge warn">{d.stale.length}</span></div>
            {d.stale.length === 0 ? <p className="muted small">Ningún negocio supera el tiempo esperado en su etapa.</p> : d.stale.map((s) => <div key={s.id} className="row" style={{ padding: "6px 0", borderBottom: "1px solid var(--rule2)" }}><div className="grow" style={{ minWidth: 0 }}><Link to={`/negocios/${s.id}`} className="ell bold" style={{ display: "block" }}>{s.name}</Link><div className="xs muted">{s.stage_name} · {s.days} d (esperado {s.expected_days})</div></div><span className="num small">{fmtMoney(s.amount, s.currency)}</span></div>)}
          </div>
          <div className="card">
            <div className="card-title"><h2>Cierres próximos (14 d)</h2></div>
            {d.upcoming.length === 0 ? <p className="muted small">Nada previsto en dos semanas.</p> : d.upcoming.map((s) => <div key={s.id} className="row" style={{ padding: "6px 0", borderBottom: "1px solid var(--rule2)" }}><div className="grow" style={{ minWidth: 0 }}><Link to={`/negocios/${s.id}`} className="ell bold" style={{ display: "block" }}>{s.name}</Link><div className="xs muted">{s.company_name} · {fmtDate(s.expected_close_date)} · {s.probability}%</div></div><span className="num small">{fmtMoney(s.amount, s.currency)}</span></div>)}
          </div>
          <div className="card">
            <div className="card-title"><h2>{d.leaderboard.length ? "Ranking del mes" : "Actividad (30 d)"}</h2></div>
            {d.leaderboard.length ? d.leaderboard.map((u, i) => <div key={u.id} className="row" style={{ padding: "6px 0", borderBottom: "1px solid var(--rule2)" }}><span className="muted num small" style={{ width: 16 }}>{i + 1}</span><Avatar name={u.name} size="sm" /><span className="grow ell">{u.name}</span><span className="num small">{u.count} · {fmtMoney(u.amount)}</span></div>) : null}
            <div className="row wrap mt12">{d.activity.map((a) => <span key={a.type} className="badge">{ACTIVITY_TYPES[a.type]}: {a.n}</span>)}{d.activity.length === 0 && <span className="muted small">Sin actividad registrada en 30 días.</span>}</div>
            {d.quota.target ? <div className="mt12"><div className="row between small"><span>Mi cuota mensual</span><span className="num">{fmtMoney(d.quota.won)} / {fmtMoney(d.quota.target)}</span></div><div className="progress mt8"><div style={{ width: `${Math.min(100, (100 * d.quota.won) / d.quota.target)}%` }} /></div></div> : null}
            {d.tickets.open ? <div className="mt12 small"><Link to="/tickets">{d.tickets.open} tickets abiertos</Link>{d.tickets.sla_breached ? <span style={{ color: "var(--risk)" }}> · {d.tickets.sla_breached} con SLA incumplido</span> : null}</div> : null}
          </div>
        </div>
      </>)}
    </div>
  );
}
