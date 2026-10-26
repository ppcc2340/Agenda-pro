import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, Pencil, ExternalLink } from "lucide-react";
import { api } from "../api";
import { useApp } from "../lib/app";
import { Modal, Field, Spinner, Empty, useToast, errorMessage } from "../components/ui";
import { fmtMoney2, fmtDate, QUOTE_STATUS } from "../lib/format";

interface P { id: string; sku: string | null; name: string; description: string | null; unit_price: number; currency: string; tax_rate: number; cost: number | null; category: string | null; unit: string; billing_period: string; active: number }

export function ProductsPage() {
  const [items, setItems] = useState<P[] | null>(null);
  const [editing, setEditing] = useState<P | "new" | null>(null);
  const { can } = useApp();
  const load = () => api.get<{ items: P[] }>("products").then((r) => setItems(r.items));
  useEffect(() => { load(); }, []);
  return (
    <div>
      <div className="page-head"><div><h1>Catálogo de productos</h1><p className="sub">Productos y servicios para líneas de negocio y presupuestos.</p></div>{can("product", "create") && <button className="btn primary" onClick={() => setEditing("new")}><Plus />Nuevo producto</button>}</div>
      {!items ? <Spinner /> : items.length === 0 ? <div className="card"><Empty title="Sin productos" action={<button className="btn primary" onClick={() => setEditing("new")}>Crear el primero</button>} /></div> : (
        <div className="card tight"><table className="table"><thead><tr><th>SKU</th><th>Producto</th><th>Categoría</th><th className="r">Precio</th><th className="r">IVA</th><th className="r">Coste</th><th className="r">Margen</th><th>Periodo</th><th>Estado</th><th></th></tr></thead><tbody>
          {items.map((p) => <tr key={p.id}><td className="muted">{p.sku}</td><td><div className="bold">{p.name}</div>{p.description && <div className="xs muted">{p.description}</div>}</td><td>{p.category}</td><td className="r num">{fmtMoney2(p.unit_price, p.currency)}</td><td className="r num">{p.tax_rate}%</td><td className="r num">{p.cost != null ? fmtMoney2(p.cost, p.currency) : ""}</td><td className="r num">{p.cost != null && p.unit_price ? `${Math.round((100 * (p.unit_price - p.cost)) / p.unit_price)}%` : ""}</td><td>{p.billing_period === "one_time" ? "único" : p.billing_period === "monthly" ? "mensual" : "anual"}</td><td>{p.active ? <span className="badge ok">activo</span> : <span className="badge">inactivo</span>}</td><td className="r"><button className="iconbtn" onClick={() => setEditing(p)} aria-label="Editar"><Pencil size={15} /></button></td></tr>)}
        </tbody></table></div>
      )}
      {editing && <ProductForm product={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}

function ProductForm({ product, onClose, onSaved }: { product: P | null; onClose: () => void; onSaved: () => void }) {
  const { settings } = useApp();
  const toast = useToast();
  const [f, setF] = useState<Partial<P>>({ sku: "", name: "", description: "", unit_price: 0, currency: settings.currency, tax_rate: 21, cost: null, category: "", unit: "ud", billing_period: "one_time", active: 1, ...(product ?? {}) });
  const set = (k: keyof P, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => { try { const payload = { ...f, active: !!f.active, cost: f.cost === null || (f.cost as unknown) === "" ? null : Number(f.cost), unit_price: Number(f.unit_price), tax_rate: Number(f.tax_rate), sku: f.sku || null, category: f.category || null, description: f.description || null }; if (product) await api.put(`products/${product.id}`, payload); else await api.post("products", payload); toast("Producto guardado", "ok"); onSaved(); onClose(); } catch (e) { toast(errorMessage(e), "error"); } };
  return (
    <Modal title={product ? "Editar producto" : "Nuevo producto"} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}>
      <div className="form-grid">
        <Field label="Nombre *" full><input className="input" autoFocus value={f.name ?? ""} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="SKU"><input className="input" value={f.sku ?? ""} onChange={(e) => set("sku", e.target.value)} /></Field>
        <Field label="Categoría"><input className="input" value={f.category ?? ""} onChange={(e) => set("category", e.target.value)} /></Field>
        <Field label={`Precio unitario (${f.currency})`}><input className="input" type="number" step="0.01" value={f.unit_price ?? 0} onChange={(e) => set("unit_price", e.target.value)} /></Field>
        <Field label="IVA %"><input className="input" type="number" value={f.tax_rate ?? 21} onChange={(e) => set("tax_rate", e.target.value)} /></Field>
        <Field label="Coste (para margen)"><input className="input" type="number" step="0.01" value={f.cost ?? ""} onChange={(e) => set("cost", e.target.value)} /></Field>
        <Field label="Periodicidad"><select className="input" value={f.billing_period} onChange={(e) => set("billing_period", e.target.value)}><option value="one_time">Pago único</option><option value="monthly">Mensual</option><option value="yearly">Anual</option></select></Field>
        <Field label="Descripción" full><textarea className="input" value={f.description ?? ""} onChange={(e) => set("description", e.target.value)} /></Field>
        <label className="checkbox full"><input type="checkbox" checked={!!f.active} onChange={(e) => set("active", e.target.checked ? 1 : 0)} />Activo (disponible en presupuestos)</label>
      </div>
    </Modal>
  );
}

export function QuotesPage() {
  const [items, setItems] = useState<{ id: string; number: string; version: number; status: string; total: number; date: string; valid_until: string | null; views: number; deal_id: string; deal_name: string; company_name: string | null }[] | null>(null);
  useEffect(() => { api.get<{ items: NonNullable<typeof items> }>("quotes").then((r) => setItems(r.items)); }, []);
  return (
    <div>
      <div className="page-head"><div><h1>Presupuestos</h1><p className="sub">Se crean desde la ficha del negocio. El cliente los ve y acepta desde un enlace con seguimiento.</p></div></div>
      {!items ? <Spinner /> : items.length === 0 ? <div className="card"><Empty title="Sin presupuestos" text="Abre un negocio y pulsa «Nuevo presupuesto»." /></div> : (
        <div className="card tight"><table className="table"><thead><tr><th>Número</th><th>Negocio</th><th>Cliente</th><th>Estado</th><th className="r">Total</th><th>Fecha</th><th>Validez</th><th className="r">Vistas</th><th></th></tr></thead><tbody>
          {items.map((q) => <tr key={q.id}><td className="bold">{q.number} <span className="muted">v{q.version}</span></td><td><Link to={`/negocios/${q.deal_id}`}>{q.deal_name}</Link></td><td>{q.company_name}</td><td><span className={`badge ${q.status === "accepted" ? "ok" : q.status === "rejected" || q.status === "expired" ? "risk" : q.status === "viewed" ? "sea" : ""}`}>{QUOTE_STATUS[q.status]}</span></td><td className="r num">{fmtMoney2(q.total)}</td><td>{fmtDate(q.date)}</td><td>{fmtDate(q.valid_until)}</td><td className="r num">{q.views}</td><td className="r"><Link to={`/negocios/${q.deal_id}?tab=quotes`} className="btn xs"><ExternalLink />Abrir</Link></td></tr>)}
        </tbody></table></div>
      )}
    </div>
  );
}
