import { useEffect, useState } from "react";
import { Plus, Trash2, Pencil, Play, Copy, ExternalLink, FlaskConical } from "lucide-react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { Modal, Field, useToast, useConfirm, errorMessage, Spinner, Picker, TagInput } from "../components/ui";
import { FilterBuilder, describeFilters, type FilterGroup } from "../components/FilterBuilder";
import { fmtDateTime, relTime } from "../lib/format";

type Any = Record<string, unknown>;
type Trigger = { type: string; object?: string; field?: string; value?: string; stage_id?: string; pipeline_id?: string; form_id?: string; days?: number; min?: number };
type Action = { type: string; [k: string]: unknown };
interface WF { id: string; name: string; description: string | null; trigger: Trigger; conditions: FilterGroup; actions: Action[]; active: number; allow_reenroll: number; runs: number; last_run_at: string | null; errors: number }

const TRIGGERS: Record<string, { label: string; object?: boolean; help: string }> = {
  record_created: { label: "Registro creado", object: true, help: "Cuando se crea un contacto, empresa, negocio o ticket" },
  record_updated: { label: "Registro actualizado", object: true, help: "Cualquier cambio en el registro" },
  field_changed: { label: "Campo cambia a un valor", object: true, help: "Ej. lead_status pasa a qualified" },
  stage_changed: { label: "Negocio cambia de etapa", help: "Opcionalmente a una etapa concreta" },
  deal_won: { label: "Negocio ganado", help: "" }, deal_lost: { label: "Negocio perdido", help: "" },
  form_submitted: { label: "Formulario web enviado", help: "El registro es el contacto" },
  task_overdue: { label: "Tarea vencida", help: "" },
  deal_inactive: { label: "Negocio sin actividad N días", help: "Se evalúa cada día" }, deal_stale: { label: "Negocio estancado en etapa", help: "Supera los días esperados" },
  score_threshold: { label: "Puntuación supera umbral", help: "Contactos" }, ticket_created: { label: "Ticket creado", help: "" }, ticket_sla_risk: { label: "Ticket a punto de incumplir SLA", help: "" },
  email_opened: { label: "Email abierto", help: "El registro es el contacto" }, quote_viewed: { label: "Presupuesto visto", help: "" }, quote_accepted: { label: "Presupuesto aceptado", help: "" },
  scheduled_daily: { label: "Cada día (programado)", object: true, help: "Se inscribe cada registro que cumpla las condiciones, una vez al día" },
  webhook_in: { label: "Webhook externo recibido", help: "POST /hooks/<id del workflow> con {object, record_id}" },
};
const ACTIONS: Record<string, string> = { create_task: "Crear tarea", notify: "Enviar notificación", send_email: "Enviar email", update_field: "Actualizar campo", change_owner: "Cambiar propietario", change_stage: "Cambiar etapa", add_tag: "Añadir etiqueta", add_to_list: "Añadir a lista", add_score: "Sumar puntuación", create_deal: "Crear negocio", log_note: "Registrar nota", call_webhook: "Llamar webhook", delay: "Esperar" };

export function WorkflowsAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<WF[] | null>(null);
  const [editing, setEditing] = useState<WF | "new" | null>(null);
  const [runs, setRuns] = useState<{ wf: WF; items: { id: string; status: string; log: string[]; ran_at: string; record_id: string; object: string }[] } | null>(null);
  const load = () => api.get<{ items: WF[] }>("workflows").then((r) => setItems(r.items));
  useEffect(() => { load(); }, []);
  const toggle = async (w: WF) => { await api.put(`workflows/${w.id}`, { active: !w.active }); load(); };
  const del = async (w: WF) => { if (!(await confirm({ title: `¿Borrar «${w.name}»?`, danger: true, confirmText: "Borrar" }))) return; await api.del(`workflows/${w.id}`); load(); };
  if (!items) return <Spinner />;
  return (
    <div className="card tight">
      <div className="row between" style={{ padding: "12px 16px" }}><div><h2>Workflows</h2><p className="small muted">Disparador → condiciones → acciones. Historial de ejecuciones por registro; sin reinscripción salvo que se permita.</p></div><button className="btn primary sm" onClick={() => setEditing("new")}><Plus />Nuevo workflow</button></div>
      <table className="table"><thead><tr><th>Estado</th><th>Nombre</th><th>Disparador</th><th>Acciones</th><th className="r">Ejecuciones</th><th>Última</th><th></th></tr></thead><tbody>
        {items.map((w) => <tr key={w.id}><td><label className="checkbox"><input type="checkbox" checked={!!w.active} onChange={() => toggle(w)} /></label></td><td><div className="bold">{w.name}</div>{w.description && <div className="xs muted">{w.description}</div>}</td><td className="small">{TRIGGERS[w.trigger.type]?.label ?? w.trigger.type}{w.trigger.object ? ` (${w.trigger.object})` : ""}</td><td className="small muted">{w.actions.map((a) => ACTIONS[a.type] ?? a.type).join(" → ")}</td><td className="r num">{w.runs}{w.errors ? <span className="badge risk" style={{ marginLeft: 4 }}>{w.errors} err</span> : null}</td><td className="small muted">{w.last_run_at ? relTime(w.last_run_at) : "—"}</td><td className="r row" style={{ justifyContent: "flex-end" }}><button className="iconbtn" title="Historial" onClick={async () => setRuns({ wf: w, items: (await api.get<{ items: NonNullable<typeof runs>["items"] }>(`workflows/${w.id}/runs`)).items })}><Play size={15} /></button><button className="iconbtn" onClick={() => setEditing(w)}><Pencil size={15} /></button><button className="iconbtn" onClick={() => del(w)}><Trash2 size={15} /></button></td></tr>)}
      </tbody></table>
      {editing && <WorkflowEditor wf={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}
      {runs && <Modal title={`Ejecuciones: ${runs.wf.name}`} size="lg" onClose={() => setRuns(null)}>{runs.items.length === 0 ? <p className="muted">Aún no se ha ejecutado.</p> : <table className="table"><thead><tr><th>Fecha</th><th>Registro</th><th>Estado</th><th>Log</th></tr></thead><tbody>{runs.items.map((r) => <tr key={r.id}><td className="small">{fmtDateTime(r.ran_at)}</td><td className="small"><a href={`/${r.object === "contact" ? "contactos" : r.object === "deal" ? "negocios" : r.object === "company" ? "empresas" : "tickets"}/${r.record_id}`} target="_blank" rel="noreferrer">{r.object} <ExternalLink size={11} /></a></td><td><span className={`badge ${r.status === "ok" ? "ok" : r.status === "error" ? "risk" : ""}`}>{r.status}</span></td><td className="small">{r.log.map((l, i) => <div key={i}>{l}</div>)}</td></tr>)}</tbody></table>}</Modal>}
    </div>
  );
}

function WorkflowEditor({ wf, onClose, onSaved }: { wf: WF | null; onClose: () => void; onSaved: () => void }) {
  const { users, pipelines, teams } = useApp();
  const toast = useToast();
  const [name, setName] = useState(wf?.name ?? "");
  const [description, setDescription] = useState(wf?.description ?? "");
  const [trigger, setTrigger] = useState<Trigger>(wf?.trigger ?? { type: "record_created", object: "contact" });
  const [conditions, setConditions] = useState<FilterGroup>(wf?.conditions?.conditions ? wf.conditions : { logic: "and", conditions: [] });
  const [actions, setActions] = useState<Action[]>(wf?.actions ?? []);
  const [reenroll, setReenroll] = useState(!!wf?.allow_reenroll);
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [lists, setLists] = useState<{ id: string; name: string }[]>([]);
  const [forms, setForms] = useState<{ id: string; name: string }[]>([]);
  const [sim, setSim] = useState<{ object: string; record_id: string | null; result: Any | null }>({ object: "contact", record_id: null, result: null });
  useEffect(() => { api.get<{ items: typeof templates }>("email-templates").then((r) => setTemplates(r.items)); api.get<{ items: typeof lists }>("lists").then((r) => setLists(r.items)); api.get<{ items: typeof forms }>("forms").then((r) => setForms(r.items)); }, []);
  const condObject = trigger.object ?? (["deal_won", "deal_lost", "stage_changed", "deal_inactive", "deal_stale", "quote_viewed", "quote_accepted"].includes(trigger.type) ? "deal" : ["ticket_created", "ticket_sla_risk"].includes(trigger.type) ? "ticket" : trigger.type === "task_overdue" ? "task" : "contact");
  const upd = (i: number, p: Partial<Action>) => setActions((as) => as.map((a, j) => (j === i ? { ...a, ...p } : a)));
  const save = async () => { try { const body = { name, description: description || null, trigger, conditions, actions, allow_reenroll: reenroll, active: wf ? !!wf.active : true }; if (wf) await api.put(`workflows/${wf.id}`, body); else await api.post("workflows", body); toast("Workflow guardado", "ok"); onSaved(); onClose(); } catch (e) { toast(errorMessage(e), "error"); } };
  const simulate = async () => { if (!sim.record_id) return; try { const r = await api.post<Any>("workflows/simulate", { workflow: { name: name || "sim", trigger, conditions, actions }, object: condObject, record_id: sim.record_id }); setSim({ ...sim, result: r }); } catch (e) { toast(errorMessage(e), "error"); } };
  const userOpts = <><option value="owner">Propietario del registro</option><option value="manager">Manager del propietario</option><option value="creator">Creador</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={`user:${u.id}`}>{u.name}</option>)}</>;
  const t = TRIGGERS[trigger.type];
  return (
    <Modal title={wf ? "Editar workflow" : "Nuevo workflow"} size="xl" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!name.trim() || !actions.length} onClick={save}>Guardar</button></>}>
      <div className="form-grid mb12"><Field label="Nombre"><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field><Field label="Descripción"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field></div>
      <div className="card mb12" style={{ background: "var(--panel)" }}>
        <h3 className="mb8">1 · Disparador</h3>
        <div className="form-grid">
          <Field label="Cuando…"><select className="input" value={trigger.type} onChange={(e) => setTrigger({ type: e.target.value, object: TRIGGERS[e.target.value]?.object ? (trigger.object ?? "contact") : undefined })}>{Object.entries(TRIGGERS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></Field>
          {t?.object && <Field label="Objeto"><select className="input" value={trigger.object ?? "contact"} onChange={(e) => setTrigger({ ...trigger, object: e.target.value })}><option value="contact">Contacto</option><option value="company">Empresa</option><option value="deal">Negocio</option><option value="ticket">Ticket</option></select></Field>}
          {trigger.type === "field_changed" && <><Field label="Campo"><input className="input" placeholder="ej. lead_status o custom.interes" value={trigger.field ?? ""} onChange={(e) => setTrigger({ ...trigger, field: e.target.value })} /></Field><Field label="Nuevo valor (vacío = cualquiera)"><input className="input" value={trigger.value ?? ""} onChange={(e) => setTrigger({ ...trigger, value: e.target.value })} /></Field></>}
          {trigger.type === "stage_changed" && <Field label="A la etapa (opcional)"><select className="input" value={trigger.stage_id ?? ""} onChange={(e) => setTrigger({ ...trigger, stage_id: e.target.value || undefined })}><option value="">Cualquiera</option>{pipelines.flatMap((p) => p.stages.map((s) => <option key={s.id} value={s.id}>{p.name} · {s.name}</option>))}</select></Field>}
          {trigger.type === "form_submitted" && <Field label="Formulario (opcional)"><select className="input" value={trigger.form_id ?? ""} onChange={(e) => setTrigger({ ...trigger, form_id: e.target.value || undefined })}><option value="">Cualquiera</option>{forms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Field>}
          {trigger.type === "deal_inactive" && <Field label="Días sin actividad"><input className="input" type="number" value={trigger.days ?? 7} onChange={(e) => setTrigger({ ...trigger, days: Number(e.target.value) })} /></Field>}
          {trigger.type === "score_threshold" && <Field label="Umbral de puntuación"><input className="input" type="number" value={trigger.min ?? 50} onChange={(e) => setTrigger({ ...trigger, min: Number(e.target.value) })} /></Field>}
        </div>
        {t?.help && <p className="xs muted mt8">{t.help}{wf && trigger.type === "webhook_in" ? ` · URL: ${location.origin}/hooks/${wf.id}` : ""}</p>}
      </div>
      <div className="card mb12" style={{ background: "var(--panel)" }}><h3 className="mb8">2 · Condiciones <span className="muted small">(sobre el {condObject}; usa company.sector para campos de la empresa relacionada)</span></h3><FilterBuilder object={condObject} value={conditions} onChange={setConditions} /></div>
      <div className="card mb12" style={{ background: "var(--panel)" }}>
        <h3 className="mb8">3 · Acciones</h3>
        {actions.map((a, i) => (
          <div key={i} className="card mb8">
            <div className="row mb8"><strong className="muted small">{i + 1}.</strong><select className="input sm" style={{ width: "auto" }} value={a.type} onChange={(e) => upd(i, { type: e.target.value })}>{Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><button className="iconbtn right" onClick={() => setActions((as) => as.filter((_, j) => j !== i))}><Trash2 size={14} /></button></div>
            <div className="form-grid">
              {a.type === "create_task" && <><Field label="Título" hint="Variables: {{name}}, {{empresa}}, {{importe}}"><input className="input sm" value={String(a.title ?? "")} onChange={(e) => upd(i, { title: e.target.value })} /></Field><Field label="Tipo"><select className="input sm" value={String(a.task_type ?? "followup")} onChange={(e) => upd(i, { task_type: e.target.value })}><option value="call">Llamada</option><option value="email">Email</option><option value="meeting">Reunión</option><option value="followup">Seguimiento</option><option value="todo">Tarea</option></select></Field><Field label="Vence en (días)"><input className="input sm" type="number" value={Number(a.due_in_days ?? 1)} onChange={(e) => upd(i, { due_in_days: Number(e.target.value) })} /></Field><Field label="Asignar a"><select className="input sm" value={String(a.assignee ?? "owner")} onChange={(e) => upd(i, { assignee: e.target.value })}>{userOpts}</select></Field><Field label="Prioridad"><select className="input sm" value={String(a.priority ?? "normal")} onChange={(e) => upd(i, { priority: e.target.value })}><option value="low">Baja</option><option value="normal">Normal</option><option value="high">Alta</option></select></Field></>}
              {a.type === "notify" && <><Field label="Destinatario"><select className="input sm" value={String(a.to ?? "owner")} onChange={(e) => upd(i, { to: e.target.value })}>{userOpts}{teams.map((tm) => <option key={tm.id} value={`team:${tm.id}`}>Equipo {tm.name}</option>)}</select></Field><Field label="Título"><input className="input sm" value={String(a.title ?? "")} onChange={(e) => upd(i, { title: e.target.value })} /></Field><Field label="Texto" full><input className="input sm" value={String(a.body ?? "")} onChange={(e) => upd(i, { body: e.target.value })} /></Field></>}
              {a.type === "send_email" && <><Field label="Para"><select className="input sm" value={String(a.to ?? "contact")} onChange={(e) => upd(i, { to: e.target.value })}><option value="contact">Contacto</option>{userOpts}</select></Field><Field label="Plantilla"><select className="input sm" value={String(a.template_id ?? "")} onChange={(e) => upd(i, { template_id: e.target.value || undefined })}><option value="">— escribir abajo —</option>{templates.map((tp) => <option key={tp.id} value={tp.id}>{tp.name}</option>)}</select></Field>{!a.template_id && <><Field label="Asunto"><input className="input sm" value={String(a.title ?? "")} onChange={(e) => upd(i, { title: e.target.value })} /></Field><Field label="Cuerpo" full><textarea className="input" value={String(a.body ?? "")} onChange={(e) => upd(i, { body: e.target.value })} /></Field></>}</>}
              {a.type === "update_field" && <><Field label="Campo" hint="ej. lead_status, lifecycle_stage, custom.clave"><input className="input sm" value={String(a.field ?? "")} onChange={(e) => upd(i, { field: e.target.value })} /></Field><Field label="Valor"><input className="input sm" value={String(a.value ?? "")} onChange={(e) => upd(i, { value: e.target.value })} /></Field></>}
              {a.type === "change_owner" && <><Field label="Modo"><select className="input sm" value={String(a.mode ?? "fixed")} onChange={(e) => upd(i, { mode: e.target.value })}><option value="fixed">Usuario fijo</option><option value="round_robin">Round-robin</option><option value="least_loaded">Menos leads abiertos</option></select></Field>{a.mode === "fixed" || !a.mode ? <Field label="Usuario"><select className="input sm" value={String(a.user_id ?? "")} onChange={(e) => upd(i, { user_id: e.target.value })}><option value="">—</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field> : <Field label="Dentro del equipo"><select className="input sm" value={String(a.team_id ?? "")} onChange={(e) => upd(i, { team_id: e.target.value || undefined })}><option value="">Todos los usuarios</option>{teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}</select></Field>}</>}
              {a.type === "change_stage" && <Field label="Etapa"><select className="input sm" value={String(a.stage_id ?? "")} onChange={(e) => upd(i, { stage_id: e.target.value })}><option value="">—</option>{pipelines.flatMap((p) => p.stages.filter((s) => s.kind === "open").map((s) => <option key={s.id} value={s.id}>{p.name} · {s.name}</option>))}</select></Field>}
              {a.type === "add_tag" && <Field label="Etiqueta"><input className="input sm" value={String(a.tag ?? "")} onChange={(e) => upd(i, { tag: e.target.value })} /></Field>}
              {a.type === "add_to_list" && <Field label="Lista"><select className="input sm" value={String(a.list_id ?? "")} onChange={(e) => upd(i, { list_id: e.target.value })}><option value="">—</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
              {a.type === "add_score" && <Field label="Puntos (negativo para restar)"><input className="input sm" type="number" value={Number(a.points ?? 10)} onChange={(e) => upd(i, { points: Number(e.target.value) })} /></Field>}
              {a.type === "create_deal" && <><Field label="Nombre del negocio"><input className="input sm" value={String(a.name ?? "Negocio {{name}}")} onChange={(e) => upd(i, { name: e.target.value })} /></Field><Field label="Pipeline"><select className="input sm" value={String(a.pipeline_id ?? "")} onChange={(e) => upd(i, { pipeline_id: e.target.value || undefined })}><option value="">Por defecto</option>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field></>}
              {a.type === "log_note" && <><Field label="Título"><input className="input sm" value={String(a.title ?? "")} onChange={(e) => upd(i, { title: e.target.value })} /></Field><Field label="Texto"><input className="input sm" value={String(a.body ?? "")} onChange={(e) => upd(i, { body: e.target.value })} /></Field></>}
              {a.type === "call_webhook" && <Field label="URL" full><input className="input sm" value={String(a.url ?? "")} onChange={(e) => upd(i, { url: e.target.value })} /></Field>}
              {a.type === "delay" && <><Field label="Días"><input className="input sm" type="number" value={Number(a.days ?? 0)} onChange={(e) => upd(i, { days: Number(e.target.value) })} /></Field><Field label="Minutos"><input className="input sm" type="number" value={Number(a.minutes ?? 0)} onChange={(e) => upd(i, { minutes: Number(e.target.value) })} /></Field></>}
            </div>
          </div>
        ))}
        <button className="btn sm" onClick={() => setActions((as) => [...as, { type: "create_task", title: "Seguimiento de {{name}}", due_in_days: 1, assignee: "owner" }])}><Plus />Añadir acción</button>
      </div>
      <div className="row wrap"><label className="checkbox"><input type="checkbox" checked={reenroll} onChange={(e) => setReenroll(e.target.checked)} />Permitir que un mismo registro se inscriba varias veces</label></div>
      <div className="card mt12" style={{ background: "var(--panel)" }}><h3 className="mb8"><FlaskConical size={14} /> Probar en modo simulación</h3><div className="row"><div className="grow"><Picker kind={condObject === "company" ? "company" : condObject === "deal" ? "deal" : "contact"} value={sim.record_id} onChange={(id) => setSim({ ...sim, record_id: id, result: null })} /></div><button className="btn" disabled={!sim.record_id} onClick={simulate}>Simular</button></div>{sim.result && <div className="mt8 small">{sim.result.found ? <>{sim.result.matches ? <span className="badge ok">Cumple las condiciones</span> : <span className="badge risk">No cumple las condiciones</span>} <strong>{String(sim.result.record_name)}</strong><ul style={{ margin: "6px 0 0 18px" }}>{(sim.result.actions as string[]).map((x, i) => <li key={i}>{x}</li>)}</ul></> : "Registro no encontrado"}</div>}</div>
    </Modal>
  );
}

type FormDef = { id: string; name: string; slug: string; fields: { key: string; label: string; type: string; required: boolean; options?: string[] }[]; settings: Any; active: number; submissions: number };
export function FormsAdmin() {
  const { users, teams, pipelines } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<FormDef[] | null>(null);
  const [editing, setEditing] = useState<Partial<FormDef> | null>(null);
  const [subs, setSubs] = useState<{ form: FormDef; items: { id: string; created_at: string; contact_id: string | null; contact_name: string | null; data: Any }[] } | null>(null);
  const [publicUrl, setPublicUrl] = useState(location.origin);
  const load = () => api.get<{ items: FormDef[] }>("forms").then((r) => setItems(r.items));
  useEffect(() => { load(); api.get<{ public_url: string }>("admin/settings").then((r) => setPublicUrl(r.public_url)); }, []);
  const s = (editing?.settings ?? {}) as Any;
  const setS = (k: string, v: unknown) => setEditing((e) => ({ ...e, settings: { ...(e?.settings ?? {}), [k]: v } }));
  const fields = editing?.fields ?? [];
  const setField = (i: number, p: Partial<FormDef["fields"][0]>) => setEditing((e) => ({ ...e, fields: (e?.fields ?? []).map((f, j) => (j === i ? { ...f, ...p } : f)) }));
  const save = async () => { if (!editing) return; try { if (editing.id) await api.put(`forms/${editing.id}`, { name: editing.name, fields: editing.fields, settings: editing.settings, active: !!editing.active }); else await api.post("forms", { name: editing.name, slug: editing.slug || undefined, fields: editing.fields, settings: editing.settings }); toast("Formulario guardado", "ok"); setEditing(null); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  const copy = (txt: string) => { navigator.clipboard.writeText(txt); toast("Copiado", "ok"); };
  if (!items) return <Spinner />;
  return (
    <div className="card tight">
      <div className="row between" style={{ padding: "12px 16px" }}><div><h2>Formularios web</h2><p className="small muted">Captura de leads con UTM, asignación automática, tarea de llamada y notificación. Página propia o embebido con un script.</p></div><button className="btn primary sm" onClick={() => setEditing({ name: "", slug: "", fields: [{ key: "name", label: "Nombre y apellidos", type: "text", required: true }, { key: "email", label: "Email", type: "email", required: true }, { key: "phone", label: "Teléfono", type: "phone", required: false }, { key: "company", label: "Empresa", type: "text", required: false }, { key: "message", label: "Mensaje", type: "textarea", required: false }], settings: { assignment: { mode: "round_robin" }, create_task: true, task_title: "Llamar al nuevo lead en 1 h", thank_you: "¡Gracias! Te contactaremos muy pronto.", consent_text: "Acepto recibir comunicaciones comerciales.", require_consent: false, tags: ["web"], source: "web", lifecycle_stage: "lead", notify_assignee: true, button_text: "Enviar", title: "", description: "" }, active: 1 })}><Plus />Nuevo formulario</button></div>
      <table className="table"><thead><tr><th>Nombre</th><th>URL pública</th><th className="r">Envíos</th><th>Asignación</th><th>Estado</th><th></th></tr></thead><tbody>
        {items.map((f) => <tr key={f.id}><td className="bold">{f.name}</td><td className="small"><a href={`/f/${f.slug}`} target="_blank" rel="noreferrer">{publicUrl}/f/{f.slug}</a> <button className="btn xs ghost" onClick={() => copy(`<script src="${publicUrl}/embed.js" data-form="${f.slug}"></script>`)}><Copy />embed</button></td><td className="r num">{f.submissions}</td><td className="small">{String((f.settings.assignment as Any)?.mode ?? "—")}</td><td>{f.active ? <span className="badge ok">activo</span> : <span className="badge">inactivo</span>}</td><td className="r row" style={{ justifyContent: "flex-end" }}><button className="btn xs" onClick={async () => setSubs({ form: f, items: (await api.get<{ items: NonNullable<typeof subs>["items"] }>(`forms/${f.id}/submissions`)).items })}>Envíos</button><button className="iconbtn" onClick={() => setEditing({ ...f })}><Pencil size={15} /></button><button className="iconbtn" onClick={async () => { if (await confirm({ title: `¿Borrar «${f.name}»?`, danger: true, confirmText: "Borrar" })) { await api.del(`forms/${f.id}`); load(); } }}><Trash2 size={15} /></button></td></tr>)}
      </tbody></table>
      {editing && <Modal title={editing.id ? "Editar formulario" : "Nuevo formulario"} size="xl" onClose={() => setEditing(null)} footer={<><button className="btn" onClick={() => setEditing(null)}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}>
        <div className="form-grid mb12"><Field label="Nombre interno"><input className="input" value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>{!editing.id && <Field label="Slug (URL)" hint="minúsculas y guiones; vacío = automático"><input className="input" value={editing.slug ?? ""} onChange={(e) => setEditing({ ...editing, slug: e.target.value })} /></Field>}<Field label="Título visible"><input className="input" value={String(s.title ?? "")} onChange={(e) => setS("title", e.target.value)} /></Field><Field label="Descripción visible"><input className="input" value={String(s.description ?? "")} onChange={(e) => setS("description", e.target.value)} /></Field></div>
        <h3 className="mb8">Campos</h3>
        {fields.map((f, i) => <div key={i} className="row mb8"><input className="input sm" style={{ width: 150 }} placeholder="clave" value={f.key} onChange={(e) => setField(i, { key: e.target.value })} /><input className="input sm grow" placeholder="Etiqueta" value={f.label} onChange={(e) => setField(i, { label: e.target.value })} /><select className="input sm" style={{ width: 130 }} value={f.type} onChange={(e) => setField(i, { type: e.target.value })}>{["text", "email", "phone", "textarea", "select", "checkbox", "hidden"].map((t) => <option key={t}>{t}</option>)}</select>{f.type === "select" && <input className="input sm" style={{ width: 180 }} placeholder="opciones, separadas por comas" value={(f.options ?? []).join(",")} onChange={(e) => setField(i, { options: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) })} />}<label className="checkbox small"><input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} />oblig.</label><button className="iconbtn" onClick={() => setEditing({ ...editing, fields: fields.filter((_, j) => j !== i) })}><Trash2 size={14} /></button></div>)}
        <p className="xs muted mb8">Claves reconocidas: name, first_name, last_name, email, phone, company, job_title, city, country, message. Usa <code>custom.clave</code> para campos personalizados.</p>
        <button className="btn sm mb12" onClick={() => setEditing({ ...editing, fields: [...fields, { key: "", label: "", type: "text", required: false }] })}><Plus />Campo</button>
        <h3 className="mb8">Qué pasa al recibir un envío</h3>
        <div className="form-grid">
          <Field label="Asignar a"><select className="input" value={String((s.assignment as Any)?.mode ?? "round_robin")} onChange={(e) => setS("assignment", { ...(s.assignment as Any), mode: e.target.value })}><option value="round_robin">Round-robin</option><option value="least_loaded">Menos leads abiertos</option><option value="fixed">Usuario fijo</option><option value="none">Sin asignar</option></select></Field>
          {(s.assignment as Any)?.mode === "fixed" ? <Field label="Usuario"><select className="input" value={String((s.assignment as Any)?.user_id ?? "")} onChange={(e) => setS("assignment", { ...(s.assignment as Any), user_id: e.target.value })}><option value="">—</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field> : <Field label="Dentro del equipo"><select className="input" value={String((s.assignment as Any)?.team_id ?? "")} onChange={(e) => setS("assignment", { ...(s.assignment as Any), team_id: e.target.value || null })}><option value="">Todos los usuarios</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}
          <Field label="Origen"><input className="input" value={String(s.source ?? "web")} onChange={(e) => setS("source", e.target.value)} /></Field>
          <Field label="Etiquetas"><TagInput value={(s.tags as string[]) ?? []} onChange={(v) => setS("tags", v)} /></Field>
          <label className="checkbox"><input type="checkbox" checked={s.create_task !== false} onChange={(e) => setS("create_task", e.target.checked)} />Crear tarea de llamada (1 h)</label>
          <Field label="Título de la tarea"><input className="input" value={String(s.task_title ?? "")} onChange={(e) => setS("task_title", e.target.value)} /></Field>
          <label className="checkbox"><input type="checkbox" checked={!!s.create_deal} onChange={(e) => setS("create_deal", e.target.checked)} />Crear negocio automáticamente</label>
          {!!s.create_deal && <Field label="Pipeline"><select className="input" value={String(s.pipeline_id ?? "")} onChange={(e) => setS("pipeline_id", e.target.value || null)}><option value="">Por defecto</option>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
          <label className="checkbox"><input type="checkbox" checked={s.notify_assignee !== false} onChange={(e) => setS("notify_assignee", e.target.checked)} />Notificar al asignado</label>
          <label className="checkbox"><input type="checkbox" checked={!!s.require_consent} onChange={(e) => setS("require_consent", e.target.checked)} />Consentimiento obligatorio</label>
          <Field label="Texto de consentimiento" full><input className="input" value={String(s.consent_text ?? "")} onChange={(e) => setS("consent_text", e.target.value)} /></Field>
          <Field label="Mensaje de gracias"><input className="input" value={String(s.thank_you ?? "")} onChange={(e) => setS("thank_you", e.target.value)} /></Field>
          <Field label="…o redirigir a URL"><input className="input" value={String(s.redirect_url ?? "")} onChange={(e) => setS("redirect_url", e.target.value || null)} /></Field>
          <Field label="Texto del botón"><input className="input" value={String(s.button_text ?? "Enviar")} onChange={(e) => setS("button_text", e.target.value)} /></Field>
          {editing.id && <label className="checkbox"><input type="checkbox" checked={!!editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked ? 1 : 0 })} />Formulario activo</label>}
        </div>
      </Modal>}
      {subs && <Modal title={`Envíos: ${subs.form.name}`} size="lg" onClose={() => setSubs(null)}>{subs.items.length === 0 ? <p className="muted">Sin envíos todavía.</p> : <table className="table"><thead><tr><th>Fecha</th><th>Contacto</th><th>Datos</th></tr></thead><tbody>{subs.items.map((x) => <tr key={x.id}><td className="small">{fmtDateTime(x.created_at)}</td><td>{x.contact_id ? <a href={`/contactos/${x.contact_id}`} target="_blank" rel="noreferrer">{x.contact_name}</a> : "—"}</td><td className="small muted">{Object.entries(x.data).map(([k, v]) => `${k}: ${v}`).join(" · ")}</td></tr>)}</tbody></table>}</Modal>}
    </div>
  );
}

export function TemplatesAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<{ id: string; name: string; folder: string | null; subject: string; body: string; created_by_name: string | null }[] | null>(null);
  const [editing, setEditing] = useState<Partial<NonNullable<typeof items>[0]> | null>(null);
  const load = () => api.get<{ items: NonNullable<typeof items> }>("email-templates").then((r) => setItems(r.items));
  useEffect(() => { load(); }, []);
  const save = async () => { if (!editing) return; try { if (editing.id) await api.put(`email-templates/${editing.id}`, editing); else await api.post("email-templates", editing); toast("Plantilla guardada", "ok"); setEditing(null); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  if (!items) return <Spinner />;
  return (
    <div className="card tight">
      <div className="row between" style={{ padding: "12px 16px" }}><div><h2>Plantillas de email</h2><p className="small muted">Variables: {"{{nombre}}, {{apellidos}}, {{empresa}}, {{cargo}}, {{propietario.nombre}}, {{propietario.firma}}"}</p></div><button className="btn primary sm" onClick={() => setEditing({ name: "", folder: "", subject: "", body: "" })}><Plus />Nueva plantilla</button></div>
      <table className="table"><thead><tr><th>Carpeta</th><th>Nombre</th><th>Asunto</th><th>Autor</th><th></th></tr></thead><tbody>{items.map((t) => <tr key={t.id}><td className="muted">{t.folder}</td><td className="bold">{t.name}</td><td className="small">{t.subject}</td><td className="small muted">{t.created_by_name}</td><td className="r row" style={{ justifyContent: "flex-end" }}><button className="iconbtn" onClick={() => setEditing({ ...t })}><Pencil size={15} /></button><button className="iconbtn" onClick={async () => { if (await confirm({ title: `¿Borrar «${t.name}»?`, danger: true, confirmText: "Borrar" })) { await api.del(`email-templates/${t.id}`); load(); } }}><Trash2 size={15} /></button></td></tr>)}{items.length === 0 && <tr><td colSpan={5} className="muted">Sin plantillas.</td></tr>}</tbody></table>
      {editing && <Modal title={editing.id ? "Editar plantilla" : "Nueva plantilla"} size="lg" onClose={() => setEditing(null)} footer={<><button className="btn" onClick={() => setEditing(null)}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}><div className="form-grid"><Field label="Nombre"><input className="input" value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field><Field label="Carpeta"><input className="input" value={editing.folder ?? ""} onChange={(e) => setEditing({ ...editing, folder: e.target.value })} /></Field><Field label="Asunto" full><input className="input" value={editing.subject ?? ""} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} /></Field><Field label="Cuerpo" full><textarea className="input" style={{ minHeight: 200 }} value={editing.body ?? ""} onChange={(e) => setEditing({ ...editing, body: e.target.value })} /></Field></div></Modal>}
    </div>
  );
}

export function ScoringAdmin() {
  const { settings } = useApp();
  const toast = useToast();
  const [items, setItems] = useState<{ id: string; label: string; field: string; op: string; value: string | null; points: number; active: number }[] | null>(null);
  const [f, setF] = useState({ label: "", field: "job_title", op: "contains", value: "", points: 10 });
  const load = () => api.get<{ items: NonNullable<typeof items> }>("admin/scoring-rules").then((r) => setItems(r.items));
  useEffect(() => { load(); }, []);
  const add = async () => { try { await api.post("admin/scoring-rules", { ...f, points: Number(f.points) }); setF({ ...f, label: "", value: "" }); load(); toast("Regla añadida", "ok"); } catch (e) { toast(errorMessage(e), "error"); } };
  if (!items) return <Spinner />;
  return (
    <div className="card">
      <h2>Lead scoring</h2><p className="small muted mb12">Puntos por reglas sobre el contacto (o <code>company.campo</code>). Además: +3 por interacción entrante (máx. 30), +2 por apertura de email (máx. 20), −10 por email gratuito, −1 por semana sin actividad. Umbrales actuales: MQL ≥ {settings.mql_threshold}, SQL ≥ {settings.sql_threshold} (Ajustes → General). La puntuación se recalcula al guardar el contacto y al registrar actividad.</p>
      <table className="table mb12"><thead><tr><th>Regla</th><th>Campo</th><th>Operador</th><th>Valor</th><th className="r">Puntos</th><th>Activa</th><th></th></tr></thead><tbody>{items.map((r) => <tr key={r.id}><td>{r.label}</td><td><code>{r.field}</code></td><td>{r.op}</td><td>{r.value}</td><td className="r num">{r.points > 0 ? `+${r.points}` : r.points}</td><td><input type="checkbox" checked={!!r.active} onChange={async (e) => { await api.put(`admin/scoring-rules/${r.id}`, { active: e.target.checked }); load(); }} /></td><td className="r"><button className="iconbtn" onClick={async () => { await api.del(`admin/scoring-rules/${r.id}`); load(); }}><Trash2 size={15} /></button></td></tr>)}</tbody></table>
      <div className="row wrap"><input className="input sm" style={{ width: 200 }} placeholder="Descripción" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /><input className="input sm" style={{ width: 150 }} placeholder="campo" value={f.field} onChange={(e) => setF({ ...f, field: e.target.value })} /><select className="input sm" style={{ width: "auto" }} value={f.op} onChange={(e) => setF({ ...f, op: e.target.value })}>{["eq", "neq", "contains", "gt", "gte", "lt", "lte", "empty", "not_empty", "is_true", "in"].map((o) => <option key={o}>{o}</option>)}</select><input className="input sm" style={{ width: 120 }} placeholder="valor" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} /><input className="input sm num" style={{ width: 80 }} type="number" value={f.points} onChange={(e) => setF({ ...f, points: Number(e.target.value) })} /><button className="btn sm primary" disabled={!f.label} onClick={add}><Plus />Añadir</button></div>
    </div>
  );
}
export { describeFilters };
