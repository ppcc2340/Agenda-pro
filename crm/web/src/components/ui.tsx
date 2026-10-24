import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { X, ChevronLeft, ChevronRight, Check, Search } from "lucide-react";
import { initials } from "../lib/format";
import { api } from "../api";

// ---------- Toasts ----------
type Toast = { id: number; text: string; kind?: "ok" | "error" | "info" };
const ToastCtx = createContext<{ push: (text: string, kind?: Toast["kind"]) => void }>({ push: () => undefined });
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = (text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === "error" ? 6000 : 3500);
  };
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind ?? ""}`}>
            {t.kind === "ok" && <Check size={16} />}
            <span>{t.text}</span>
            <button onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))} aria-label="Cerrar">×</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx).push;

// ---------- Confirm ----------
type ConfirmOpts = { title: string; text?: string; confirmText?: string; danger?: boolean };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(() => Promise.resolve(false));
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const ask = (o: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...o, resolve }));
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {state && (
        <Modal title={state.title} onClose={() => { state.resolve(false); setState(null); }} footer={<>
          <button className="btn" onClick={() => { state.resolve(false); setState(null); }}>Cancelar</button>
          <button className={`btn ${state.danger ? "danger" : "primary"}`} autoFocus onClick={() => { state.resolve(true); setState(null); }}>{state.confirmText ?? "Confirmar"}</button>
        </>}>
          {state.text && <p className="sub">{state.text}</p>}
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);

// ---------- Modal / Drawer ----------
export function Modal({ title, onClose, children, footer, size }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: "lg" | "xl" }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${size ?? ""}`} role="dialog" aria-modal="true">
        <div className="modal-head"><h2>{title}</h2><button className="iconbtn" onClick={onClose} aria-label="Cerrar"><X size={18} /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
export function Drawer({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="drawer-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="drawer" role="dialog" aria-modal="true">
        <div className="modal-head"><h2>{title}</h2><button className="iconbtn" onClick={onClose} aria-label="Cerrar"><X size={18} /></button></div>
        <div className="modal-body grow">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- Misc ----------
export const Spinner = () => <div className="spinner" aria-label="Cargando" />;
export function Empty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return <div className="empty"><h3>{title}</h3>{text && <p>{text}</p>}{action && <div className="mt12">{action}</div>}</div>;
}
export function Avatar({ name, size }: { name: string | null | undefined; size?: "sm" | "lg" }) {
  return <span className={`avatar ${size ?? ""}`} title={name ?? ""}>{initials(name)}</span>;
}
export function Tabs({ items, value, onChange }: { items: { key: string; label: string; count?: number }[]; value: string; onChange: (k: string) => void }) {
  return <div className="tabs" role="tablist">{items.map((t) => <button key={t.key} role="tab" aria-selected={value === t.key} className={value === t.key ? "active" : ""} onClick={() => onChange(t.key)}>{t.label}{t.count !== undefined && <span className="muted"> {t.count}</span>}</button>)}</div>;
}
export function Seg<T extends string>({ items, value, onChange }: { items: { key: T; label: string }[]; value: T; onChange: (k: T) => void }) {
  return <div className="seg">{items.map((t) => <button key={t.key} className={value === t.key ? "active" : ""} onClick={() => onChange(t.key)}>{t.label}</button>)}</div>;
}
export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <span>{total === 0 ? "Sin resultados" : `${(page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)} de ${total}`}</span>
      <span className="right row">
        <button className="btn sm ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft /></button>
        <span>{page} / {pages}</span>
        <button className="btn sm ghost" disabled={page >= pages} onClick={() => onPage(page + 1)}><ChevronRight /></button>
      </span>
    </div>
  );
}
export function Field({ label, children, hint, error, full }: { label?: string; children: ReactNode; hint?: string; error?: string; full?: boolean }) {
  return <div className={`field ${full ? "full" : ""}`}>{label && <label>{label}</label>}{children}{hint && !error && <span className="hint">{hint}</span>}{error && <span className="error">{error}</span>}</div>;
}
export function Menu({ trigger, children }: { trigger: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return <div ref={ref} style={{ position: "relative", display: "inline-block" }}><span onClick={() => setOpen((o) => !o)}>{trigger}</span>{open && <div className="menu" onClick={() => setOpen(false)}>{children}</div>}</div>;
}
export function TagInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState("");
  const add = () => { const t = text.trim(); if (t && !value.includes(t)) onChange([...value, t]); setText(""); };
  return (
    <div className="input row wrap" style={{ minHeight: 34, padding: "4px 8px" }}>
      {value.map((t) => <span key={t} className="tag">{t}<button type="button" onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Quitar ${t}`}><X size={11} /></button></span>)}
      <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1)); }} onBlur={add} placeholder={value.length ? "" : (placeholder ?? "Añadir etiqueta…")} style={{ border: 0, outline: 0, background: "transparent", flex: 1, minWidth: 80, fontSize: 13 }} />
    </div>
  );
}
export function ScoreBar({ value }: { value: number }) {
  return <span className="score num"><span className="bar"><div style={{ width: `${Math.min(100, value)}%`, background: value >= 80 ? "var(--ok)" : value >= 50 ? "var(--sea)" : "var(--ink3)" }} /></span>{value}</span>;
}

/** Async record picker (contacts, companies, deals, users). */
export function Picker({ kind, value, onChange, placeholder, allowEmpty = true, autoFocus }: { kind: "contact" | "company" | "deal" | "user"; value: string | null | undefined; onChange: (id: string | null, item?: PickItem) => void; placeholder?: string; allowEmpty?: boolean; autoFocus?: boolean }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<PickItem[]>([]);
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!value) { setLabel(null); return; }
    let alive = true;
    const url = kind === "contact" ? `contacts/${value}` : kind === "company" ? `companies/${value}` : kind === "deal" ? `deals/${value}` : null;
    if (kind === "user") { api.get<{ items: { id: string; name: string }[] }>("admin/users").then((r) => { if (alive) setLabel(r.items.find((u) => u.id === value)?.name ?? null); }).catch(() => undefined); return; }
    api.get<Record<string, unknown>>(url!).then((r) => { if (alive) setLabel(kind === "contact" ? `${r.first_name} ${r.last_name}` : String(r.name)); }).catch(() => { if (alive) setLabel(null); });
    return () => { alive = false; };
  }, [value, kind]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        if (kind === "user") { const r = await api.get<{ items: { id: string; name: string; email: string; active: boolean }[] }>("admin/users"); if (alive) setItems(r.items.filter((u) => u.active && (!q || u.name.toLowerCase().includes(q.toLowerCase()))).map((u) => ({ id: u.id, label: u.name, sub: u.email }))); return; }
        const r = await api.get<{ contacts: PickRaw[]; companies: PickRaw[]; deals: PickRaw[] }>(`search?q=${encodeURIComponent(q || "a")}`);
        const list = kind === "contact" ? r.contacts.map((c) => ({ id: c.id, label: `${c.first_name} ${c.last_name}`, sub: c.company_name ?? c.email ?? "" })) : kind === "company" ? r.companies.map((c) => ({ id: c.id, label: c.name!, sub: c.domain ?? "" })) : r.deals.map((d) => ({ id: d.id, label: d.name!, sub: d.company_name ?? "" }));
        if (alive) setItems(list);
      } catch { /* ignore */ }
    }, 150);
    return () => { alive = false; clearTimeout(t); };
  }, [q, open, kind]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  const ph = placeholder ?? ({ contact: "Buscar contacto…", company: "Buscar empresa…", deal: "Buscar negocio…", user: "Buscar usuario…" }[kind]);
  return (
    <div ref={ref} style={{ position: "relative" }}>
      {value && label !== null && !open ? (
        <div className="input row" style={{ cursor: "pointer" }} onClick={() => { setOpen(true); setQ(""); }}><span className="grow ell">{label}</span>{allowEmpty && <button type="button" className="iconbtn" style={{ width: 22, height: 22 }} onClick={(e) => { e.stopPropagation(); onChange(null); }} aria-label="Quitar"><X size={13} /></button>}</div>
      ) : (
        <div className="input row"><Search size={14} className="muted" /><input autoFocus={autoFocus} value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }} onFocus={() => setOpen(true)} onKeyDown={(e) => { if (e.key === "ArrowDown") setActive((a) => Math.min(items.length - 1, a + 1)); if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1)); if (e.key === "Enter" && items[active]) { e.preventDefault(); onChange(items[active].id, items[active]); setLabel(items[active].label); setOpen(false); } }} placeholder={ph} style={{ border: 0, outline: 0, background: "transparent", flex: 1, fontSize: 13.5 }} /></div>
      )}
      {open && (
        <div className="menu" style={{ left: 0, right: 0, maxHeight: 260, overflowY: "auto" }}>
          {items.length === 0 && <div className="muted small" style={{ padding: 8 }}>Sin resultados</div>}
          {items.map((it, i) => <button type="button" key={it.id} className={i === active ? "active" : ""} style={i === active ? { background: "var(--panel)" } : undefined} onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(it.id, it); setLabel(it.label); setOpen(false); }}><span className="grow ell">{it.label}</span><span className="muted small ell">{it.sub}</span></button>)}
        </div>
      )}
    </div>
  );
}
export type PickItem = { id: string; label: string; sub?: string };
type PickRaw = { id: string; first_name?: string; last_name?: string; name?: string; email?: string | null; company_name?: string | null; domain?: string | null };

export function useDebounce<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Error inesperado";
}
