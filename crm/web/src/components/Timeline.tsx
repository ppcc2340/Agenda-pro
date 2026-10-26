import { useEffect, useState } from "react";
import { Mail, Phone, CalendarDays, StickyNote, CheckSquare, Zap, Pin, Trash2, MessageSquare, Eye } from "lucide-react";
import { api } from "../api";
import { fmtDateTime, relTime, ACTIVITY_TYPES } from "../lib/format";
import { useToast, useConfirm, Empty, errorMessage } from "./ui";
import { useApp } from "../lib/app";

export interface Activity { id: string; type: string; subject: string; body: string | null; occurred_at: string; duration_min: number | null; outcome: string | null; direction: string | null; user_id: string | null; user_name: string | null; pinned: number; meta: Record<string, unknown>; email_opens?: number | null; email_status?: string | null; contact_id?: string | null; deal_id?: string | null }
export type LinkTo = { contact_id?: string; company_id?: string; deal_id?: string; ticket_id?: string };

const ICON: Record<string, typeof Mail> = { email: Mail, call: Phone, meeting: CalendarDays, note: StickyNote, task: CheckSquare, system: Zap, sms: MessageSquare, whatsapp: MessageSquare, chat: MessageSquare };

export function Timeline({ link, refreshKey, onChanged }: { link: LinkTo; refreshKey?: number; onChanged?: () => void }) {
  const [items, setItems] = useState<Activity[] | null>(null);
  const [types, setTypes] = useState<string[]>([]);
  const toast = useToast();
  const confirm = useConfirm();
  const base = link.contact_id ? `contacts/${link.contact_id}` : link.company_id ? `companies/${link.company_id}` : link.deal_id ? `deals/${link.deal_id}` : `tickets/${link.ticket_id}`;
  const load = () => api.get<{ items: Activity[] }>(`${base}/timeline${types.length ? `?types=${types.join(",")}` : ""}`).then((r) => setItems(r.items)).catch((e) => toast(errorMessage(e), "error"));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [base, types.join(","), refreshKey]);
  const toggle = (t: string) => setTypes((x) => (x.includes(t) ? x.filter((y) => y !== t) : [...x, t]));
  const pin = async (a: Activity) => { await api.put(`activities/${a.id}`, { pinned: !a.pinned }); load(); };
  const del = async (a: Activity) => { if (!(await confirm({ title: "¿Borrar esta actividad?", danger: true, confirmText: "Borrar" }))) return; await api.del(`activities/${a.id}`); toast("Actividad borrada", "ok"); load(); onChanged?.(); };
  return (
    <div>
      <div className="row wrap mb12">
        {["note", "email", "call", "meeting", "task", "system"].map((t) => <button key={t} className={`chip ${types.includes(t) ? "active" : ""}`} onClick={() => toggle(t)}>{ACTIVITY_TYPES[t]}</button>)}
        {types.length > 0 && <button className="btn xs ghost" onClick={() => setTypes([])}>Quitar filtros</button>}
      </div>
      {!items ? <div className="skeleton" /> : items.length === 0 ? <Empty title="Sin actividad todavía" text="Registra una nota, llamada o email con el formulario de arriba." /> : (
        <div className="timeline">
          {items.map((a) => { const Icon = ICON[a.type] ?? Zap; return (
            <div key={a.id} className={`tl-item ${a.type} ${a.pinned ? "pinned" : ""}`}>
              <div className={`tl-icon ${a.type}`}><Icon /></div>
              <div className="tl-body">
                <div className="tl-head">
                  <strong className={a.type === "system" ? "" : ""}>{a.subject || ACTIVITY_TYPES[a.type]}</strong>
                  {a.direction && <span className="badge">{a.direction === "inbound" ? "entrante" : "saliente"}</span>}
                  {a.outcome && <span className="badge sea">{a.outcome}</span>}
                  {a.duration_min ? <span className="muted small">{a.duration_min} min</span> : null}
                  {a.type === "email" && a.email_opens != null && <span className={`badge ${a.email_opens > 0 ? "ok" : ""}`} title="Aperturas"><Eye size={11} />{a.email_opens}</span>}
                  {a.meta?.automated ? <span className="badge warn">automático</span> : null}
                  <span className="muted small right" title={fmtDateTime(a.occurred_at)}>{a.user_name ? `${a.user_name} · ` : ""}{relTime(a.occurred_at)}</span>
                  {a.type !== "system" && <span className="row"><button className="iconbtn" style={{ width: 24, height: 24 }} title={a.pinned ? "Desfijar" : "Fijar arriba"} onClick={() => pin(a)} aria-label={a.pinned ? "Desfijar" : "Fijar arriba"}><Pin size={13} /></button><button className="iconbtn" style={{ width: 24, height: 24 }} title="Borrar" onClick={() => del(a)} aria-label="Borrar"><Trash2 size={13} /></button></span>}
                </div>
                {a.body && <div className="tl-text">{a.body}</div>}
              </div>
            </div>
          ); })}
        </div>
      )}
    </div>
  );
}

/** Quick composer: note / call / email / meeting / task. */
export function Composer({ link, contactEmail, dealId, onDone, initial }: { link: LinkTo; contactEmail?: string | null; dealId?: string | null; onDone: () => void; initial?: string }) {
  const [tab, setTab] = useState<string>(initial ?? "note");
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");
  const [outcome, setOutcome] = useState("Contactado");
  const [duration, setDuration] = useState("");
  const [when, setWhen] = useState("");
  const [templates, setTemplates] = useState<{ id: string; name: string; subject: string; body: string; folder: string | null }[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const { me } = useApp();
  useEffect(() => { if (tab === "email" && !templates.length) api.get<{ items: typeof templates }>("email-templates").then((r) => setTemplates(r.items)).catch(() => undefined); }, [tab, templates.length]);
  const submit = async () => {
    setBusy(true);
    try {
      if (tab === "email") {
        if (!link.contact_id) throw new Error("El email solo se puede enviar desde un contacto");
        if (!subject.trim() || !body.trim()) throw new Error("Indica asunto y texto");
        await api.post("activities/send-email", { contact_id: link.contact_id, subject, body, deal_id: dealId ?? null });
        toast("Email enviado y registrado", "ok");
      } else if (tab === "task") {
        if (!subject.trim()) throw new Error("Indica el título de la tarea");
        await api.post("tasks", { title: subject, type: "followup", due_at: when ? new Date(when).toISOString() : new Date(Date.now() + 86400000).toISOString(), description: body || null, assignee_id: me.id, ...link, deal_id: dealId ?? link.deal_id ?? null });
        toast("Tarea creada", "ok");
      } else {
        if (!body.trim() && !subject.trim()) throw new Error("Escribe algo");
        await api.post("activities", { type: tab, subject: subject || ({ note: "Nota", call: "Llamada", meeting: "Reunión" } as Record<string, string>)[tab], body: body || null, outcome: tab === "call" ? outcome : null, duration_min: duration ? Number(duration) : null, direction: tab === "call" ? "outbound" : null, occurred_at: when ? new Date(when).toISOString() : undefined, ...link, deal_id: dealId ?? link.deal_id ?? null });
        toast("Registrado", "ok");
      }
      setBody(""); setSubject(""); setWhen(""); setDuration("");
      onDone();
    } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  };
  const applyTemplate = (id: string) => { const t = templates.find((x) => x.id === id); if (t) { setSubject(t.subject); setBody(t.body); } };
  return (
    <div className="composer">
      <div className="ctabs">
        {[["note", "Nota"], ["call", "Llamada"], ["email", "Email"], ["meeting", "Reunión"], ["task", "Tarea"]].map(([k, l]) => <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k!)}>{l}</button>)}
      </div>
      <div className="cbody">
        {tab === "email" && (
          <div className="row wrap">
            <span className="muted small">Para: {contactEmail ?? "(sin email)"}</span>
            {templates.length > 0 && <select className="input sm right" style={{ width: "auto" }} defaultValue="" onChange={(e) => applyTemplate(e.target.value)}><option value="">Plantilla…</option>{templates.map((t) => <option key={t.id} value={t.id}>{t.folder ? `${t.folder} / ` : ""}{t.name}</option>)}</select>}
          </div>
        )}
        {(tab === "email" || tab === "task" || tab === "meeting" || tab === "call") && <input className="input sm" placeholder={tab === "email" ? "Asunto" : tab === "task" ? "Título de la tarea" : tab === "meeting" ? "Título de la reunión" : "Motivo de la llamada"} value={subject} onChange={(e) => setSubject(e.target.value)} />}
        <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={tab === "note" ? "Escribe una nota… (puedes mencionar con @nombre)" : tab === "email" ? "Texto del email. Variables: {{nombre}}, {{empresa}}, {{propietario.nombre}}" : tab === "call" ? "Resumen de la llamada" : tab === "meeting" ? "Notas de la reunión" : "Descripción (opcional)"} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submit(); }} />
        <div className="row wrap">
          {tab === "call" && <><select className="input sm" style={{ width: "auto" }} value={outcome} onChange={(e) => setOutcome(e.target.value)}>{["Contactado", "Sin respuesta", "Buzón de voz", "Número erróneo", "Reunión agendada"].map((o) => <option key={o}>{o}</option>)}</select><input aria-label="min" className="input sm" style={{ width: 90 }} type="number" placeholder="min" value={duration} onChange={(e) => setDuration(e.target.value)} /></>}
          {tab === "meeting" && <input aria-label="min" className="input sm" style={{ width: 90 }} type="number" placeholder="min" value={duration} onChange={(e) => setDuration(e.target.value)} />}
          {(tab === "task" || tab === "meeting" || tab === "call") && <input className="input sm" style={{ width: "auto" }} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} title={tab === "task" ? "Vencimiento" : "Fecha"} />}
          <span className="right muted xs hide-mobile">Ctrl + Enter</span>
          <button className="btn primary sm" disabled={busy} onClick={submit}>{tab === "email" ? "Enviar email" : tab === "task" ? "Crear tarea" : "Registrar"}</button>
        </div>
      </div>
    </div>
  );
}
