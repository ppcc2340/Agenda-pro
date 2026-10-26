import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, useLayoutEffect, isValidElement, cloneElement, Children, type ReactElement } from "react";
import { X, ChevronLeft, ChevronRight, Check, Search } from "lucide-react";
import { initials } from "../lib/format";
import { api } from "../api";
import { t } from "../lib/i18n";
const tr = t;

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
          <div key={t.id} className={`toast ${t.kind ?? ""}`} role={t.kind === "error" ? "alert" : undefined}>
            {t.kind === "ok" && <Check size={16} />}
            <span>{t.text}</span>
            <button onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))} aria-label={tr("common.close")}>×</button>
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
          <button className="btn" onClick={() => { state.resolve(false); setState(null); }}>{t("common.cancel")}</button>
          <button className={`btn ${state.danger ? "danger" : "primary"}`} autoFocus onClick={() => { state.resolve(true); setState(null); }}>{state.confirmText ?? t("common.confirm")}</button>
        </>}>
          {state.text && <p className="sub">{state.text}</p>}
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);

// ---------- Modal / Drawer ----------
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** Diálogo accesible: Escape cierra (solo el de encima), el foco queda atrapado dentro y vuelve al elemento que lo abrió. */
function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) { const first = el.querySelector<HTMLElement>("[autofocus], .modal-body " + FOCUSABLE) ?? el.querySelector<HTMLElement>(FOCUSABLE); (first ?? el).focus({ preventScroll: true }); }
    const h = (e: KeyboardEvent) => {
      const all = Array.from(document.querySelectorAll<HTMLElement>("[data-dialog]"));
      if (all[all.length - 1] !== ref.current) return; // solo el diálogo superior
      if (e.key === "Escape") { e.stopPropagation(); closeRef.current(); return; }
      if (e.key === "Tab" && ref.current) {
        const f = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null || x === document.activeElement);
        if (!f.length) return;
        const first = f[0]!, last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", h);
    return () => { window.removeEventListener("keydown", h); if (prev && document.contains(prev)) prev.focus({ preventScroll: true }); };
  }, []);
  return ref;
}
export function Modal({ title, onClose, children, footer, size }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: "lg" | "xl" }) {
  const ref = useDialog(onClose);
  const id = useId();
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} data-dialog className={`modal ${size ?? ""}`} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} tabIndex={-1}>
        <div className="modal-head"><h2 id={`${id}-t`}>{title}</h2><button className="iconbtn" onClick={onClose} aria-label={t("common.close")}><X size={18} /></button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
export function Drawer({ title, onClose, children, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useDialog(onClose);
  const id = useId();
  return (
    <div className="drawer-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} data-dialog className="drawer" role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} tabIndex={-1}>
        <div className="modal-head"><h2 id={`${id}-t`}>{title}</h2><button className="iconbtn" onClick={onClose} aria-label={t("common.close")}><X size={18} /></button></div>
        <div className="modal-body grow">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- Misc ----------
export const Spinner = () => <div className="spinner" role="status" aria-label={t("common.loading")} />;
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
  return <div className="seg" role="group">{items.map((t) => <button key={t.key} className={value === t.key ? "active" : ""} aria-pressed={value === t.key} onClick={() => onChange(t.key)}>{t.label}</button>)}</div>;
}
export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <span>{total === 0 ? t("common.noResults") : t("common.of", { a: (page - 1) * pageSize + 1, b: Math.min(total, page * pageSize), total })}</span>
      <span className="right row">
        <button className="btn sm ghost" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t("common.prev")}><ChevronLeft /></button>
        <span>{page} / {pages}</span>
        <button className="btn sm ghost" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t("common.next")}><ChevronRight /></button>
      </span>
    </div>
  );
}
export function Field({ label, children, hint, error, full }: { label?: string; children: ReactNode; hint?: string; error?: string; full?: boolean }) {
  const id = useId();
  // el primer control nativo del campo queda asociado a su etiqueta (lectores de pantalla y clic en la etiqueta)
  const kids = Children.toArray(children);
  const first = kids[0];
  const ctl = isValidElement(first) && typeof first.type === "string" && ["input", "select", "textarea"].includes(first.type) && !(first.props as Record<string, unknown>).id;
  const out = ctl ? [cloneElement(first as ReactElement<Record<string, unknown>>, { id }), ...kids.slice(1)] : children;
  return <div className={`field ${full ? "full" : ""}`} role={!ctl && label ? "group" : undefined} aria-labelledby={!ctl && label ? `${id}-l` : undefined}>{label && <label id={`${id}-l`} htmlFor={ctl ? id : undefined}>{label}</label>}{out}{hint && !error && <span className="hint">{hint}</span>}{error && <span className="error">{error}</span>}</div>;
}
export function Menu({ trigger, children, fixed }: { trigger: ReactNode; children: ReactNode; /** posición fija: no lo recorta un contenedor con scroll (tablas) */ fixed?: boolean }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<React.CSSProperties | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !fixed || !ref.current) { setPos(undefined); return; }
    const r = ref.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom > 280;
    setPos({ position: "fixed", left: Math.max(8, Math.min(r.left, window.innerWidth - 240)), right: "auto", ...(below ? { top: r.bottom + 4 } : { top: "auto", bottom: window.innerHeight - r.top + 4 }), maxHeight: "60vh", overflowY: "auto", zIndex: 140 });
  }, [open, fixed]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    // el foco entra en la primera opción para poder usar las flechas
    setTimeout(() => ref.current?.querySelector<HTMLElement>(".menu button:not([disabled]), .menu a")?.focus({ preventScroll: true }), 0);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  const items = () => Array.from(ref.current?.querySelectorAll<HTMLElement>(".menu button:not([disabled]), .menu a") ?? []);
  const onKey = (e: React.KeyboardEvent) => {
    if (!open) { if ((e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") && (e.target as HTMLElement).closest("button") && !(e.target as HTMLElement).closest(".menu")) { /* el botón abre con su clic */ } return; }
    const list = items(); const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); e.stopPropagation(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); ref.current?.querySelector<HTMLElement>("button")?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  };
  return <div ref={ref} style={{ position: "relative", display: "inline-block" }} onKeyDown={onKey}><span onClick={() => setOpen((o) => !o)}>{isValidElement(trigger) && trigger.type === "button" ? cloneElement(trigger as ReactElement<Record<string, unknown>>, { "aria-haspopup": "menu", "aria-expanded": open }) : trigger}</span>{open && <div className="menu" role="menu" style={pos} onClick={() => setOpen(false)}>{children}</div>}</div>;
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
