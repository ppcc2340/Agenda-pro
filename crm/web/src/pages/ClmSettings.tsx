import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Pencil, Trash2, Eye } from "lucide-react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { Modal, Field, Tabs, Spinner, useToast, useConfirm, errorMessage } from "../components/ui";
import { fmtDate, fmtMoney } from "../lib/format";
import { FAMILY, type ContractType } from "../lib/clm";
import { PALETTE } from "../lib/board";
import { pillStyle } from "../lib/colors";

type Any = Record<string, unknown>;
const CATEGORY_GROUPS: Record<string, string> = { A: "Identificación y estructura", B: "Duración y terminación", C: "Económicas", D: "Obligaciones", E: "Responsabilidad y riesgo", F: "Confidencialidad, datos y seguridad", G: "Propiedad intelectual", H: "Relación y competencia", I: "Resolución de conflictos", J: "Sectoriales" };

export function ClmSettingsPage() {
  const [tab, setTab] = useState("types");
  return (
    <div>
      <div className="row small muted mb8"><Link to="/contratos">Contratos</Link><span>/</span><span>Configuración del CLM</span></div>
      <div className="page-head"><div><h1>Configuración del CLM</h1><p className="sub">Tipos de contrato, biblioteca de cláusulas con variantes, plantillas con variables, playbooks de negociación y poderes de firma. Todo editable, como el resto del CRM.</p></div></div>
      <Tabs items={[{ key: "types", label: "Tipos de contrato" }, { key: "clauses", label: "Biblioteca de cláusulas" }, { key: "templates", label: "Plantillas" }, { key: "playbooks", label: "Playbooks" }, { key: "authority", label: "Poderes de firma" }]} value={tab} onChange={setTab} />
      <div className="mt12">
        {tab === "types" && <TypesAdmin />}{tab === "clauses" && <ClausesAdmin />}{tab === "templates" && <TemplatesAdmin />}{tab === "playbooks" && <PlaybooksAdmin />}{tab === "authority" && <AuthorityAdmin />}
      </div>
    </div>
  );
}

function TypesAdmin() {
  const toast = useToast(); const confirm = useConfirm();
  const [items, setItems] = useState<ContractType[] | null>(null);
  const [tpls, setTpls] = useState<Any[]>([]); const [pbs, setPbs] = useState<Any[]>([]);
  const [edit, setEdit] = useState<Any | null>(null);
  const load = () => { api.get<{ items: ContractType[] }>("clm/types").then((r) => setItems(r.items)); api.get<{ items: Any[] }>("clm/templates").then((r) => setTpls(r.items)); api.get<{ items: Any[] }>("clm/playbooks").then((r) => setPbs(r.items)); };
  useEffect(() => { load(); }, []);
  const save = async () => { if (!edit) return; try { const body = { ...edit, retention_years: Number(edit.retention_years), sla_hours: Number(edit.sla_hours), default_template_id: edit.default_template_id || null, default_playbook_id: edit.default_playbook_id || null }; if (edit.id) await api.put(`clm/types/${edit.id}`, body); else await api.post("clm/types", body); toast("Guardado", "ok"); setEdit(null); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  if (!items) return <Spinner />;
  return (
    <div>
      <div className="filterbar"><span className="small sub">Cada tipo define familia, dirección, nivel mínimo de firma eIDAS, retención, prefijo de numeración, SLA de legal, plantilla y playbook por defecto. Las reglas de aprobación por defecto (negocio, legal, director legal, finanzas, DPO, dirección) se aplican si el tipo no define las suyas.</span><button className="btn primary right" onClick={() => setEdit({ code: "", name: "", family: "sales", direction: "income", min_signature_level: "SES", retention_years: 6, number_prefix: "", sla_hours: 72, requires_dpa: true, requires_kyc: false, self_service: false, color: PALETTE[0], default_template_id: "", default_playbook_id: "", active: true })}><Plus />Tipo</button></div>
      <div className="card tight"><table className="table"><thead><tr><th>Código</th><th>Nombre</th><th>Familia</th><th>Dirección</th><th>Firma mín.</th><th className="r">Retención</th><th className="r">SLA</th><th>Plantilla</th><th>Playbook</th><th className="r">Contratos</th><th /></tr></thead><tbody>
        {items.map((t) => <tr key={t.id} style={{ opacity: t.active ? 1 : 0.5 }}><td><span className="badge" style={pillStyle(t.color)}>{t.code}</span></td><td className="bold">{t.name}</td><td className="small">{FAMILY[t.family]}</td><td className="small">{t.direction === "income" ? "Ingreso" : t.direction === "expense" ? "Gasto" : "Neutral"}</td><td>{t.min_signature_level}</td><td className="r num">{t.retention_years} años</td><td className="r num">{t.sla_hours} h</td><td className="small">{String(tpls.find((x) => x.id === t.default_template_id)?.name ?? "—")}</td><td className="small">{String(pbs.find((x) => x.id === t.default_playbook_id)?.name ?? "por dirección")}</td><td className="r num">{t.contracts}</td><td className="r nowrap"><button className="iconbtn" onClick={() => setEdit({ ...t, requires_dpa: !!t.requires_dpa, requires_kyc: !!t.requires_kyc, self_service: !!t.self_service, active: !!t.active, default_template_id: t.default_template_id ?? "", default_playbook_id: t.default_playbook_id ?? "" })} aria-label="Editar"><Pencil size={14} /></button><button className="iconbtn" onClick={async () => { if (await confirm({ title: `¿Borrar el tipo ${t.code}?`, danger: true, confirmText: "Borrar" })) { try { await api.del(`clm/types/${t.id}`); load(); } catch (e) { toast(errorMessage(e), "error"); } } }} aria-label="Borrar"><Trash2 size={14} /></button></td></tr>)}
      </tbody></table></div>
      {edit && <Modal title={edit.id ? `Editar tipo ${String(edit.code)}` : "Nuevo tipo de contrato"} size="lg" onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}><div className="form-grid">
        <Field label="Código"><input className="input" disabled={!!edit.id} value={String(edit.code)} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase(), number_prefix: edit.number_prefix || e.target.value.toUpperCase() })} /></Field><Field label="Nombre"><input className="input" value={String(edit.name)} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
        <Field label="Familia"><select className="input" value={String(edit.family)} onChange={(e) => setEdit({ ...edit, family: e.target.value })}>{Object.entries(FAMILY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field><Field label="Dirección"><select className="input" value={String(edit.direction)} onChange={(e) => setEdit({ ...edit, direction: e.target.value })}><option value="income">Ingreso (vendemos)</option><option value="expense">Gasto (compramos)</option><option value="neutral">Neutral</option></select></Field>
        <Field label="Nivel mínimo de firma"><select className="input" value={String(edit.min_signature_level)} onChange={(e) => setEdit({ ...edit, min_signature_level: e.target.value })}><option value="SES">SES · simple con OTP</option><option value="AdES">AdES · avanzada</option><option value="QES">QES · cualificada</option></select></Field><Field label="Retención (años desde la terminación)"><input className="input" type="number" value={String(edit.retention_years)} onChange={(e) => setEdit({ ...edit, retention_years: e.target.value })} /></Field>
        <Field label="Prefijo de numeración"><input className="input" value={String(edit.number_prefix)} onChange={(e) => setEdit({ ...edit, number_prefix: e.target.value.toUpperCase() })} /></Field><Field label="SLA de legal (horas)"><input className="input" type="number" value={String(edit.sla_hours)} onChange={(e) => setEdit({ ...edit, sla_hours: e.target.value })} /></Field>
        <Field label="Plantilla por defecto"><select className="input" value={String(edit.default_template_id)} onChange={(e) => setEdit({ ...edit, default_template_id: e.target.value })}><option value="">—</option>{tpls.filter((t) => t.kind === "contract").map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.name)}</option>)}</select></Field><Field label="Playbook por defecto"><select className="input" value={String(edit.default_playbook_id)} onChange={(e) => setEdit({ ...edit, default_playbook_id: e.target.value })}><option value="">Según dirección</option>{pbs.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.name)}</option>)}</select></Field>
        <Field label="Color"><div className="cpal" style={{ position: "static", boxShadow: "none", padding: 0 }}>{PALETTE.map((c) => <button key={c} style={{ background: c, outline: edit.color === c ? "2px solid var(--ink)" : undefined }} onClick={() => setEdit({ ...edit, color: c })} />)}</div></Field>
        <div className="col"><label className="checkbox"><input type="checkbox" checked={!!edit.requires_dpa} onChange={(e) => setEdit({ ...edit, requires_dpa: e.target.checked })} />Exige DPA si trata datos personales</label><label className="checkbox"><input type="checkbox" checked={!!edit.requires_kyc} onChange={(e) => setEdit({ ...edit, requires_kyc: e.target.checked })} />Exige KYC (CIF) de la contraparte antes de firmar</label><label className="checkbox"><input type="checkbox" checked={!!edit.self_service} onChange={(e) => setEdit({ ...edit, self_service: e.target.checked })} />Permite autoservicio</label><label className="checkbox"><input type="checkbox" checked={!!edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />Activo</label></div>
      </div></Modal>}
    </div>
  );
}

function ClausesAdmin() {
  const toast = useToast();
  const [items, setItems] = useState<Any[] | null>(null);
  const [edit, setEdit] = useState<Any | null>(null);
  const [q, setQ] = useState("");
  const [cats, setCats] = useState<Record<string, string>>({});
  const load = () => { api.get<{ items: Any[] }>("clm/clauses").then((r) => setItems(r.items)); api.get<{ categories: Record<string, string> }>("clm/meta").then((m) => setCats(m.categories)); };
  useEffect(() => { load(); }, []);
  const save = async () => { if (!edit) return; try { if (edit.id) await api.put(`clm/clauses/${edit.id}`, edit); else await api.post("clm/clauses", edit); toast("Cláusula guardada", "ok"); setEdit(null); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  if (!items) return <Spinner />;
  const filtered = items.filter((c) => !q || `${c.code} ${c.title} ${c.category} ${cats[String(c.category)] ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  const groups = Array.from(new Set(filtered.map((c) => String(c.category).charAt(0)))).sort();
  const VAR: Record<string, string> = { standard: "estándar", alternative: "alternativa", fallback: "último recurso", prohibited: "prohibida" };
  return (
    <div>
      <div className="filterbar"><input aria-label="Buscar por código, título o categoría" className="input" style={{ maxWidth: 260 }} placeholder="Buscar por código, título o categoría" value={q} onChange={(e) => setQ(e.target.value)} /><span className="small sub">Catálogo de 70 categorías (A01…J05). Cada cláusula tiene variantes: estándar → alternativa → último recurso; las prohibidas marcan el papel de la contraparte en rojo.</span><button className="btn primary right" onClick={() => setEdit({ code: "", title: "", category: "E01", variant_type: "standard", position: "preferred", direction: "both", body: "", risk_level: "low", status: "approved", usage_guide: "", negotiation_notes: "", approver_role: "" })}><Plus />Cláusula</button></div>
      {groups.map((g) => (
        <div key={g} className="mgroup" style={{ "--gc": PALETTE[((g.charCodeAt(0) - 65) * 2) % PALETTE.length] ?? "#579bfc" } as React.CSSProperties}><div className="ghead"><h2>Grupo {g} · {CATEGORY_GROUPS[g]}</h2><span className="count">{filtered.filter((c) => String(c.category).charAt(0) === g).length}</span></div>
          <div className="card tight"><table className="table"><thead><tr><th>Código</th><th>Categoría</th><th>Título</th><th>Variante</th><th>Posición</th><th>Dirección</th><th>Riesgo</th><th>Estado</th><th className="r">Usos</th><th /></tr></thead><tbody>
            {filtered.filter((c) => String(c.category).charAt(0) === g).map((c) => <tr key={String(c.id)} style={{ opacity: c.status === "retired" ? 0.5 : 1 }}><td className="num bold">{String(c.code)}</td><td><span className="badge">{String(c.category)}</span> <span className="small">{cats[String(c.category)]}</span></td><td>{String(c.title)}</td><td><span className={`badge ${c.variant_type === "prohibited" ? "risk" : c.variant_type === "fallback" ? "warn" : c.variant_type === "standard" ? "ok" : ""}`}>{VAR[String(c.variant_type)]}</span></td><td className="small">{String(c.position)}</td><td className="small">{c.direction === "both" ? "ambas" : c.direction === "income" ? "venta" : "compra"}</td><td className="small">{String(c.risk_level)}</td><td className="small">{String(c.status)} v{String(c.version)}</td><td className="r num">{String(c.usage_count)}</td><td className="r"><button className="iconbtn" onClick={() => setEdit({ ...c })} aria-label="Editar"><Pencil size={14} /></button></td></tr>)}
          </tbody></table></div></div>))}
      {edit && <Modal title={edit.id ? `Cláusula ${String(edit.code)}` : "Nueva cláusula"} size="xl" onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancelar</button><button className="btn primary" onClick={save}>Guardar{edit.id ? " (nueva versión)" : ""}</button></>}><div className="form-grid">
        <Field label="Código"><input className="input" disabled={!!edit.id} value={String(edit.code)} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} placeholder="E01-ALT3" /></Field><Field label="Categoría"><select className="input" value={String(edit.category)} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>{Object.entries(cats).map(([k, v]) => <option key={k} value={k}>{k} · {v}</option>)}</select></Field>
        <Field label="Título" full><input className="input" value={String(edit.title)} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field>
        <Field label="Variante"><select className="input" value={String(edit.variant_type)} onChange={(e) => setEdit({ ...edit, variant_type: e.target.value })}>{Object.entries(VAR).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field><Field label="Posición de negociación"><select className="input" value={String(edit.position)} onChange={(e) => setEdit({ ...edit, position: e.target.value })}><option value="preferred">Preferida</option><option value="acceptable">Aceptable</option><option value="last_resort">Último recurso</option><option value="never">Nunca</option></select></Field>
        <Field label="Dirección"><select className="input" value={String(edit.direction)} onChange={(e) => setEdit({ ...edit, direction: e.target.value })}><option value="both">Ambas</option><option value="income">Venta</option><option value="expense">Compra</option></select></Field><Field label="Riesgo"><select className="input" value={String(edit.risk_level)} onChange={(e) => setEdit({ ...edit, risk_level: e.target.value })}><option value="low">Bajo</option><option value="medium">Medio</option><option value="high">Alto</option></select></Field>
        <Field label="Aprobador de desviación"><input className="input" value={String(edit.approver_role ?? "")} onChange={(e) => setEdit({ ...edit, approver_role: e.target.value })} placeholder="legal, legal_director, cfo, dpo, ceo" /></Field><Field label="Estado"><select className="input" value={String(edit.status)} onChange={(e) => setEdit({ ...edit, status: e.target.value })}><option value="draft">Borrador</option><option value="approved">Aprobada y vigente</option><option value="retired">Retirada</option></select></Field>
        <Field label="Texto (variables: {{entity.name}}, {{counterparty.name}}, {{contract.total_value_fmt}}, {{contract.term_months}}, {{contract.notice_period_days | default:'60'}}…)" full><textarea className="input" style={{ minHeight: 160 }} value={String(edit.body)} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field>
        <Field label="Guía de uso"><textarea className="input" value={String(edit.usage_guide ?? "")} onChange={(e) => setEdit({ ...edit, usage_guide: e.target.value })} /></Field><Field label="Notas de negociación"><textarea className="input" value={String(edit.negotiation_notes ?? "")} onChange={(e) => setEdit({ ...edit, negotiation_notes: e.target.value })} /></Field>
      </div></Modal>}
    </div>
  );
}

function TemplatesAdmin() {
  const toast = useToast();
  const [items, setItems] = useState<Any[] | null>(null);
  const [types, setTypes] = useState<ContractType[]>([]);
  const [edit, setEdit] = useState<Any | null>(null);
  const [preview, setPreview] = useState<{ text: string; unresolved: string[]; clauses: string[] } | null>(null);
  const load = () => { api.get<{ items: Any[] }>("clm/templates").then((r) => setItems(r.items)); api.get<{ items: ContractType[] }>("clm/types").then((r) => setTypes(r.items)); };
  useEffect(() => { load(); }, []);
  const save = async () => { if (!edit) return; try { const body = { ...edit, type_id: edit.type_id || null }; if (edit.id) await api.put(`clm/templates/${edit.id}`, body); else await api.post("clm/templates", body); toast("Plantilla guardada", "ok"); setEdit(null); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  const doPreview = async (t: Any) => { try { setPreview(await api.post(`clm/templates/${t.id}/preview`, edit && edit.id === t.id ? { body: edit.body } : {})); } catch (e) { toast(errorMessage(e), "error"); } };
  if (!items) return <Spinner />;
  const KIND_ES: Record<string, string> = { contract: "Contrato", amendment: "Enmienda", renewal: "Renovación", termination: "Terminación", letter: "Carta" };
  return (
    <div>
      <div className="filterbar"><span className="small sub">Sintaxis: <code>{"{{variable | filtro}}"}</code> (money, date, words, upper, default), <code>{"{% if expr %}…{% else %}…{% endif %}"}</code>, <code>{"{% for item in deal.products %}"}</code>, <code>{'{% clause "E01-STD" if contract.contains_personal_data %}'}</code>, <code>{'{% signature_block party="us" %}'}</code>.</span><button className="btn primary right" onClick={() => setEdit({ name: "", type_id: "", kind: "contract", status: "approved", language: "es", body: "", description: "" })}><Plus />Plantilla</button></div>
      <div className="card tight"><table className="table"><thead><tr><th>Nombre</th><th>Clase</th><th>Tipo</th><th>Estado</th><th className="r">Versión</th><th className="r">Usos</th><th>Actualizada</th><th /></tr></thead><tbody>
        {items.map((t) => <tr key={String(t.id)} style={{ opacity: t.status === "retired" ? 0.5 : 1 }}><td className="bold">{String(t.name)}</td><td><span className="badge">{KIND_ES[String(t.kind)]}</span></td><td className="small">{types.find((x) => x.id === t.type_id)?.name ?? "Cualquiera"}</td><td className="small">{String(t.status)}</td><td className="r num">v{String(t.version)}</td><td className="r num">{String(t.uses)}</td><td className="small">{fmtDate(String(t.updated_at))}</td><td className="r nowrap"><button className="btn xs" onClick={() => doPreview(t)}><Eye />Vista previa</button><button className="iconbtn" onClick={() => setEdit({ ...t, type_id: t.type_id ?? "" })} aria-label="Editar"><Pencil size={14} /></button></td></tr>)}
      </tbody></table></div>
      {edit && <Modal title={edit.id ? `Plantilla: ${String(edit.name)}` : "Nueva plantilla"} size="xl" onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancelar</button>{edit.id && <button className="btn" onClick={() => doPreview(edit)}><Eye />Probar con datos ficticios</button>}<button className="btn primary" onClick={save}>Guardar{edit.id ? " (nueva versión)" : ""}</button></>}><div className="form-grid">
        <Field label="Nombre"><input className="input" value={String(edit.name)} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field><Field label="Clase"><select className="input" value={String(edit.kind)} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>{Object.entries(KIND_ES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <Field label="Tipo de contrato"><select className="input" value={String(edit.type_id)} onChange={(e) => setEdit({ ...edit, type_id: e.target.value })}><option value="">Cualquiera</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field><Field label="Estado"><select className="input" value={String(edit.status)} onChange={(e) => setEdit({ ...edit, status: e.target.value })}><option value="draft">Borrador</option><option value="approved">Aprobada</option><option value="retired">Retirada</option></select></Field>
        <Field label="Cuerpo" full><textarea className="input doc-editor" value={String(edit.body)} onChange={(e) => setEdit({ ...edit, body: e.target.value })} /></Field>
      </div></Modal>}
      {preview && <Modal title="Vista previa con datos de ejemplo" size="xl" onClose={() => setPreview(null)}>{preview.unresolved.length > 0 && <p className="small warn mb8">Variables sin resolver: {preview.unresolved.join(", ")}</p>}<p className="xs muted mb8">Cláusulas de biblioteca insertadas: {preview.clauses.join(", ") || "ninguna"}</p><div className="doc-view" style={{ maxHeight: "60vh", overflow: "auto" }}>{preview.text}</div></Modal>}
    </div>
  );
}

function PlaybooksAdmin() {
  const toast = useToast();
  const [items, setItems] = useState<Any[] | null>(null);
  const [types, setTypes] = useState<ContractType[]>([]);
  const [clauses, setClauses] = useState<Any[]>([]);
  const [cats, setCats] = useState<Record<string, string>>({});
  const [edit, setEdit] = useState<Any | null>(null);
  const load = () => { api.get<{ items: Any[] }>("clm/playbooks").then((r) => setItems(r.items)); api.get<{ items: ContractType[] }>("clm/types").then((r) => setTypes(r.items)); api.get<{ items: Any[] }>("clm/clauses").then((r) => setClauses(r.items)); api.get<{ categories: Record<string, string> }>("clm/meta").then((m) => setCats(m.categories)); };
  useEffect(() => { load(); }, []);
  const save = async () => { if (!edit) return; try { const body = { ...edit, type_id: edit.type_id || null, rules: (edit.rules as Any[]).map((r) => ({ ...r, acceptable: typeof r.acceptable === "string" ? String(r.acceptable).split(",").map((s) => s.trim()).filter(Boolean) : r.acceptable, prohibited_patterns: typeof r.prohibited_patterns === "string" ? String(r.prohibited_patterns).split("\n").map((s) => s.trim()).filter(Boolean) : r.prohibited_patterns, thresholds: Object.fromEntries(Object.entries((r.thresholds as Any) ?? {}).filter(([, v]) => v !== "" && v !== null).map(([k, v]) => [k, Number(v)])) })) }; if (edit.id) await api.put(`clm/playbooks/${edit.id}`, body); else await api.post("clm/playbooks", body); toast("Playbook guardado", "ok"); setEdit(null); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  if (!items) return <Spinner />;
  const rules = (edit?.rules as Any[]) ?? [];
  const setRule = (i: number, p: Any) => setEdit({ ...edit, rules: rules.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const th = (r: Any, k: string) => String(((r.thresholds as Any) ?? {})[k] ?? "");
  const setTh = (i: number, k: string, v: string) => setRule(i, { thresholds: { ...((rules[i]!.thresholds as Any) ?? {}), [k]: v } });
  return (
    <div>
      <div className="filterbar"><span className="small sub">Un playbook por tipo y dirección: por cada categoría define si es obligatoria, la variante preferida, las aceptables, el último recurso, umbrales (tope de responsabilidad, plazo de pago, preaviso), patrones prohibidos y quién aprueba cada nivel de desviación.</span><button className="btn primary right" onClick={() => setEdit({ name: "", type_id: "", direction: "income", active: true, rules: [] })}><Plus />Playbook</button></div>
      <div className="card tight"><table className="table"><thead><tr><th>Nombre</th><th>Tipo</th><th>Dirección</th><th className="r">Reglas</th><th>Activo</th><th /></tr></thead><tbody>
        {items.map((p) => <tr key={String(p.id)}><td className="bold">{String(p.name)}</td><td className="small">{types.find((t) => t.id === p.type_id)?.name ?? "Cualquiera"}</td><td className="small">{p.direction === "both" ? "Ambas" : p.direction === "income" ? "Venta" : "Compra"}</td><td className="r num">{(p.rules as Any[]).length}</td><td>{p.active ? <span className="badge ok">sí</span> : <span className="badge">no</span>}</td><td className="r"><button className="iconbtn" onClick={() => setEdit({ ...p, type_id: p.type_id ?? "", active: !!p.active })} aria-label="Editar"><Pencil size={14} /></button></td></tr>)}
      </tbody></table></div>
      {edit && <Modal title={edit.id ? `Playbook: ${String(edit.name)}` : "Nuevo playbook"} size="xl" onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}>
        <div className="form-grid mb12"><Field label="Nombre"><input className="input" value={String(edit.name)} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field><Field label="Tipo"><select className="input" value={String(edit.type_id)} onChange={(e) => setEdit({ ...edit, type_id: e.target.value })}><option value="">Cualquiera (por dirección)</option>{types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field><Field label="Dirección"><select className="input" value={String(edit.direction)} onChange={(e) => setEdit({ ...edit, direction: e.target.value })}><option value="income">Venta</option><option value="expense">Compra</option><option value="both">Ambas</option></select></Field><label className="checkbox"><input type="checkbox" checked={!!edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />Activo</label></div>
        {rules.map((r, i) => (
          <div key={i} className="card mb8" style={{ background: "var(--panel)" }}>
            <div className="row wrap mb8"><select className="input sm" style={{ width: 300 }} value={String(r.category)} onChange={(e) => setRule(i, { category: e.target.value })}>{Object.entries(cats).map(([k, v]) => <option key={k} value={k}>{k} · {v}</option>)}</select><label className="checkbox small"><input type="checkbox" checked={!!r.must_exist} onChange={(e) => setRule(i, { must_exist: e.target.checked })} />Obligatoria</label><label className="checkbox small"><input type="checkbox" checked={!!r.must_exist_if_personal_data} onChange={(e) => setRule(i, { must_exist_if_personal_data: e.target.checked })} />Obligatoria si hay datos personales</label><select className="input sm" style={{ width: 180 }} value={String(r.if_present ?? "")} onChange={(e) => setRule(i, { if_present: e.target.value || undefined })}><option value="">Si aparece: evaluar</option><option value="minor">Si aparece: menor</option><option value="major">Si aparece: mayor</option><option value="prohibited">Si aparece: prohibida</option></select><button className="iconbtn right" onClick={() => setEdit({ ...edit, rules: rules.filter((_, j) => j !== i) })} aria-label="Borrar"><Trash2 size={14} /></button></div>
            <div className="form-grid">
              <Field label="Variante preferida"><select className="input sm" value={String(r.preferred ?? "")} onChange={(e) => setRule(i, { preferred: e.target.value || null })}><option value="">—</option>{clauses.filter((c) => c.category === r.category).map((c) => <option key={String(c.id)} value={String(c.code)}>{String(c.code)} · {String(c.title)}</option>)}</select></Field>
              <Field label="Aceptables (códigos, coma)"><input className="input sm" value={Array.isArray(r.acceptable) ? (r.acceptable as string[]).join(", ") : String(r.acceptable ?? "")} onChange={(e) => setRule(i, { acceptable: e.target.value })} /></Field>
              <Field label="Último recurso"><input className="input sm" value={String(r.fallback ?? "")} onChange={(e) => setRule(i, { fallback: e.target.value || null })} /></Field>
              <Field label="Aprueba desviación menor / mayor"><div className="row"><input className="input sm" value={String(r.minor_approver ?? "")} onChange={(e) => setRule(i, { minor_approver: e.target.value })} placeholder="legal" /><input className="input sm" value={String(r.major_approver ?? "")} onChange={(e) => setRule(i, { major_approver: e.target.value })} placeholder="legal_director" /></div></Field>
              {r.category === "E01" && <Field label="Tope de responsabilidad mín. / máx. (% del valor anual)"><div className="row"><input className="input sm" type="number" value={th(r, "liability_cap_min_pct")} onChange={(e) => setTh(i, "liability_cap_min_pct", e.target.value)} /><input className="input sm" type="number" value={th(r, "liability_cap_max_pct")} onChange={(e) => setTh(i, "liability_cap_max_pct", e.target.value)} /></div></Field>}
              {r.category === "C02" && <Field label="Plazo de pago preferido / máximo / legal (días)"><div className="row"><input className="input sm" type="number" value={th(r, "payment_days_preferred")} onChange={(e) => setTh(i, "payment_days_preferred", e.target.value)} /><input className="input sm" type="number" value={th(r, "payment_days_max")} onChange={(e) => setTh(i, "payment_days_max", e.target.value)} /><input className="input sm" type="number" value={th(r, "payment_days_legal_max")} onChange={(e) => setTh(i, "payment_days_legal_max", e.target.value)} /></div></Field>}
              {r.category === "B03" && <Field label="Preaviso mínimo / máximo (días)"><div className="row"><input className="input sm" type="number" value={th(r, "notice_period_days_min")} onChange={(e) => setTh(i, "notice_period_days_min", e.target.value)} /><input className="input sm" type="number" value={th(r, "notice_period_days_max")} onChange={(e) => setTh(i, "notice_period_days_max", e.target.value)} /></div></Field>}
              {r.category === "I01" && <Field label="Leyes preferidas / aceptables (ISO, coma)"><div className="row"><input className="input sm" value={((r.preferred_values as string[]) ?? []).join(", ")} onChange={(e) => setRule(i, { preferred_values: e.target.value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) })} /><input className="input sm" value={((r.acceptable_values as string[]) ?? []).join(", ")} onChange={(e) => setRule(i, { acceptable_values: e.target.value.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) })} /></div></Field>}
              <Field label="Patrones prohibidos (regex, uno por línea)" full><textarea className="input sm" value={Array.isArray(r.prohibited_patterns) ? (r.prohibited_patterns as string[]).join("\n") : String(r.prohibited_patterns ?? "")} onChange={(e) => setRule(i, { prohibited_patterns: e.target.value })} /></Field>
              <Field label="Guía para el negociador" full><input className="input sm" value={String(r.guidance ?? "")} onChange={(e) => setRule(i, { guidance: e.target.value })} /></Field>
            </div>
          </div>))}
        <button className="btn sm" onClick={() => setEdit({ ...edit, rules: [...rules, { category: "E01", must_exist: true, minor_approver: "legal", major_approver: "legal_director", thresholds: {} }] })}><Plus />Regla</button>
      </Modal>}
    </div>
  );
}

function AuthorityAdmin() {
  const toast = useToast(); const { users, isAdmin } = useApp();
  const [items, setItems] = useState<Any[] | null>(null);
  const [types, setTypes] = useState<ContractType[]>([]);
  const [edit, setEdit] = useState<Any | null>(null);
  const load = () => { api.get<{ items: Any[] }>("clm/authority").then((r) => setItems(r.items)); api.get<{ items: ContractType[] }>("clm/types").then((r) => setTypes(r.items)); };
  useEffect(() => { load(); }, []);
  const save = async () => { if (!edit) return; try { await api.post("clm/authority", { ...edit, max_value: edit.max_value === "" ? null : Number(edit.max_value), valid_from: edit.valid_from || null, valid_to: edit.valid_to || null }); toast("Poder registrado", "ok"); setEdit(null); load(); } catch (e) { toast(errorMessage(e), "error"); } };
  if (!items) return <Spinner />;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div>
      <div className="filterbar"><span className="small sub">Matriz de autoridad de firma: quién puede firmar qué tipos y hasta qué importe, con referencia al poder notarial y su vigencia. Al enviar a firma se valida; los poderes caducados bloquean el envío.</span>{isAdmin && <button className="btn primary right" onClick={() => setEdit({ user_id: users[0]?.id, type_codes: [], max_value: "", requires_joint: false, valid_from: "", valid_to: "", power_ref: "" })}><Plus />Poder</button>}</div>
      <div className="card tight"><table className="table"><thead><tr><th>Usuario</th><th>Tipos</th><th className="r">Importe máximo</th><th>Mancomunada</th><th>Vigencia</th><th>Poder</th><th /></tr></thead><tbody>
        {items.map((a) => { const expired = a.valid_to && String(a.valid_to) < today; return <tr key={String(a.id)} style={{ opacity: expired ? 0.6 : 1 }}><td className="bold">{String(a.user_name)}</td><td className="small">{(a.type_codes as string[]).length ? (a.type_codes as string[]).join(", ") : "Todos"}</td><td className="r num">{a.max_value == null ? "Sin límite" : fmtMoney(Number(a.max_value))}</td><td>{a.requires_joint ? "Sí" : "No"}</td><td className="small">{a.valid_from ? fmtDate(String(a.valid_from)) : "—"} → {a.valid_to ? fmtDate(String(a.valid_to)) : "indefinida"}{expired ? <span className="badge risk" style={{ marginLeft: 6 }}>caducado</span> : null}</td><td className="small muted">{String(a.power_ref ?? "")}</td><td className="r">{isAdmin && <button className="iconbtn" onClick={() => api.del(`clm/authority/${a.id}`).then(load)} aria-label="Borrar"><Trash2 size={14} /></button>}</td></tr>; })}
      </tbody></table></div>
      {edit && <Modal title="Nuevo poder de firma" onClose={() => setEdit(null)} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}><div className="form-grid">
        <Field label="Usuario" full><select className="input" value={String(edit.user_id)} onChange={(e) => setEdit({ ...edit, user_id: e.target.value })}>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
        <Field label="Tipos (vacío = todos)" full><div className="row wrap">{types.map((t) => <label key={t.id} className="checkbox small"><input type="checkbox" checked={(edit.type_codes as string[]).includes(t.code)} onChange={(e) => setEdit({ ...edit, type_codes: e.target.checked ? [...(edit.type_codes as string[]), t.code] : (edit.type_codes as string[]).filter((x) => x !== t.code) })} />{t.code}</label>)}</div></Field>
        <Field label="Importe máximo (vacío = sin límite)"><input className="input" type="number" value={String(edit.max_value)} onChange={(e) => setEdit({ ...edit, max_value: e.target.value })} /></Field><Field label="Referencia del poder"><input className="input" value={String(edit.power_ref)} onChange={(e) => setEdit({ ...edit, power_ref: e.target.value })} placeholder="Escritura nº … notario …" /></Field>
        <Field label="Válido desde"><input className="input" type="date" value={String(edit.valid_from)} onChange={(e) => setEdit({ ...edit, valid_from: e.target.value })} /></Field><Field label="Válido hasta"><input className="input" type="date" value={String(edit.valid_to)} onChange={(e) => setEdit({ ...edit, valid_to: e.target.value })} /></Field>
        <label className="checkbox"><input type="checkbox" checked={!!edit.requires_joint} onChange={(e) => setEdit({ ...edit, requires_joint: e.target.checked })} />Firma mancomunada (requiere dos firmantes internos)</label>
      </div></Modal>}
    </div>
  );
}
