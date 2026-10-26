/** Ajustes → Listas y etiquetas: todas las listas de valores del CRM y del CLM en un solo sitio. */
import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { usePicklists } from "../lib/picklists";
import { PicklistEditor } from "../components/PicklistEditor";
import { inkOn } from "../lib/colors";

export function PicklistsAdmin() {
  const lists = usePicklists();
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const groups = (["CRM", "CLM"] as const).map((m) => ({ m, items: lists.filter((l) => l.module === m && (!q || `${l.label} ${l.options.map((o) => o.label).join(" ")}`.toLowerCase().includes(q.toLowerCase()))) }));
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <h2>Listas y etiquetas</h2>
        <p className="small muted">Todas las etiquetas de los campos del sistema son tuyas: renómbralas, cambia su color y orden, ocúltalas, añade nuevas o bórralas (también las originales). Cada etiqueta tiene un <b>comportamiento</b>, que es lo que usa la lógica del CRM — por ejemplo, cualquier etiqueta que «se comporte como Resuelto» cierra el SLA y envía la encuesta. Al borrar una etiqueta en uso eliges a cuál se mueven sus registros.</p>
        <input className="input mt8" style={{ maxWidth: 320 }} placeholder="Buscar lista o etiqueta…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar lista o etiqueta" />
      </div>
      {groups.map(({ m, items }) => items.length > 0 && (
        <div key={m} className="card tight">
          <h3 style={{ padding: "12px 16px 4px" }}>{m === "CRM" ? "CRM" : "Contratos (CLM)"}</h3>
          {items.map((l) => (
            <div key={l.key} className="pl-item" style={{ borderTop: "1px solid var(--rule2)" }}>
              <button className="pl-toggle" aria-expanded={open === l.key} onClick={() => setOpen(open === l.key ? null : l.key)}>
                {open === l.key ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                <b className="small" style={{ minWidth: 220, textAlign: "left" }}>{l.label}</b>
                <span className="row wrap" style={{ gap: 2 }}>{l.options.filter((o) => !o.hidden).slice(0, 10).map((o) => <span key={o.id} className="pill-mini" style={{ background: o.color, color: inkOn(o.color) }}>{o.label}</span>)}</span>
                {l.uncovered.length > 0 && <span className="badge warn xs right" title={l.uncovered.map((u) => u.label).join(", ")}>{l.uncovered.length} comportamiento(s) sin etiqueta</span>}
              </button>
              {open === l.key && <div style={{ padding: "4px 16px 16px" }}><PicklistEditor key={l.key + l.options.map((o) => o.id + o.label).join()} pkey={l.key} onCancel={() => setOpen(null)} onSaved={() => undefined} /></div>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
