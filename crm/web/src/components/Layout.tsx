import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Link, useNavigate, useLocation } from "react-router-dom";
import { Home, Sun, Users, Building2, Handshake, CheckSquare, LifeBuoy, BarChart3, Settings, Search, Bell, LogOut, Package, FileText, ListChecks, Menu as MenuIcon, X } from "lucide-react";
import { useApp } from "../lib/app";
import { api } from "../api";
import { Avatar, Menu } from "./ui";
import { relTime, fmtMoney } from "../lib/format";

const NAV = [
  { to: "/", label: "Inicio", icon: Home, end: true },
  { to: "/mi-dia", label: "Mi día", icon: Sun },
  { to: "/contactos", label: "Contactos", icon: Users },
  { to: "/empresas", label: "Empresas", icon: Building2 },
  { to: "/negocios", label: "Negocios", icon: Handshake },
  { to: "/tareas", label: "Tareas", icon: CheckSquare },
  { to: "/tickets", label: "Tickets", icon: LifeBuoy },
  { to: "/listas", label: "Listas", icon: ListChecks },
  { to: "/productos", label: "Productos", icon: Package },
  { to: "/presupuestos", label: "Presupuestos", icon: FileText },
  { to: "/informes", label: "Informes", icon: BarChart3 },
];

export function Layout({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  const { me, settings } = useApp();
  const [palette, setPalette] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  useEffect(() => { setMobileNav(false); }, [loc.pathname]);
  const logout = async () => { await api.post("auth/logout").catch(() => undefined); onLogout(); };
  const navItems = (
    <nav className="nav">
      {NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "active" : "")}><n.icon />{n.label}</NavLink>)}
      <div className="section">Administración</div>
      <NavLink to="/ajustes" className={({ isActive }) => (isActive ? "active" : "")}><Settings />Ajustes</NavLink>
    </nav>
  );
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand"><span className="logo">{(settings.company_name || "C").slice(0, 1).toUpperCase()}</span><span className="ell">{settings.company_name || "CRM"}</span></div>
        {navItems}
        <div className="user">
          <Avatar name={me.name} />
          <div className="grow" style={{ minWidth: 0 }}><div className="ell" style={{ color: "#fff", fontWeight: 600, fontSize: 13 }}>{me.name}</div><div className="ell xs" style={{ color: "#8da0b1" }}>{me.role.name}</div></div>
          <button className="iconbtn" style={{ color: "#8da0b1" }} onClick={logout} title="Cerrar sesión"><LogOut size={16} /></button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="iconbtn" style={{ display: "none" }} id="mobile-menu-btn" onClick={() => setMobileNav(true)}><MenuIcon size={20} /></button>
          <div className="search-trigger" onClick={() => setPalette(true)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setPalette(true)}><Search size={15} /><span>Buscar contactos, empresas, negocios…</span><kbd className="hide-mobile">Ctrl K</kbd></div>
          <div className="right row">
            <Notifications />
            <Menu trigger={<button className="iconbtn" aria-label="Menú de usuario"><Avatar name={me.name} /></button>}>
              <Link to="/ajustes/perfil"><Settings />Mi perfil y seguridad</Link>
              <div className="sep" />
              <button onClick={logout}><LogOut />Cerrar sesión</button>
            </Menu>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
      <nav className="bottom-nav">
        <NavLink to="/" end><Home />Inicio</NavLink>
        <NavLink to="/mi-dia"><Sun />Mi día</NavLink>
        <NavLink to="/contactos"><Users />Contactos</NavLink>
        <NavLink to="/negocios"><Handshake />Negocios</NavLink>
        <a href="#" onClick={(e) => { e.preventDefault(); setMobileNav(true); }}><MenuIcon />Más</a>
      </nav>
      {mobileNav && (
        <div className="overlay" style={{ alignItems: "stretch", padding: 0 }} onMouseDown={(e) => { if (e.target === e.currentTarget) setMobileNav(false); }}>
          <div style={{ background: "var(--side)", width: 260, height: "100%", overflowY: "auto", color: "var(--side-ink)" }}>
            <div className="brand"><span className="logo">{(settings.company_name || "C").slice(0, 1)}</span><span className="grow">{settings.company_name}</span><button className="iconbtn" style={{ color: "#fff" }} onClick={() => setMobileNav(false)}><X /></button></div>
            {navItems}
            <div className="user"><Avatar name={me.name} /><div className="grow" style={{ color: "#fff" }}>{me.name}</div><button className="iconbtn" style={{ color: "#8da0b1" }} onClick={logout}><LogOut size={16} /></button></div>
          </div>
        </div>
      )}
      {palette && <Palette onClose={() => setPalette(false)} />}
    </div>
  );
}

type SearchRes = { contacts: { id: string; first_name: string; last_name: string; email: string | null; company_name: string | null }[]; companies: { id: string; name: string; domain: string | null; city: string | null }[]; deals: { id: string; name: string; amount: number; currency: string; company_name: string | null; stage_name: string }[]; tickets: { id: string; number: number; subject: string; status: string }[]; quotes: { id: string; number: string; status: string; total: number; deal_id: string }[] };

function Palette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<SearchRes | null>(null);
  const [active, setActive] = useState(0);
  const nav = useNavigate();
  const [recent, setRecent] = useState<{ label: string; to: string }[]>(() => { try { return JSON.parse(localStorage.getItem("crm:recent") ?? "[]"); } catch { return []; } });
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    let alive = true;
    const t = setTimeout(() => api.get<SearchRes>(`search?q=${encodeURIComponent(q.trim())}`).then((r) => alive && setRes(r)).catch(() => undefined), 120);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);
  const items: { label: string; sub?: string; to: string; group: string; icon: typeof Users }[] = [];
  if (res) {
    res.contacts.forEach((c) => items.push({ label: `${c.first_name} ${c.last_name}`, sub: c.company_name ?? c.email ?? "", to: `/contactos/${c.id}`, group: "Contactos", icon: Users }));
    res.companies.forEach((c) => items.push({ label: c.name, sub: c.domain ?? c.city ?? "", to: `/empresas/${c.id}`, group: "Empresas", icon: Building2 }));
    res.deals.forEach((d) => items.push({ label: d.name, sub: `${d.stage_name} · ${fmtMoney(d.amount, d.currency)}`, to: `/negocios/${d.id}`, group: "Negocios", icon: Handshake }));
    res.tickets.forEach((t) => items.push({ label: `#${t.number} ${t.subject}`, sub: t.status, to: `/tickets/${t.id}`, group: "Tickets", icon: LifeBuoy }));
    res.quotes.forEach((x) => items.push({ label: `Presupuesto ${x.number}`, sub: `${x.status} · ${fmtMoney(x.total)}`, to: `/negocios/${x.deal_id}`, group: "Presupuestos", icon: FileText }));
  } else if (!q.trim()) {
    recent.forEach((r) => items.push({ label: r.label, to: r.to, group: "Recientes", icon: Search }));
    [{ label: "Nuevo contacto", to: "/contactos?new=1" }, { label: "Nuevo negocio", to: "/negocios?new=1" }, { label: "Nueva tarea", to: "/tareas?new=1" }, { label: "Mi día", to: "/mi-dia" }, { label: "Importar CSV", to: "/ajustes/importar" }].forEach((a) => items.push({ ...a, group: "Acciones", icon: Search }));
  }
  const go = (it: { label: string; to: string }) => {
    const r = [{ label: it.label, to: it.to }, ...recent.filter((x) => x.to !== it.to)].slice(0, 6);
    localStorage.setItem("crm:recent", JSON.stringify(r)); setRecent(r);
    nav(it.to); onClose();
  };
  let lastGroup = "";
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette">
        <input ref={inputRef} value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} placeholder="Buscar por nombre, email, teléfono, empresa, nº de ticket o presupuesto…" onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); } if (e.key === "Enter" && items[active]) go(items[active]); if (e.key === "Escape") onClose(); }} />
        <div className="results">
          {items.length === 0 && q.trim().length >= 2 && <div className="muted" style={{ padding: 14 }}>Sin resultados para «{q}»</div>}
          {items.map((it, i) => { const showGroup = it.group !== lastGroup; lastGroup = it.group; return (<div key={it.to + i}>{showGroup && <div className="group">{it.group}</div>}<div className={`item ${i === active ? "active" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => go(it)}><it.icon /><span className="grow ell">{it.label}</span><span className="muted small ell">{it.sub}</span></div></div>); })}
        </div>
      </div>
    </div>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ items: { id: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string }[]; unread: number }>({ items: [], unread: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const load = () => api.get<typeof data>("notifications").then(setData).catch(() => undefined);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, []);
  useEffect(() => { if (!open) return; const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }; document.addEventListener("mousedown", h); return () => document.removeEventListener("mousedown", h); }, [open]);
  const markAll = async () => { await api.post("notifications/read"); load(); };
  const nav = useNavigate();
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button className="iconbtn" onClick={() => setOpen((o) => !o)} aria-label="Notificaciones"><Bell size={18} />{data.unread > 0 && <span className="dot">{data.unread}</span>}</button>
      {open && (
        <div className="notif-panel">
          <div className="row between" style={{ padding: "10px 14px", borderBottom: "1px solid var(--rule)" }}><strong>Notificaciones</strong>{data.unread > 0 && <button className="btn xs ghost" onClick={markAll}>Marcar todo leído</button>}</div>
          <div className="list">
            {data.items.length === 0 && <div className="empty small">Nada nuevo por aquí</div>}
            {data.items.map((n) => <a key={n.id} href={n.link ?? "#"} className={`notif ${n.read_at ? "" : "unread"}`} onClick={async (e) => { e.preventDefault(); await api.post("notifications/read", { ids: [n.id] }); load(); setOpen(false); if (n.link) nav(n.link); }}><div className="t">{n.title}</div>{n.body && <div className="b">{n.body}</div>}<div className="xs muted">{relTime(n.created_at)}</div></a>)}
          </div>
        </div>
      )}
    </div>
  );
}
