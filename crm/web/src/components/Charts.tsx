import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, LineChart, Line, PieChart, Pie, Cell, Legend } from "recharts";
import { fmtMoney, fmtNum } from "../lib/format";

export const PALETTE = ["#0073ea", "#a25ddc", "#00c875", "#fdab3d", "#e2445c", "#579bfc", "#784bd1", "#66ccff"];
const axis = { fontSize: 11, fill: "var(--ink3)" };

/** Lo que hay dentro de un gráfico oculto a los lectores de pantalla no debe recibir el foco del teclado. */
const unfocus = (el: HTMLDivElement | null) => { if (el) setTimeout(() => el.querySelectorAll("[tabindex], svg, a, button").forEach((x) => x.setAttribute("tabindex", "-1")), 50); };
/** Resumen textual de un gráfico para lectores de pantalla. */
const describe = (data: Record<string, unknown>[], x: string, series: { key: string; label: string }[]) => data.slice(0, 24).map((d) => `${String(d[x])}: ${series.map((b) => `${b.label} ${String(d[b.key] ?? 0)}`).join(", ")}`).join("; ");

export function Bars({ data, x, bars, money, height = 240, stacked }: { data: Record<string, unknown>[]; x: string; bars: { key: string; label: string; color?: string }[]; money?: boolean; height?: number; stacked?: boolean }) {
  const chartLabel = describe(data, x, bars);
  return (
    <div role="img" aria-label={chartLabel}><div aria-hidden="true" ref={unfocus}>
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--rule2)" />
        <XAxis dataKey={x} tick={axis} axisLine={false} tickLine={false} />
        <YAxis tick={axis} axisLine={false} tickLine={false} width={money ? 60 : 36} tickFormatter={(v) => (money ? fmtMoney(v) : fmtNum(v))} />
        <Tooltip formatter={(v: number) => (money ? fmtMoney(v) : fmtNum(v))} contentStyle={{ borderRadius: 8, border: "1px solid var(--rule)", background: "var(--raised)", color: "var(--ink)" }} cursor={{ fill: "var(--panel)" }} />
        {bars.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {bars.map((b, i) => <Bar key={b.key} dataKey={b.key} name={b.label} fill={b.color ?? PALETTE[i % PALETTE.length]} radius={[4, 4, 0, 0]} stackId={stacked ? "a" : undefined} />)}
      </BarChart>
    </ResponsiveContainer>
    </div></div>
  );
}
export function Lines({ data, x, lines, height = 220, money }: { data: Record<string, unknown>[]; x: string; lines: { key: string; label: string; color?: string }[]; height?: number; money?: boolean }) {
  const chartLabel = describe(data, x, lines);
  return (
    <div role="img" aria-label={chartLabel}><div aria-hidden="true" ref={unfocus}>
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--rule2)" />
        <XAxis dataKey={x} tick={axis} axisLine={false} tickLine={false} />
        <YAxis tick={axis} axisLine={false} tickLine={false} width={money ? 64 : 44} tickFormatter={(v) => (money ? fmtMoney(v) : fmtNum(v))} />
        <Tooltip formatter={(v: number) => (money ? fmtMoney(v) : fmtNum(v))} contentStyle={{ borderRadius: 8, border: "1px solid var(--rule)", background: "var(--raised)", color: "var(--ink)" }} />
        {lines.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
        {lines.map((l, i) => <Line key={l.key} type="monotone" dataKey={l.key} name={l.label} stroke={l.color ?? PALETTE[i % PALETTE.length]} strokeWidth={2} dot={false} />)}
      </LineChart>
    </ResponsiveContainer>
    </div></div>
  );
}
export function Donut({ data, nameKey, valueKey, height = 220, pie, money }: { data: Record<string, unknown>[]; nameKey: string; valueKey: string; height?: number; /** tarta completa en lugar de anillo */ pie?: boolean; money?: boolean }) {
  const chartLabel = data.map((d) => `${String(d[nameKey])}: ${String(d[valueKey])}`).join("; ");
  return (
    <div role="img" aria-label={chartLabel}><div aria-hidden="true" ref={unfocus}>
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie data={data} dataKey={valueKey} nameKey={nameKey} innerRadius={pie ? 0 : Math.round(height * 0.23)} outerRadius={Math.round(height * 0.36)} paddingAngle={pie ? 0 : 2}>{data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}</Pie>
        <Tooltip formatter={(v: number) => (money ? fmtMoney(v) : fmtNum(v))} contentStyle={{ borderRadius: 8, border: "1px solid var(--rule)", background: "var(--raised)", color: "var(--ink)" }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
    </div></div>
  );
}
export function Funnel({ steps }: { steps: { label: string; value: number; color?: string }[] }) {
  const max = Math.max(1, ...steps.map((s) => s.value));
  return (
    <div className="col" style={{ gap: 6 }}>
      {steps.map((s, i) => (
        <div key={s.label} className="row">
          <span className="small" style={{ width: 120 }}>{s.label}</span>
          <div className="grow" style={{ background: "var(--rule2)", borderRadius: 6, height: 22, overflow: "hidden" }}><div style={{ width: `${(s.value / max) * 100}%`, background: s.color ?? PALETTE[i % PALETTE.length], height: "100%", borderRadius: 6, minWidth: s.value ? 4 : 0 }} /></div>
          <span className="num small" style={{ width: 90, textAlign: "right" }}>{fmtNum(s.value)}{i > 0 && steps[i - 1]!.value > 0 && <span className="muted"> ({Math.round((100 * s.value) / steps[i - 1]!.value)}%)</span>}</span>
        </div>
      ))}
    </div>
  );
}
