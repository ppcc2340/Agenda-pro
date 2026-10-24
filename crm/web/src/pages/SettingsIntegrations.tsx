import { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { Plus, Trash2, Copy, RefreshCw, Upload } from "lucide-react";
import Papa from "papaparse";
import { api } from "../api";
import { useApp } from "../lib/app";
import { Modal, Field, useToast, useConfirm, errorMessage, Spinner, Pager, TagInput } from "../components/ui";
import { fmtDateTime, relTime, fmtNum } from "../lib/format";

type Any = Record<string, unknown>;

export function ApiKeysAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<{ id: string; name: string; prefix: string; scopes: string; last_used_at: string | null; created_at: string; revoked_at: string | null; user_name: string }[]>([]);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("read,write");
  const [publicUrl, setPublicUrl] = useState(location.origin);
  const load = () => api.get<{ items: typeof items }>("admin/api-keys").then((r) => setItems(r.items));
  useEffect(() => { load(); api.get<{ public_url: string }>("admin/settings").then((r) => setPublicUrl(r.public_url)); }, []);
  const create = async () => { try { const r = await api.post<{ key: string; name: string }>("admin/api-keys", { name, scopes }); setCreated(r); setName(""); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card tight">
        <div className="row between" style={{ padding: "12px 16px" }}><div><h2>API keys</h2><p className="small muted">Acceso REST con <code>Authorization: Bearer &lt;key&gt;</code>. Misma API que usa la aplicación, en <code>{publicUrl}/api/v1/…</code></p></div></div>
        <table className="table"><thead><tr><th>Nombre</th><th>Prefijo</th><th>Permisos</th><th>Usuario</th><th>Último uso</th><th>Estado</th><th></th></tr></thead><tbody>{items.map((k) => <tr key={k.id}><td className="bold">{k.name}</td><td><code>{k.prefix}…</code></td><td>{k.scopes === "read" ? "solo lectura" : "lectura y escritura"}</td><td>{k.user_name}</td><td className="small muted">{k.last_used_at ? relTime(k.last_used_at) : "nunca"}</td><td>{k.revoked_at ? <span className="badge risk">revocada</span> : <span className="badge ok">activa</span>}</td><td className="r">{!k.revoked_at && <button className="iconbtn" onClick={async () => { if (await confirm({ title: `¿Revocar la clave ${k.name}?`, danger: true, confirmText: "Revocar" })) { await api.del(`admin/api-keys/${k.id}`); load(); } }}><Trash2 size={15} /></button>}</td></tr>)}{items.length === 0 && <tr><td colSpan={7} className="muted">Sin claves.</td></tr>}</tbody></table>
        <div className="row" style={{ padding: 12 }}><input className="input sm" style={{ maxWidth: 240 }} placeholder="Nombre (ej. Zapier)" value={name} onChange={(e) => setName(e.target.value)} /><select className="input sm" style={{ width: "auto" }} value={scopes} onChange={(e) => setScopes(e.target.value)}><option value="read,write">Lectura y escritura</option><option value="read">Solo lectura</option></select><button className="btn primary sm" disabled={!name} onClick={create}><Plus />Crear clave</button></div>
      </div>
      <div className="card"><h3 className="mb8">Ejemplos</h3><pre>{`# Listar contactos (filtros en JSON, paginación)
curl -H "Authorization: Bearer crm_xxx" "${publicUrl}/api/v1/contacts?page_size=20&filters={\\"logic\\":\\"and\\",\\"conditions\\":[{\\"field\\":\\"lifecycle_stage\\",\\"op\\":\\"eq\\",\\"value\\":\\"lead\\"}]}"

# Crear contacto (409 si ya existe por email; usa ?force=1 para crear igualmente)
curl -X POST -H "Authorization: Bearer crm_xxx" -H "content-type: application/json" \\
  -d '{"first_name":"Ana","last_name":"Pérez","email":"ana@acme.com","company_name":"Acme","source":"api"}' ${publicUrl}/api/v1/contacts

# Crear negocio
curl -X POST -H "Authorization: Bearer crm_xxx" -H "content-type: application/json" \\
  -d '{"name":"Acme · CRM","amount":12000,"company_id":"<id>","contact_ids":["<id>"]}' ${publicUrl}/api/v1/deals

# Objetos: contacts, companies, deals, tasks, activities, tickets, products, quotes, lists, workflows, forms.
# Documentación completa en docs/API.md del repositorio.`}</pre></div>
      {created && <Modal title="Clave creada" onClose={() => setCreated(null)} footer={<button className="btn primary" onClick={() => setCreated(null)}>Hecho</button>}><p className="sub mb8">Cópiala ahora: no se volverá a mostrar.</p><div className="row"><code className="input" style={{ flex: 1 }}>{created.key}</code><button className="btn" onClick={() => { navigator.clipboard.writeText(created.key); toast("Copiada", "ok"); }}><Copy /></button></div></Modal>}
    </div>
  );
}

const EVENTS = ["*", "contact.created", "contact.updated", "contact.deleted", "company.created", "company.updated", "deal.created", "deal.updated", "deal.stage_changed", "deal.won", "deal.lost", "task.created", "task.completed", "ticket.created", "ticket.updated", "ticket.resolved", "form.submitted", "email.opened", "quote.viewed", "quote.accepted", "quote.rejected"];
export function WebhooksAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const [items, setItems] = useState<{ id: string; url: string; events: string[]; active: number; failed: number; last_delivery: string | null; secret: string }[]>([]);
  const [editing, setEditing] = useState<{ url: string; events: string[] } | null>(null);
  const [deliveries, setDeliveries] = useState<{ id: string; event: string; status: string; attempts: number; response_code: number | null; error: string | null; created_at: string }[] | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const load = () => api.get<{ items: typeof items }>("admin/webhooks").then((r) => setItems(r.items));
  useEffect(() => { load(); }, []);
  const save = async () => { if (!editing) return; try { const r = await api.post<{ secret: string }>("admin/webhooks", editing); setCreated(r.secret); setEditing(null); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <div className="card tight">
      <div className="row between" style={{ padding: "12px 16px" }}><div><h2>Webhooks salientes</h2><p className="small muted">POST JSON firmado con HMAC-SHA256 (<code>X-CRM-Signature: sha256=…</code>). Reintentos con backoff (1 min, 5 min, 30 min, 2 h, 12 h).</p></div><button className="btn primary sm" onClick={() => setEditing({ url: "", events: ["*"] })}><Plus />Nuevo webhook</button></div>
      <table className="table"><thead><tr><th>URL</th><th>Eventos</th><th>Estado</th><th>Última entrega</th><th className="r">Fallidas</th><th></th></tr></thead><tbody>{items.map((w) => <tr key={w.id}><td className="small"><code>{w.url}</code></td><td className="small muted">{w.events.join(", ")}</td><td><label className="checkbox"><input type="checkbox" checked={!!w.active} onChange={async (e) => { await api.put(`admin/webhooks/${w.id}`, { active: e.target.checked }); load(); }} /></label></td><td className="small muted">{w.last_delivery ? relTime(w.last_delivery) : "—"}</td><td className="r num">{w.failed}</td><td className="r row" style={{ justifyContent: "flex-end" }}><button className="btn xs" onClick={async () => setDeliveries((await api.get<{ items: NonNullable<typeof deliveries> }>(`admin/webhooks/${w.id}/deliveries`)).items)}>Entregas</button><button className="iconbtn" onClick={async () => { if (await confirm({ title: "¿Borrar webhook?", danger: true, confirmText: "Borrar" })) { await api.del(`admin/webhooks/${w.id}`); load(); } }}><Trash2 size={15} /></button></td></tr>)}{items.length === 0 && <tr><td colSpan={6} className="muted">Sin webhooks.</td></tr>}</tbody></table>
      {editing && <Modal title="Nuevo webhook" onClose={() => setEditing(null)} footer={<><button className="btn" onClick={() => setEditing(null)}>Cancelar</button><button className="btn primary" disabled={!editing.url.startsWith("http")} onClick={save}>Crear</button></>}><div className="col"><Field label="URL de destino"><input className="input" value={editing.url} onChange={(e) => setEditing({ ...editing, url: e.target.value })} placeholder="https://…" /></Field><Field label="Eventos"><div className="row wrap">{EVENTS.map((ev) => <label key={ev} className="checkbox small"><input type="checkbox" checked={editing.events.includes(ev)} onChange={(e) => setEditing({ ...editing, events: e.target.checked ? [...editing.events, ev] : editing.events.filter((x) => x !== ev) })} />{ev === "*" ? "todos" : ev}</label>)}</div></Field></div></Modal>}
      {created && <Modal title="Webhook creado" onClose={() => setCreated(null)}><p className="sub mb8">Secreto para verificar la firma (guárdalo):</p><code className="input">{created}</code></Modal>}
      {deliveries && <Modal title="Entregas" size="lg" onClose={() => setDeliveries(null)}><table className="table"><thead><tr><th>Fecha</th><th>Evento</th><th>Estado</th><th className="r">Intentos</th><th>Resp.</th><th></th></tr></thead><tbody>{deliveries.map((d) => <tr key={d.id}><td className="small">{fmtDateTime(d.created_at)}</td><td className="small">{d.event}</td><td><span className={`badge ${d.status === "ok" ? "ok" : d.status === "failed" ? "risk" : "warn"}`}>{d.status}</span></td><td className="r num">{d.attempts}</td><td className="small muted">{d.response_code ?? d.error}</td><td className="r">{d.status !== "ok" && <button className="btn xs" onClick={async () => { await api.post(`admin/webhooks/deliveries/${d.id}/retry`); toast("Reintentado", "ok"); }}><RefreshCw />Reintentar</button>}</td></tr>)}{deliveries.length === 0 && <tr><td colSpan={6} className="muted">Sin entregas.</td></tr>}</tbody></table></Modal>}
    </div>
  );
}

export function OutboxAdmin() {
  const [data, setData] = useState<{ mode: string; items: { id: string; to_email: string; subject: string; status: string; opens: number; clicks: number; sent_at: string | null; error: string | null; contact_name: string | null }[] } | null>(null);
  const [view, setView] = useState<{ body: string; subject: string; to_email: string } | null>(null);
  useEffect(() => { api.get<typeof data>("admin/outbox").then(setData); }, []);
  if (!data) return <Spinner />;
  return (
    <div className="card tight">
      <div className="row between" style={{ padding: "12px 16px" }}><div><h2>Emails enviados</h2><p className="small muted">Modo <span className={`badge ${data.mode === "smtp" ? "ok" : "warn"}`}>{data.mode}</span>{data.mode === "fake" && " · en modo fake los emails se registran pero no salen (configura SMTP en .env)"}. Seguimiento de aperturas y clics por píxel y enlaces reescritos.</p></div></div>
      <table className="table"><thead><tr><th>Fecha</th><th>Para</th><th>Asunto</th><th>Estado</th><th className="r">Aperturas</th><th className="r">Clics</th><th></th></tr></thead><tbody>{data.items.map((e) => <tr key={e.id}><td className="small">{fmtDateTime(e.sent_at)}</td><td className="small">{e.contact_name ?? e.to_email}</td><td>{e.subject}</td><td><span className={`badge ${e.status === "failed" ? "risk" : e.status === "sent" ? "ok" : ""}`}>{e.status}</span>{e.error && <div className="xs" style={{ color: "var(--risk)" }}>{e.error}</div>}</td><td className="r num">{e.opens}</td><td className="r num">{e.clicks}</td><td className="r"><button className="btn xs" onClick={async () => setView(await api.get<NonNullable<typeof view>>(`admin/outbox/${e.id}`))}>Ver</button></td></tr>)}{data.items.length === 0 && <tr><td colSpan={7} className="muted">Nada enviado todavía.</td></tr>}</tbody></table>
      {view && <Modal title={view.subject} size="lg" onClose={() => setView(null)}><p className="small muted mb8">Para: {view.to_email}</p><div className="card" dangerouslySetInnerHTML={{ __html: view.body }} /></Modal>}
    </div>
  );
}

export function AuditAdmin() {
  const { users } = useApp();
  const [data, setData] = useState<{ items: { id: string; object: string; record_id: string | null; action: string; changes: Any; user_name: string | null; ip: string | null; created_at: string }[]; total: number; page: number; page_size: number } | null>(null);
  const [page, setPage] = useState(1);
  const [object, setObject] = useState("");
  const [action, setAction] = useState("");
  const [user, setUser] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => { api.get<typeof data>(`admin/audit?page=${page}&object=${object}&action=${action}&user_id=${user}&q=${encodeURIComponent(q)}`).then(setData); }, [page, object, action, user, q]);
  const link = (o: string, id: string | null) => (!id ? null : o === "contact" ? `/contactos/${id}` : o === "company" ? `/empresas/${id}` : o === "deal" ? `/negocios/${id}` : o === "ticket" ? `/tickets/${id}` : null);
  return (
    <div className="card tight">
      <div className="row wrap" style={{ padding: "12px 16px" }}><div className="grow"><h2>Registro de auditoría</h2><p className="small muted">Quién cambió qué y cuándo: valores anterior y nuevo, usuario, IP. Incluye accesos, exportaciones, borrados y cambios de permisos.</p></div><select className="input sm" style={{ width: "auto" }} value={object} onChange={(e) => setObject(e.target.value)}><option value="">Todos los objetos</option>{["contact", "company", "deal", "task", "ticket", "user", "role", "workflow", "api_key", "import", "quote", "workspace"].map((o) => <option key={o}>{o}</option>)}</select><select className="input sm" style={{ width: "auto" }} value={action} onChange={(e) => setAction(e.target.value)}><option value="">Todas las acciones</option>{["create", "update", "delete", "restore", "stage_change", "merge", "anonymize", "export", "login", "login_failed", "permission"].map((a) => <option key={a}>{a}</option>)}</select><select className="input sm" style={{ width: "auto" }} value={user} onChange={(e) => setUser(e.target.value)}><option value="">Todos los usuarios</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select><input className="input sm" style={{ width: 180 }} placeholder="id o texto…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {!data ? <Spinner /> : <><table className="table"><thead><tr><th>Fecha</th><th>Usuario</th><th>Acción</th><th>Objeto</th><th>Cambios</th><th>IP</th></tr></thead><tbody>{data.items.map((a) => { const l = link(a.object, a.record_id); return <tr key={a.id}><td className="small">{fmtDateTime(a.created_at)}</td><td className="small">{a.user_name ?? "sistema"}</td><td><span className="badge">{a.action}</span></td><td className="small">{l ? <Link to={l}>{a.object}</Link> : a.object}</td><td className="small muted" style={{ maxWidth: 420 }}>{Object.entries(a.changes).slice(0, 6).map(([k, v]) => <div key={k} className="ell"><span className="bold">{k}</span>: {Array.isArray(v) ? `${fmt(v[0])} → ${fmt(v[1])}` : fmt(v)}</div>)}</td><td className="xs muted">{a.ip}</td></tr>; })}</tbody></table><Pager page={data.page} pageSize={data.page_size} total={data.total} onPage={setPage} /></>}
    </div>
  );
}
const fmt = (v: unknown) => (v === null || v === undefined || v === "" ? "vacío" : typeof v === "object" ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60));

export function UsageAdmin() {
  const [u, setU] = useState<Any | null>(null);
  const [gdpr, setGdpr] = useState<{ id: string; type: string; contact_name: string | null; user_name: string | null; created_at: string }[]>([]);
  useEffect(() => { api.get<Any>("admin/usage").then(setU); api.get<{ items: typeof gdpr }>("admin/gdpr-requests").then((r) => setGdpr(r.items)); }, []);
  if (!u) return <Spinner />;
  const L: Record<string, string> = { contacts: "Contactos", companies: "Empresas", deals: "Negocios", activities: "Actividades", emails_30d: "Emails (30 d)", workflow_runs_30d: "Ejecuciones de workflows (30 d)", webhook_failed: "Entregas de webhook fallidas", users: "Usuarios activos" };
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="grid c4">{Object.entries(L).map(([k, l]) => <div key={k} className="stat"><div className="label">{l}</div><div className="value num">{fmtNum(u[k] as number)}</div></div>)}</div>
      <div className="card"><h2 className="mb8">Copias de seguridad</h2><p className="small sub">La base de datos es un único archivo SQLite (<code>DATABASE_PATH</code>, por defecto <code>data/crm.db</code>). Copia diaria recomendada: <code>sqlite3 data/crm.db ".backup backups/crm-$(date +%F).db"</code> (o copia el archivo con el servidor parado). Restaurar = sustituir el archivo. Cifrado en tránsito: sirve la app detrás de un proxy TLS (Caddy, nginx).</p></div>
      <div className="card tight"><div style={{ padding: "12px 16px" }}><h2>Solicitudes RGPD</h2></div><table className="table"><thead><tr><th>Fecha</th><th>Tipo</th><th>Contacto</th><th>Usuario</th></tr></thead><tbody>{gdpr.map((g) => <tr key={g.id}><td className="small">{fmtDateTime(g.created_at)}</td><td><span className="badge">{g.type === "export" ? "exportación" : "anonimización"}</span></td><td>{g.contact_name}</td><td className="small">{g.user_name}</td></tr>)}{gdpr.length === 0 && <tr><td colSpan={4} className="muted">Sin solicitudes.</td></tr>}</tbody></table></div>
    </div>
  );
}

export function RecycleBin() {
  const toast = useToast();
  const [d, setD] = useState<{ contacts: { id: string; name: string; email: string | null; deleted_at: string; merged_into: string | null }[]; companies: { id: string; name: string; domain: string | null; deleted_at: string }[]; deals: { id: string; name: string; amount: number; deleted_at: string }[] } | null>(null);
  const load = () => api.get<typeof d>("admin/recycle-bin").then(setD);
  useEffect(() => { load(); }, []);
  if (!d) return <Spinner />;
  const restore = async (kind: string, id: string) => { await api.post(`${kind}/${id}/restore`); toast("Restaurado", "ok"); load(); };
  const Sec = ({ title, kind, rows }: { title: string; kind: string; rows: { id: string; name: string; sub?: string | null; deleted_at: string; merged?: boolean }[] }) => <div className="card tight mb16"><div style={{ padding: "10px 16px" }}><h3>{title} <span className="muted">({rows.length})</span></h3></div><table className="table"><tbody>{rows.map((r) => <tr key={r.id}><td className="bold">{r.name}{r.merged && <span className="badge" style={{ marginLeft: 6 }}>fusionado</span>}</td><td className="small muted">{r.sub}</td><td className="small muted">borrado {relTime(r.deleted_at)}</td><td className="r"><button className="btn xs" onClick={() => restore(kind, r.id)}>Restaurar</button></td></tr>)}{rows.length === 0 && <tr><td className="muted">Vacío</td></tr>}</tbody></table></div>;
  return (<div><p className="small muted mb12">Los registros borrados se conservan 30 días y luego se eliminan definitivamente.</p><Sec title="Contactos" kind="contacts" rows={d.contacts.map((c) => ({ id: c.id, name: c.name, sub: c.email, deleted_at: c.deleted_at, merged: !!c.merged_into }))} /><Sec title="Empresas" kind="companies" rows={d.companies.map((c) => ({ id: c.id, name: c.name, sub: c.domain, deleted_at: c.deleted_at }))} /><Sec title="Negocios" kind="deals" rows={d.deals.map((c) => ({ id: c.id, name: c.name, sub: String(c.amount), deleted_at: c.deleted_at }))} /></div>);
}

export function QualityGdpr() {
  return <div className="card"><h2 className="mb8">Calidad de datos y RGPD</h2><ul className="small sub" style={{ margin: "0 0 0 18px", lineHeight: 1.8 }}><li><Link to="/informes">Informes → Calidad de datos</Link>: registros sin email, sin propietario, inactivos, duplicados.</li><li><Link to="/contactos/duplicados">Duplicados</Link>: detección por email, teléfono y nombre+empresa; fusión campo a campo reversible 30 días.</li><li>Normalización automática al guardar: emails en minúscula, teléfonos en formato internacional, nombres capitalizados, dominios sin www.</li><li>Desde la ficha de un contacto: <strong>Exportar datos (derecho de acceso)</strong> y <strong>Anonimizar</strong>. El registro de solicitudes está en <Link to="/ajustes/uso">Uso del sistema</Link>.</li><li>Política de retención automática en <Link to="/ajustes/general">General</Link>.</li><li>Auditoría completa en <Link to="/ajustes/auditoria">Auditoría</Link> (12+ meses).</li></ul></div>;
}

const FIELDS: Record<string, { key: string; label: string }[]> = {
  contact: [{ key: "first_name", label: "Nombre" }, { key: "last_name", label: "Apellidos" }, { key: "full_name", label: "Nombre completo" }, { key: "email", label: "Email" }, { key: "phone", label: "Teléfono" }, { key: "job_title", label: "Cargo" }, { key: "company_name", label: "Empresa (nombre)" }, { key: "lifecycle_stage", label: "Etapa ciclo de vida" }, { key: "lead_status", label: "Estado lead" }, { key: "source", label: "Origen" }, { key: "city", label: "Ciudad" }, { key: "country", label: "País" }, { key: "linkedin", label: "LinkedIn" }, { key: "birthday", label: "Cumpleaños" }],
  company: [{ key: "name", label: "Nombre" }, { key: "domain", label: "Dominio" }, { key: "website", label: "Web" }, { key: "sector", label: "Sector" }, { key: "size", label: "Empleados" }, { key: "revenue", label: "Facturación" }, { key: "tax_id", label: "CIF" }, { key: "address", label: "Dirección" }, { key: "city", label: "Ciudad" }, { key: "country", label: "País" }, { key: "phone", label: "Teléfono" }, { key: "type", label: "Tipo" }],
  deal: [{ key: "name", label: "Nombre" }, { key: "company_name", label: "Empresa (nombre)" }, { key: "amount", label: "Importe" }, { key: "stage_name", label: "Etapa (nombre)" }, { key: "expected_close_date", label: "Cierre previsto" }],
};
export function ImportPage() {
  const [params] = useSearchParams();
  const { customFields, users, me } = useApp();
  const toast = useToast();
  const [object, setObject] = useState(params.get("object") ?? "contact");
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [dedupe, setDedupe] = useState("skip");
  const [owner, setOwner] = useState(me.id);
  const [tags, setTags] = useState<string[]>([]);
  const [preview, setPreview] = useState<Any | null>(null);
  const [result, setResult] = useState<Any | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<{ id: string; object: string; file_name: string | null; total: number; created: number; updated: number; skipped: number; errors: unknown[]; reverted_at: string | null; user_name: string; created_at: string }[]>([]);
  const loadHistory = () => api.get<{ items: typeof history }>("imports").then((r) => setHistory(r.items));
  useEffect(() => { loadHistory(); }, []);
  const fields = [...(FIELDS[object] ?? []), ...customFields.filter((f) => f.object === object).map((f) => ({ key: `custom.${f.key}`, label: `${f.label} (personalizado)` }))];
  const onFile = (file: File) => {
    setFileName(file.name); setResult(null); setPreview(null);
    Papa.parse<Record<string, string>>(file, { header: true, skipEmptyLines: true, complete: (r) => {
      const hs = r.meta.fields ?? [];
      setHeaders(hs); setRows(r.data);
      const auto: Record<string, string> = {};
      for (const h of hs) { const n = h.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, ""); const guess = fields.find((f) => f.key === n || f.label.toLowerCase() === n || (n.includes("mail") && f.key === "email") || (n.includes("tel") && f.key === "phone") || (n.includes("nombre") && !n.includes("empresa") && (f.key === "first_name" || f.key === "name")) || (n.includes("apellido") && f.key === "last_name") || (n.includes("empresa") && f.key === "company_name") || (n.includes("cargo") && f.key === "job_title") || (n.includes("ciudad") && f.key === "city") || (n.includes("importe") && f.key === "amount") || (n.includes("sector") && f.key === "sector") || (n.includes("dominio") && f.key === "domain") || (n.includes("web") && f.key === "website")); if (guess) auto[h] = guess.key; }
      setMapping(auto);
    } });
  };
  const run = async (dry: boolean) => {
    setBusy(true);
    try { const r = await api.post<Any>("import", { object, file_name: fileName, mapping, rows, dedupe, owner_id: owner, tags, dry_run: dry }); if (dry) setPreview(r); else { setResult(r); toast(`Importación completada: ${r.created} creados`, "ok"); loadHistory(); } } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  };
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <h2 className="mb8">Importar desde CSV / Excel (CSV)</h2>
        <p className="small muted mb12">1. Elige el objeto y el archivo · 2. Mapea columnas · 3. Previsualiza · 4. Importa. Se detectan duplicados por email (contactos) o dominio/nombre (empresas) y se crean las empresas por nombre o dominio del email. Toda importación se puede revertir.</p>
        <div className="row wrap mb12"><select className="input sm" style={{ width: "auto" }} value={object} onChange={(e) => { setObject(e.target.value); setMapping({}); }}><option value="contact">Contactos</option><option value="company">Empresas</option><option value="deal">Negocios</option></select><label className="btn sm"><Upload />Elegir archivo CSV<input type="file" accept=".csv,text/csv" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} /></label>{fileName && <span className="small">{fileName} · {rows.length} filas</span>}</div>
        {headers.length > 0 && (<>
          <h3 className="mb8">Mapeo de columnas</h3>
          <div className="grid c3 mb12">{headers.map((h) => <div key={h} className="row"><span className="small ell" style={{ width: 140 }} title={h}>{h}</span><select className="input sm" value={mapping[h] ?? ""} onChange={(e) => setMapping({ ...mapping, [h]: e.target.value })}><option value="">— ignorar —</option>{fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select></div>)}</div>
          <div className="form-grid mb12"><Field label="Si ya existe (por email / dominio)"><select className="input" value={dedupe} onChange={(e) => setDedupe(e.target.value)}><option value="skip">Omitir (no crear duplicados)</option><option value="update">Actualizar el existente</option><option value="create">Crear igualmente</option></select></Field><Field label="Propietario por defecto"><select className="input" value={owner} onChange={(e) => setOwner(e.target.value)}>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field><Field label="Etiquetas a añadir" full><TagInput value={tags} onChange={setTags} /></Field></div>
          <div className="row"><button className="btn" disabled={busy} onClick={() => run(true)}>Previsualizar</button><button className="btn primary" disabled={busy || !preview} onClick={() => run(false)}>Importar {rows.length} filas</button></div>
          {preview && <div className="alert info mt12 small">Previsualización: <strong>{String(preview.created)}</strong> se crearían · <strong>{String(preview.updated)}</strong> se actualizarían · <strong>{String(preview.skipped)}</strong> se omitirían (duplicados) · <strong>{(preview.errors as unknown[]).length}</strong> con errores{(preview.errors as { row: number; message: string }[]).slice(0, 5).map((e) => <div key={e.row}>Fila {e.row}: {e.message}</div>)}</div>}
          {result && <div className="alert ok mt12 small">Importado: {String(result.created)} creados, {String(result.updated)} actualizados, {String(result.skipped)} omitidos, {(result.errors as unknown[]).length} errores.</div>}
          <div className="table-wrap mt12"><table className="table"><thead><tr>{headers.slice(0, 8).map((h) => <th key={h}>{h}<div className="xs" style={{ textTransform: "none", color: "var(--sea)" }}>{fields.find((f) => f.key === mapping[h])?.label ?? "—"}</div></th>)}</tr></thead><tbody>{rows.slice(0, 5).map((r, i) => <tr key={i}>{headers.slice(0, 8).map((h) => <td key={h} className="small">{r[h]}</td>)}</tr>)}</tbody></table></div>
        </>)}
      </div>
      <div className="card tight"><div style={{ padding: "12px 16px" }}><h2>Historial de importaciones</h2></div><table className="table"><thead><tr><th>Fecha</th><th>Objeto</th><th>Archivo</th><th className="r">Filas</th><th className="r">Creados</th><th className="r">Actualizados</th><th className="r">Omitidos</th><th className="r">Errores</th><th>Usuario</th><th></th></tr></thead><tbody>{history.map((h) => <tr key={h.id}><td className="small">{fmtDateTime(h.created_at)}</td><td>{h.object}</td><td className="small">{h.file_name}</td><td className="r num">{h.total}</td><td className="r num">{h.created}</td><td className="r num">{h.updated}</td><td className="r num">{h.skipped}</td><td className="r num">{h.errors.length}</td><td className="small">{h.user_name}</td><td className="r">{h.reverted_at ? <span className="badge">revertida</span> : h.created > 0 && <button className="btn xs" onClick={async () => { if (confirm("¿Revertir? Se borrarán los registros creados por esta importación.")) { await api.post(`imports/${h.id}/revert`); toast("Importación revertida", "ok"); loadHistory(); } }}>Revertir</button>}</td></tr>)}{history.length === 0 && <tr><td colSpan={10} className="muted">Sin importaciones.</td></tr>}</tbody></table></div>
    </div>
  );
}
