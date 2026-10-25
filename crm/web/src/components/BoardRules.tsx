import { useEffect, useState } from "react";
import { Plus, Trash2, Pencil, Zap, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useApp } from "../lib/app";
import { Drawer, Modal, useToast, useConfirm, errorMessage, Spinner } from "./ui";
import { WorkflowEditor } from "../pages/AutomationCenter";
import type { Column } from "./DataTable";
import { relTime } from "../lib/format";

type Any = Record<string, unknown>;
interface WF { id: string; name: string; description: string | null; trigger: { type: string; object?: string; field?: string; value?: string; stage_id?: string; days?: number }; conditions: { logic: "and" | "or"; conditions: { field: string; op: string; value?: unknown }[] }; actions: ({ type: string } & Any)[]; active: number; allow_reenroll: number; runs: number; last_run_at: string | null; errors: number }

const OBJ_LABEL: Record<string, string> = { contact: "contacto", company: "empresa", deal: "negocio", ticket: "ticket", contract: "contrato" };

/** Which workflows belong to this board */
function belongs(w: WF, object: string) {
  const t = w.trigger;
  if (t.object) return t.object === object;
  if (object === "deal") return ["stage_changed", "deal_won", "deal_lost", "deal_inactive", "deal_stale", "quote_viewed", "quote_accepted"].includes(t.type);
  if (object === "ticket") return ["ticket_created", "ticket_sla_risk"].includes(t.type);
  if (object === "contact") return ["form_submitted", "email_opened", "score_threshold"].includes(t.type);
  return false;
}

export function BoardRules({ object, columns, onClose }: { object: "contact" | "company" | "deal" | "ticket" | "contract"; columns: Column<unknown>[]; onClose: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<WF[] | null>(null);
  const [recipe, setRecipe] = useState(false);
  const [editing, setEditing] = useState<WF | null>(null);
  const load = () => api.get<{ items: WF[] }>("workflows").then((r) => setItems(r.items.filter((w) => belongs(w, object))));
  useEffect(() => { load(); }, [object]);
  const toggle = async (w: WF) => { await api.put(`workflows/${w.id}`, { active: !w.active }); load(); };
  const del = async (w: WF) => { if (!(await confirm({ title: `¿Borrar la regla «${w.name}»?`, danger: true, confirmText: "Borrar" }))) return; await api.del(`workflows/${w.id}`); load(); };
  return (
    <Drawer title={<span className="row"><Zap size={16} /> Automatizaciones del tablero</span>} onClose={onClose} footer={<><Link to="/ajustes/automatizaciones" className="btn ghost" onClick={onClose}><ExternalLink />Centro de automatizaciones</Link><button className="btn primary right" onClick={() => setRecipe(true)}><Plus />Nueva regla</button></>}>
      <p className="small sub mb12">Reglas del tipo «Cuando pasa X, entonces haz Y» sobre los {OBJ_LABEL[object]}s de este tablero. Se ejecutan al instante en el servidor.</p>
      {!items ? <Spinner /> : items.length === 0 ? <div className="empty"><Zap size={28} /><div className="t">Aún no hay reglas</div><div className="small sub">Crea la primera: por ejemplo, notificar al propietario cuando un estado cambie.</div></div> : (
        <div className="col" style={{ gap: 8 }}>
          {items.map((w) => (
            <div key={w.id} className={`rule ${w.active ? "" : "off"}`}>
              <label className="switch" title={w.active ? "Activa" : "Pausada"}><input type="checkbox" checked={!!w.active} onChange={() => toggle(w)} /><i /></label>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="bold ell">{w.name}</div>
                <div className="xs muted">{describe(w, columns)}{w.runs ? ` · ${w.runs} ejecuciones` : ""}{w.last_run_at ? ` · última ${relTime(w.last_run_at)}` : ""}{w.errors ? ` · ${w.errors} errores` : ""}</div>
              </div>
              <button className="iconbtn" title="Editar en detalle" onClick={() => setEditing(w)}><Pencil size={14} /></button>
              <button className="iconbtn" title="Borrar" onClick={() => del(w)}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
      {recipe && <RecipeBuilder object={object} columns={columns} onClose={() => setRecipe(false)} onSaved={() => { setRecipe(false); load(); }} />}
      {editing && <WorkflowEditor wf={editing as never} onClose={() => setEditing(null)} onSaved={load} />}
    </Drawer>
  );
}

function describe(w: WF, columns: Column<unknown>[]): string {
  const t = w.trigger;
  const col = (k?: string) => columns.find((c) => c.key === k || (k === "stage_id" && c.key === "stage_id"));
  const val = (k?: string, v?: string) => { const c = col(k); return c?.options?.[v ?? ""]?.label ?? v ?? "cualquier valor"; };
  const when: Record<string, string> = { record_created: "se crea un elemento", record_updated: "se modifica un elemento", field_changed: `«${col(t.field)?.label ?? t.field}» cambia a ${val(t.field, t.value)}`, stage_changed: "cambia de etapa", deal_won: "se gana el negocio", deal_lost: "se pierde el negocio", deal_inactive: `pasan ${t.days ?? 7} días sin actividad`, deal_stale: "se estanca en la etapa", ticket_created: "se crea un ticket", ticket_sla_risk: "el SLA está en riesgo", form_submitted: "llega un formulario", score_threshold: "la puntuación supera el umbral", scheduled_daily: "cada día", email_opened: "se abre un email", task_overdue: "vence una tarea", quote_viewed: "se ve un presupuesto", quote_accepted: "se acepta un presupuesto", webhook_in: "llega un webhook" };
  const act: Record<string, (a: Any) => string> = { notify: () => "notificar", create_task: (a) => `crear tarea «${a.title ?? ""}»`, send_email: () => "enviar email", update_field: (a) => `poner ${col(String(a.field))?.label ?? a.field} = ${val(String(a.field), String(a.value ?? ""))}`, change_owner: () => "cambiar propietario", change_stage: () => "mover de etapa", add_tag: (a) => `etiquetar «${a.tag}»`, add_to_list: () => "añadir a lista", add_score: (a) => `sumar ${a.points} puntos`, create_deal: () => "crear negocio", log_note: () => "registrar nota", call_webhook: () => "llamar webhook", delay: (a) => `esperar ${a.days ?? 0} d` };
  return `Cuando ${when[t.type] ?? t.type}, entonces ${w.actions.map((a) => (act[a.type] ?? (() => a.type))(a)).join(" y ")}`;
}

/** monday-style sentence builder: Cuando [disparador] [valor] → entonces [acción] [parámetros] */
function RecipeBuilder({ object, columns, onClose, onSaved }: { object: string; columns: Column<unknown>[]; onClose: () => void; onSaved: () => void }) {
  const { users, pipelines, teams } = useApp();
  const toast = useToast();
  const statusCols = columns.filter((c) => c.type === "status" && c.options && c.key !== "stage_id");
  const stages = pipelines.flatMap((p) => p.stages.map((s) => ({ ...s, pipeline: p.name })));
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { api.get<{ items: typeof templates }>("email-templates").then((r) => setTemplates(r.items)).catch(() => undefined); }, []);

  type TrigKind = "created" | "status" | "stage" | "won" | "lost" | "inactive" | "sla" | "updated";
  const trigKinds: { key: TrigKind; label: string }[] = [
    { key: "created", label: "se crea un elemento" },
    ...(statusCols.length ? [{ key: "status" as TrigKind, label: "un estado cambia a…" }] : []),
    ...(object === "deal" ? [{ key: "stage" as TrigKind, label: "la etapa cambia a…" }, { key: "won" as TrigKind, label: "se gana el negocio" }, { key: "lost" as TrigKind, label: "se pierde el negocio" }, { key: "inactive" as TrigKind, label: "pasan N días sin actividad" }] : []),
    ...(object === "ticket" ? [{ key: "sla" as TrigKind, label: "el SLA está en riesgo" }] : []),
    { key: "updated", label: "se modifica cualquier dato" },
  ];
  const [tk, setTk] = useState<TrigKind>(trigKinds[0]!.key);
  const [tField, setTField] = useState(statusCols[0]?.key ?? "");
  const [tValue, setTValue] = useState("");
  const [tStage, setTStage] = useState("");
  const [tDays, setTDays] = useState(7);
  type ActKind = "notify" | "assign" | "task" | "set" | "stage" | "tag" | "email";
  const actKinds: { key: ActKind; label: string }[] = [
    { key: "notify", label: "notificar a…" }, { key: "assign", label: "asignar a…" }, { key: "task", label: "crear una tarea" },
    ...(statusCols.length ? [{ key: "set" as ActKind, label: "cambiar un estado a…" }] : []),
    ...(object === "deal" ? [{ key: "stage" as ActKind, label: "mover a la etapa…" }] : []),
    { key: "tag", label: "añadir etiqueta" }, { key: "email", label: "enviar email con plantilla" },
  ];
  const [ak, setAk] = useState<ActKind>("notify");
  const [aTo, setATo] = useState("owner");
  const [aUser, setAUser] = useState(users.find((u) => u.active)?.id ?? "");
  const [aTitle, setATitle] = useState("Seguimiento de {{name}}");
  const [aDays, setADays] = useState(1);
  const [aField, setAField] = useState(statusCols[0]?.key ?? "");
  const [aValue, setAValue] = useState("");
  const [aStage, setAStage] = useState(stages.find((s) => s.kind === "open")?.id ?? "");
  const [aTag, setATag] = useState("");
  const [aTpl, setATpl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const tCol = statusCols.find((c) => c.key === tField);
  const aCol = statusCols.find((c) => c.key === aField);
  const sentence = () => {
    const w = tk === "created" ? "se crea un elemento" : tk === "status" ? `«${tCol?.label}» cambia a ${tCol?.options?.[tValue]?.label ?? "cualquier valor"}` : tk === "stage" ? `la etapa cambia a ${stages.find((s) => s.id === tStage)?.name ?? "cualquiera"}` : tk === "won" ? "se gana el negocio" : tk === "lost" ? "se pierde el negocio" : tk === "inactive" ? `pasan ${tDays} días sin actividad` : tk === "sla" ? "el SLA está en riesgo" : "se modifica";
    const a = ak === "notify" ? `notificar a ${aTo === "owner" ? "el propietario" : aTo === "manager" ? "el manager" : users.find((u) => `user:${u.id}` === aTo)?.name ?? aTo}` : ak === "assign" ? `asignar a ${users.find((u) => u.id === aUser)?.name ?? "…"}` : ak === "task" ? `crear la tarea «${aTitle}» en ${aDays} d` : ak === "set" ? `poner «${aCol?.label}» = ${aCol?.options?.[aValue]?.label ?? "…"}` : ak === "stage" ? `mover a ${stages.find((s) => s.id === aStage)?.name ?? "…"}` : ak === "tag" ? `etiquetar «${aTag}»` : "enviar email";
    return `Cuando ${w}, entonces ${a}`;
  };
  const build = () => {
    const trigger: Any = tk === "created" ? { type: "record_created", object } : tk === "status" ? { type: "field_changed", object, field: tField, value: tValue || undefined } : tk === "stage" ? { type: "stage_changed", stage_id: tStage || undefined } : tk === "won" ? { type: "deal_won" } : tk === "lost" ? { type: "deal_lost" } : tk === "inactive" ? { type: "deal_inactive", days: tDays } : tk === "sla" ? { type: "ticket_sla_risk" } : { type: "record_updated", object };
    const action: Any = ak === "notify" ? { type: "notify", to: aTo, title: `{{name}}: ${sentence().split(", entonces")[0]!.replace("Cuando ", "")}`, body: "Revisa el elemento en el CRM" } : ak === "assign" ? { type: "change_owner", mode: "fixed", user_id: aUser } : ak === "task" ? { type: "create_task", title: aTitle, task_type: "followup", due_in_days: aDays, assignee: "owner" } : ak === "set" ? { type: "update_field", field: aField, value: aValue } : ak === "stage" ? { type: "change_stage", stage_id: aStage } : ak === "tag" ? { type: "add_tag", tag: aTag } : { type: "send_email", to: object === "contact" ? "contact" : "owner", template_id: aTpl };
    return { name: name.trim() || sentence(), trigger, conditions: { logic: "and", conditions: [] }, actions: [action], active: true, allow_reenroll: true };
  };
  const valid = (tk !== "status" || tField) && (ak !== "set" || (aField && aValue)) && (ak !== "stage" || aStage) && (ak !== "tag" || aTag.trim()) && (ak !== "email" || aTpl) && (ak !== "assign" || aUser);
  const save = async () => { setBusy(true); try { await api.post("workflows", build()); toast("Regla creada", "ok"); onSaved(); } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); } };
  const Sel = ({ value, onChange, children }: { value: string; onChange: (v: string) => void; children: React.ReactNode }) => <select className="rsel" value={value} onChange={(e) => onChange(e.target.value)}>{children}</select>;
  return (
    <Modal title="Nueva regla" size="lg" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!valid || busy} onClick={save}>Crear regla</button></>}>
      <div className="recipe">
        <div className="rline"><span className="kw">Cuando</span>
          <Sel value={tk} onChange={(v) => setTk(v as TrigKind)}>{trigKinds.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</Sel>
          {tk === "status" && <><Sel value={tField} onChange={setTField}>{statusCols.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</Sel><Sel value={tValue} onChange={setTValue}><option value="">cualquier valor</option>{Object.entries(tCol?.options ?? {}).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}</Sel></>}
          {tk === "stage" && <Sel value={tStage} onChange={setTStage}><option value="">cualquier etapa</option>{stages.map((s) => <option key={s.id} value={s.id}>{s.pipeline} · {s.name}</option>)}</Sel>}
          {tk === "inactive" && <input className="rnum" type="number" min={1} value={tDays} onChange={(e) => setTDays(Number(e.target.value))} />}
        </div>
        <div className="rline"><span className="kw">entonces</span>
          <Sel value={ak} onChange={(v) => setAk(v as ActKind)}>{actKinds.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}</Sel>
          {ak === "notify" && <Sel value={aTo} onChange={setATo}><option value="owner">el propietario</option><option value="manager">el manager del propietario</option><option value="creator">quien lo creó</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={`user:${u.id}`}>{u.name}</option>)}{teams.map((t) => <option key={t.id} value={`team:${t.id}`}>equipo {t.name}</option>)}</Sel>}
          {ak === "assign" && <Sel value={aUser} onChange={setAUser}>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Sel>}
          {ak === "task" && <><input className="rtxt" value={aTitle} onChange={(e) => setATitle(e.target.value)} placeholder="Título de la tarea" /><span>en</span><input className="rnum" type="number" min={0} value={aDays} onChange={(e) => setADays(Number(e.target.value))} /><span>días</span></>}
          {ak === "set" && <><Sel value={aField} onChange={setAField}>{statusCols.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</Sel><Sel value={aValue} onChange={setAValue}><option value="">elige…</option>{Object.entries(aCol?.options ?? {}).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}</Sel></>}
          {ak === "stage" && <Sel value={aStage} onChange={setAStage}>{stages.filter((s) => s.kind === "open").map((s) => <option key={s.id} value={s.id}>{s.pipeline} · {s.name}</option>)}</Sel>}
          {ak === "tag" && <input className="rtxt" value={aTag} onChange={(e) => setATag(e.target.value)} placeholder="etiqueta" />}
          {ak === "email" && <Sel value={aTpl} onChange={setATpl}><option value="">elige plantilla…</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Sel>}
        </div>
      </div>
      <div className="card mt12" style={{ background: "var(--panel)" }}><div className="xs muted mb8">Vista previa</div><div className="bold">{sentence()}</div></div>
      <div className="mt12"><input className="input" placeholder="Nombre de la regla (opcional)" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <p className="xs muted mt8">¿Necesitas condiciones, varias acciones o esperas? Crea la regla y pulsa el lápiz para abrir el editor completo.</p>
    </Modal>
  );
}
