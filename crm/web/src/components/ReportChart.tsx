/** Pinta el resultado de un informe del constructor: barras, apiladas, líneas, tarta, tabla o KPI. */
import { Bars, Lines, Donut } from "./Charts";
import { fmtMoney, fmtNum } from "../lib/format";

export interface ReportResult {
  object: string;
  dims: { key: string; label: string; field: string }[];
  metrics: { key: string; label: string; fn: string; field?: string; money: boolean }[];
  rows: Record<string, unknown>[];
  totals: Record<string, number>;
  chart: string;
  truncated: boolean;
}
export const fmtMetric = (m: { money: boolean }, v: unknown) => (m.money ? fmtMoney(Number(v)) : fmtNum(Math.round(Number(v) * 100) / 100));

/** Con dos dimensiones, convierte filas (d0, d1, m0) en series: una columna por valor de d1. */
function pivot(res: ReportResult) {
  const series = Array.from(new Set(res.rows.map((r) => String(r.d1_label))));
  const map = new Map<string, Record<string, unknown>>();
  for (const r of res.rows) {
    const k = String(r.d0_label);
    if (!map.has(k)) map.set(k, { x: k });
    map.get(k)![`s_${series.indexOf(String(r.d1_label))}`] = r.m0;
  }
  return { data: [...map.values()], series: series.map((s, i) => ({ key: `s_${i}`, label: s })) };
}

export function ReportChart({ res, chart, height = 260, compact }: { res: ReportResult; chart?: string; height?: number; compact?: boolean }) {
  const type = chart ?? res.chart;
  const m0 = res.metrics[0]!;
  if (type === "kpi" || !res.dims.length) {
    return (
      <div className="rc-kpi">
        {res.metrics.map((m) => <div key={m.key}><div className="rc-kpi-v num">{fmtMetric(m, res.totals[m.key])}</div><div className="rc-kpi-l">{m.label}</div></div>)}
      </div>
    );
  }
  if (!res.rows.length) return <div className="rc-empty">Sin datos para estos filtros</div>;
  if (type === "table") return <ReportTable res={res} compact={compact} />;
  if (res.dims.length === 2 && (type === "bar" || type === "stacked" || type === "line")) {
    const p = pivot(res);
    return type === "line" ? <Lines data={p.data} x="x" lines={p.series} money={m0.money} height={height} /> : <Bars data={p.data} x="x" bars={p.series} money={m0.money} height={height} stacked={type === "stacked"} />;
  }
  const data = res.rows.map((r) => ({ ...r, x: String(r.d0_label) }));
  if (type === "pie") return <Donut data={data} nameKey="x" valueKey="m0" height={height} pie money={m0.money} />;
  const series = res.metrics.filter((m) => m.money === m0.money).map((m) => ({ key: m.key, label: m.label }));
  if (type === "line") return <Lines data={data} x="x" lines={series} money={m0.money} height={height} />;
  return <Bars data={data} x="x" bars={series} money={m0.money} height={height} stacked={type === "stacked"} />;
}

export function ReportTable({ res, compact }: { res: ReportResult; compact?: boolean }) {
  return (
    <div className="rc-table" style={compact ? { maxHeight: 240 } : undefined}>
      <table className="table">
        <thead><tr>{res.dims.map((d) => <th key={d.key}>{d.label}</th>)}{res.metrics.map((m) => <th key={m.key} className="r">{m.label}</th>)}</tr></thead>
        <tbody>
          {res.rows.map((r, i) => <tr key={i}>{res.dims.map((d) => <td key={d.key}>{String(r[`${d.key}_label`])}</td>)}{res.metrics.map((m) => <td key={m.key} className="r num">{fmtMetric(m, r[m.key])}</td>)}</tr>)}
        </tbody>
        {res.dims.length > 0 && <tfoot><tr><td colSpan={res.dims.length}><b>Total</b></td>{res.metrics.map((m) => <td key={m.key} className="r num"><b>{fmtMetric(m, res.totals[m.key])}</b></td>)}</tr></tfoot>}
      </table>
      {res.truncated && <p className="xs muted mt8">Se muestran las primeras filas; amplía el límite o filtra para ver el resto.</p>}
    </div>
  );
}
