/**
 * Centro de automatizaciones (manual monday caps. 10-24): lista con propietario, prioridad y consumo;
 * editor «Cuando / Y solo si / Entonces» con condiciones AND/OR anidadas, ramas y aprobaciones;
 * recetas; historial con exportación; uso frente al presupuesto; bandeja de aprobaciones; gobierno.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { Plus, Trash2, Pencil, Play, Copy, FlaskConical, Download, Check, X, ChevronDown, ChevronUp, GitBranch, ShieldCheck, Zap, Clock, BookOpen, Gauge, ListChecks, Users } from "lucide-react";
import { api, downloadFile, qs } from "../api";
import { useApp, type StatusLabel } from "../lib/app";
import { Modal, Field, useToast, useConfirm, errorMessage, Spinner, Picker, TagInput, Tabs } from "../components/ui";
import { fmtDateTime, relTime, fmtNum, LIFECYCLE, LEAD_STATUS, DEAL_STATUS, TICKET_STATUS, PRIORITY, COMPANY_TYPES, SOURCES } from "../lib/format";

type Any = Record<string, unknown>;
export type Trigger = { type: string; object?: string; field?: string; value?: string; from?: string; exclude?: string[]; stage_id?: string; pipeline_id?: string; form_id?: string; days?: number; min?: number; offset_days?: number; offset_hours?: number; at_hour?: number; business_days?: boolean; period?: string; weekday?: number; monthday?: number; button?: string; user_id?: string };
export type Cond = { field?: string; op?: string; value?: unknown; logic?: "and" | "or"; conditions?: Cond[] };
export type Action = { type: string; then?: Action[]; else?: Action[]; [k: string]: unknown };
export interface WF { id: string; name: string; description: string | null; trigger: Trigger; conditions: Cond; actions: Action[]; active: number; allow_reenroll: number; runs: number; last_run_at: string | null; errors?: number; owner_id?: string | null; owner_name?: string | null; priority?: number; atomic?: number; review_at?: string | null; paused_reason?: string | null; month_actions?: number; recipe?: string | null }
interface Meta { trigger_info: Record<string, { label: string; group: string; object: boolean; help: string }>; action_info: Record<string, { label: string; group: string }>; relations: Record<string, { key: string; label: string; target: string; many: boolean }[]>; budget: number; used: number }
interface Schema { builtin: { id: string; title: string; type: string }[]; custom: { key: string; label: string; type: string; settings?: Any }[]; relations: { key: string; label: string; target: string; many: boolean; fields: string[] }[] }

export const OBJ_LABEL: Record<string, string> = { contact: "Contactos", company: "Empresas", deal: "Negocios", ticket: "Tickets", contract: "Contratos", task: "Tareas" };
const OPS: Record<string, string> = { eq: "es", neq: "no es", contains: "contiene", not_contains: "no contiene", starts: "empieza por", gt: "mayor que", gte: "mayor o igual", lt: "menor que", lte: "menor o igual", empty: "está vacío", not_empty: "no está vacío", in: "es uno de", not_in: "no es ninguno de", last_days: "en los últimos N días", next_days: "en los próximos N días", before: "anterior a (fecha o today)", after: "posterior a (fecha o today)", today: "es hoy", past: "ya pasó", future: "es futura", is_true: "es sí", is_false: "es no", changed: "ha cambiado en este evento" };
const NO_VALUE = new Set(["empty", "not_empty", "today", "past", "future", "is_true", "is_false", "changed"]);
const SPECIAL = [{ key: "_origin", label: "Origen del cambio (ui, api, automation, import, form, system)" }, { key: "_actor", label: "Quién hizo el cambio (id de usuario)" }, { key: "_activity.body", label: "Texto de la actualización" }, { key: "_activity.type", label: "Tipo de actualización" }, { key: "_subitem.status", label: "Estado del subelemento" }, { key: "_subitem.title", label: "Título del subelemento" }, { key: "company.sector", label: "Empresa relacionada · sector" }, { key: "company.type", label: "Empresa relacionada · tipo" }, { key: "company.size", label: "Empresa relacionada · empleados" }];
const DATE_TYPES = new Set(["date", "datetime", "creation_log", "last_updated", "timeline"]);
const WEEKDAYS = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];

function useMeta() { const [m, setM] = useState<Meta | null>(null); useEffect(() => { api.get<Meta>("workflows/meta").then(setM).catch(() => undefined); }, []); return m; }
const schemaCache: Record<string, Promise<Schema>> = {};
function useSchema(object: string | undefined) {
  const [s, setS] = useState<Schema | null>(null);
  useEffect(() => { if (!object || !["contact", "company", "deal", "ticket", "contract"].includes(object)) { setS(null); return; } schemaCache[object] ??= api.get<Schema>(`columns/schema/${object}`); schemaCache[object].then(setS).catch(() => setS(null)); }, [object]);
  return s;
}
function inferObject(t: Trigger): string { if (t.object) return t.object; if (["deal_won", "deal_lost", "stage_changed", "deal_inactive", "deal_stale", "quote_viewed", "quote_accepted"].includes(t.type)) return "deal"; if (["ticket_created", "ticket_sla_risk"].includes(t.type)) return "ticket"; if (t.type === "task_overdue") return "task"; return "contact"; }

/* ------------------------------------------------------------------ selector de columnas y valores */
function FieldSelect({ schema, value, onChange, filter, special, placeholder = "— columna —" }: { schema: Schema | null; value?: string; onChange: (v: string) => void; filter?: (type: string) => boolean; special?: boolean; placeholder?: string }) {
  const b = (schema?.builtin ?? []).filter((x) => !filter || filter(x.type));
  const c = (schema?.custom ?? []).filter((x) => !filter || filter(x.type) || (x.type === "formula" && filter("formula")));
  return (
    <select className="input sm" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {b.length > 0 && <optgroup label="Columnas">{b.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</optgroup>}
      {c.length > 0 && <optgroup label="Columnas personalizadas">{c.map((x) => <option key={x.key} value={`custom.${x.key}`}>{x.label}{["formula", "mirror"].includes(x.type) ? " (calculada)" : ""}</option>)}{filter?.("date") && (schema?.custom ?? []).filter((x) => x.type === "timeline").flatMap((x) => [<option key={`${x.key}#start`} value={`custom.${x.key}#start`}>{x.label} · inicio</option>, <option key={`${x.key}#end`} value={`custom.${x.key}#end`}>{x.label} · fin</option>])}</optgroup>}
      {special && <optgroup label="Del evento y relacionados">{SPECIAL.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</optgroup>}
      {value && ![...b.map((x) => x.id), ...c.map((x) => `custom.${x.key}`), ...SPECIAL.map((x) => x.key)].includes(value) && <option value={value}>{value}</option>}
    </select>
  );
}
function useValueOptions(object: string, schema: Schema | null) {
  const { users, pipelines, objects } = useApp();
  return (field?: string): { v: string; l: string }[] | null => {
    if (!field) return null;
    if (field === "status" && object.startsWith("o_")) return (objects.find((o) => o.key === object)?.statuses ?? []).map((s) => ({ v: String(s.id), l: s.label }));
    if (field.startsWith("custom.")) { const d = schema?.custom.find((x) => `custom.${x.key}` === field); if (d?.type === "status") return (((d.settings ?? {}).labels as StatusLabel[] | undefined) ?? []).map((l) => ({ v: l.label, l: l.label })); if (d?.type === "user") return users.map((u) => ({ v: u.id, l: u.name })); return null; }
    if (/(owner_id|assignee_id|legal_owner_id|_actor)$/.test(field)) return users.map((u) => ({ v: u.id, l: u.name }));
    if (field === "stage_id") return pipelines.flatMap((p) => p.stages.map((s) => ({ v: s.id, l: `${p.name} · ${s.name}` })));
    const map: Record<string, Record<string, string>> = { lifecycle_stage: LIFECYCLE, lead_status: LEAD_STATUS, priority: PRIORITY, source: SOURCES, type: object === "company" ? COMPANY_TYPES : {}, status: object === "deal" ? DEAL_STATUS : object === "ticket" ? TICKET_STATUS : object === "contract" ? { DRAFT: "Borrador", INTERNAL_REVIEW: "Revisión interna", NEGOTIATION: "Negociación", PENDING_APPROVAL: "Pendiente de aprobación", APPROVED: "Aprobado", OUT_FOR_SIGNATURE: "En firma", PARTIALLY_SIGNED: "Firmado parcialmente", ACTIVE: "Activo", EXPIRED: "Vencido", TERMINATED: "Terminado", RENEWED: "Renovado", CANCELLED: "Cancelado" } : {}, _origin: { ui: "Pantalla", api: "API", automation: "Automatización", import: "Importación", form: "Formulario", system: "Sistema" } };
    const m = map[field]; return m && Object.keys(m).length ? Object.entries(m).map(([v, l]) => ({ v, l })) : null;
  };
}
function ValueInput({ options, value, onChange, placeholder }: { options: { v: string; l: string }[] | null; value: unknown; onChange: (v: string) => void; placeholder?: string }) {
  if (options) return <select className="input sm" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}><option value="">{placeholder ?? "— valor —"}</option>{options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>;
  return <input className="input sm" value={String(value ?? "")} placeholder={placeholder ?? "valor"} onChange={(e) => onChange(e.target.value)} />;
}

/* ------------------------------------------------------------------ condiciones anidadas */
export function ConditionTree({ value, onChange, object, schema, depth = 0 }: { value: Cond; onChange: (c: Cond) => void; object: string; schema: Schema | null; depth?: number }) {
  const opts = useValueOptions(object, schema);
  const conds = value.conditions ?? [];
  const set = (i: number, c: Cond) => onChange({ ...value, conditions: conds.map((x, j) => (j === i ? c : x)) });
  return (
    <div className={`ctree ${depth ? "nested" : ""}`}>
      {conds.length > 1 && <div className="row mb8"><span className="xs muted">Se deben cumplir</span><select className="input sm" style={{ width: "auto" }} value={value.logic ?? "and"} onChange={(e) => onChange({ ...value, logic: e.target.value as "and" })}><option value="and">TODAS (Y)</option><option value="or">ALGUNA (O)</option></select></div>}
      {conds.map((c, i) => c.conditions ? (
        <div key={i} className="row" style={{ alignItems: "flex-start" }}><div className="grow"><ConditionTree value={c} onChange={(x) => set(i, x)} object={object} schema={schema} depth={depth + 1} /></div><button className="iconbtn" onClick={() => onChange({ ...value, conditions: conds.filter((_, j) => j !== i) })} aria-label="Quitar grupo"><Trash2 size={14} /></button></div>
      ) : (
        <div key={i} className="row wrap mb8 cond-row">
          {i > 0 && <span className="xs bold" style={{ width: 22 }}>{value.logic === "or" ? "O" : "Y"}</span>}
          <div style={{ minWidth: 180, flex: 1 }}><FieldSelect schema={schema} special value={c.field} onChange={(f) => set(i, { ...c, field: f, value: "" })} /></div>
          <select className="input sm" style={{ width: "auto" }} value={c.op ?? "eq"} onChange={(e) => set(i, { ...c, op: e.target.value })}>{Object.entries(OPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          {!NO_VALUE.has(c.op ?? "eq") && <div style={{ minWidth: 140, flex: 1 }}><ValueInput options={["in", "not_in"].includes(c.op ?? "") ? null : opts(c.field)} value={c.value} onChange={(v) => set(i, { ...c, value: v })} placeholder={["in", "not_in"].includes(c.op ?? "") ? "valores separados por comas" : undefined} /></div>}
          <button className="iconbtn" onClick={() => onChange({ ...value, conditions: conds.filter((_, j) => j !== i) })} aria-label="Quitar condición"><Trash2 size={14} /></button>
        </div>
      ))}
      <div className="row"><button className="btn ghost sm" onClick={() => onChange({ ...value, logic: value.logic ?? "and", conditions: [...conds, { field: "", op: "eq", value: "" }] })}><Plus />Condición</button>{depth < 2 && <button className="btn ghost sm" onClick={() => onChange({ ...value, logic: value.logic ?? "and", conditions: [...conds, { logic: "or", conditions: [{ field: "", op: "eq", value: "" }] }] })}><Plus />Grupo (Y/O)</button>}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ acciones */
function UserSpec({ value, onChange, schema, allowMany }: { value: string; onChange: (v: string) => void; schema: Schema | null; allowMany?: boolean }) {
  const { users, teams } = useApp();
  const parts = value ? value.split(",") : [];
  const options = [["owner", "Propietario / asignado"], ["manager", "Manager del propietario"], ["creator", "Creador"], ["actor", "Quien hizo el cambio"], ["legal", "Responsable legal"], ["admins", "Administradores"], ...users.filter((u) => u.active).map((u) => [`user:${u.id}`, u.name]), ...teams.map((t) => [`team:${t.id}`, `Equipo ${t.name}`]), ...(schema?.custom.filter((c) => c.type === "user").map((c) => [`field:custom.${c.key}`, `Columna «${c.label}»`]) ?? [])];
  if (!allowMany) return <select className="input sm" value={value || "owner"} onChange={(e) => onChange(e.target.value)}>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>;
  return <div className="row wrap" style={{ gap: 4 }}>{options.map(([k, l]) => <label key={k} className={`chip ${parts.includes(k!) ? "on" : ""}`}><input type="checkbox" checked={parts.includes(k!)} onChange={(e) => onChange((e.target.checked ? [...parts, k] : parts.filter((p) => p !== k)).join(","))} />{l}</label>)}</div>;
}
const DEFAULT_ACTION: Record<string, Action> = {
  notify: { type: "notify", to: "owner", title: "Aviso: {{name}}" }, send_email: { type: "send_email", to: "contact", title: "", body: "" }, log_note: { type: "log_note", title: "Nota automática" }, call_webhook: { type: "call_webhook", url: "https://" },
  update_field: { type: "update_field", field: "", value: "" }, set_date: { type: "set_date", field: "", mode: "today", days: 0 }, shift_date: { type: "shift_date", field: "", days: 1 }, set_number: { type: "set_number", field: "", mode: "set", value: "0" }, copy_field: { type: "copy_field", field: "", source_field: "" }, clear_field: { type: "clear_field", field: "" }, add_tag: { type: "add_tag", tag: "" }, remove_tag: { type: "remove_tag", tag: "" }, add_score: { type: "add_score", points: 10 },
  assign: { type: "assign", mode: "round_robin" }, change_owner: { type: "change_owner", mode: "fixed" }, change_stage: { type: "change_stage", stage_id: "" }, add_to_list: { type: "add_to_list", list_id: "" },
  create_task: { type: "create_task", title: "Seguimiento de {{name}}", due_in_days: 1, assignee: "owner" }, create_subitems: { type: "create_subitems", titles: "Paso 1\nPaso 2", due_in_days: 1 }, complete_subitems: { type: "complete_subitems" }, set_parent: { type: "set_parent", field: "", value: "" },
  create_record: { type: "create_record", object: "task", values: {}, connect: true }, create_deal: { type: "create_deal", name: "Negocio {{name}}" }, update_related: { type: "update_related", relation: "", field: "", value: "" }, duplicate_record: { type: "duplicate_record" }, archive_record: { type: "archive_record" },
  branch: { type: "branch", conditions: { logic: "and", conditions: [] }, then: [], else: [] }, request_approval: { type: "request_approval", approver: "manager", title: "Aprobar {{name}}", then: [], else: [] }, delay: { type: "delay", days: 1 },
  ai_categorize: { type: "ai_categorize", source_field: "description", target_field: "", rules: [{ label: "", keywords: "" }] }, ai_summarize: { type: "ai_summarize", source_field: "description", target_field: "", sentences: 2 },
};
export function ActionList({ actions, onChange, object, schema, meta, depth = 0 }: { actions: Action[]; onChange: (a: Action[]) => void; object: string; schema: Schema | null; meta: Meta; depth?: number }) {
  const [adding, setAdding] = useState(false);
  const groups = useMemo(() => { const g: Record<string, [string, string][]> = {}; for (const [k, v] of Object.entries(meta.action_info)) { if (k === "change_owner") continue; (g[v.group] ??= []).push([k, v.label]); } return g; }, [meta]);
  const upd = (i: number, a: Action) => onChange(actions.map((x, j) => (j === i ? a : x)));
  const move = (i: number, d: number) => { const n = [...actions]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x!); onChange(n); };
  return (
    <div className="col" style={{ gap: 8 }}>
      {actions.map((a, i) => (
        <div key={i} className={`act-card ${a.type === "branch" || a.type === "request_approval" ? "act-flow" : ""}`}>
          <div className="row mb8"><span className="act-n">{i + 1}</span><b className="small">{meta.action_info[a.type]?.label ?? a.type}</b><span className="right" /><button className="iconbtn" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Subir"><ChevronUp size={14} /></button><button className="iconbtn" disabled={i === actions.length - 1} onClick={() => move(i, 1)} aria-label="Bajar"><ChevronDown size={14} /></button><button className="iconbtn" onClick={() => onChange(actions.filter((_, j) => j !== i))} aria-label="Quitar"><Trash2 size={14} /></button></div>
          <ActionForm a={a} onChange={(x) => upd(i, x)} object={object} schema={schema} meta={meta} depth={depth} />
        </div>
      ))}
      {adding ? (
        <div className="act-pick">{Object.entries(groups).map(([g, items]) => <div key={g}><div className="xs muted bold mb8">{g}</div><div className="row wrap" style={{ gap: 4 }}>{items.filter(([k]) => depth < 2 || !["branch", "request_approval"].includes(k)).map(([k, l]) => <button key={k} className="btn sm" onClick={() => { onChange([...actions, structuredClone(DEFAULT_ACTION[k] ?? { type: k })]); setAdding(false); }}>{l}</button>)}</div></div>)}<button className="btn ghost sm" onClick={() => setAdding(false)}>Cancelar</button></div>
      ) : <button className="btn sm" onClick={() => setAdding(true)}><Plus />Añadir acción</button>}
    </div>
  );
}
function ActionForm({ a, onChange, object, schema, meta, depth }: { a: Action; onChange: (a: Action) => void; object: string; schema: Schema | null; meta: Meta; depth: number }) {
  const { users, teams, pipelines, objects } = useApp();
  const opts = useValueOptions(object, schema);
  const s = (k: string) => String(a[k] ?? "");
  const set = (p: Any) => onChange({ ...a, ...p });
  const tpl = "Variables: {{name}}, {{empresa}}, {{importe}}, {{propietario.nombre}}, {{campo.<clave>}}, {{enlace}}, {{hoy}}";
  const editable = (t: string) => !["formula", "mirror", "autonumber", "creation_log", "last_updated", "button"].includes(t);
  switch (a.type) {
    case "notify": return <div className="form-grid"><Field label="Destinatarios" full><UserSpec value={s("to") || "owner"} onChange={(v) => set({ to: v })} schema={schema} allowMany /></Field><Field label="Título" hint={tpl}><input className="input sm" value={s("title")} onChange={(e) => set({ title: e.target.value })} /></Field><Field label="Texto"><input className="input sm" value={s("body")} onChange={(e) => set({ body: e.target.value })} /></Field></div>;
    case "send_email": return <div className="form-grid"><Field label="Para"><select className="input sm" value={s("to") || "contact"} onChange={(e) => set({ to: e.target.value })}><option value="contact">Contacto del elemento</option><option value="owner">Propietario</option><option value="manager">Manager</option>{users.map((u) => <option key={u.id} value={`user:${u.id}`}>{u.name}</option>)}</select></Field><Field label="Asunto" hint={tpl}><input className="input sm" value={s("title")} onChange={(e) => set({ title: e.target.value })} /></Field><Field label="Cuerpo (admite HTML)" full><textarea className="input" value={s("body")} onChange={(e) => set({ body: e.target.value })} /></Field></div>;
    case "log_note": return <div className="form-grid"><Field label="Título" hint={tpl}><input className="input sm" value={s("title")} onChange={(e) => set({ title: e.target.value })} /></Field><Field label="Texto"><input className="input sm" value={s("body")} onChange={(e) => set({ body: e.target.value })} /></Field></div>;
    case "call_webhook": return <Field label="URL (recibe el elemento en JSON)"><input className="input sm" value={s("url")} onChange={(e) => set({ url: e.target.value })} /></Field>;
    case "update_field": case "set_parent": return <div className="form-grid"><Field label={a.type === "set_parent" ? "Columna del padre" : "Columna"}><FieldSelect schema={schema} value={s("field")} onChange={(f) => set({ field: f })} filter={editable} /></Field><Field label="Valor" hint={tpl}><ValueInput options={opts(s("field"))} value={a.value} onChange={(v) => set({ value: v })} /></Field></div>;
    case "set_date": return <div className="form-grid"><Field label="Columna de fecha"><FieldSelect schema={schema} value={s("field")} onChange={(f) => set({ field: f })} filter={(t) => t === "date" || t === "datetime"} /></Field><Field label="Fecha base"><select className="input sm" value={s("mode") || "today"} onChange={(e) => set({ mode: e.target.value })}><option value="today">Hoy</option><option value="field">Otra columna</option><option value="fixed">Fecha concreta</option></select></Field>{s("mode") === "field" && <Field label="Columna origen"><FieldSelect schema={schema} value={s("source_field")} onChange={(f) => set({ source_field: f })} filter={(t) => DATE_TYPES.has(t)} /></Field>}{s("mode") === "fixed" && <Field label="Fecha"><input className="input sm" type="date" value={s("value")} onChange={(e) => set({ value: e.target.value })} /></Field>}<Field label="± días"><input className="input sm" type="number" value={Number(a.days ?? 0)} onChange={(e) => set({ days: Number(e.target.value) })} /></Field><label className="checkbox small"><input type="checkbox" checked={!!a.business_days} onChange={(e) => set({ business_days: e.target.checked })} />Días hábiles (lun-vie)</label></div>;
    case "shift_date": return <div className="form-grid"><Field label="Columna de fecha"><FieldSelect schema={schema} value={s("field")} onChange={(f) => set({ field: f })} filter={(t) => t === "date"} /></Field><Field label="Días (negativo = antes)"><input className="input sm" type="number" value={Number(a.days ?? 1)} onChange={(e) => set({ days: Number(e.target.value) })} /></Field><label className="checkbox small"><input type="checkbox" checked={!!a.business_days} onChange={(e) => set({ business_days: e.target.checked })} />Días hábiles</label></div>;
    case "set_number": return <div className="form-grid"><Field label="Columna numérica"><FieldSelect schema={schema} value={s("field")} onChange={(f) => set({ field: f })} filter={(t) => ["number", "currency", "percent"].includes(t)} /></Field><Field label="Operación"><select className="input sm" value={s("mode") || "set"} onChange={(e) => set({ mode: e.target.value })}><option value="set">Fijar</option><option value="increment">Sumar</option><option value="decrement">Restar</option><option value="multiply">Multiplicar</option><option value="copy">Copiar de otra columna</option></select></Field>{s("mode") === "copy" ? <Field label="Columna origen"><FieldSelect schema={schema} value={s("source_field")} onChange={(f) => set({ source_field: f })} /></Field> : <Field label="Valor" hint="Admite {{variables}}"><input className="input sm" value={s("value")} onChange={(e) => set({ value: e.target.value })} /></Field>}</div>;
    case "copy_field": return <div className="form-grid"><Field label="Destino"><FieldSelect schema={schema} value={s("field")} onChange={(f) => set({ field: f })} filter={editable} /></Field><Field label="Origen"><FieldSelect schema={schema} value={s("source_field")} onChange={(f) => set({ source_field: f })} /></Field></div>;
    case "clear_field": return <Field label="Columna"><FieldSelect schema={schema} value={s("field")} onChange={(f) => set({ field: f })} filter={editable} /></Field>;
    case "add_tag": case "remove_tag": return <Field label="Etiqueta"><input className="input sm" value={s("tag")} onChange={(e) => set({ tag: e.target.value })} /></Field>;
    case "add_score": return <Field label="Puntos (negativo resta)"><input className="input sm" type="number" value={Number(a.points ?? 10)} onChange={(e) => set({ points: Number(e.target.value) })} /></Field>;
    case "assign": case "change_owner": return <div className="form-grid"><Field label="Cómo"><select className="input sm" value={s("mode") || "round_robin"} onChange={(e) => set({ mode: e.target.value })}><option value="fixed">Persona concreta</option><option value="round_robin">Rotativo (round-robin)</option><option value="least_loaded">Quien tenga menos carga</option><option value="creator">Creador</option><option value="actor">Quien hizo el cambio</option><option value="team_manager">Responsable del equipo</option><option value="unassign">Quitar asignación</option></select></Field>{s("mode") === "fixed" && <Field label="Persona"><select className="input sm" value={s("user_id")} onChange={(e) => set({ user_id: e.target.value })}><option value="">—</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>}{["round_robin", "least_loaded"].includes(s("mode") || "round_robin") && <Field label="Entre"><select className="input sm" value={s("team_id")} onChange={(e) => set({ team_id: e.target.value || undefined })}><option value="">Todo el equipo</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}<Field label="Columna de persona"><FieldSelect schema={schema} value={s("field")} onChange={(f) => set({ field: f || undefined })} filter={(t) => t === "user"} placeholder="Propietario / asignado" /></Field></div>;
    case "change_stage": return <Field label="Etapa"><select className="input sm" value={s("stage_id")} onChange={(e) => set({ stage_id: e.target.value })}><option value="">—</option>{pipelines.flatMap((p) => p.stages.filter((x) => x.kind === "open").map((x) => <option key={x.id} value={x.id}>{p.name} · {x.name}</option>))}</select></Field>;
    case "add_to_list": return <Field label="ID de lista"><input className="input sm" value={s("list_id")} onChange={(e) => set({ list_id: e.target.value })} /></Field>;
    case "create_task": return <div className="form-grid"><Field label="Título" hint={tpl}><input className="input sm" value={s("title")} onChange={(e) => set({ title: e.target.value })} /></Field><Field label="Vence en (días)"><input className="input sm" type="number" value={Number(a.due_in_days ?? 1)} onChange={(e) => set({ due_in_days: Number(e.target.value) })} /></Field><Field label="Asignar a"><UserSpec value={s("assignee") || "owner"} onChange={(v) => set({ assignee: v })} schema={schema} /></Field><Field label="Prioridad"><select className="input sm" value={s("priority") || "normal"} onChange={(e) => set({ priority: e.target.value })}><option value="low">Baja</option><option value="normal">Normal</option><option value="high">Alta</option></select></Field></div>;
    case "create_subitems": return <div className="form-grid"><Field label="Subelementos (uno por línea; cuenta una acción cada uno)" full><textarea className="input" value={s("titles")} onChange={(e) => set({ titles: e.target.value })} /></Field><Field label="Vencen en (días)"><input className="input sm" type="number" value={Number(a.due_in_days ?? 1)} onChange={(e) => set({ due_in_days: Number(e.target.value) })} /></Field><Field label="Asignar a"><UserSpec value={s("assignee") || "owner"} onChange={(v) => set({ assignee: v })} schema={schema} /></Field></div>;
    case "complete_subitems": case "duplicate_record": case "archive_record": return <p className="xs muted">{a.type === "complete_subitems" ? "Completa todas las tareas abiertas del elemento." : a.type === "duplicate_record" ? "Disponible para negocios, empresas y tickets." : "Envía el elemento a la papelera (recuperable 30 días)."}</p>;
    case "create_deal": return <Field label="Nombre del negocio" hint={tpl}><input className="input sm" value={s("name")} onChange={(e) => set({ name: e.target.value })} /></Field>;
    case "create_record": {
      const vals = (a.values ?? {}) as Record<string, string>;
      const targets: Record<string, string[]> = { task: ["title", "assignee_id"], deal: ["name", "amount", "owner_id"], ticket: ["subject", "description", "priority", "assignee_id"], company: ["name", "sector", "city"], contact: ["first_name", "last_name", "email", "phone"], ...Object.fromEntries(objects.map((o) => [o.key, ["name", "status", "owner_id"]])) };
      return <div className="form-grid"><Field label="Tablero destino"><select className="input sm" value={s("object") || "task"} onChange={(e) => set({ object: e.target.value, values: {} })}>{Object.keys(targets).map((k) => <option key={k} value={k}>{OBJ_LABEL[k] ?? objects.find((o) => o.key === k)?.plural ?? k}</option>)}</select></Field><label className="checkbox small"><input type="checkbox" checked={a.connect !== false} onChange={(e) => set({ connect: e.target.checked })} />Conectar con este elemento</label>
        <Field label="Mapeo de columnas (destino ← plantilla o =columna_origen)" full><div className="col" style={{ gap: 4 }}>{(targets[s("object") || "task"] ?? []).map((k) => <div key={k} className="row"><code className="xs" style={{ width: 110 }}>{k}</code><input aria-label="{{name}} o =amount" className="input sm grow" placeholder="{{name}} o =amount" value={vals[k] ?? ""} onChange={(e) => set({ values: { ...vals, [k]: e.target.value } })} /></div>)}</div></Field></div>;
    }
    case "update_related": { const rels = meta.relations[object] ?? []; return <div className="form-grid"><Field label="Elementos conectados"><select className="input sm" value={s("relation")} onChange={(e) => set({ relation: e.target.value })}><option value="">—</option>{rels.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></Field><Field label="Columna del conectado" hint="ej. custom.estado_contrato, sector, status"><input className="input sm" value={s("field")} onChange={(e) => set({ field: e.target.value })} /></Field><Field label="Valor" hint={tpl}><input className="input sm" value={s("value")} onChange={(e) => set({ value: e.target.value })} /></Field></div>; }
    case "delay": return <div className="form-grid"><Field label="Días"><input className="input sm" type="number" value={Number(a.days ?? 0)} onChange={(e) => set({ days: Number(e.target.value) })} /></Field><Field label="Horas"><input className="input sm" type="number" value={Number(a.hours ?? 0)} onChange={(e) => set({ hours: Number(e.target.value) })} /></Field><Field label="Minutos"><input className="input sm" type="number" value={Number(a.minutes ?? 0)} onChange={(e) => set({ minutes: Number(e.target.value) })} /></Field></div>;
    case "ai_categorize": { const rules = (a.rules ?? []) as { label: string; keywords: string }[]; return <div className="form-grid"><Field label="Texto a analizar"><FieldSelect schema={schema} value={s("source_field")} onChange={(f) => set({ source_field: f })} /></Field><Field label="Guardar categoría en"><FieldSelect schema={schema} value={s("target_field")} onChange={(f) => set({ target_field: f })} filter={editable} /></Field><Field label="Categorías y palabras clave" full><div className="col" style={{ gap: 4 }}>{rules.map((r, i) => <div key={i} className="row"><input aria-label="Categoría" className="input sm" style={{ width: 150 }} placeholder="Categoría" value={r.label} onChange={(e) => set({ rules: rules.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} /><input aria-label="palabra1, palabra2…" className="input sm grow" placeholder="palabra1, palabra2…" value={r.keywords} onChange={(e) => set({ rules: rules.map((x, j) => (j === i ? { ...x, keywords: e.target.value } : x)) })} /><button className="iconbtn" onClick={() => set({ rules: rules.filter((_, j) => j !== i) })} aria-label="Quitar"><X size={14} /></button></div>)}<button className="btn ghost sm" onClick={() => set({ rules: [...rules, { label: "", keywords: "" }] })}><Plus />Categoría</button></div></Field><Field label="Si no coincide ninguna"><input className="input sm" value={s("default_label")} onChange={(e) => set({ default_label: e.target.value })} /></Field><p className="xs muted full">IA local por reglas: no envía datos fuera ni consume créditos. Para contratos regulados es la opción segura.</p></div>; }
    case "ai_summarize": return <div className="form-grid"><Field label="Texto a resumir"><FieldSelect schema={schema} value={s("source_field")} onChange={(f) => set({ source_field: f })} /></Field><Field label="Guardar resumen en"><FieldSelect schema={schema} value={s("target_field")} onChange={(f) => set({ target_field: f })} filter={(t) => ["text", "textarea"].includes(t)} /></Field><Field label="Frases"><input className="input sm" type="number" min={1} max={5} value={Number(a.sentences ?? 2)} onChange={(e) => set({ sentences: Number(e.target.value) })} /></Field></div>;
    case "branch": return (
      <div className="col" style={{ gap: 8 }}>
        <div className="branch-box"><div className="xs bold mb8"><GitBranch size={12} /> SI</div><ConditionTree value={(a.conditions as Cond) ?? { logic: "and", conditions: [] }} onChange={(c) => set({ conditions: c })} object={object} schema={schema} /></div>
        <div className="branch-box yes"><div className="xs bold mb8">ENTONCES</div><ActionList actions={a.then ?? []} onChange={(x) => set({ then: x })} object={object} schema={schema} meta={meta} depth={depth + 1} /></div>
        <div className="branch-box no"><div className="xs bold mb8">SI NO</div><ActionList actions={a.else ?? []} onChange={(x) => set({ else: x })} object={object} schema={schema} meta={meta} depth={depth + 1} /></div>
      </div>
    );
    case "request_approval": return (
      <div className="col" style={{ gap: 8 }}>
        <div className="form-grid"><Field label="Aprobador"><UserSpec value={s("approver") || "manager"} onChange={(v) => set({ approver: v })} schema={schema} /></Field><Field label="Qué se aprueba" hint={tpl}><input className="input sm" value={s("title")} onChange={(e) => set({ title: e.target.value })} /></Field><Field label="Detalle" full><input className="input sm" value={s("body")} onChange={(e) => set({ body: e.target.value })} /></Field></div>
        <div className="branch-box yes"><div className="xs bold mb8"><Check size={12} /> SI SE APRUEBA (y después, las acciones siguientes)</div><ActionList actions={a.then ?? []} onChange={(x) => set({ then: x })} object={object} schema={schema} meta={meta} depth={depth + 1} /></div>
        <div className="branch-box no"><div className="xs bold mb8"><X size={12} /> SI SE RECHAZA (el flujo termina aquí)</div><ActionList actions={a.else ?? []} onChange={(x) => set({ else: x })} object={object} schema={schema} meta={meta} depth={depth + 1} /></div>
      </div>
    );
    default: return null;
  }
}

/* ------------------------------------------------------------------ disparador */
function TriggerForm({ t, onChange, meta, schema, wfId }: { t: Trigger; onChange: (t: Trigger) => void; meta: Meta; schema: Schema | null; wfId?: string }) {
  const { pipelines, users, objects } = useApp();
  useObjectLabels();
  const [forms, setForms] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { if (t.type === "form_submitted") api.get<{ items: typeof forms }>("forms").then((r) => setForms(r.items)); }, [t.type]);
  const info = meta.trigger_info[t.type];
  const object = inferObject(t);
  const opts = useValueOptions(object, schema);
  const groups = useMemo(() => { const g: Record<string, [string, string][]> = {}; for (const [k, v] of Object.entries(meta.trigger_info)) (g[v.group] ??= []).push([k, v.label]); return g; }, [meta]);
  const set = (p: Partial<Trigger>) => onChange({ ...t, ...p });
  const before = (t.offset_days ?? 0) < 0;
  return (
    <div className="form-grid">
      <Field label="Cuando…"><select className="input" value={t.type} onChange={(e) => { const i = meta.trigger_info[e.target.value]; onChange({ type: e.target.value, object: i?.object ? (t.object ?? "deal") : undefined }); }}>{Object.entries(groups).map(([g, items]) => <optgroup key={g} label={g}>{items.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</optgroup>)}</select></Field>
      {info?.object && <Field label="Tablero"><select className="input" value={t.object ?? "deal"} onChange={(e) => set({ object: e.target.value, field: undefined, value: undefined, from: undefined })}>{["contact", "company", "deal", "ticket", "contract", ...objects.map((o) => o.key)].map((k) => <option key={k} value={k}>{OBJ_LABEL[k] ?? k}</option>)}</select></Field>}
      {(t.type === "field_changed" || t.type === "status_unchanged") && <><Field label="Columna"><FieldSelect schema={schema} value={t.field} onChange={(f) => set({ field: f, value: undefined, from: undefined })} /></Field>{t.type === "field_changed" && <Field label="De (vacío = cualquiera)"><ValueInput options={opts(t.field)} value={t.from} onChange={(v) => set({ from: v || undefined })} placeholder="cualquier valor" /></Field>}<Field label={t.type === "status_unchanged" ? "Con el valor (opcional)" : "A (vacío = cualquiera)"}><ValueInput options={opts(t.field)} value={t.value} onChange={(v) => set({ value: v || undefined })} placeholder="cualquier valor" /></Field></>}
      {t.type === "status_unchanged" && <Field label="Días sin cambiar"><input className="input" type="number" min={1} value={t.days ?? 7} onChange={(e) => set({ days: Number(e.target.value) })} /></Field>}
      {t.type === "any_field_changed" && <Field label="Excepto estas columnas" full><TagInput value={t.exclude ?? []} onChange={(v) => set({ exclude: v })} placeholder="ej. updated_at, score" /></Field>}
      {t.type === "person_assigned" && <><Field label="Columna de persona"><FieldSelect schema={schema} value={t.field} onChange={(f) => set({ field: f || undefined })} filter={(x) => x === "user"} placeholder="Propietario / asignado / legal" /></Field><Field label="A (opcional)"><select className="input" value={t.user_id ?? ""} onChange={(e) => set({ user_id: e.target.value || undefined })}><option value="">Cualquier persona</option><option value="@actor">A quien hizo el cambio</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field></>}
      {t.type === "button_clicked" && <Field label="Botón"><select className="input" value={t.button ?? ""} onChange={(e) => set({ button: e.target.value })}><option value="">Cualquier botón</option>{schema?.custom.filter((c) => c.type === "button").map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></Field>}
      {(t.type === "date_arrives" || t.type === "date_passed") && <Field label="Columna de fecha"><FieldSelect schema={schema} value={t.field} onChange={(f) => set({ field: f })} filter={(x) => DATE_TYPES.has(x) || x === "formula"} /></Field>}
      {t.type === "date_arrives" && <>
        <Field label="Cuándo"><div className="row"><input className="input" type="number" min={0} style={{ width: 80 }} value={Math.abs(t.offset_days ?? 0)} onChange={(e) => set({ offset_days: (before ? -1 : 1) * Number(e.target.value) })} /><select className="input" value={before ? "before" : "after"} onChange={(e) => set({ offset_days: (e.target.value === "before" ? -1 : 1) * Math.abs(t.offset_days ?? 0) })}><option value="before">días antes</option><option value="after">días después</option></select></div></Field>
        <Field label="A las (hora local)"><select className="input" value={t.at_hour ?? 8} onChange={(e) => set({ at_hour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}</select></Field>
        <Field label="± horas (opcional)"><input className="input" type="number" value={t.offset_hours ?? 0} onChange={(e) => set({ offset_hours: Number(e.target.value) || undefined })} /></Field>
        <label className="checkbox small"><input type="checkbox" checked={!!t.business_days} onChange={(e) => set({ business_days: e.target.checked })} />Contar días hábiles (lun-vie)</label>
      </>}
      {t.type === "every_period" && <><Field label="Cada"><select className="input" value={t.period ?? "day"} onChange={(e) => set({ period: e.target.value })}><option value="day">Día</option><option value="week">Semana</option><option value="month">Mes</option></select></Field>{t.period === "week" && <Field label="El"><select className="input" value={t.weekday ?? 1} onChange={(e) => set({ weekday: Number(e.target.value) })}>{WEEKDAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}</select></Field>}{t.period === "month" && <Field label="Día del mes"><input className="input" type="number" min={1} max={28} value={t.monthday ?? 1} onChange={(e) => set({ monthday: Number(e.target.value) })} /></Field>}<Field label="A las"><select className="input" value={t.at_hour ?? 8} onChange={(e) => set({ at_hour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}</select></Field></>}
      {t.type === "stage_changed" && <Field label="A la etapa (opcional)"><select className="input" value={t.stage_id ?? ""} onChange={(e) => set({ stage_id: e.target.value || undefined })}><option value="">Cualquiera</option>{pipelines.flatMap((p) => p.stages.map((s) => <option key={s.id} value={s.id}>{p.name} · {s.name}</option>))}</select></Field>}
      {t.type === "form_submitted" && <Field label="Formulario (opcional)"><select className="input" value={t.form_id ?? ""} onChange={(e) => set({ form_id: e.target.value || undefined })}><option value="">Cualquiera</option>{forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Field>}
      {t.type === "deal_inactive" && <Field label="Días sin actividad"><input className="input" type="number" value={t.days ?? 7} onChange={(e) => set({ days: Number(e.target.value) })} /></Field>}
      {t.type === "score_threshold" && <Field label="Umbral"><input className="input" type="number" value={t.min ?? 50} onChange={(e) => set({ min: Number(e.target.value) })} /></Field>}
      {info?.help && <p className="xs muted full">{info.help}{wfId && t.type === "webhook_in" ? ` · URL: ${location.origin}/hooks/${wfId}` : ""}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ editor */
export function WorkflowEditor({ wf, onClose, onSaved, preset }: { wf: WF | null; onClose: () => void; onSaved: () => void; preset?: Partial<WF> }) {
  const meta = useMeta();
  const { users } = useApp();
  const toast = useToast();
  const [name, setName] = useState(wf?.name ?? preset?.name ?? "");
  const [description, setDescription] = useState(wf?.description ?? "");
  const [trigger, setTrigger] = useState<Trigger>(wf?.trigger ?? preset?.trigger ?? { type: "record_created", object: "deal" });
  const [conditions, setConditions] = useState<Cond>(wf?.conditions?.conditions ? wf.conditions : { logic: "and", conditions: [] });
  const [actions, setActions] = useState<Action[]>(wf?.actions ?? preset?.actions ?? []);
  const [reenroll, setReenroll] = useState(!!wf?.allow_reenroll);
  const [owner, setOwner] = useState<string>(wf?.owner_id ?? "");
  const [priority, setPriority] = useState(wf?.priority ?? 100);
  const [atomic, setAtomic] = useState(!!wf?.atomic);
  const [review, setReview] = useState(wf?.review_at ?? "");
  const [sim, setSim] = useState<{ record_id: string | null; result: Any | null }>({ record_id: null, result: null });
  const object = inferObject(trigger);
  const schema = useSchema(object);
  if (!meta) return <Modal title="Automatización" onClose={onClose}><Spinner /></Modal>;
  const body = () => ({ name, description: description || null, trigger, conditions, actions, allow_reenroll: reenroll, active: wf ? !!wf.active : true, owner_id: owner || null, priority, atomic, review_at: review || null });
  const save = async () => { try { const r = await (wf ? api.put<{ planned?: number }>(`workflows/${wf.id}`, body()) : api.post<{ planned?: number }>("workflows", body())); toast(`Automatización guardada${r.planned ? ` · ${r.planned} ejecución(es) programada(s)` : ""}`, "ok"); onSaved(); onClose(); } catch (e) { toast(errorMessage(e), "error"); } };
  const simulate = async () => { if (!sim.record_id) return; try { setSim({ ...sim, result: await api.post<Any>("workflows/simulate", { workflow: body(), object, record_id: sim.record_id }) }); } catch (e) { toast(errorMessage(e), "error"); } };
  const sentence = `CUANDO ${meta.trigger_info[trigger.type]?.label.toLowerCase() ?? trigger.type}${trigger.object ? ` en ${OBJ_LABEL[trigger.object]?.toLowerCase()}` : ""}${(conditions.conditions ?? []).length ? ` Y SOLO SI se cumplen ${(conditions.conditions ?? []).length} condición(es)` : ""} ENTONCES ${actions.map((a) => meta.action_info[a.type]?.label.toLowerCase() ?? a.type).join(", luego ") || "…"}`;
  return (
    <Modal title={wf ? "Editar automatización" : "Nueva automatización"} size="xl" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!name.trim() || !actions.length} onClick={save}>Guardar</button></>}>
      <div className="sentence mb12">{sentence}</div>
      <div className="form-grid mb12"><Field label="Nombre"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field><Field label="Descripción (para el catálogo)"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field></div>
      <div className="wf-step"><h3><Zap size={14} /> Cuando</h3><TriggerForm t={trigger} onChange={setTrigger} meta={meta} schema={schema} wfId={wf?.id} /></div>
      <div className="wf-step"><h3><ListChecks size={14} /> Y solo si <span className="muted small">(opcional; condiciones sobre el {OBJ_LABEL[object]?.toLowerCase().replace(/s$/, "")}, incluidas fórmulas y reflejos)</span></h3><ConditionTree value={conditions} onChange={setConditions} object={object} schema={schema} /></div>
      <div className="wf-step"><h3><Play size={14} /> Entonces</h3><ActionList actions={actions} onChange={setActions} object={object} schema={schema} meta={meta} /></div>
      <details className="wf-step"><summary className="bold small">Ejecución y gobierno</summary>
        <div className="form-grid mt8">
          <Field label="Se ejecuta como" hint="La automatización actúa con los permisos de su propietario"><select className="input" value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">Automatizaciones (usuario de servicio)</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
          <Field label="Prioridad" hint="Menor número = se ejecuta antes ante el mismo evento"><input className="input" type="number" min={1} max={1000} value={priority} onChange={(e) => setPriority(Number(e.target.value))} /></Field>
          <Field label="Revisar el"><input className="input" type="date" value={review ?? ""} onChange={(e) => setReview(e.target.value)} /></Field>
          <label className="checkbox small"><input type="checkbox" checked={atomic} onChange={(e) => setAtomic(e.target.checked)} />Atómica: si una acción falla, se deshacen los cambios de esta ejecución</label>
          <label className="checkbox small"><input type="checkbox" checked={reenroll} onChange={(e) => setReenroll(e.target.checked)} />Puede ejecutarse varias veces sobre el mismo elemento</label>
        </div>
      </details>
      <div className="wf-step"><h3><FlaskConical size={14} /> Simulación (dry run)</h3><div className="row">{["contact", "company", "deal"].includes(object) ? <div className="grow"><Picker kind={object as "deal"} value={sim.record_id} onChange={(id) => setSim({ record_id: id, result: null })} /></div> : <input className="input grow" placeholder={`ID del ${OBJ_LABEL[object]?.toLowerCase()}`} value={sim.record_id ?? ""} onChange={(e) => setSim({ record_id: e.target.value, result: null })} />}<button className="btn" disabled={!sim.record_id} onClick={simulate}>Simular</button></div>
        {sim.result && <div className="mt8 small">{sim.result.found ? <>{sim.result.matches ? <span className="badge ok">Cumple las condiciones</span> : <span className="badge risk">No cumple las condiciones</span>} <strong>{String(sim.result.record_name)}</strong> · {String(sim.result.actions_count)} acción(es){sim.result.next_fire_at ? <> · próxima ejecución {fmtDateTime(String(sim.result.next_fire_at))}</> : null}<ol style={{ margin: "6px 0 0 18px" }}>{(sim.result.actions as string[]).map((x, i) => <li key={i}>{x}</li>)}</ol></> : "Registro no encontrado"}</div>}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ centro */
const STATUS_BADGE: Record<string, string> = { ok: "ok", error: "risk", skipped: "", waiting: "warn" };
const STATUS_LABEL: Record<string, string> = { ok: "Correcta", error: "Error", skipped: "No cumplía", waiting: "En espera" };
export function AutomationCenter() {
  const { isAdmin } = useApp();
  useObjectLabels();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? (isAdmin ? "lista" : "aprobaciones");
  const meta = useMeta();
  const items = [{ key: "lista", label: "Automatizaciones" }, { key: "recetas", label: "Recetas" }, { key: "historial", label: "Historial" }, { key: "uso", label: "Uso y presupuesto" }, { key: "aprobaciones", label: "Aprobaciones" }, { key: "gobierno", label: "Gobierno" }].filter((x) => isAdmin || x.key === "aprobaciones");
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row between wrap"><div><h2>Centro de automatizaciones</h2><p className="small muted">Frases «Cuando… y solo si… entonces…» con ramas y aprobaciones. Cada acción ejecutada cuenta contra el presupuesto mensual{meta ? ` (${fmtNum(meta.used)} de ${fmtNum(meta.budget)} este mes)` : ""}.</p></div></div>
      <Tabs items={items} value={tab} onChange={(k) => setParams({ tab: k })} />
      {tab === "lista" && <WorkflowList />}
      {tab === "recetas" && <Recipes />}
      {tab === "historial" && <History />}
      {tab === "uso" && <Usage />}
      {tab === "aprobaciones" && <Approvals />}
      {tab === "gobierno" && <Governance />}
    </div>
  );
}
function WorkflowList() {
  const toast = useToast();
  const confirm = useConfirm();
  const meta = useMeta();
  const [items, setItems] = useState<WF[] | null>(null);
  const [editing, setEditing] = useState<WF | "new" | null>(null);
  const [runs, setRuns] = useState<{ wf: WF; items: Any[] } | null>(null);
  const [q, setQ] = useState("");
  const load = () => api.get<{ items: WF[] }>("workflows").then((r) => setItems(r.items));
  useEffect(() => { load(); }, []);
  const toggle = async (w: WF) => { try { await api.put(`workflows/${w.id}`, { active: !w.active }); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  const del = async (w: WF) => { if (!(await confirm({ title: `¿Borrar «${w.name}»?`, text: "Se borra también su historial.", danger: true, confirmText: "Borrar" }))) return; await api.del(`workflows/${w.id}`); load(); };
  const dup = async (w: WF) => { try { await api.post(`workflows/${w.id}/duplicate`, {}); toast("Duplicada (en pausa)", "ok"); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  if (!items || !meta) return <Spinner />;
  const list = items.filter((w) => !q || w.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="card tight">
      <div className="row between" style={{ padding: "12px 16px" }}><input aria-label="Buscar automatización" className="input sm" style={{ maxWidth: 280 }} placeholder="Buscar automatización" value={q} onChange={(e) => setQ(e.target.value)} /><button className="btn primary sm" onClick={() => setEditing("new")}><Plus />Nueva automatización</button></div>
      <table className="table"><thead><tr><th>Activa</th><th>Automatización</th><th>Cuando</th><th>Entonces</th><th>Propietario</th><th className="r">Prior.</th><th className="r">Acciones (mes)</th><th>Última</th><th></th></tr></thead><tbody>
        {list.map((w) => <tr key={w.id} className={w.active ? "" : "muted"}><td><label className="switch" title={w.active ? "Activa" : "En pausa"}><input type="checkbox" checked={!!w.active} onChange={() => toggle(w)} /><i /></label></td><td><div className="bold">{w.name}{w.recipe && <span className="badge" style={{ marginLeft: 6 }}>{w.recipe}</span>}</div>{w.paused_reason ? <div className="xs" style={{ color: "var(--risk-ink)" }}>{w.paused_reason}</div> : w.description && <div className="xs muted ell" style={{ maxWidth: 320 }}>{w.description}</div>}</td><td className="small">{meta.trigger_info[w.trigger.type]?.label ?? w.trigger.type}{w.trigger.object ? ` · ${OBJ_LABEL[w.trigger.object]}` : ""}</td><td className="small muted">{w.actions.map((a) => meta.action_info[a.type]?.label ?? a.type).join(" → ")}</td><td className="small">{w.owner_name ?? "Automatizaciones"}</td><td className="r num">{w.priority ?? 100}</td><td className="r num">{fmtNum(Number(w.month_actions ?? 0))}{w.errors ? <span className="badge risk" style={{ marginLeft: 4 }}>{w.errors} err</span> : null}</td><td className="small muted">{w.last_run_at ? relTime(w.last_run_at) : "—"}</td>
          <td className="r row" style={{ justifyContent: "flex-end" }}><button className="iconbtn" title="Historial" onClick={async () => setRuns({ wf: w, items: (await api.get<{ items: Any[] }>(`workflows/${w.id}/runs`)).items })} aria-label="Historial"><Clock size={15} /></button><button className="iconbtn" title="Duplicar" onClick={() => dup(w)} aria-label="Duplicar"><Copy size={15} /></button><button className="iconbtn" title="Editar" onClick={() => setEditing(w)} aria-label="Editar"><Pencil size={15} /></button><button className="iconbtn" title="Borrar" onClick={() => del(w)} aria-label="Borrar"><Trash2 size={15} /></button></td></tr>)}
        {list.length === 0 && <tr><td colSpan={9} className="muted">Sin automatizaciones. Empieza por una receta.</td></tr>}
      </tbody></table>
      {editing && <WorkflowEditor wf={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}
      {runs && <Modal title={`Historial: ${runs.wf.name}`} size="xl" onClose={() => setRuns(null)}><RunsTable items={runs.items} /></Modal>}
    </div>
  );
}
const objPath: Record<string, string> = { contact: "contactos", deal: "negocios", company: "empresas", ticket: "tickets", contract: "contratos" };
/** Añade los objetos personalizados a los nombres y rutas de tableros que usan las listas de este módulo. */
function useObjectLabels() {
  const { objects } = useApp();
  for (const o of objects) { OBJ_LABEL[o.key] = o.plural; objPath[o.key] = `o/${o.key}`; }
}
function RunsTable({ items, showWf }: { items: Any[]; showWf?: boolean }) {
  if (!items.length) return <p className="muted small">Sin ejecuciones.</p>;
  return <table className="table"><thead><tr><th>Fecha</th>{showWf && <th>Automatización</th>}<th>Disparador</th><th>Elemento</th><th>Estado</th><th className="r">Acciones</th><th>Origen</th><th>Detalle</th></tr></thead><tbody>
    {items.map((r) => <tr key={String(r.id)}><td className="small nowrap">{fmtDateTime(String(r.ran_at))}</td>{showWf && <td className="small">{String(r.workflow_name ?? "")}</td>}<td className="small muted">{String(r.trigger_desc ?? "")}</td><td className="small">{objPath[String(r.object)] ? <Link to={`/${objPath[String(r.object)]}/${r.record_id}`}>{OBJ_LABEL[String(r.object)]?.replace(/s$/, "")}</Link> : String(r.object)}</td><td><span className={`badge ${STATUS_BADGE[String(r.status)] ?? ""}`}>{STATUS_LABEL[String(r.status)] ?? String(r.status)}</span></td><td className="r num">{String(r.actions_count ?? 0)}</td><td className="xs muted">{String(r.origin ?? "")}{Number(r.depth) > 1 ? ` · cadena ${r.depth}` : ""}</td><td className="small">{(r.log as string[]).map((l, i) => <div key={i} style={{ color: /^Error|Bucle|cortada/.test(l) ? "var(--risk)" : undefined }}>{l}</div>)}</td></tr>)}
  </tbody></table>;
}
function History() {
  const [f, setF] = useState<{ status: string; object: string; from: string }>({ status: "", object: "", from: "" });
  const [items, setItems] = useState<Any[] | null>(null);
  useEffect(() => { setItems(null); api.get<{ items: Any[] }>(`workflows/runs${qs({ ...f, limit: 300 })}`).then((r) => setItems(r.items)); }, [f]);
  return (
    <div className="card tight">
      <div className="row wrap" style={{ padding: "12px 16px", gap: 8 }}>
        <select className="input sm" style={{ width: "auto" }} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Todos los estados</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <select className="input sm" style={{ width: "auto" }} value={f.object} onChange={(e) => setF({ ...f, object: e.target.value })}><option value="">Todos los tableros</option>{Object.entries(OBJ_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        <input className="input sm" type="date" style={{ width: "auto" }} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        <span className="right" /><button className="btn sm" onClick={() => downloadFile(`/api/workflows/runs.csv${qs({ ...f, limit: 2000 })}`, "historial-automatizaciones.csv")}><Download />Exportar CSV</button>
      </div>
      <p className="xs muted" style={{ padding: "0 16px" }}>El historial se conserva según la retención configurada en Uso y presupuesto (monday guarda 10 días). Exporta periódicamente si necesitas auditoría a largo plazo.</p>
      {items ? <RunsTable items={items} showWf /> : <Spinner />}
    </div>
  );
}
function Recipes() {
  const toast = useToast();
  const [items, setItems] = useState<Any[] | null>(null);
  const [cat, setCat] = useState("");
  const load = () => api.get<{ items: Any[] }>("workflows/recipes").then((r) => setItems(r.items));
  useEffect(() => { load(); }, []);
  if (!items) return <Spinner />;
  const install = async (code: string) => { try { const r = await api.post<{ workflows: string[]; fields_created: string[] }>(`workflows/recipes/${code}/install`, {}); toast(`Receta ${code} instalada: ${r.workflows.length} automatización(es)${r.fields_created.length ? `, columnas ${r.fields_created.join(", ")}` : ""}`, "ok"); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row"><Tabs items={[{ key: "", label: "Todas" }, { key: "CRM", label: "CRM" }, { key: "CLM", label: "Contratos" }, { key: "Operaciones", label: "Operaciones" }]} value={cat} onChange={setCat} /></div>
      <div className="recipe-grid">{items.filter((r) => !cat || r.category === cat).map((r) => (
        <div key={String(r.code)} className="recipe">
          <div className="row"><span className="badge">{String(r.code)}</span><span className="xs muted">{String(r.category)}</span>{Number(r.installed) > 0 && <span className="badge ok right">Instalada</span>}</div>
          <b>{String(r.title)}</b><p className="small muted">{String(r.description)}</p>
          {(r.fields as string[]).length > 0 && <p className="xs">Crea: {(r.fields as string[]).join(", ")}</p>}
          <div className="row"><span className="xs muted"><Gauge size={11} /> {String(r.estimate)}</span><button className="btn sm right" onClick={() => install(String(r.code))}><Plus />{Number(r.installed) ? "Instalar otra vez" : "Usar receta"}</button></div>
        </div>
      ))}</div>
      <p className="xs muted">R14 (subida de archivos) no aplica porque el CRM no tiene columnas de archivo; el análisis de documentos lo hace el CLM al recibir versiones.</p>
    </div>
  );
}
function Usage() {
  const { settings, refresh } = useApp();
  const toast = useToast();
  const [u, setU] = useState<Any | null>(null);
  const [form, setForm] = useState({ automation_budget: Number((settings as unknown as Any).automation_budget ?? 25000), automation_budget_mode: String((settings as unknown as Any).automation_budget_mode ?? "block_edit"), automation_history_days: Number((settings as unknown as Any).automation_history_days ?? 365), automation_max_depth: Number((settings as unknown as Any).automation_max_depth ?? 10) });
  useEffect(() => { api.get<Any>("workflows/usage").then(setU); }, []);
  if (!u) return <Spinner />;
  const pct = Number(u.pct); const daily = u.daily as { day: string; actions: number }[]; const max = Math.max(1, ...daily.map((d) => d.actions));
  const save = async () => { try { await api.put("admin/settings", form); toast("Configuración guardada", "ok"); refresh(); setU(await api.get<Any>("workflows/usage")); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="kpis">
        <div className="kpi"><div className="l">Acciones este mes</div><div className="v num">{fmtNum(Number(u.used))}</div><div className="s">de {fmtNum(Number(u.budget))} · {pct} %</div><div className="meter mt8"><i style={{ width: `${Math.min(100, pct)}%`, background: pct >= 100 ? "var(--risk)" : pct >= 80 ? "var(--c-orange)" : pct >= 60 ? "#cab641" : "var(--c-green)" }} /></div></div>
        <div className="kpi"><div className="l">Proyección a fin de mes</div><div className="v num">{fmtNum(Number(u.projection))}</div><div className="s">{Number(u.projection) > Number(u.budget) ? "superará el presupuesto" : "dentro del presupuesto"}</div></div>
        <div className="kpi"><div className="l">Al agotarse</div><div className="v" style={{ fontSize: 16 }}>{u.mode === "pause_all" ? "Se pausan" : "Bloqueo de edición"}</div><div className="s">{u.exceeded ? "Presupuesto agotado" : "Avisos al 60, 80 y 100 %"}</div></div>
      </div>
      <div className="charts">
        <div className="chart"><h3>Acciones por día</h3><div className="bars">{daily.map((d) => <div key={d.day} className="bar"><b>{d.actions}</b><i style={{ height: `${(100 * d.actions) / max}%` }} /><small>{d.day.slice(8)}</small></div>)}</div>{!daily.length && <p className="muted small">Aún no hay ejecuciones este mes.</p>}</div>
        <div className="chart"><h3>Por tablero</h3>{Object.entries(u.by_board as Record<string, number>).map(([k, v]) => <div key={k} className="row small" style={{ justifyContent: "space-between" }}><span>{OBJ_LABEL[k] ?? k}</span><b className="num">{fmtNum(v)}</b></div>)}</div>
      </div>
      <div className="card tight"><table className="table"><thead><tr><th>Automatización</th><th>Tablero</th><th className="r">Ejecuciones</th><th className="r">Acciones</th></tr></thead><tbody>{(u.by_workflow as Any[]).filter((x) => Number(x.runs)).map((x) => <tr key={String(x.id)}><td>{String(x.name)}</td><td className="small">{OBJ_LABEL[String(x.board)] ?? "—"}</td><td className="r num">{String(x.runs)}</td><td className="r num">{String(x.actions)}</td></tr>)}</tbody></table></div>
      <div className="card"><h3 className="mb8">Presupuesto y límites</h3><div className="form-grid">
        <Field label="Acciones al mes" hint="0 = sin límite"><input className="input" type="number" min={0} value={form.automation_budget} onChange={(e) => setForm({ ...form, automation_budget: Number(e.target.value) })} /></Field>
        <Field label="Al agotarse"><select className="input" value={form.automation_budget_mode} onChange={(e) => setForm({ ...form, automation_budget_mode: e.target.value })}><option value="block_edit">Siguen funcionando; se bloquea crear y editar (como monday)</option><option value="pause_all">Se pausan todas hasta el mes siguiente</option></select></Field>
        <Field label="Conservar historial (días)" hint="0 = ilimitado"><input className="input" type="number" min={0} value={form.automation_history_days} onChange={(e) => setForm({ ...form, automation_history_days: Number(e.target.value) })} /></Field>
        <Field label="Profundidad máxima de cadena" hint="Protección de bucles"><input className="input" type="number" min={2} max={25} value={form.automation_max_depth} onChange={(e) => setForm({ ...form, automation_max_depth: Number(e.target.value) })} /></Field>
      </div><button className="btn primary mt8" onClick={save}>Guardar</button><p className="xs muted mt8">Consejos para gastar menos: usa valores por defecto del tablero en lugar de «cuando se crea, establecer»; condiciones estrictas; evita «cualquier columna cambia»; una notificación a un equipo en vez de tres; desactiva automatizaciones durante importaciones masivas.</p></div>
    </div>
  );
}
function Approvals() {
  const { isAdmin } = useApp();
  const toast = useToast();
  const [all, setAll] = useState(false);
  const [items, setItems] = useState<Any[] | null>(null);
  const load = () => api.get<{ items: Any[] }>(`workflows/approvals${all ? "?all=1" : ""}`).then((r) => setItems(r.items));
  useEffect(() => { load(); }, [all]);
  const decide = async (id: string, decision: "approved" | "rejected") => { const comment = decision === "rejected" ? window.prompt("Motivo del rechazo") : ""; if (decision === "rejected" && !comment) return; try { await api.post(`workflows/approvals/${id}/decide`, { decision, comment }); toast(decision === "approved" ? "Aprobado: el flujo continúa" : "Rechazado: se ejecuta la rama «si se rechaza»", "ok"); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  if (!items) return <Spinner />;
  return (
    <div className="card tight">
      <div className="row between" style={{ padding: "12px 16px" }}><p className="small muted"><ShieldCheck size={14} /> Aprobaciones pedidas por automatizaciones (human in the loop). Al decidir, el flujo sigue por la rama correspondiente.</p>{isAdmin && <label className="checkbox small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Ver todas</label>}</div>
      <table className="table"><thead><tr><th>Solicitud</th><th>Automatización</th><th>Aprobador</th><th>Estado</th><th>Fecha</th><th></th></tr></thead><tbody>
        {items.map((a) => <tr key={String(a.id)}><td><b>{String(a.title)}</b>{a.body ? <div className="xs muted">{String(a.body)}</div> : null}{objPath[String(a.object)] && <div className="xs"><Link to={`/${objPath[String(a.object)]}/${a.record_id}`}>Abrir elemento</Link></div>}</td><td className="small">{String(a.workflow_name ?? "")}</td><td className="small">{String(a.approver_name ?? "—")}</td><td><span className={`badge ${a.status === "approved" ? "ok" : a.status === "rejected" ? "risk" : "warn"}`}>{({ pending: "Pendiente", approved: "Aprobada", rejected: "Rechazada" } as Record<string, string>)[String(a.status)]}</span>{a.comment ? <div className="xs muted">{String(a.comment)}</div> : null}</td><td className="small muted">{relTime(String(a.created_at))}</td><td className="r">{a.status === "pending" && <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn primary sm" onClick={() => decide(String(a.id), "approved")}><Check />Aprobar</button><button className="btn sm" onClick={() => decide(String(a.id), "rejected")}><X />Rechazar</button></div>}</td></tr>)}
        {items.length === 0 && <tr><td colSpan={6} className="muted">No hay aprobaciones.</td></tr>}
      </tbody></table>
    </div>
  );
}
function Governance() {
  const { users } = useApp();
  const toast = useToast();
  const [items, setItems] = useState<Any[] | null>(null);
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const load = () => api.get<{ items: Any[] }>("workflows/catalog").then((r) => setItems(r.items));
  useEffect(() => { load(); }, []);
  if (!items) return <Spinner />;
  const owners = Array.from(new Map(items.map((w) => [String(w.owner_id ?? ""), String(w.owner_name)])).entries());
  const reassign = async () => { try { const r = await api.post<{ updated: number }>("workflows/reassign", { from: from || null, to: to || null, reactivate: true }); toast(`${r.updated} automatización(es) reasignadas`, "ok"); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  const overdue = (d: unknown) => !!d && String(d) < new Date().toISOString().slice(0, 10);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="card"><h3 className="mb8"><Users size={14} /> Propietarios</h3><p className="small muted mb8">Cada automatización se ejecuta con la identidad de su propietario. Si se da de baja, se pausa con un error legible: reasígnalas aquí (lo recomendable es el usuario de servicio «Automatizaciones»).</p><div className="row wrap"><select className="input sm" style={{ width: "auto" }} value={from} onChange={(e) => setFrom(e.target.value)}><option value="">Automatizaciones (servicio)</option>{owners.filter(([k]) => k).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select><span>→</span><select className="input sm" style={{ width: "auto" }} value={to} onChange={(e) => setTo(e.target.value)}><option value="">Automatizaciones (servicio)</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select><button className="btn sm" onClick={reassign}>Reasignar y reactivar</button></div></div>
      <div className="card tight"><table className="table"><thead><tr><th>Automatización</th><th>Tablero</th><th>Propietario</th><th className="r">Acciones/ejecución</th><th className="r">Est. mensual</th><th className="r">Usadas (mes)</th><th className="r">Errores 30 d</th><th className="r">Programadas</th><th>Revisar</th></tr></thead><tbody>
        {items.map((w) => <tr key={String(w.id)} className={w.active ? "" : "muted"}><td><b>{String(w.name)}</b>{w.paused_reason ? <div className="xs" style={{ color: "var(--risk-ink)" }}>{String(w.paused_reason)}</div> : null}</td><td className="small">{OBJ_LABEL[String(w.board)] ?? "—"}</td><td className="small">{String(w.owner_name)}{!w.owner_active && <span className="badge risk" style={{ marginLeft: 4 }}>inactivo</span>}</td><td className="r num">{String(w.actions_per_run)}</td><td className="r num">{fmtNum(Number(w.estimate_month))}</td><td className="r num">{fmtNum(Number(w.month_actions))}</td><td className="r num">{Number(w.errors30) ? <span className="badge risk">{String(w.errors30)}</span> : 0}</td><td className="r num">{String(w.scheduled)}</td><td className="small" style={{ color: overdue(w.review_at) ? "var(--risk)" : undefined }}>{w.review_at ? String(w.review_at) : "—"}</td></tr>)}
      </tbody></table></div>
      <div className="card small"><h3 className="mb8"><BookOpen size={14} /> Buenas prácticas</h3><ul style={{ margin: 0, paddingLeft: 18 }}><li>Una automatización = una responsabilidad; evita monstruos de ocho acciones.</li><li>Diseña estados terminales y condiciones que rompan ciclos (p. ej. «solo si el estado no es ya el destino»).</li><li>Usa «Origen del cambio ≠ automation» para no reaccionar a tus propias acciones.</li><li>Prueba con la simulación y en un grupo de pruebas antes de activar.</li><li>Revisa qué automatizaciones usan una columna antes de cambiar sus etiquetas: el CRM te avisa al borrarla.</li></ul></div>
    </div>
  );
}

/** Historial de automatizaciones de un elemento (para las fichas). */
export function RecordAutomations({ object, id }: { object: string; id: string }): ReactNode {
  const [d, setD] = useState<{ items: Any[]; scheduled: Any[] } | null>(null);
  useEffect(() => { api.get<{ items: Any[]; scheduled: Any[] }>(`workflows/record/${object}/${id}`).then(setD).catch(() => undefined); }, [object, id]);
  if (!d) return <Spinner />;
  return (
    <div className="col" style={{ gap: 8 }}>
      {d.scheduled.length > 0 && <div><div className="xs bold mb8">Programadas</div>{d.scheduled.map((s) => <div key={String(s.id)} className="small row"><Clock size={12} />{String(s.workflow_name)} · {fmtDateTime(String(s.fire_at))}</div>)}</div>}
      <div className="xs bold">Ejecuciones</div>
      {d.items.length === 0 ? <p className="small muted">Ninguna automatización ha actuado sobre este elemento.</p> : d.items.slice(0, 30).map((r) => <div key={String(r.id)} className="small" style={{ borderBottom: "1px solid var(--rule2)", padding: "4px 0" }}><span className={`badge ${STATUS_BADGE[String(r.status)] ?? ""}`}>{STATUS_LABEL[String(r.status)] ?? String(r.status)}</span> <b>{String(r.workflow_name)}</b> <span className="muted">· {relTime(String(r.ran_at))} · {String(r.actions_count)} acción(es)</span><div className="xs muted">{(r.log as string[]).join(" · ")}</div></div>)}
    </div>
  );
}
