/** Create/edit forms for contacts, companies and deals (shared by list pages and detail pages). */
import { useState } from "react";
import { api, ApiError } from "../api";
import { Modal, Field, Picker, TagInput, useToast, errorMessage } from "./ui";
import { CustomFieldsForm } from "./CustomFields";
import { useApp } from "../lib/app";
import { LIFECYCLE, LEAD_STATUS, SOURCES, COMPANY_TYPES, todayISO } from "../lib/format";

type Rec = Record<string, unknown>;
type Dup = { id: string; name: string; email: string | null; phone: string | null; reason: string };

export function ContactForm({ initial, onClose, onSaved }: { initial?: Rec | null; onClose: () => void; onSaved: (c: Rec) => void }) {
  const { users, me } = useApp();
  const toast = useToast();
  const edit = !!initial?.id;
  const [f, setF] = useState<Rec>({ first_name: "", last_name: "", email: "", phone: "", job_title: "", company_id: null, lifecycle_stage: "lead", lead_status: "new", source: "other", owner_id: me.id, tags: [], custom: {}, consent_marketing: false, city: "", country: "", linkedin: "", birthday: "", ...(initial ?? {}) });
  const [dups, setDups] = useState<Dup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const payload = () => ({ first_name: f.first_name, last_name: f.last_name, email: f.email || null, phone: f.phone || null, job_title: f.job_title || null, company_id: f.company_id ?? null, company_name: f.company_name || undefined, lifecycle_stage: f.lifecycle_stage, lead_status: f.lead_status, disqualify_reason: f.disqualify_reason || null, source: f.source, owner_id: f.owner_id || null, tags: f.tags, custom: f.custom, consent_marketing: !!f.consent_marketing, do_not_contact: !!f.do_not_contact, city: f.city || null, country: f.country || null, linkedin: f.linkedin || null, birthday: f.birthday || null, language: f.language || null });
  const save = async (force = false) => {
    setBusy(true);
    try {
      const c = edit ? await api.put<Rec>(`contacts/${initial!.id}`, payload()) : await api.post<Rec>(`contacts${force ? "?force=1" : ""}`, payload());
      toast(edit ? "Contacto actualizado" : "Contacto creado", "ok"); onClose(); onSaved(c);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.details as { duplicates?: Dup[] })?.duplicates) setDups((e.details as { duplicates: Dup[] }).duplicates);
      else toast(errorMessage(e), "error");
    } finally { setBusy(false); }
  };
  return (
    <Modal title={edit ? "Editar contacto" : "Nuevo contacto"} size="lg" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy} onClick={() => save()}>{edit ? "Guardar" : "Crear contacto"}</button></>}>
      {dups && (
        <div className="alert warn mb12">
          <strong>Puede que este contacto ya exista:</strong>
          <ul style={{ margin: "6px 0 8px 18px" }}>{dups.map((d) => <li key={d.id}><a href={`/contactos/${d.id}`} target="_blank" rel="noreferrer">{d.name}</a> · {d.email ?? d.phone} <span className="muted">({d.reason})</span></li>)}</ul>
          <div className="row"><button className="btn sm" onClick={() => save(true)}>Crear de todos modos</button><button className="btn sm ghost" onClick={onClose}>Cancelar</button></div>
        </div>
      )}
      <div className="form-grid">
        <Field label="Nombre *"><input className="input" autoFocus value={String(f.first_name ?? "")} onChange={(e) => set("first_name", e.target.value)} /></Field>
        <Field label="Apellidos"><input className="input" value={String(f.last_name ?? "")} onChange={(e) => set("last_name", e.target.value)} /></Field>
        <Field label="Email"><input className="input" type="email" value={String(f.email ?? "")} onChange={(e) => set("email", e.target.value)} /></Field>
        <Field label="Teléfono"><input className="input" type="tel" value={String(f.phone ?? "")} onChange={(e) => set("phone", e.target.value)} /></Field>
        <Field label="Cargo"><input className="input" value={String(f.job_title ?? "")} onChange={(e) => set("job_title", e.target.value)} /></Field>
        <Field label="Empresa" hint={!f.company_id ? "Si no existe, escribe el nombre en el campo de abajo" : undefined}><Picker kind="company" value={f.company_id as string | null} onChange={(id) => set("company_id", id)} /></Field>
        {!f.company_id && <Field label="…o nueva empresa"><input aria-label="Nombre de la empresa (se crea al guardar)" className="input" placeholder="Nombre de la empresa (se crea al guardar)" value={String(f.company_name ?? "")} onChange={(e) => set("company_name", e.target.value)} /></Field>}
        <Field label="Etapa del ciclo de vida"><select className="input" value={String(f.lifecycle_stage)} onChange={(e) => set("lifecycle_stage", e.target.value)}>{Object.entries(LIFECYCLE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Estado del lead"><select className="input" value={String(f.lead_status)} onChange={(e) => set("lead_status", e.target.value)}>{Object.entries(LEAD_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        {f.lead_status === "unqualified" && <Field label="Motivo de descalificación *"><input className="input" value={String(f.disqualify_reason ?? "")} onChange={(e) => set("disqualify_reason", e.target.value)} /></Field>}
        <Field label="Origen"><select className="input" value={String(f.source ?? "other")} onChange={(e) => set("source", e.target.value)}>{Object.entries(SOURCES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Propietario"><select className="input" value={String(f.owner_id ?? "")} onChange={(e) => set("owner_id", e.target.value || null)}><option value="">Sin asignar</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <Field label="Ciudad"><input className="input" value={String(f.city ?? "")} onChange={(e) => set("city", e.target.value)} /></Field>
        <Field label="País"><input className="input" value={String(f.country ?? "")} onChange={(e) => set("country", e.target.value)} /></Field>
        <Field label="LinkedIn"><input aria-label="https://linkedin.com/in/…" className="input" placeholder="https://linkedin.com/in/…" value={String(f.linkedin ?? "")} onChange={(e) => set("linkedin", e.target.value)} /></Field>
        <Field label="Cumpleaños"><input className="input" type="date" value={String(f.birthday ?? "").slice(0, 10)} onChange={(e) => set("birthday", e.target.value)} /></Field>
        <Field label="Etiquetas" full><TagInput value={(f.tags as string[]) ?? []} onChange={(v) => set("tags", v)} /></Field>
        <div className="full row wrap"><label className="checkbox"><input type="checkbox" checked={!!f.consent_marketing} onChange={(e) => set("consent_marketing", e.target.checked)} />Consentimiento de marketing (RGPD)</label><label className="checkbox"><input type="checkbox" checked={!!f.do_not_contact} onChange={(e) => set("do_not_contact", e.target.checked)} />No contactar</label></div>
        <CustomFieldsForm object="contact" value={(f.custom as Rec) ?? {}} onChange={(v) => set("custom", v)} record={f} />
      </div>
    </Modal>
  );
}

export function CompanyForm({ initial, onClose, onSaved }: { initial?: Rec | null; onClose: () => void; onSaved: (c: Rec) => void }) {
  const { users, me } = useApp();
  const toast = useToast();
  const edit = !!initial?.id;
  const [f, setF] = useState<Rec>({ name: "", domain: "", sector: "", size: "", revenue: "", tax_id: "", address: "", city: "", country: "", phone: "", website: "", parent_id: null, owner_id: me.id, type: "prospect", tags: [], custom: {}, ...(initial ?? {}) });
  const [dup, setDup] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const payload = () => ({ name: f.name, domain: f.domain || null, sector: f.sector || null, size: f.size === "" || f.size === null ? null : Number(f.size), revenue: f.revenue === "" || f.revenue === null ? null : Number(f.revenue), tax_id: f.tax_id || null, address: f.address || null, city: f.city || null, country: f.country || null, phone: f.phone || null, website: f.website || null, parent_id: f.parent_id ?? null, owner_id: f.owner_id || null, type: f.type, tags: f.tags, custom: f.custom });
  const save = async (force = false) => {
    setBusy(true);
    try { const c = edit ? await api.put<Rec>(`companies/${initial!.id}`, payload()) : await api.post<Rec>(`companies${force ? "?force=1" : ""}`, payload()); toast(edit ? "Empresa actualizada" : "Empresa creada", "ok"); onClose(); onSaved(c); }
    catch (e) { if (e instanceof ApiError && e.status === 409) setDup((e.details as { duplicate: { id: string; name: string } }).duplicate); else toast(errorMessage(e), "error"); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={edit ? "Editar empresa" : "Nueva empresa"} size="lg" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy} onClick={() => save()}>{edit ? "Guardar" : "Crear empresa"}</button></>}>
      {dup && <div className="alert warn mb12">Ya existe <a href={`/empresas/${dup.id}`} target="_blank" rel="noreferrer">{dup.name}</a> con ese nombre o dominio. <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => save(true)}>Crear de todos modos</button></div>}
      <div className="form-grid">
        <Field label="Nombre *"><input className="input" autoFocus value={String(f.name ?? "")} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="Dominio web"><input aria-label="empresa.com" className="input" placeholder="empresa.com" value={String(f.domain ?? "")} onChange={(e) => set("domain", e.target.value)} /></Field>
        <Field label="Sector"><input className="input" value={String(f.sector ?? "")} onChange={(e) => set("sector", e.target.value)} /></Field>
        <Field label="Tipo"><select className="input" value={String(f.type)} onChange={(e) => set("type", e.target.value)}>{Object.entries(COMPANY_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Empleados"><input className="input" type="number" value={String(f.size ?? "")} onChange={(e) => set("size", e.target.value)} /></Field>
        <Field label="Facturación anual"><input className="input" type="number" value={String(f.revenue ?? "")} onChange={(e) => set("revenue", e.target.value)} /></Field>
        <Field label="CIF / NIF"><input className="input" value={String(f.tax_id ?? "")} onChange={(e) => set("tax_id", e.target.value)} /></Field>
        <Field label="Teléfono"><input className="input" value={String(f.phone ?? "")} onChange={(e) => set("phone", e.target.value)} /></Field>
        <Field label="Dirección" full><input className="input" value={String(f.address ?? "")} onChange={(e) => set("address", e.target.value)} /></Field>
        <Field label="Ciudad"><input className="input" value={String(f.city ?? "")} onChange={(e) => set("city", e.target.value)} /></Field>
        <Field label="País"><input className="input" value={String(f.country ?? "")} onChange={(e) => set("country", e.target.value)} /></Field>
        <Field label="Empresa matriz"><Picker kind="company" value={f.parent_id as string | null} onChange={(id) => set("parent_id", id)} /></Field>
        <Field label="Propietario"><select className="input" value={String(f.owner_id ?? "")} onChange={(e) => set("owner_id", e.target.value || null)}><option value="">Sin asignar</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <Field label="Etiquetas" full><TagInput value={(f.tags as string[]) ?? []} onChange={(v) => set("tags", v)} /></Field>
        <CustomFieldsForm object="company" value={(f.custom as Rec) ?? {}} onChange={(v) => set("custom", v)} record={f} />
      </div>
    </Modal>
  );
}

export function DealForm({ initial, defaults, onClose, onSaved }: { initial?: Rec | null; defaults?: Rec; onClose: () => void; onSaved: (d: Rec) => void }) {
  const { users, me, pipelines, settings } = useApp();
  const toast = useToast();
  const edit = !!initial?.id;
  const defPipe = pipelines.find((p) => p.is_default) ?? pipelines[0];
  const [f, setF] = useState<Rec>({ name: "", company_id: null, pipeline_id: defPipe?.id, stage_id: defPipe?.stages.find((s) => s.kind === "open")?.id, amount: "", currency: settings.currency, expected_close_date: "", owner_id: me.id, source: "", tags: [], custom: {}, contact_ids: [], ...(defaults ?? {}), ...(initial ?? {}) });
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const pipe = pipelines.find((p) => p.id === f.pipeline_id);
  const save = async () => {
    setBusy(true);
    try {
      const payload: Rec = { name: f.name, company_id: f.company_id ?? null, amount: f.amount === "" ? 0 : Number(f.amount), currency: f.currency, expected_close_date: f.expected_close_date || null, owner_id: f.owner_id || null, source: f.source || null, tags: f.tags, custom: f.custom };
      if (!edit) { payload.pipeline_id = f.pipeline_id; payload.stage_id = f.stage_id; payload.contact_ids = f.contact_ids; }
      if (edit && (initial!.products as unknown[])?.length) delete payload.amount;
      const d = edit ? await api.put<Rec>(`deals/${initial!.id}`, payload) : await api.post<Rec>("deals", payload);
      toast(edit ? "Negocio actualizado" : "Negocio creado", "ok"); onClose(); onSaved(d);
    } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  };
  return (
    <Modal title={edit ? "Editar negocio" : "Nuevo negocio"} size="lg" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy} onClick={save}>{edit ? "Guardar" : "Crear negocio"}</button></>}>
      <div className="form-grid">
        <Field label="Nombre *" full><input aria-label="Ej. Implantación CRM · Empresa" className="input" autoFocus placeholder="Ej. Implantación CRM · Empresa" value={String(f.name ?? "")} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="Empresa"><Picker kind="company" value={f.company_id as string | null} onChange={(id) => set("company_id", id)} /></Field>
        {!edit && <Field label="Contacto principal"><Picker kind="contact" value={((f.contact_ids as string[]) ?? [])[0] ?? null} onChange={(id) => set("contact_ids", id ? [id] : [])} /></Field>}
        {!edit && <Field label="Pipeline"><select className="input" value={String(f.pipeline_id ?? "")} onChange={(e) => { const p = pipelines.find((x) => x.id === e.target.value); set("pipeline_id", e.target.value); set("stage_id", p?.stages.find((s) => s.kind === "open")?.id); }}>{pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
        {!edit && <Field label="Etapa"><select className="input" value={String(f.stage_id ?? "")} onChange={(e) => set("stage_id", e.target.value)}>{pipe?.stages.filter((s) => s.kind === "open").map((s) => <option key={s.id} value={s.id}>{s.name} ({s.probability}%)</option>)}</select></Field>}
        <Field label={`Importe (${settings.currency})`} hint={edit && (initial!.products as unknown[])?.length ? "Se calcula a partir de las líneas de producto" : undefined}><input className="input" type="number" min={0} disabled={edit && !!(initial!.products as unknown[])?.length} value={String(f.amount ?? "")} onChange={(e) => set("amount", e.target.value)} /></Field>
        <Field label="Cierre previsto"><input className="input" type="date" min={todayISO()} value={String(f.expected_close_date ?? "").slice(0, 10)} onChange={(e) => set("expected_close_date", e.target.value)} /></Field>
        <Field label="Propietario"><select className="input" value={String(f.owner_id ?? "")} onChange={(e) => set("owner_id", e.target.value || null)}><option value="">Sin asignar</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <Field label="Origen"><select className="input" value={String(f.source ?? "")} onChange={(e) => set("source", e.target.value)}><option value="">—</option>{Object.entries(SOURCES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Etiquetas" full><TagInput value={(f.tags as string[]) ?? []} onChange={(v) => set("tags", v)} /></Field>
        <CustomFieldsForm object="deal" value={(f.custom as Rec) ?? {}} onChange={(v) => set("custom", v)} record={f} />
      </div>
    </Modal>
  );
}
