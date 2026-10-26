/**
 * Ajustes CLM avanzados: ciclo de vida por tipo, matriz de aprobación, sustituciones, configuración por tipo
 * (formulario de solicitud, numeración, obligaciones/hitos por defecto, alertas) e importación/exportación.
 */
import { useEffect, useState } from "react";
import { Plus, Trash2, ArrowUp, ArrowDown, Pencil, Download, Upload, RotateCcw, Play } from "lucide-react";
import { api, downloadFile } from "../api";
import { useApp } from "../lib/app";
import { Modal, Field, Spinner, useToast, useConfirm, errorMessage, Tabs } from "../components/ui";
import { CSTATUS, OBL_TYPE, MS_TYPE, type ContractType } from "../lib/clm";
import { pillStyle } from "../lib/colors";
import { PALETTE } from "../lib/board";

type Any = Record<string, unknown>;
interface StateDef { key: string; label: string; phase: string; color?: string; optional?: boolean; sla_hours?: number | null; escalate_to?: string | null; roles?: string[]; required_fields?: string[]; require_document?: boolean; description?: string | null }
interface LcTransition { from: string; to: string; label?: string; roles?: string[]; required_fields?: string[]; require_document?: boolean }
interface ConfigMeta { phases: string[]; condition_fields: Record<string, string>; condition_ops: string[]; intake_types: string[] }
const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "estado";
const csv = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
const FIELD_OPTS: [string, string][] = [["counterparty_company_id", "Contraparte"], ["total_value", "Valor total"], ["annual_value", "Valor anual"], ["effective_date", "Fecha de inicio"], ["end_date", "Fecha de fin"], ["term_months", "Duración"], ["notice_period_days", "Preaviso"], ["department", "Departamento"], ["description", "Objeto"], ["legal_owner_id", "Responsable legal"], ["governing_law", "Ley aplicable"], ["jurisdiction", "Jurisdicción"], ["payment_terms_days", "Plazo de pago"], ["deal_id", "Negocio"], ["data_role", "Rol en el tratamiento"]];
const OPS_ES: Record<string, string> = { eq: "=", ne: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", in: "en lista", not_in: "no en lista", contains: "contiene", is_true: "es sí", is_false: "es no", empty: "vacío", not_empty: "no vacío" };
const useMeta = () => { const [m, setM] = useState<ConfigMeta | null>(null); useEffect(() => { api.get<ConfigMeta>("clm/config/meta").then(setM); }, []); return m; };
const useRoles = () => { const [r, setR] = useState<{ key: string; name: string }[]>([]); useEffect(() => { api.get<{ items: { key: string; name: string }[] }>("admin/roles").then((x) => setR(x.items)).catch(() => setR([])); }, []); return r; };
const useTypes = () => { const [t, setT] = useState<ContractType[]>([]); const load = () => api.get<{ items: ContractType[] }>("clm/types").then((r) => setT(r.items)); useEffect(() => { load(); }, []); return { types: t, reload: load }; };

/* ============================================================ ciclo de vida */
export function LifecycleAdmin() {
  const toast = useToast(); const confirm = useConfirm();
  const meta = useMeta(); const roles = useRoles(); const { types } = useTypes(); const { customFields } = useApp();
  const [typeId, setTypeId] = useState("*");
  const [states, setStates] = useState<StateDef[] | null>(null);
  const [transitions, setTransitions] = useState<LcTransition[]>([]);
  const [inherited, setInherited] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const load = (tid: string) => api.get<{ lifecycle: { states: StateDef[]; transitions: LcTransition[] } | null; inherited: boolean }>(`clm/lifecycles/${encodeURIComponent(tid)}`).then((r) => { setStates(r.lifecycle?.states ?? []); setTransitions(r.lifecycle?.transitions ?? []); setInherited(r.inherited); });
  useEffect(() => { load(typeId); }, [typeId]);
  if (!meta || !states) return <Spinner />;
  const fieldOpts: [string, string][] = [...FIELD_OPTS, ...customFields.filter((f) => f.object === "contract").map((f) => [`custom.${f.key}`, `${f.label} (personalizado)`] as [string, string])];
  const save = async () => { try { await api.put(`clm/lifecycles/${encodeURIComponent(typeId)}`, { states, transitions }); toast("Ciclo de vida guardado", "ok"); load(typeId); } catch (e) { toast(errorMessage(e), "error"); } };
  const addState = (phase: string) => { const n = states.filter((s) => s.phase === phase).length + 1; const label = `${CSTATUS[phase]?.label ?? phase} ${n}`; let key = slug(label); while (states.some((s) => s.key === key)) key += "_x"; setStates([...states, { key, label, phase, color: CSTATUS[phase]?.color }]); setEditing(states.length); };
  const move = (i: number, d: -1 | 1) => { const s = states[i]!; const same = states.map((x, j) => [x, j] as const).filter(([x]) => x.phase === s.phase).map(([, j]) => j); const pos = same.indexOf(i); const k = same[pos + d]; if (k === undefined) return; const arr = [...states]; [arr[i], arr[k]] = [arr[k]!, arr[i]!]; setStates(arr); };
  const del = (i: number) => { const key = states[i]!.key; setStates(states.filter((_, j) => j !== i)); setTransitions(transitions.filter((t) => t.from !== key && t.to !== key)); setEditing(null); };
  const upd = (i: number, p: Partial<StateDef>) => setStates(states.map((s, j) => (j === i ? { ...s, ...p } : s)));
  const ed = editing !== null ? states[editing] : null;
  return (
    <div>
      <div className="filterbar">
        <label className="small bold">Tipo de contrato</label>
        <select aria-label="Tipo de contrato" className="input" style={{ maxWidth: 280 }} value={typeId} onChange={(e) => setTypeId(e.target.value)}><option value="*">Todos los tipos (por defecto)</option>{types.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.name}</option>)}</select>
        {inherited && <span className="badge">Hereda del ciclo por defecto: al guardar se crea uno propio</span>}
        <span className="small sub">Las 15 fases del motor (firma, activación, renovación…) no cambian; dentro de cada una defines tus estados, su orden, cuáles son opcionales, el SLA y quién puede mover.</span>
        <div className="right row">{typeId !== "*" && !inherited && <button className="btn" onClick={async () => { if (await confirm({ title: "¿Quitar el ciclo propio de este tipo?", text: "Sus contratos pasan a usar el ciclo por defecto.", danger: true, confirmText: "Quitar" })) { await api.del(`clm/lifecycles/${typeId}`); load(typeId); } }}>Usar el por defecto</button>}<button className="btn primary" onClick={save}>Guardar ciclo de vida</button></div>
      </div>
      <div className="lc-board" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))", gap: 10 }}>
        {meta.phases.map((ph) => { const list = states.map((s, i) => [s, i] as const).filter(([s]) => s.phase === ph); return (
          <div key={ph} className="card tight" data-phase={ph} style={{ borderTop: `3px solid ${CSTATUS[ph]?.color ?? "#999"}` }}>
            <div className="row mb8"><span className="bold small">{CSTATUS[ph]?.label ?? ph}</span><span className="xs muted">{ph}</span><button className="iconbtn right" aria-label={`Añadir estado en ${CSTATUS[ph]?.label ?? ph}`} onClick={() => addState(ph)}><Plus size={14} /></button></div>
            {!list.length && <div className="xs muted">Sin estados propios: se usa la fase tal cual.</div>}
            {list.map(([s, i], n) => (
              <div key={s.key} className="row lc-state" style={{ padding: "4px 6px", borderRadius: 6, background: editing === i ? "var(--panel)" : undefined, gap: 4 }}>
                <span className="badge" style={pillStyle(s.color ?? CSTATUS[ph]?.color ?? "#579bfc")}>{n + 1}. {s.label}</span>
                {s.optional && <span className="xs muted">opcional</span>}{s.sla_hours ? <span className="xs muted">{s.sla_hours} h</span> : null}
                <span className="right row" style={{ gap: 0 }}><button className="iconbtn" aria-label="Subir" onClick={() => move(i, -1)}><ArrowUp size={12} /></button><button className="iconbtn" aria-label="Bajar" onClick={() => move(i, 1)}><ArrowDown size={12} /></button><button className="iconbtn" aria-label={`Editar ${s.label}`} onClick={() => setEditing(i)}><Pencil size={12} /></button></span>
              </div>))}
          </div>); })}
      </div>
      <div className="card mt12">
        <div className="row mb8"><h3 style={{ margin: 0 }}>Transiciones permitidas entre estados</h3><span className="small sub">Sin transiciones, cualquier estado de la misma fase es alcanzable. Con ellas, solo las listadas (usa «*» como origen para «desde cualquiera»).</span><button className="btn sm right" onClick={() => setTransitions([...transitions, { from: "*", to: states[0]?.key ?? "" }])} disabled={!states.length}><Plus />Transición</button></div>
        <table className="table"><thead><tr><th>Desde</th><th>Hasta</th><th>Etiqueta</th><th>Roles que pueden</th><th>Campos obligatorios</th><th>Documento</th><th /></tr></thead><tbody>
          {transitions.map((t, i) => { const set = (p: Partial<LcTransition>) => setTransitions(transitions.map((x, j) => (j === i ? { ...x, ...p } : x))); return (
            <tr key={i}><td><select className="input sm" aria-label="Desde" value={t.from} onChange={(e) => set({ from: e.target.value })}><option value="*">* cualquiera</option>{states.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></td>
              <td><select className="input sm" aria-label="Hasta" value={t.to} onChange={(e) => set({ to: e.target.value })}>{states.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select></td>
              <td><input className="input sm" value={t.label ?? ""} onChange={(e) => set({ label: e.target.value })} /></td>
              <td><input className="input sm" placeholder="admin, manager" value={(t.roles ?? []).join(", ")} onChange={(e) => set({ roles: csv(e.target.value) })} /></td>
              <td><input className="input sm" placeholder="department, custom.x" value={(t.required_fields ?? []).join(", ")} onChange={(e) => set({ required_fields: csv(e.target.value) })} /></td>
              <td><input type="checkbox" aria-label="Exige documento" checked={!!t.require_document} onChange={(e) => set({ require_document: e.target.checked })} /></td>
              <td className="r"><button className="iconbtn" aria-label="Borrar transición" onClick={() => setTransitions(transitions.filter((_, j) => j !== i))}><Trash2 size={14} /></button></td></tr>); })}
        </tbody></table>
      </div>
      {ed && editing !== null && <Modal title={`Estado: ${ed.label}`} size="lg" onClose={() => setEditing(null)} footer={<><button className="btn danger" onClick={() => del(editing)}><Trash2 />Borrar estado</button><button className="btn primary" onClick={() => setEditing(null)}>Listo</button></>}>
        <div className="form-grid">
          <Field label="Nombre"><input className="input" aria-label="Nombre del estado" value={ed.label} onChange={(e) => upd(editing, { label: e.target.value })} /></Field>
          <Field label="Clave interna" hint="Se usa en reglas, API e importación"><input className="input" value={ed.key} onChange={(e) => { const nk = slug(e.target.value); setTransitions(transitions.map((t) => ({ ...t, from: t.from === ed.key ? nk : t.from, to: t.to === ed.key ? nk : t.to }))); upd(editing, { key: nk }); }} /></Field>
          <Field label="Fase del motor"><select className="input" value={ed.phase} onChange={(e) => upd(editing, { phase: e.target.value })}>{meta.phases.map((p) => <option key={p} value={p}>{CSTATUS[p]?.label ?? p}</option>)}</select></Field>
          <Field label="Color"><div className="cpal" style={{ position: "static", boxShadow: "none", padding: 0 }}>{PALETTE.slice(0, 20).map((c) => <button key={c} aria-label={c} style={{ background: c, outline: ed.color === c ? "2px solid var(--ink)" : undefined }} onClick={() => upd(editing, { color: c })} />)}</div></Field>
          <Field label="SLA (horas en este estado)" hint="Vacío = sin SLA"><input className="input" type="number" value={ed.sla_hours ?? ""} onChange={(e) => upd(editing, { sla_hours: e.target.value === "" ? null : Number(e.target.value) })} /></Field>
          <Field label="Escalar a" hint="Si se supera el SLA"><select className="input" value={ed.escalate_to ?? "manager"} onChange={(e) => upd(editing, { escalate_to: e.target.value })}><option value="manager">Manager del propietario</option><option value="legal_owner">Responsable legal</option><option value="owner">Propietario</option>{roles.map((r) => <option key={r.key} value={`role:${r.key}`}>Rol: {r.name}</option>)}</select></Field>
          <Field label="Roles que pueden pasar a este estado (vacío = todos)" full><div className="row wrap">{roles.map((r) => <label key={r.key} className="checkbox small"><input type="checkbox" checked={(ed.roles ?? []).includes(r.key)} onChange={(e) => upd(editing, { roles: e.target.checked ? [...(ed.roles ?? []), r.key] : (ed.roles ?? []).filter((x) => x !== r.key) })} />{r.name}</label>)}</div></Field>
          <Field label="Campos obligatorios para entrar" full><div className="row wrap">{fieldOpts.map(([k, l]) => <label key={k} className="checkbox small"><input type="checkbox" checked={(ed.required_fields ?? []).includes(k)} onChange={(e) => upd(editing, { required_fields: e.target.checked ? [...(ed.required_fields ?? []), k] : (ed.required_fields ?? []).filter((x) => x !== k) })} />{l}</label>)}</div></Field>
          <div className="col"><label className="checkbox"><input type="checkbox" checked={!!ed.optional} onChange={(e) => upd(editing, { optional: e.target.checked })} />Opcional (al entrar en la fase se salta)</label><label className="checkbox"><input type="checkbox" checked={!!ed.require_document} onChange={(e) => upd(editing, { require_document: e.target.checked })} />Exige documento</label></div>
          <Field label="Descripción" full><input className="input" value={ed.description ?? ""} onChange={(e) => upd(editing, { description: e.target.value })} /></Field>
        </div>
      </Modal>}
    </div>
  );
}

/* ============================================================ matriz de aprobación */
interface Leaf { field: string; op: string; value?: unknown }
interface Group { logic: "all" | "any"; conditions: (Leaf | Group)[] }
interface Step { name: string; approver: { kind: string; user_id?: string; role?: string; users?: string[]; mode?: "any" | "all" }; parallel?: boolean; sla_hours?: number; expiry_days?: number | null }
interface Rule { id?: string; name: string; priority?: number; active?: boolean | number; type_ids: string[]; conditions: Group; steps: Step[]; reason?: string | null; stop?: boolean | number }
const KIND_ES: Record<string, string> = { user: "Usuario", role: "Rol", manager_of_owner: "Manager del propietario", legal_owner: "Responsable legal", owner: "Propietario", group: "Grupo" };
function describeApprover(a: Step["approver"], userName: (id: string) => string): string {
  if (a.kind === "user") return userName(a.user_id ?? "");
  if (a.kind === "role") return `rol ${a.role}`;
  if (a.kind === "group") return `${a.mode === "all" ? "todos" : "cualquiera"} de: ${(a.users ?? []).map(userName).join(", ")}`;
  return KIND_ES[a.kind] ?? a.kind;
}
function ConditionEditor({ g, onChange, meta, customKeys, depth = 0 }: { g: Group; onChange: (g: Group) => void; meta: ConfigMeta; customKeys: [string, string][]; depth?: number }) {
  const fields: [string, string][] = [...Object.entries(meta.condition_fields), ...customKeys];
  const set = (i: number, c: Leaf | Group) => onChange({ ...g, conditions: g.conditions.map((x, j) => (j === i ? c : x)) });
  return (
    <div className="cond-group" style={{ borderLeft: "3px solid var(--line)", paddingLeft: 8, marginLeft: depth ? 8 : 0 }}>
      <div className="row mb8"><select className="input sm" aria-label="Lógica del grupo" style={{ width: 170 }} value={g.logic} onChange={(e) => onChange({ ...g, logic: e.target.value as Group["logic"] })}><option value="all">Se cumplen TODAS</option><option value="any">Se cumple ALGUNA</option></select>
        <button className="btn xs" onClick={() => onChange({ ...g, conditions: [...g.conditions, { field: "value", op: "gte", value: 0 }] })}><Plus />Condición</button>
        {depth < 2 && <button className="btn xs" onClick={() => onChange({ ...g, conditions: [...g.conditions, { logic: "any", conditions: [] }] })}><Plus />Grupo</button>}
        {!g.conditions.length && <span className="xs muted">Sin condiciones: siempre aplica</span>}</div>
      {g.conditions.map((c, i) => "logic" in c
        ? <div key={i} className="row" style={{ alignItems: "flex-start" }}><ConditionEditor g={c} onChange={(x) => set(i, x)} meta={meta} customKeys={customKeys} depth={depth + 1} /><button className="iconbtn" aria-label="Borrar grupo" onClick={() => onChange({ ...g, conditions: g.conditions.filter((_, j) => j !== i) })}><Trash2 size={12} /></button></div>
        : <div key={i} className="row mb8" style={{ gap: 4 }}>
          <select className="input sm" aria-label="Campo" style={{ width: 210 }} value={c.field} onChange={(e) => set(i, { ...c, field: e.target.value })}>{fields.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <select className="input sm" aria-label="Operador" style={{ width: 110 }} value={c.op} onChange={(e) => set(i, { ...c, op: e.target.value })}>{meta.condition_ops.map((o) => <option key={o} value={o}>{OPS_ES[o] ?? o}</option>)}</select>
          {!["is_true", "is_false", "empty", "not_empty"].includes(c.op) && <input className="input sm" aria-label="Valor" style={{ width: 160 }} value={String(c.value ?? "")} onChange={(e) => set(i, { ...c, value: e.target.value !== "" && !Number.isNaN(Number(e.target.value)) && !["in", "not_in", "contains", "eq", "ne"].includes(c.op) ? Number(e.target.value) : e.target.value })} placeholder={["in", "not_in"].includes(c.op) ? "ES, PT, FR" : ""} />}
          <button className="iconbtn" aria-label="Borrar condición" onClick={() => onChange({ ...g, conditions: g.conditions.filter((_, j) => j !== i) })}><Trash2 size={12} /></button></div>)}
    </div>
  );
}
export function ApprovalMatrixAdmin() {
  const toast = useToast(); const confirm = useConfirm(); const { users, userName, customFields, isAdmin } = useApp();
  const meta = useMeta(); const roles = useRoles(); const { types } = useTypes();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [edit, setEdit] = useState<Rule | null>(null);
  const [sim, setSim] = useState<{ cid: string; out: { contract: Any; steps: Any[] } | null }>({ cid: "", out: null });
  const [contracts, setContracts] = useState<Any[]>([]);
  const load = () => api.get<{ items: Rule[] }>("clm/approval-rules").then((r) => setRules(r.items));
  useEffect(() => { load(); api.get<{ items: Any[] }>("clm/contracts?page_size=200").then((r) => setContracts(r.items)); }, []);
  if (!rules || !meta) return <Spinner />;
  const customKeys: [string, string][] = customFields.filter((f) => f.object === "contract").map((f) => [`custom.${f.key}`, `${f.label} (personalizado)`]);
  const save = async () => { if (!edit) return; try { const body = { ...edit, active: !!edit.active, stop: !!edit.stop }; delete (body as Any).id; if (edit.id) await api.put(`clm/approval-rules/${edit.id}`, body); else await api.post("clm/approval-rules", body); toast("Regla guardada", "ok"); setEdit(null); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  const reorder = async (i: number, d: -1 | 1) => { const arr = [...rules]; const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j]!, arr[i]!]; setRules(arr); await api.post("clm/approval-rules/reorder", { ids: arr.map((r) => r.id) }); };
  const simulate = async (cid: string) => { setSim({ cid, out: null }); if (!cid) return; try { setSim({ cid, out: await api.post("clm/approval-rules/preview", { contract_id: cid }) }); } catch (e) { toast(errorMessage(e), "error"); } };
  const steps = edit?.steps ?? [];
  const setStep = (i: number, p: Partial<Step>) => edit && setEdit({ ...edit, steps: steps.map((s, j) => (j === i ? { ...s, ...p } : s)) });
  return (
    <div>
      <div className="filterbar"><span className="small sub">Las reglas se evalúan en orden. Cada regla que se cumple añade sus pasos: secuenciales (una etapa tras otra) o en paralelo con el anterior. Un mismo aprobador se agrupa en un paso; el propietario nunca aprueba su contrato (separación de funciones) y las ausencias se cubren con sustitutos.</span>
        <div className="right row">{isAdmin && <button className="btn" onClick={async () => { if (await confirm({ title: "¿Restablecer la política por defecto?", text: "Se borran tus reglas y se crean las 6 de serie.", danger: true, confirmText: "Restablecer" })) { await api.post("clm/approval-rules/reset"); load(); } }}><RotateCcw />Por defecto</button>}<button className="btn primary" onClick={() => setEdit({ name: "", priority: (rules.length + 1) * 10, active: true, type_ids: [], conditions: { logic: "all", conditions: [] }, steps: [{ name: "Aprobación", approver: { kind: "manager_of_owner" }, sla_hours: 48 }], reason: "", stop: false })}><Plus />Regla</button></div></div>
      <div className="card tight"><table className="table"><thead><tr><th>#</th><th>Regla</th><th>Tipos</th><th>Pasos</th><th>Activa</th><th /></tr></thead><tbody>
        {rules.map((r, i) => <tr key={r.id} style={{ opacity: r.active ? 1 : 0.5 }}><td className="nowrap"><button className="iconbtn" aria-label="Subir" onClick={() => reorder(i, -1)}><ArrowUp size={12} /></button><button className="iconbtn" aria-label="Bajar" onClick={() => reorder(i, 1)}><ArrowDown size={12} /></button></td>
          <td><div className="bold">{r.name}{r.stop ? <span className="badge" style={{ marginLeft: 6 }}>detiene</span> : null}</div><div className="xs muted">{r.reason}</div></td>
          <td className="small">{r.type_ids.length ? r.type_ids.map((t) => types.find((x) => x.id === t)?.code ?? "?").join(", ") : "Todos"}</td>
          <td className="small">{r.steps.map((s, j) => <div key={j}>{s.parallel ? "∥ " : `${j + 1}. `}<b>{s.name}</b> · {describeApprover(s.approver, userName)}{s.sla_hours ? ` · ${s.sla_hours} h` : ""}{s.expiry_days ? ` · caduca ${s.expiry_days} d` : ""}</div>)}</td>
          <td>{r.active ? <span className="badge ok">sí</span> : <span className="badge">no</span>}</td>
          <td className="r nowrap"><button className="iconbtn" aria-label={`Editar ${r.name}`} onClick={() => setEdit({ ...r, active: !!r.active, stop: !!r.stop })}><Pencil size={14} /></button><button className="iconbtn" aria-label="Borrar" onClick={async () => { if (await confirm({ title: `¿Borrar la regla «${r.name}»?`, danger: true, confirmText: "Borrar" })) { await api.del(`clm/approval-rules/${r.id}`); load(); } }}><Trash2 size={14} /></button></td></tr>)}
      </tbody></table></div>
      <div className="card mt12"><div className="row mb8"><Play size={14} /><h3 style={{ margin: 0 }}>Simular con un contrato</h3><select className="input" aria-label="Contrato a simular" style={{ maxWidth: 380 }} value={sim.cid} onChange={(e) => simulate(e.target.value)}><option value="">Elige un contrato…</option>{contracts.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.number)} · {String(c.title)}</option>)}</select></div>
        {sim.out && (sim.out.steps.length ? <ol className="approval-chain">{sim.out.steps.map((s, i) => <li key={i}><span className="badge">Etapa {String(s.stage ?? i + 1)}</span> <b>{String(s.name)}</b> → {(s.group as string[] | undefined)?.length && s.mode === "any" ? `cualquiera de ${(s.group as string[]).map(userName).join(", ")}` : userName(String(s.approver_user_id ?? "")) || "sin aprobador"}{s.substitute_for ? ` (sustituye a ${userName(String(s.substitute_for))})` : ""} <span className="xs muted">· {String(s.reason)}</span></li>)}</ol> : <p className="small muted">Ninguna regla aplica: se aprobaría automáticamente.</p>)}
      </div>
      {edit && <Modal title={edit.id ? `Regla: ${edit.name}` : "Nueva regla de aprobación"} size="xl" onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancelar</button><button className="btn primary" onClick={save}>Guardar regla</button></>}>
        <div className="form-grid mb12">
          <Field label="Nombre"><input className="input" aria-label="Nombre de la regla" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Motivo que verá el aprobador" hint="Variables: {value} {term_months} {deviations} {major} {risk_score}…"><input className="input" value={edit.reason ?? ""} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></Field>
          <Field label="Solo para tipos (vacío = todos)" full><div className="row wrap">{types.map((t) => <label key={t.id} className="checkbox small"><input type="checkbox" checked={edit.type_ids.includes(t.id)} onChange={(e) => setEdit({ ...edit, type_ids: e.target.checked ? [...edit.type_ids, t.id] : edit.type_ids.filter((x) => x !== t.id) })} />{t.code}</label>)}</div></Field>
          <div className="col"><label className="checkbox"><input type="checkbox" checked={!!edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />Activa</label><label className="checkbox"><input type="checkbox" checked={!!edit.stop} onChange={(e) => setEdit({ ...edit, stop: e.target.checked })} />Si se cumple, no evaluar las siguientes</label></div>
        </div>
        <h4>Condiciones</h4>
        <ConditionEditor g={edit.conditions} onChange={(g) => setEdit({ ...edit, conditions: g })} meta={meta} customKeys={customKeys} />
        <h4 className="mt12">Pasos</h4>
        {steps.map((s, i) => (
          <div key={i} className="card mb8 rule-step" style={{ background: "var(--panel)" }}><div className="row wrap" style={{ gap: 6 }}>
            <input className="input sm" aria-label="Nombre del paso" style={{ width: 180 }} value={s.name} onChange={(e) => setStep(i, { name: e.target.value })} />
            <select className="input sm" aria-label="Tipo de aprobador" style={{ width: 200 }} value={s.approver.kind} onChange={(e) => setStep(i, { approver: { kind: e.target.value, mode: e.target.value === "group" ? "any" : undefined, users: e.target.value === "group" ? [] : undefined } })}>{Object.entries(KIND_ES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            {s.approver.kind === "user" && <select className="input sm" aria-label="Usuario aprobador" style={{ width: 180 }} value={s.approver.user_id ?? ""} onChange={(e) => setStep(i, { approver: { ...s.approver, user_id: e.target.value } })}><option value="">Elige…</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>}
            {s.approver.kind === "role" && <select className="input sm" aria-label="Rol aprobador" style={{ width: 180 }} value={s.approver.role ?? ""} onChange={(e) => setStep(i, { approver: { ...s.approver, role: e.target.value } })}><option value="">Elige…</option>{[...roles.map((r) => [r.key, r.name]), ["legal_director", "Director legal"], ["cfo", "Finanzas (CFO)"], ["dpo", "DPO"], ["ceo", "Dirección general"]].filter((x, j, a) => a.findIndex((y) => y[0] === x[0]) === j).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
            {s.approver.kind === "group" && <><select className="input sm" aria-label="Modo del grupo" style={{ width: 150 }} value={s.approver.mode ?? "any"} onChange={(e) => setStep(i, { approver: { ...s.approver, mode: e.target.value as "any" | "all" } })}><option value="any">Cualquiera aprueba</option><option value="all">Todos aprueban</option></select>
              <div className="row wrap" style={{ gap: 4 }}>{users.filter((u) => u.active).map((u) => <label key={u.id} className="checkbox xs"><input type="checkbox" checked={(s.approver.users ?? []).includes(u.id)} onChange={(e) => setStep(i, { approver: { ...s.approver, users: e.target.checked ? [...(s.approver.users ?? []), u.id] : (s.approver.users ?? []).filter((x) => x !== u.id) } })} />{u.name}</label>)}</div></>}
            <label className="checkbox small"><input type="checkbox" checked={!!s.parallel} onChange={(e) => setStep(i, { parallel: e.target.checked })} />En paralelo con el anterior</label>
            <input className="input sm" aria-label="SLA en horas" type="number" style={{ width: 80 }} value={s.sla_hours ?? 48} onChange={(e) => setStep(i, { sla_hours: Number(e.target.value) })} /><span className="xs muted">h SLA</span>
            <input className="input sm" aria-label="Caducidad en días" type="number" style={{ width: 80 }} value={s.expiry_days ?? ""} onChange={(e) => setStep(i, { expiry_days: e.target.value === "" ? null : Number(e.target.value) })} /><span className="xs muted">días caducidad</span>
            <button className="iconbtn right" aria-label="Borrar paso" onClick={() => setEdit({ ...edit, steps: steps.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
          </div></div>))}
        <button className="btn sm" onClick={() => setEdit({ ...edit, steps: [...steps, { name: "Aprobación", approver: { kind: "role", role: "manager" }, sla_hours: 48 }] })}><Plus />Paso</button>
      </Modal>}
    </div>
  );
}

/* ============================================================ sustituciones */
export function DelegationsAdmin() {
  const toast = useToast(); const { users, me, isAdmin } = useApp();
  const [items, setItems] = useState<Any[] | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  const [edit, setEdit] = useState<Any | null>(null);
  const load = () => api.get<{ items: Any[] }>("clm/delegations").then((r) => setItems(r.items));
  useEffect(() => { load(); }, []);
  if (!items) return <Spinner />;
  const save = async () => { try { await api.post("clm/delegations", edit); toast("Sustitución guardada", "ok"); setEdit(null); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <div>
      <div className="filterbar"><span className="small sub">Ausencias y sustitutos: durante el periodo, las aprobaciones de la persona ausente las recibe (y puede decidir) su sustituto, también las ya pendientes.</span><button className="btn primary right" onClick={() => setEdit({ user_id: me.id, substitute_id: users.find((u) => u.id !== me.id && u.active)?.id, from_date: today, to_date: today, reason: "" })}><Plus />Ausencia</button></div>
      <div className="card tight"><table className="table"><thead><tr><th>Ausente</th><th>Sustituto</th><th>Desde</th><th>Hasta</th><th>Motivo</th><th /></tr></thead><tbody>
        {items.map((d) => <tr key={String(d.id)} style={{ opacity: String(d.to_date) < today ? 0.5 : 1 }}><td className="bold">{String(d.user_name)}</td><td>{String(d.substitute_name)}</td><td>{String(d.from_date)}</td><td>{String(d.to_date)}</td><td className="small">{String(d.reason ?? "")}</td><td className="r"><button className="iconbtn" aria-label="Borrar" onClick={() => api.del(`clm/delegations/${d.id}`).then(load)}><Trash2 size={14} /></button></td></tr>)}
        {!items.length && <tr><td colSpan={6} className="muted small">Sin ausencias registradas.</td></tr>}
      </tbody></table></div>
      {edit && <Modal title="Nueva ausencia" onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}><div className="form-grid">
        <Field label="Persona ausente"><select className="input" disabled={!isAdmin} value={String(edit.user_id)} onChange={(e) => setEdit({ ...edit, user_id: e.target.value })}>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <Field label="Sustituto"><select className="input" value={String(edit.substitute_id)} onChange={(e) => setEdit({ ...edit, substitute_id: e.target.value })}>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <Field label="Desde"><input className="input" type="date" value={String(edit.from_date)} onChange={(e) => setEdit({ ...edit, from_date: e.target.value })} /></Field>
        <Field label="Hasta"><input className="input" type="date" value={String(edit.to_date)} onChange={(e) => setEdit({ ...edit, to_date: e.target.value })} /></Field>
        <Field label="Motivo" full><input className="input" value={String(edit.reason ?? "")} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></Field>
      </div></Modal>}
    </div>
  );
}

/* ============================================================ importar / exportar */
export function ConfigTransfer() {
  const toast = useToast(); const confirm = useConfirm(); const { isAdmin } = useApp();
  const [text, setText] = useState(""); const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [result, setResult] = useState<Any | null>(null);
  const doImport = async () => {
    let data: unknown; try { data = JSON.parse(text); } catch { toast("El JSON no es válido", "error"); return; }
    if (mode === "replace" && !(await confirm({ title: "¿Sustituir ciclos de vida y reglas de aprobación?", text: "Los tipos, cláusulas, plantillas y playbooks se fusionan; ciclos y reglas se reemplazan.", danger: true, confirmText: "Importar" }))) return;
    try { setResult(await api.post("clm/config/import", { data, mode })); toast("Configuración importada", "ok"); } catch (e) { toast(errorMessage(e), "error"); }
  };
  return (
    <div className="grid2" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
      <div className="card"><h3>Exportar</h3><p className="small sub">Un único JSON con tipos (formulario, numeración, alertas, obligaciones e hitos por defecto), cláusulas, plantillas, playbooks, ciclos de vida, matriz de aprobación y campos de contrato. Los usuarios se exportan por email para poder llevarlo a otro entorno.</p>
        <button className="btn primary" onClick={() => downloadFile("/api/clm/config/export?download=1")}><Download />Descargar configuración</button></div>
      <div className="card"><h3>Importar</h3>
        {!isAdmin ? <p className="small muted">Solo un administrador puede importar.</p> : <>
          <input type="file" accept="application/json" aria-label="Archivo JSON" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
          <textarea className="input mt8" aria-label="JSON de configuración" style={{ minHeight: 140, fontFamily: "monospace", fontSize: 12 }} placeholder='{"format":"crm-clm-config", …}' value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row mt8"><select className="input" style={{ maxWidth: 260 }} value={mode} onChange={(e) => setMode(e.target.value as "merge" | "replace")}><option value="merge">Fusionar (por código y nombre)</option><option value="replace">Sustituir ciclos y reglas</option></select><button className="btn primary" disabled={!text.trim()} onClick={doImport}><Upload />Importar</button></div>
          {result && <div className="small mt8"><div>Creados: {JSON.stringify(result.created)}</div><div>Actualizados: {JSON.stringify(result.updated)}</div>{(result.warnings as string[]).map((w, i) => <div key={i} className="warn">{w}</div>)}</div>}
        </>}</div>
    </div>
  );
}

/* ============================================================ configuración por tipo */
interface IntakeField { key: string; label: string; type: string; required?: boolean; help?: string | null; options?: string[]; placeholder?: string | null; section?: string | null; show_if?: { field: string; op: string; value?: unknown } | null; map_to?: string | null }
const INTAKE_ES: Record<string, string> = { text: "Texto", textarea: "Texto largo", number: "Número", money: "Importe", date: "Fecha", select: "Lista", multiselect: "Lista múltiple", boolean: "Sí / No", user: "Usuario", email: "Email", url: "URL" };
const MAP_ES: [string, string][] = [["", "Solo en la solicitud"], ["description", "Objeto / descripción"], ["department", "Departamento"], ["total_value", "Valor total"], ["annual_value", "Valor anual"], ["effective_date", "Fecha de inicio"], ["end_date", "Fecha de fin"], ["term_months", "Duración (meses)"], ["notice_period_days", "Preaviso (días)"], ["payment_terms_days", "Plazo de pago"], ["governing_law", "Ley aplicable"], ["jurisdiction", "Jurisdicción"], ["urgency", "Urgencia"], ["confidentiality", "Confidencialidad"], ["currency", "Moneda"]];
export function TypeConfigModal({ type, onClose, onSaved }: { type: ContractType; onClose: () => void; onSaved: () => void }) {
  const toast = useToast(); const { customFields, refresh } = useApp();
  const [tab, setTab] = useState("intake");
  const [form, setForm] = useState<IntakeField[]>(type.intake_form ?? []);
  const [fmt, setFmt] = useState(type.number_format ?? "");
  const [preview, setPreview] = useState("");
  const [obls, setObls] = useState<Any[]>(type.default_obligations ?? []);
  const [mss, setMss] = useState<Any[]>(type.default_milestones ?? []);
  const [alerts, setAlerts] = useState<Any>(type.alert_config ?? {});
  const [newField, setNewField] = useState({ key: "", label: "", type: "text", required: false });
  const typeFields = customFields.filter((f) => f.object === "contract" && (f as unknown as { contract_type_id?: string | null }).contract_type_id === type.id);
  useEffect(() => { const t = setTimeout(() => { api.post<{ number: string }>(`clm/types/${type.id}/number-preview`, { format: fmt || null, department: "Ventas" }).then((r) => setPreview(r.number)).catch((e) => setPreview(`⚠ ${errorMessage(e)}`)); }, 250); return () => clearTimeout(t); }, [fmt, type.id]);
  const save = async () => { try { await api.put(`clm/types/${type.id}`, { intake_form: form.map((f) => ({ ...f, map_to: f.map_to || null, options: f.options?.length ? f.options : undefined, show_if: f.show_if?.field ? f.show_if : null })), number_format: fmt || null, default_obligations: obls, default_milestones: mss, alert_config: alerts }); toast("Configuración del tipo guardada", "ok"); onSaved(); onClose(); } catch (e) { toast(errorMessage(e), "error"); } };
  const setF = (i: number, p: Partial<IntakeField>) => setForm(form.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const offsets = (k: string) => ((alerts[k] as number[] | undefined) ?? []).join(", ");
  const setOffsets = (k: string, v: string) => setAlerts({ ...alerts, [k]: v.trim() ? csv(v).map(Number).filter((n) => !Number.isNaN(n)) : undefined });
  const addTypeField = async () => { try { await api.post("admin/custom-fields", { object: "contract", key: newField.key, label: newField.label, type: newField.type, required: newField.required, contract_type_id: type.id }); setNewField({ key: "", label: "", type: "text", required: false }); await refresh(); toast("Campo creado", "ok"); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <Modal title={`Configurar ${type.code} · ${type.name}`} size="xl" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Guardar configuración</button></>}>
      <Tabs items={[{ key: "intake", label: "Formulario de solicitud" }, { key: "fields", label: "Campos del tipo" }, { key: "number", label: "Numeración" }, { key: "defaults", label: "Al activar" }, { key: "alerts", label: "Alertas" }]} value={tab} onChange={setTab} />
      <div className="mt12">
        {tab === "intake" && <div>
          <p className="small sub">Preguntas que se hacen al pedir un contrato de este tipo. Pueden ser obligatorias, mostrarse solo si otra respuesta lo pide y volcarse en un campo del contrato.</p>
          {form.map((f, i) => <div key={i} className="card mb8 intake-field" style={{ background: "var(--panel)" }}><div className="row wrap" style={{ gap: 6 }}>
            <input className="input sm" aria-label="Pregunta" style={{ width: 200 }} placeholder="Pregunta" value={f.label} onChange={(e) => setF(i, { label: e.target.value, key: f.key || slug(e.target.value) })} />
            <input className="input sm" aria-label="Clave" style={{ width: 130 }} value={f.key} onChange={(e) => setF(i, { key: slug(e.target.value) })} />
            <select className="input sm" aria-label="Tipo de respuesta" style={{ width: 130 }} value={f.type} onChange={(e) => setF(i, { type: e.target.value })}>{Object.entries(INTAKE_ES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            {["select", "multiselect"].includes(f.type) && <input className="input sm" aria-label="Opciones" style={{ width: 200 }} placeholder="Opciones separadas por coma" value={(f.options ?? []).join(", ")} onChange={(e) => setF(i, { options: csv(e.target.value) })} />}
            <label className="checkbox small"><input type="checkbox" checked={!!f.required} onChange={(e) => setF(i, { required: e.target.checked })} />Obligatoria</label>
            <select className="input sm" aria-label="Volcar en" style={{ width: 170 }} value={f.map_to ?? ""} onChange={(e) => setF(i, { map_to: e.target.value || null })}>{MAP_ES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}{customFields.filter((c) => c.object === "contract").map((c) => <option key={c.key} value={`custom.${c.key}`}>{c.label} (campo)</option>)}</select>
            <button className="iconbtn right" aria-label="Borrar pregunta" onClick={() => setForm(form.filter((_, j) => j !== i))}><Trash2 size={14} /></button>
          </div><div className="row wrap mt8" style={{ gap: 6 }}>
            <input className="input sm" aria-label="Ayuda" style={{ width: 260 }} placeholder="Texto de ayuda" value={f.help ?? ""} onChange={(e) => setF(i, { help: e.target.value })} />
            <span className="xs muted">Mostrar solo si</span>
            <select className="input sm" aria-label="Condición: pregunta" style={{ width: 150 }} value={f.show_if?.field ?? ""} onChange={(e) => setF(i, { show_if: e.target.value ? { field: e.target.value, op: f.show_if?.op ?? "truthy", value: f.show_if?.value } : null })}><option value="">siempre</option>{form.filter((_, j) => j !== i).map((o) => <option key={o.key} value={o.key}>{o.label || o.key}</option>)}</select>
            {f.show_if?.field && <><select className="input sm" aria-label="Condición: operador" style={{ width: 110 }} value={f.show_if.op} onChange={(e) => setF(i, { show_if: { ...f.show_if!, op: e.target.value } })}><option value="truthy">es sí / tiene valor</option><option value="eq">=</option><option value="ne">≠</option><option value="in">en lista</option><option value="gt">&gt;</option><option value="lt">&lt;</option></select>
              {f.show_if.op !== "truthy" && <input className="input sm" aria-label="Condición: valor" style={{ width: 120 }} value={String(f.show_if.value ?? "")} onChange={(e) => setF(i, { show_if: { ...f.show_if!, value: e.target.value } })} />}</>}
          </div></div>)}
          <button className="btn sm" onClick={() => setForm([...form, { key: `pregunta_${form.length + 1}`, label: "", type: "text" }])}><Plus />Pregunta</button>
        </div>}
        {tab === "fields" && <div>
          <p className="small sub">Campos personalizados de contrato que solo existen (y solo se exigen) en contratos de este tipo.</p>
          <table className="table mb12"><thead><tr><th>Campo</th><th>Clave</th><th>Tipo</th><th>Obligatorio</th></tr></thead><tbody>{typeFields.map((f) => <tr key={f.key}><td>{f.label}</td><td className="small">{f.key}</td><td className="small">{f.type}</td><td>{f.required ? "Sí" : "No"}</td></tr>)}{!typeFields.length && <tr><td colSpan={4} className="small muted">Sin campos propios.</td></tr>}</tbody></table>
          <div className="row wrap"><input className="input sm" aria-label="Etiqueta del campo" placeholder="Etiqueta" value={newField.label} onChange={(e) => setNewField({ ...newField, label: e.target.value, key: newField.key || slug(e.target.value) })} /><input className="input sm" aria-label="Clave del campo" placeholder="clave" value={newField.key} onChange={(e) => setNewField({ ...newField, key: slug(e.target.value) })} /><select className="input sm" value={newField.type} onChange={(e) => setNewField({ ...newField, type: e.target.value })}><option value="text">Texto</option><option value="number">Número</option><option value="currency">Importe</option><option value="date">Fecha</option><option value="boolean">Sí/No</option></select><label className="checkbox small"><input type="checkbox" checked={newField.required} onChange={(e) => setNewField({ ...newField, required: e.target.checked })} />Obligatorio</label><button className="btn sm" disabled={!newField.label || !newField.key} onClick={addTypeField}><Plus />Añadir campo</button></div>
        </div>}
        {tab === "number" && <div className="form-grid">
          <Field label="Formato de numeración" hint="Tokens: {TYPE} prefijo · {CODE} código · {YYYY} {YY} {MM} · {DEPT} departamento · {SEQ:4} secuencia con 4 dígitos. Con {YYYY}/{YY} la secuencia reinicia cada año; con {DEPT}, por departamento. Vacío = PREFIJO-AAAA-00001." full><input className="input" aria-label="Formato de numeración" value={fmt} placeholder="{TYPE}-{YYYY}-{SEQ:5}" onChange={(e) => setFmt(e.target.value)} /></Field>
          <Field label="Siguiente número (departamento «Ventas»)"><div className="bold num" data-testid="number-preview">{preview}</div></Field>
          <Field label="Plantilla, playbook y nivel de firma"><div className="small sub">Se definen en la ficha del tipo (lápiz): plantilla por defecto, playbook por defecto y nivel mínimo de firma eIDAS.</div></Field>
        </div>}
        {tab === "defaults" && <div>
          <h4>Obligaciones que se crean al activar</h4>
          {obls.map((o, i) => { const set = (p: Any) => setObls(obls.map((x, j) => (j === i ? { ...x, ...p } : x))); return <div key={i} className="row wrap mb8" style={{ gap: 6 }}>
            <input className="input sm" aria-label="Obligación" style={{ width: 220 }} placeholder="Título" value={String(o.title ?? "")} onChange={(e) => set({ title: e.target.value })} />
            <select className="input sm" style={{ width: 140 }} value={String(o.type ?? "other")} onChange={(e) => set({ type: e.target.value })}>{Object.entries(OBL_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <select className="input sm" style={{ width: 110 }} value={String(o.obligor ?? "us")} onChange={(e) => set({ obligor: e.target.value })}><option value="us">Nosotros</option><option value="them">Contraparte</option></select>
            <input className="input sm" type="number" aria-label="Desfase en días" style={{ width: 80 }} value={Number(o.offset_days ?? 0)} onChange={(e) => set({ offset_days: Number(e.target.value) })} /><span className="xs muted">días desde</span>
            <select className="input sm" style={{ width: 120 }} value={String(o.anchor ?? "effective")} onChange={(e) => set({ anchor: e.target.value })}><option value="effective">el inicio</option><option value="end">el fin</option><option value="signature">la firma</option></select>
            <select className="input sm" style={{ width: 120 }} value={String(o.recurrence ?? "none")} onChange={(e) => set({ recurrence: e.target.value })}><option value="none">Una vez</option><option value="monthly">Mensual</option><option value="quarterly">Trimestral</option><option value="yearly">Anual</option></select>
            <button className="iconbtn" aria-label="Borrar" onClick={() => setObls(obls.filter((_, j) => j !== i))}><Trash2 size={14} /></button></div>; })}
          <button className="btn sm mb12" onClick={() => setObls([...obls, { title: "", type: "report", obligor: "us", anchor: "effective", offset_days: 30, recurrence: "none" }])}><Plus />Obligación</button>
          <h4>Hitos que se crean al activar</h4>
          {mss.map((m, i) => { const set = (p: Any) => setMss(mss.map((x, j) => (j === i ? { ...x, ...p } : x))); return <div key={i} className="row wrap mb8" style={{ gap: 6 }}>
            <input className="input sm" aria-label="Hito" style={{ width: 220 }} placeholder="Etiqueta" value={String(m.label ?? "")} onChange={(e) => set({ label: e.target.value })} />
            <select className="input sm" style={{ width: 150 }} value={String(m.type ?? "custom")} onChange={(e) => set({ type: e.target.value })}>{Object.entries(MS_TYPE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <input className="input sm" type="number" style={{ width: 80 }} value={Number(m.offset_days ?? 0)} onChange={(e) => set({ offset_days: Number(e.target.value) })} /><span className="xs muted">días desde</span>
            <select className="input sm" style={{ width: 130 }} value={String(m.anchor ?? "effective")} onChange={(e) => set({ anchor: e.target.value })}><option value="effective">el inicio</option><option value="end">el fin</option><option value="notice">el preaviso</option><option value="signature">la firma</option></select>
            <input className="input sm" style={{ width: 120 }} aria-label="Avisos" placeholder="30, 7, 1" value={((m.alert_offsets as number[]) ?? []).join(", ")} onChange={(e) => set({ alert_offsets: csv(e.target.value).map(Number).filter((n) => !Number.isNaN(n)) })} /><span className="xs muted">avisos (días antes)</span>
            <button className="iconbtn" aria-label="Borrar" onClick={() => setMss(mss.filter((_, j) => j !== i))}><Trash2 size={14} /></button></div>; })}
          <button className="btn sm" onClick={() => setMss([...mss, { label: "", type: "custom", anchor: "effective", offset_days: 90, alert_offsets: [30, 7] }])}><Plus />Hito</button>
        </div>}
        {tab === "alerts" && <div className="form-grid">
          <Field label="Avisos del límite de preaviso (días antes)" hint="Por defecto 120, 90, 60, 30, 14, 7, 1, 0"><input className="input" aria-label="Avisos de preaviso" value={offsets("notice")} onChange={(e) => setOffsets("notice", e.target.value)} /></Field>
          <Field label="Avisos del fin de vigencia" hint="Por defecto 90, 60, 30, 7"><input className="input" value={offsets("end")} onChange={(e) => setOffsets("end", e.target.value)} /></Field>
          <Field label="Avisos de renovación" hint="Por defecto 30"><input className="input" value={offsets("renewal")} onChange={(e) => setOffsets("renewal", e.target.value)} /></Field>
          <Field label="Avisos de obligaciones" hint="Por defecto 7"><input className="input" value={offsets("obligation")} onChange={(e) => setOffsets("obligation", e.target.value)} /></Field>
          <Field label="Escalar si nadie acusa recibo en (días)" hint="Vacío = no escalar"><input className="input" type="number" value={alerts.escalate_after_days == null ? "" : String(alerts.escalate_after_days)} onChange={(e) => setAlerts({ ...alerts, escalate_after_days: e.target.value === "" ? null : Number(e.target.value) })} /></Field>
          <Field label="Escalar a"><select className="input" value={String(alerts.escalate_to ?? "manager")} onChange={(e) => setAlerts({ ...alerts, escalate_to: e.target.value })}><option value="manager">Manager del propietario</option><option value="legal_owner">Responsable legal</option><option value="owner">Propietario</option></select></Field>
        </div>}
      </div>
    </Modal>
  );
}
export const typeConfigSummary = (t: ContractType) => [t.intake_form?.length ? `${t.intake_form.length} preguntas` : "", t.number_format ? t.number_format : "", t.default_obligations?.length ? `${t.default_obligations.length} oblig.` : "", t.alert_config && Object.keys(t.alert_config).length ? "alertas" : ""].filter(Boolean).join(" · ");
