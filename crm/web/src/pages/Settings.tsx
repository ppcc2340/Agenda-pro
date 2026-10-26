import { useEffect, useState } from "react";
import { NavLink, Routes, Route, Navigate } from "react-router-dom";
import { Plus, Trash2, Pencil, KeyRound, ShieldCheck } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { api } from "../api";
import { useApp, type Pipeline, type Stage, type CustomField } from "../lib/app";
import { Modal, Field, useToast, useConfirm, errorMessage, TagInput, Spinner } from "../components/ui";
import { FormsAdmin, TemplatesAdmin, ScoringAdmin } from "./SettingsAutomation";
import { AutomationCenter } from "./AutomationCenter";
import { CustomFieldsAdmin, LabelSetsAdmin, BoardRulesAdmin } from "./SettingsColumns";
import { ApiKeysAdmin, WebhooksAdmin, OutboxAdmin, AuditAdmin, UsageAdmin, RecycleBin, QualityGdpr, ImportPage } from "./SettingsIntegrations";
import { fmtDateTime } from "../lib/format";
import { ObjectsAdmin } from "./CustomObjects";

export function SettingsPage() {
  const { isAdmin } = useApp();
  const S = ({ to, label }: { to: string; label: string }) => <NavLink to={`/ajustes/${to}`} className={({ isActive }) => (isActive ? "active" : "")}>{label}</NavLink>;
  return (
    <div className="settings">
      <nav className="settings-nav">
        <div className="section">Mi cuenta</div><S to="perfil" label="Perfil y seguridad" />
        {isAdmin && <><div className="section">Empresa</div><S to="general" label="General" /><S to="usuarios" label="Usuarios" /><S to="roles" label="Roles y permisos" /><S to="equipos" label="Equipos" />
          <div className="section">Datos</div><S to="objetos" label="Objetos personalizados" /><S to="pipelines" label="Pipelines y etapas" /><S to="campos" label="Columnas personalizadas" /><S to="etiquetas" label="Etiquetas compartidas" /><S to="reglas-tablero" label="Por defecto y obligatorias" /><S to="productos" label="Productos" /><S to="importar" label="Importar CSV" /><S to="papelera" label="Papelera" /><S to="calidad" label="Calidad y RGPD" />
          <div className="section">Automatización</div><S to="automatizaciones" label="Centro de automatizaciones" /><S to="formularios" label="Formularios web" /><S to="plantillas" label="Plantillas de email" /><S to="scoring" label="Lead scoring" />
          <div className="section">Plataforma</div><S to="api" label="API keys" /><S to="webhooks" label="Webhooks" /><S to="emails" label="Emails enviados" /><S to="auditoria" label="Auditoría" /><S to="uso" label="Uso del sistema" /></>}
        {!isAdmin && <><div className="section">Automatización</div><S to="automatizaciones" label="Mis aprobaciones" /><div className="section">Datos</div><S to="importar" label="Importar CSV" /><S to="plantillas" label="Plantillas de email" /></>}
      </nav>
      <div>
        <Routes>
          <Route index element={<Navigate to="perfil" replace />} />
          <Route path="perfil" element={<Profile />} />
          <Route path="general" element={<General />} />
          <Route path="usuarios" element={<UsersAdmin />} />
          <Route path="roles" element={<RolesAdmin />} />
          <Route path="equipos" element={<TeamsAdmin />} />
          <Route path="objetos" element={<ObjectsAdmin />} />
          <Route path="pipelines" element={<PipelinesAdmin />} />
          <Route path="campos" element={<CustomFieldsAdmin />} />
          <Route path="productos" element={<Navigate to="/productos" replace />} />
          <Route path="importar" element={<ImportPage />} />
          <Route path="papelera" element={<RecycleBin />} />
          <Route path="calidad" element={<QualityGdpr />} />
          <Route path="workflows" element={<Navigate to="/ajustes/automatizaciones" replace />} />
          <Route path="automatizaciones" element={<AutomationCenter />} />
          <Route path="etiquetas" element={<LabelSetsAdmin />} />
          <Route path="reglas-tablero" element={<BoardRulesAdmin />} />
          <Route path="formularios" element={<FormsAdmin />} />
          <Route path="plantillas" element={<TemplatesAdmin />} />
          <Route path="scoring" element={<ScoringAdmin />} />
          <Route path="api" element={<ApiKeysAdmin />} />
          <Route path="webhooks" element={<WebhooksAdmin />} />
          <Route path="emails" element={<OutboxAdmin />} />
          <Route path="auditoria" element={<AuditAdmin />} />
          <Route path="uso" element={<UsageAdmin />} />
          <Route path="*" element={<Navigate to="perfil" replace />} />
        </Routes>
      </div>
    </div>
  );
}

function Profile() {
  const { me, refresh } = useApp();
  const toast = useToast();
  const [name, setName] = useState(me.name);
  const [sig, setSig] = useState(me.email_signature ?? "");
  const [emailAll, setEmailAll] = useState(!!me.notification_prefs?.email_all);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [totp, setTotp] = useState<{ secret: string; otpauth: string } | null>(null);
  const [code, setCode] = useState("");
  const [enabled, setEnabled] = useState(me.totp_enabled);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [sessions, setSessions] = useState<{ id: string; created_at: string; ip: string | null; user_agent: string | null }[]>([]);
  useEffect(() => { api.get<{ items: typeof sessions }>("auth/sessions").then((r) => setSessions(r.items)); }, []);
  const save = async () => { try { await api.put("auth/me", { name, email_signature: sig, notification_prefs: { email_all: emailAll } }); toast("Perfil guardado", "ok"); refresh(); } catch (e) { toast(errorMessage(e), "error"); } };
  const changePw = async () => { try { await api.post("auth/password", pw); toast("Contraseña cambiada", "ok"); setPw({ current: "", next: "" }); } catch (e) { toast(errorMessage(e), "error"); } };
  const setup2fa = async () => setTotp(await api.post<{ secret: string; otpauth: string }>("auth/2fa/setup"));
  const enable2fa = async () => { try { const r = await api.post<{ recovery_codes?: string[] }>("auth/2fa/enable", { code }); toast("Verificación en dos pasos activada", "ok"); setEnabled(true); setTotp(null); setCodes(r.recovery_codes ?? null); } catch (e) { toast(errorMessage(e), "error"); } };
  const newCodes = async () => { const p = prompt("Confirma tu contraseña para generar códigos nuevos (los anteriores dejarán de valer)"); if (!p) return; try { setCodes((await api.post<{ recovery_codes: string[] }>("auth/2fa/recovery-codes", { password: p })).recovery_codes); } catch (e) { toast(errorMessage(e), "error"); } };
  const disable2fa = async () => { const p = prompt("Confirma tu contraseña para desactivar 2FA"); if (!p) return; try { await api.post("auth/2fa/disable", { password: p }); toast("2FA desactivada", "ok"); setEnabled(false); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card"><h2 className="mb12">Mi perfil</h2><div className="form-grid"><Field label="Nombre"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field><Field label="Email"><input className="input" value={me.email} disabled /></Field><Field label="Firma de email" full hint="Se inserta con {{propietario.firma}} en plantillas"><textarea className="input" value={sig} onChange={(e) => setSig(e.target.value)} /></Field><label className="checkbox full"><input type="checkbox" checked={emailAll} onChange={(e) => setEmailAll(e.target.checked)} />Recibir también las notificaciones por email</label></div><button className="btn primary mt12" onClick={save}>Guardar</button></div>
      <div className="card"><h2 className="mb12"><KeyRound size={16} /> Contraseña</h2><div className="form-grid"><Field label="Actual"><input className="input" type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field><Field label="Nueva" hint="Mínimo 12 caracteres con letras y números; no uses tu email"><input className="input" type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field></div><button className="btn mt12" onClick={changePw}>Cambiar contraseña</button></div>
      <div className="card"><h2 className="mb12"><ShieldCheck size={16} /> Verificación en dos pasos (TOTP)</h2>
        {codes && <div className="alert ok mb12" role="status"><b>Códigos de recuperación</b> (cada uno sirve una vez; guárdalos, no se volverán a mostrar):<pre style={{ columns: 2, margin: "8px 0 0" }}>{codes.join("\n")}</pre></div>}
        {enabled ? <div className="row"><span className="badge ok">Activada</span><span className="small muted">{(me as unknown as { recovery_codes_left?: number }).recovery_codes_left ?? 0} códigos de recuperación sin usar</span><button className="btn sm" onClick={newCodes}>Nuevos códigos</button><button className="btn sm" onClick={disable2fa}>Desactivar</button></div> : totp ? <div className="row wrap" style={{ gap: 20 }}><QRCodeSVG value={totp.otpauth} size={160} /><div className="col"><p className="small">Escanea el código con Google Authenticator, Authy o 1Password. Clave manual: <code>{totp.secret}</code></p><div className="row"><input aria-label="Código" className="input" style={{ width: 140 }} placeholder="Código" value={code} onChange={(e) => setCode(e.target.value)} /><button className="btn primary" onClick={enable2fa}>Activar</button></div></div></div> : <div className="row"><span className="badge">Desactivada</span><button className="btn sm" onClick={setup2fa}>Configurar</button></div>}
      </div>
      <div className="card"><h2 className="mb12">Sesiones activas</h2>{sessions.map((s) => <div key={s.id} className="row small" style={{ padding: "6px 0", borderBottom: "1px solid var(--rule2)" }}><span className="grow">{fmtDateTime(s.created_at)} · {s.ip} · <span className="muted">{s.user_agent?.slice(0, 60)}</span></span><button className="btn xs ghost" onClick={async () => { await api.del(`auth/sessions/${s.id}`); setSessions((x) => x.filter((y) => y.id !== s.id)); }}>Cerrar</button></div>)}<button className="btn sm danger mt12" onClick={async () => { await api.del("auth/sessions"); location.reload(); }}>Cerrar todas las sesiones</button></div>
    </div>
  );
}

function General() {
  const { settings, refresh, pipelines } = useApp();
  const toast = useToast();
  const [s, setS] = useState({ ...settings });
  const [emailMode, setEmailMode] = useState("fake");
  useEffect(() => { api.get<{ email_mode: string }>("admin/settings").then((r) => setEmailMode(r.email_mode)); }, []);
  const set = (k: string, v: unknown) => setS((x) => ({ ...x, [k]: v }));
  const save = async () => { try { await api.put("admin/settings", s); toast("Ajustes guardados", "ok"); refresh(); } catch (e) { toast(errorMessage(e), "error"); } };
  const stages = pipelines.flatMap((p) => p.stages.filter((st) => st.kind === "open").map((st) => ({ id: st.id, label: `${p.name} · ${st.name}` })));
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card"><h2 className="mb12">Datos de la empresa</h2><div className="form-grid">
        <Field label="Nombre"><input className="input" value={s.company_name} onChange={(e) => set("company_name", e.target.value)} /></Field>
        <Field label="Moneda (ISO)"><input className="input" value={s.currency} maxLength={3} onChange={(e) => set("currency", e.target.value.toUpperCase())} /></Field>
        <Field label="Zona horaria"><input className="input" value={s.timezone} onChange={(e) => set("timezone", e.target.value)} /></Field>
        <Field label="Prefijo telefónico por defecto"><input className="input" value={s.default_country_code} onChange={(e) => set("default_country_code", e.target.value)} /></Field>
        <Field label="Inicio del año fiscal (mes)"><input className="input" type="number" min={1} max={12} value={s.fiscal_year_start} onChange={(e) => set("fiscal_year_start", Number(e.target.value))} /></Field>
        <Field label="Color de marca"><input className="input" type="color" value={s.brand_color} onChange={(e) => set("brand_color", e.target.value)} /></Field>
        <Field label="URL del logo (presupuestos)" full><input className="input" value={s.logo_url} onChange={(e) => set("logo_url", e.target.value)} /></Field>
        <Field label="Dominios internos" full hint="No se crean contactos con emails de estos dominios (compañeros)"><TagInput value={s.internal_domains} onChange={(v) => set("internal_domains", v)} placeholder="tuempresa.com" /></Field>
      </div></div>
      <div className="card"><h2 className="mb12">Reglas comerciales</h2><div className="form-grid">
        <Field label="Negocio inactivo tras (días sin actividad)"><input className="input" type="number" value={s.inactive_deal_days} onChange={(e) => set("inactive_deal_days", Number(e.target.value))} /></Field>
        <Field label="SLA de primer contacto a leads (horas)"><input className="input" type="number" value={s.lead_sla_hours} onChange={(e) => set("lead_sla_hours", Number(e.target.value))} /></Field>
        <Field label="Umbral MQL (puntos)"><input className="input" type="number" value={s.mql_threshold} onChange={(e) => set("mql_threshold", Number(e.target.value))} /></Field>
        <Field label="Umbral SQL (puntos)"><input className="input" type="number" value={s.sql_threshold} onChange={(e) => set("sql_threshold", Number(e.target.value))} /></Field>
        <Field label="Prefijo de presupuestos"><input className="input" value={s.quote_prefix} onChange={(e) => set("quote_prefix", e.target.value)} /></Field>
        <Field label="Al aceptar un presupuesto, mover el negocio a"><select className="input" value={s.quote_accept_stage_id ?? ""} onChange={(e) => set("quote_accept_stage_id", e.target.value || null)}><option value="">No mover</option>{stages.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></Field>
      </div></div>
      <div className="card"><h2 className="mb12">SLA de tickets (horas hasta primera respuesta)</h2><div className="form-grid">{["low", "normal", "high", "urgent"].map((p) => <Field key={p} label={({ low: "Baja", normal: "Normal", high: "Alta", urgent: "Urgente" } as Record<string, string>)[p]}><input className="input" type="number" value={s.ticket_sla_hours[p] ?? 24} onChange={(e) => set("ticket_sla_hours", { ...s.ticket_sla_hours, [p]: Number(e.target.value) })} /></Field>)}</div></div>
      <div className="card"><h2 className="mb12">Retención de datos (RGPD)</h2><label className="checkbox"><input type="checkbox" checked={s.retention_enabled} onChange={(e) => set("retention_enabled", e.target.checked)} />Anonimizar automáticamente contactos no cliente sin actividad</label><div className="form-grid mt12"><Field label="Tras (meses)"><input className="input" type="number" value={s.retention_months} onChange={(e) => set("retention_months", Number(e.target.value))} /></Field></div><p className="small muted mt8">Nunca se anonimizan clientes ni contactos con negocios abiertos. Papelera de reciclaje: 30 días.</p></div>
      <div className="card"><h2 className="mb8">Email saliente</h2><p className="small sub">Modo actual: <span className={`badge ${emailMode === "smtp" ? "ok" : "warn"}`}>{emailMode === "smtp" ? "SMTP (envío real)" : "fake (solo se registra)"}</span>. Se configura con las variables de entorno <code>EMAIL_MODE</code>, <code>SMTP_HOST</code>, <code>SMTP_PORT</code>, <code>SMTP_USER</code>, <code>SMTP_PASS</code>, <code>SMTP_FROM</code> (ver <code>.env.example</code>). La sincronización de buzones (Gmail / Microsoft 365) se integra como adaptador externo; mientras tanto, registra los emails desde la ficha.</p></div>
      <div><button className="btn primary" onClick={save}>Guardar ajustes</button></div>
    </div>
  );
}

type U = { id: string; name: string; email: string; role_id: string; role: { name: string } | null; team_id: string | null; team: { name: string } | null; active: boolean; quota: number | null; totp_enabled: boolean; last_login_at: string | null };
function UsersAdmin() {
  const { refresh, teams, me } = useApp();
  const toast = useToast();
  const [items, setItems] = useState<U[]>([]);
  const [roles, setRoles] = useState<{ id: string; name: string; key: string }[]>([]);
  const [editing, setEditing] = useState<U | "new" | null>(null);
  const [f, setF] = useState<Record<string, unknown>>({});
  const load = () => { api.get<{ items: U[] }>("admin/users").then((r) => setItems(r.items)); api.get<{ items: typeof roles }>("admin/roles").then((r) => setRoles(r.items)); };
  useEffect(load, []);
  const open = (u: U | "new") => { setEditing(u); setF(u === "new" ? { name: "", email: "", password: "", role_id: roles.find((r) => r.key === "sales")?.id ?? roles[0]?.id, team_id: null, quota: "" } : { name: u.name, role_id: u.role_id, team_id: u.team_id, quota: u.quota ?? "", active: u.active, password: "" }); };
  const save = async () => { try { const payload = { ...f, quota: f.quota === "" ? null : Number(f.quota), password: f.password || undefined }; if (editing === "new") await api.post("admin/users", payload); else await api.put(`admin/users/${(editing as U).id}`, payload); toast("Usuario guardado", "ok"); setEditing(null); load(); refresh(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <div className="card tight">
      <div className="row between" style={{ padding: "12px 16px" }}><h2>Usuarios</h2><button className="btn primary sm" onClick={() => open("new")}><Plus />Nuevo usuario</button></div>
      <table className="table"><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Equipo</th><th className="r">Cuota</th><th>2FA</th><th>Último acceso</th><th>Estado</th><th></th></tr></thead><tbody>
        {items.map((u) => <tr key={u.id}><td className="bold">{u.name}</td><td>{u.email}</td><td>{u.role?.name}</td><td>{u.team?.name ?? "—"}</td><td className="r num">{u.quota ?? "—"}</td><td>{u.totp_enabled ? <span className="badge ok">sí</span> : <span className="badge">no</span>}</td><td className="small muted">{u.last_login_at ? fmtDateTime(u.last_login_at) : "nunca"}</td><td>{u.active ? <span className="badge ok">activo</span> : <span className="badge risk">desactivado</span>}</td><td className="r"><button className="iconbtn" onClick={() => open(u)} aria-label="Editar"><Pencil size={15} /></button></td></tr>)}
      </tbody></table>
      {editing && <Modal title={editing === "new" ? "Nuevo usuario" : `Editar ${(editing as U).name}`} onClose={() => setEditing(null)} footer={<><button className="btn" onClick={() => setEditing(null)}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}>
        <div className="form-grid">
          <Field label="Nombre"><input className="input" value={String(f.name ?? "")} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          {editing === "new" && <Field label="Email"><input className="input" type="email" value={String(f.email ?? "")} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>}
          <Field label={editing === "new" ? "Contraseña" : "Nueva contraseña (opcional)"} hint="Mínimo 10 caracteres"><input className="input" type="password" value={String(f.password ?? "")} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          <Field label="Rol"><select className="input" value={String(f.role_id ?? "")} onChange={(e) => setF({ ...f, role_id: e.target.value })}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
          <Field label="Equipo"><select className="input" value={String(f.team_id ?? "")} onChange={(e) => setF({ ...f, team_id: e.target.value || null })}><option value="">Sin equipo</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          <Field label="Cuota mensual (€)"><input className="input" type="number" value={String(f.quota ?? "")} onChange={(e) => setF({ ...f, quota: e.target.value })} /></Field>
          {editing !== "new" && (editing as U).id !== me.id && <label className="checkbox full"><input type="checkbox" checked={f.active !== false} onChange={(e) => setF({ ...f, active: e.target.checked })} />Usuario activo (desactivar cierra sus sesiones)</label>}
        </div>
      </Modal>}
    </div>
  );
}

type R = { id: string; name: string; key: string; permissions: Record<string, string[] | boolean | undefined>; visibility: string; is_system: number; users_count: number };
function RolesAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<{ items: R[]; objects: string[]; object_labels?: Record<string, string>; actions: string[] } | null>(null);
  const [editing, setEditing] = useState<R | "new" | null>(null);
  const [f, setF] = useState<{ name: string; key: string; visibility: string; permissions: Record<string, string[] | boolean | undefined> }>({ name: "", key: "", visibility: "own", permissions: {} });
  const load = () => api.get<typeof data>("admin/roles").then(setData);
  useEffect(() => { load(); }, []);
  const OBJ: Record<string, string> = { contact: "Contactos", company: "Empresas", deal: "Negocios", task: "Tareas", activity: "Actividades", ticket: "Tickets", product: "Productos", quote: "Presupuestos", list: "Listas", report: "Informes", contract: "Contratos", ...(data?.object_labels ?? {}) };
  const ACT: Record<string, string> = { create: "Crear", read: "Ver", update: "Editar", delete: "Borrar", export: "Exportar" };
  const open = (r: R | "new") => { setEditing(r); setF(r === "new" ? { name: "", key: "", visibility: "own", permissions: Object.fromEntries((data?.objects ?? []).map((o) => [o, ["read"]])) } : { name: r.name, key: r.key, visibility: r.visibility, permissions: { ...r.permissions } }); };
  const toggle = (o: string, a: string) => setF((x) => { const cur = Array.isArray(x.permissions[o]) ? (x.permissions[o] as string[]) : []; return { ...x, permissions: { ...x.permissions, [o]: cur.includes(a) ? cur.filter((y) => y !== a) : [...cur, a] } }; });
  const save = async () => { try { if (editing === "new") await api.post("admin/roles", f); else await api.put(`admin/roles/${(editing as R).id}`, { name: f.name, visibility: f.visibility, permissions: f.permissions }); toast("Rol guardado", "ok"); setEditing(null); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  const del = async (r: R) => { if (!(await confirm({ title: `¿Borrar el rol ${r.name}?`, danger: true, confirmText: "Borrar" }))) return; try { await api.del(`admin/roles/${r.id}`); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  if (!data) return <Spinner />;
  return (
    <div className="card tight">
      <div className="row between" style={{ padding: "12px 16px" }}><div><h2>Roles y permisos</h2><p className="small muted">Visibilidad: «solo míos» ve sus registros, «mi equipo» los de su equipo (el manager ve a su equipo), «todos» ve todo.</p></div><button className="btn primary sm" onClick={() => open("new")}><Plus />Nuevo rol</button></div>
      <table className="table"><thead><tr><th>Rol</th><th>Visibilidad</th><th>Permisos</th><th className="r">Usuarios</th><th></th></tr></thead><tbody>
        {data.items.map((r) => <tr key={r.id}><td className="bold">{r.name} {r.is_system ? <span className="badge">sistema</span> : null}</td><td>{({ own: "Solo míos", team: "Mi equipo", all: "Todos" } as Record<string, string>)[r.visibility]}</td><td className="small muted">{r.permissions.admin ? "Administración total" : data.objects.filter((o) => Array.isArray(r.permissions[o]) && (r.permissions[o] as string[]).length).map((o) => `${OBJ[o]}: ${(r.permissions[o] as string[]).map((a) => ACT[a]?.toLowerCase()).join("/")}`).join(" · ")}</td><td className="r num">{r.users_count}</td><td className="r row" style={{ justifyContent: "flex-end" }}><button className="iconbtn" onClick={() => open(r)} aria-label="Editar"><Pencil size={15} /></button>{!r.is_system && <button className="iconbtn" onClick={() => del(r)} aria-label="Borrar"><Trash2 size={15} /></button>}</td></tr>)}
      </tbody></table>
      <MfaRoles roles={data.items} />
      {editing && <Modal title={editing === "new" ? "Nuevo rol" : `Rol: ${f.name}`} size="lg" onClose={() => setEditing(null)} footer={<><button className="btn" onClick={() => setEditing(null)}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}>
        <div className="form-grid mb12"><Field label="Nombre"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>{editing === "new" && <Field label="Clave" hint="minúsculas, sin espacios"><input className="input" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} /></Field>}<Field label="Visibilidad de registros"><select className="input" value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value })}><option value="own">Solo los míos</option><option value="team">Mi equipo</option><option value="all">Todos</option></select></Field><label className="checkbox"><input type="checkbox" checked={!!f.permissions.admin} disabled={editing !== "new" && (editing as R).key === "admin"} onChange={(e) => setF({ ...f, permissions: { ...f.permissions, admin: e.target.checked } })} />Administrador (ajustes, usuarios, workflows)</label></div>
        <table className="table"><thead><tr><th>Objeto</th>{data.actions.map((a) => <th key={a}>{ACT[a]}</th>)}</tr></thead><tbody>{data.objects.map((o) => <tr key={o}><td>{OBJ[o]}</td>{data.actions.map((a) => <td key={a}><input type="checkbox" checked={Array.isArray(f.permissions[o]) && (f.permissions[o] as string[]).includes(a)} onChange={() => toggle(o, a)} /></td>)}</tr>)}</tbody></table>
      </Modal>}
    </div>
  );
}

/** Roles que deben usar verificación en dos pasos (si no la tienen, al entrar se les pide activarla). */
function MfaRoles({ roles }: { roles: { key: string; name: string }[] }) {
  const { settings, refresh } = useApp();
  const toast = useToast();
  const cur = ((settings as unknown as { mfa_required_roles?: string[] }).mfa_required_roles ?? []);
  const toggle = async (k: string) => { try { await api.put("admin/settings", { mfa_required_roles: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k] }); toast("Guardado", "ok"); refresh(); } catch (e) { toast(errorMessage(e), "error"); } };
  return <div style={{ padding: "12px 16px", borderTop: "1px solid var(--rule2)" }}><b className="small">Verificación en dos pasos obligatoria</b><p className="xs muted">Recomendado para administración y legal. Quien no la tenga deberá activarla al entrar; las API keys no se ven afectadas.</p><div className="row wrap" style={{ gap: 12 }}>{roles.map((r) => <label key={r.key} className="checkbox"><input type="checkbox" checked={cur.includes(r.key)} onChange={() => toggle(r.key)} />{r.name}</label>)}</div></div>;
}

function TeamsAdmin() {
  const { users, refresh } = useApp();
  const toast = useToast();
  const [items, setItems] = useState<{ id: string; name: string; manager_id: string | null; manager_name: string | null; members: number }[]>([]);
  const [editing, setEditing] = useState<{ id?: string; name: string; manager_id: string | null } | null>(null);
  const load = () => api.get<{ items: typeof items }>("admin/teams").then((r) => setItems(r.items));
  useEffect(() => { load(); }, []);
  const save = async () => { if (!editing) return; try { if (editing.id) await api.put(`admin/teams/${editing.id}`, { name: editing.name, manager_id: editing.manager_id }); else await api.post("admin/teams", { name: editing.name, manager_id: editing.manager_id }); toast("Equipo guardado", "ok"); setEditing(null); load(); refresh(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <div className="card tight">
      <div className="row between" style={{ padding: "12px 16px" }}><div><h2>Equipos</h2><p className="small muted">El manager de un equipo ve los registros de sus miembros (con visibilidad «mi equipo»). Los usuarios se asignan a equipos en Usuarios.</p></div><button className="btn primary sm" onClick={() => setEditing({ name: "", manager_id: null })}><Plus />Nuevo equipo</button></div>
      <table className="table"><thead><tr><th>Equipo</th><th>Manager</th><th className="r">Miembros</th><th></th></tr></thead><tbody>{items.map((t) => <tr key={t.id}><td className="bold">{t.name}</td><td>{t.manager_name ?? "—"}</td><td className="r num">{t.members}</td><td className="r row" style={{ justifyContent: "flex-end" }}><button className="iconbtn" onClick={() => setEditing({ id: t.id, name: t.name, manager_id: t.manager_id })} aria-label="Editar"><Pencil size={15} /></button><button className="iconbtn" onClick={async () => { await api.del(`admin/teams/${t.id}`); load(); refresh(); }} aria-label="Borrar"><Trash2 size={15} /></button></td></tr>)}{items.length === 0 && <tr><td colSpan={4} className="muted">Sin equipos.</td></tr>}</tbody></table>
      {editing && <Modal title={editing.id ? "Editar equipo" : "Nuevo equipo"} onClose={() => setEditing(null)} footer={<><button className="btn" onClick={() => setEditing(null)}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}><div className="col"><Field label="Nombre"><input className="input" autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field><Field label="Manager"><select className="input" value={editing.manager_id ?? ""} onChange={(e) => setEditing({ ...editing, manager_id: e.target.value || null })}><option value="">—</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field></div></Modal>}
    </div>
  );
}

function PipelinesAdmin() {
  const { pipelines, refresh } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [newName, setNewName] = useState("");
  const [stage, setStage] = useState<{ pipeline: Pipeline; stage: Partial<Stage> } | null>(null);
  const REQ = [["amount", "Importe"], ["expected_close_date", "Fecha de cierre"], ["company_id", "Empresa"], ["contacts", "Contacto decisor"], ["products", "Líneas de producto"], ["owner_id", "Propietario"]];
  const saveStage = async () => { if (!stage) return; try { const s = stage.stage; const body = { name: s.name, probability: Number(s.probability), color: s.color, expected_days: Number(s.expected_days), required_fields: s.required_fields ?? [] }; if (s.id) await api.put(`pipelines/${stage.pipeline.id}/stages/${s.id}`, body); else await api.post(`pipelines/${stage.pipeline.id}/stages`, body); toast("Etapa guardada", "ok"); setStage(null); refresh(); } catch (e) { toast(errorMessage(e), "error"); } };
  const move = async (p: Pipeline, s: Stage, dir: -1 | 1) => { const open = p.stages.filter((x) => x.kind === "open"); const i = open.findIndex((x) => x.id === s.id); const j = i + dir; if (j < 0 || j >= open.length) return; const order = open.map((x) => x.id); [order[i], order[j]] = [order[j]!, order[i]!]; await api.put(`pipelines/${p.id}/stages-order`, { order }); refresh(); };
  return (
    <div className="col" style={{ gap: 16 }}>
      {pipelines.map((p) => (
        <div key={p.id} className="card">
          <div className="row between mb12"><h2>{p.name} {p.is_default ? <span className="badge sea">por defecto</span> : null}</h2><div className="row">{!p.is_default && <button className="btn sm" onClick={async () => { await api.put(`pipelines/${p.id}`, { is_default: true }); refresh(); }}>Hacer por defecto</button>}<button className="btn sm" onClick={() => setStage({ pipeline: p, stage: { name: "", probability: 30, color: "#579bfc", expected_days: 14, required_fields: [] } })}><Plus />Etapa</button><button className="btn sm ghost" onClick={async () => { const n = prompt("Nuevo nombre", p.name); if (n) { await api.put(`pipelines/${p.id}`, { name: n }); refresh(); } }} aria-label="Editar"><Pencil /></button><button className="btn sm ghost" onClick={async () => { if (await confirm({ title: `¿Borrar el pipeline ${p.name}?`, danger: true, confirmText: "Borrar" })) { try { await api.del(`pipelines/${p.id}`); refresh(); } catch (e) { toast(errorMessage(e), "error"); } } }} aria-label="Borrar"><Trash2 /></button></div></div>
          <table className="table"><thead><tr><th></th><th>Etapa</th><th className="r">Probabilidad</th><th className="r">Días esperados</th><th>Campos obligatorios para entrar</th><th></th></tr></thead><tbody>
            {p.stages.map((s) => <tr key={s.id}><td style={{ width: 60 }}>{s.kind === "open" && <span className="row"><button className="iconbtn" style={{ width: 22, height: 22 }} onClick={() => move(p, s, -1)}>▲</button><button className="iconbtn" style={{ width: 22, height: 22 }} onClick={() => move(p, s, 1)}>▼</button></span>}</td><td><span className="badge dot" style={{ color: s.color }}>{s.name}</span> {s.kind !== "open" && <span className="muted xs">({s.kind === "won" ? "ganado" : "perdido"})</span>}</td><td className="r num">{s.probability}%</td><td className="r num">{s.expected_days}</td><td className="small muted">{(s.required_fields ?? []).map((f) => REQ.find((r) => r[0] === f)?.[1] ?? f).join(", ") || "—"}</td><td className="r row" style={{ justifyContent: "flex-end" }}><button className="iconbtn" onClick={() => setStage({ pipeline: p, stage: { ...s } })} aria-label="Editar"><Pencil size={15} /></button>{s.kind === "open" && <button className="iconbtn" onClick={async () => { if (await confirm({ title: `¿Borrar la etapa ${s.name}?`, danger: true, confirmText: "Borrar" })) { try { await api.del(`pipelines/${p.id}/stages/${s.id}`); refresh(); } catch (e) { toast(errorMessage(e), "error"); } } }} aria-label="Borrar"><Trash2 size={15} /></button>}</td></tr>)}
          </tbody></table>
        </div>
      ))}
      <div className="card"><h2 className="mb8">Nuevo pipeline</h2><p className="small muted mb8">Ventas nuevas, renovaciones, upsell, partners… Se crea con etapas por defecto que luego puedes editar.</p><div className="row"><input aria-label="Nombre del pipeline" className="input" style={{ maxWidth: 320 }} placeholder="Nombre del pipeline" value={newName} onChange={(e) => setNewName(e.target.value)} /><button className="btn primary" disabled={!newName.trim()} onClick={async () => { await api.post("pipelines", { name: newName }); setNewName(""); toast("Pipeline creado", "ok"); refresh(); }}>Crear</button></div></div>
      {stage && <Modal title={stage.stage.id ? "Editar etapa" : "Nueva etapa"} onClose={() => setStage(null)} footer={<><button className="btn" onClick={() => setStage(null)}>Cancelar</button><button className="btn primary" onClick={saveStage}>Guardar</button></>}>
        <div className="form-grid"><Field label="Nombre"><input className="input" value={stage.stage.name ?? ""} onChange={(e) => setStage({ ...stage, stage: { ...stage.stage, name: e.target.value } })} /></Field><Field label="Color"><input className="input" type="color" value={stage.stage.color ?? "#3A6EDB"} onChange={(e) => setStage({ ...stage, stage: { ...stage.stage, color: e.target.value } })} /></Field><Field label="Probabilidad por defecto %"><input className="input" type="number" value={stage.stage.probability ?? 0} onChange={(e) => setStage({ ...stage, stage: { ...stage.stage, probability: Number(e.target.value) } })} /></Field><Field label="Días esperados en etapa"><input className="input" type="number" value={stage.stage.expected_days ?? 14} onChange={(e) => setStage({ ...stage, stage: { ...stage.stage, expected_days: Number(e.target.value) } })} /></Field>
          {stage.stage.kind !== "won" && stage.stage.kind !== "lost" && <Field label="Campos obligatorios para avanzar a esta etapa" full><div className="row wrap">{REQ.map(([k, l]) => <label key={k} className="checkbox small"><input type="checkbox" checked={(stage.stage.required_fields ?? []).includes(k!)} onChange={(e) => { const cur = stage.stage.required_fields ?? []; setStage({ ...stage, stage: { ...stage.stage, required_fields: e.target.checked ? [...cur, k!] : cur.filter((x) => x !== k) } }); }} />{l}</label>)}</div></Field>}
        </div>
      </Modal>}
    </div>
  );
}

