import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, LineChart, Line, PieChart, Pie, Cell, Legend } from "recharts";
import { fmtMoney, fmtNum } from "../lib/format";

export const PALETTE = ["#0073ea", "#a25ddc", "#00c875", "#fdab3d", "#e2445c", "#579bfc", "#784bd1", "#66ccff"];
const axis = { fontSize: 11, fill: "var(--ink3)" };

export function Bars({ data, x, bars, money, height = 240, stacked }: { data: Record<string, unknown>[]; x: string; bars: { key: string; label: string; color?: string }[]; money?: boolean; height?: number; stacked?: boolean }) {
  return (
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
  );
}
export function Lines({ data, x, lines, height = 220, money }: { data: Record<string, unknown>[]; x: string; lines: { key: string; label: string; color?: string }[]; height?: number; money?: boolean }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--rule2)" />
        <XAxis dataKey={x} tick={axis} axisLine={false} tickLine={false} />
        <YAxis tick={axis} axisLine={false} tickLine={false} width={money ? 64 : 44} tickFormatter={(v) => (money ? fmtMoney(v) : fmtNum(v))} />
        <Tooltip formatter={(v: number) => (money ? fmtMoney(v) : fmtNum(v))} contentStyle={{ borderRadius: 8, border: "1px solid var(--rule)", background: "var(--raised)", color: "var(--ink)" }} />
        {lines.map((l, i) => <Line key={l.key} type="monotone" dataKey={l.key} name={l.label} stroke={l.color ?? PALETTE[i % PALETTE.length]} strokeWidth={2} dot={false} />)}
      </LineChart>
    </ResponsiveContainer>
  );
}
export function Donut({ data, nameKey, valueKey, height = 220 }: { data: Record<string, unknown>[]; nameKey: string; valueKey: string; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie data={data} dataKey={valueKey} nameKey={nameKey} innerRadius={50} outerRadius={80} paddingAngle={2}>{data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}</Pie>
        <Tooltip contentStyle={{ borderRadius: 8, border: "1px solid var(--rule)", background: "var(--raised)", color: "var(--ink)" }} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
      </PieChart>
    </ResponsiveContainer>
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
