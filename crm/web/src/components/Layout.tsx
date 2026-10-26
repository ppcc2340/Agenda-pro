import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Link, useNavigate, useLocation } from "react-router-dom";
import { Home, Sun, Users, Building2, Handshake, LifeBuoy, BarChart3, LayoutDashboard, Settings, Search, Bell, LogOut, Package, FileText, Menu as MenuIcon, X, Moon, Monitor, SunMedium, Languages, Keyboard } from "lucide-react";
import { useApp } from "../lib/app";
import { api } from "../api";
import { Avatar, Menu, Modal } from "./ui";
import { t } from "../lib/i18n";
import { getTheme, setTheme, getLang, setLang, type Theme } from "../lib/prefs";
import { relTime, fmtMoney } from "../lib/format";

const TOP = [
  { to: "/", label: t("nav.home"), icon: Home, end: true },
  { to: "/mi-dia", label: t("nav.myday"), icon: Sun },
];
const BOARDS = [
  { to: "/contactos", label: t("nav.contacts"), color: "var(--c-blue)" },
  { to: "/empresas", label: t("nav.companies"), color: "var(--c-purple)" },
  { to: "/negocios", label: t("nav.deals"), color: "var(--c-green)" },
  { to: "/contratos", label: t("nav.contracts"), color: "#175a63" },
  { to: "/tareas", label: t("nav.tasks"), color: "var(--c-orange)" },
  { to: "/tickets", label: t("nav.tickets"), color: "var(--c-red)" },
  { to: "/listas", label: t("nav.lists"), color: "var(--c-indigo)" },
];
const TOOLS = [
  { to: "/productos", label: t("nav.products"), icon: Package },
  { to: "/presupuestos", label: t("nav.quotes"), icon: FileText },
  { to: "/analitica", label: t("nav.analytics"), icon: LayoutDashboard },
  { to: "/informes", label: t("nav.reports"), icon: BarChart3 },
];
/** Atajos globales de navegación (no se activan escribiendo en un campo ni dentro de una tabla). */
const GO_KEYS: Record<string, { to: string; label: string }> = { h: { to: "/", label: t("sc.goHome") }, c: { to: "/contactos", label: t("sc.goContacts") }, e: { to: "/empresas", label: t("sc.goCompanies") }, n: { to: "/negocios", label: t("sc.goDeals") }, t: { to: "/tickets", label: t("sc.goTickets") }, a: { to: "/tareas", label: t("sc.goTasks") } };
const typing = (el: EventTarget | null) => { const e = el as HTMLElement | null; return !!e && (!!e.closest("input, textarea, select, [contenteditable='true'], .grid-focus, .modal, .drawer, .cdd, .cpop") || e.isContentEditable); };

export function Layout({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  const { me, settings, objects } = useApp();
  const [palette, setPalette] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const [help, setHelp] = useState(false);
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const loc = useLocation();
  const navigate = useNavigate();
  const pendingG = useRef(0);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPalette((p) => !p); return; }
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || typing(e.target) || document.querySelector(".overlay, .drawer-overlay")) return;
      if (pendingG.current && Date.now() - pendingG.current < 1200) { pendingG.current = 0; const g = GO_KEYS[e.key.toLowerCase()]; if (g) { e.preventDefault(); navigate(g.to); } return; }
      if (e.key === "g") { pendingG.current = Date.now(); return; }
      if (e.key === "/") { e.preventDefault(); setPalette(true); return; }
      if (e.key === "?") { e.preventDefault(); setHelp(true); return; }
      if (e.key === "n") { const b = document.querySelector<HTMLButtonElement>("#main-content .page-head .btn.primary, #main-content .filterbar .btn.primary"); if (b) { e.preventDefault(); b.click(); } }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [navigate]);
  useEffect(() => { setMobileNav(false); }, [loc.pathname]);
  const logout = async () => { await api.post("auth/logout").catch(() => undefined); onLogout(); };
  const navItems = (
    <nav className="nav" aria-label={t("nav.main")}>
      {TOP.map((n) => <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "active" : "")}><n.icon />{n.label}</NavLink>)}
      <div className="ws"><span className="wsi">{(settings.company_name || "C").slice(0, 1).toUpperCase()}</span><span className="ell grow">{settings.company_name || t("nav.workspace")}</span></div>
      <div className="section">{t("nav.boards")}</div>
      {BOARDS.map((n) => <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? "active" : "")}><span className="sq" style={{ background: n.color }} />{n.label}</NavLink>)}
      {objects.map((o) => <NavLink key={o.key} to={`/o/${o.key}`} className={({ isActive }) => (isActive ? "active" : "")}><span className="sq" style={{ background: o.color }} />{o.plural}</NavLink>)}
      <div className="section">{t("nav.tools")}</div>
      {TOOLS.map((n) => <NavLink key={n.to} to={n.to} className={({ isActive }) => (isActive ? "active" : "")}><n.icon />{n.label}</NavLink>)}
      <div className="section">{t("nav.admin")}</div>
      <NavLink to="/ajustes" className={({ isActive }) => (isActive ? "active" : "")}><Settings />{t("nav.settings")}</NavLink>
    </nav>
  );
  return (
    <div className="app">
      <a className="skip-link" href="#main-content">{t("shell.skip")}</a>
      <aside className="sidebar">
        <div className="brand"><span className="dots"><i /><i /><i /></span><span className="ell">{settings.company_name || "CRM"}<span className="sub" style={{ fontWeight: 400 }}> crm</span></span></div>
        {navItems}
        <div className="user">
          <Avatar name={me.name} />
          <div className="grow" style={{ minWidth: 0 }}><div className="ell" style={{ fontWeight: 600, fontSize: 13 }}>{me.name}</div><div className="ell xs sub">{me.role.name}</div></div>
          <button className="iconbtn" onClick={logout} title={t("shell.logout")} aria-label={t("shell.logout")}><LogOut size={16} /></button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="iconbtn menu-btn" onClick={() => setMobileNav(true)} aria-label={t("shell.menu")} aria-expanded={mobileNav}><MenuIcon size={20} /></button>
          <div className="search-trigger" onClick={() => setPalette(true)} role="button" tabIndex={0} aria-label={t("shell.search")} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setPalette(true))}><Search size={15} /><span>{t("shell.search")}</span><kbd className="hide-mobile">Ctrl K</kbd></div>
          <div className="right row">
            <Notifications />
            <Menu trigger={<button className="iconbtn" aria-label={t("shell.userMenu")}><Avatar name={me.name} /></button>}>
              <Link to="/ajustes/perfil"><Settings />{t("shell.profile")}</Link>
              <div className="sep" />
              <div className="menu-label">{t("shell.theme")}</div>
              {([["system", Monitor], ["light", SunMedium], ["dark", Moon]] as const).map(([k, Ic]) => <button key={k} role="menuitemradio" aria-checked={theme === k} onClick={() => { setTheme(k); setThemeState(k); }}><Ic />{t(`shell.theme.${k}`)}{theme === k && <span className="right">✓</span>}</button>)}
              <div className="sep" />
              <div className="menu-label">{t("shell.language")}</div>
              {([["es", "Español"], ["en", "English"]] as const).map(([k, l]) => <button key={k} role="menuitemradio" aria-checked={getLang() === k} onClick={() => getLang() !== k && setLang(k)}><Languages />{l}{getLang() === k && <span className="right">✓</span>}</button>)}
              <div className="sep" />
              <button onClick={() => setHelp(true)}><Keyboard />{t("shell.shortcuts")}</button>
              <button onClick={logout}><LogOut />{t("shell.logout")}</button>
            </Menu>
          </div>
        </header>
        <main className="content" id="main-content" tabIndex={-1}>{children}</main>
      </div>
      <nav className="bottom-nav" aria-label={t("nav.main")}>
        <NavLink to="/" end><Home />{t("nav.home")}</NavLink>
        <NavLink to="/mi-dia"><Sun />{t("nav.myday")}</NavLink>
        <NavLink to="/contactos"><Users />{t("nav.contacts")}</NavLink>
        <NavLink to="/negocios"><Handshake />{t("nav.deals")}</NavLink>
        <a href="#" onClick={(e) => { e.preventDefault(); setMobileNav(true); }}><MenuIcon />{t("nav.more")}</a>
      </nav>
      {mobileNav && (
        <div className="overlay nav-drawer" onMouseDown={(e) => { if (e.target === e.currentTarget) setMobileNav(false); }} onKeyDown={(e) => e.key === "Escape" && setMobileNav(false)}>
          <div className="nav-drawer-panel" role="dialog" aria-modal="true" aria-label={t("nav.main")}>
            <div className="brand"><span className="dots"><i /><i /><i /></span><span className="grow ell">{settings.company_name}</span><button className="iconbtn" autoFocus onClick={() => setMobileNav(false)} aria-label={t("shell.closeMenu")}><X /></button></div>
            {navItems}
            <div className="user"><Avatar name={me.name} /><div className="grow">{me.name}</div><button className="iconbtn" onClick={logout} aria-label={t("shell.logout")}><LogOut size={16} /></button></div>
          </div>
        </div>
      )}
      {palette && <Palette onClose={() => setPalette(false)} />}
      {help && <Modal title={t("shell.shortcuts")} onClose={() => setHelp(false)}>
        <table className="table"><tbody>
          {[["Ctrl K", t("sc.palette")], ["/", t("sc.search")], ...Object.entries(GO_KEYS).map(([k, v]) => [`g ${k}`, v.label]), ["n", t("sc.new")], ["?", t("sc.help")]].map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td className="small">{d}</td></tr>)}
        </tbody></table>
        <p className="xs muted mt8">{t("sc.grid")}</p>
      </Modal>}
    </div>
  );
}

type SearchRes = { contacts: { id: string; first_name: string; last_name: string; email: string | null; company_name: string | null }[]; companies: { id: string; name: string; domain: string | null; city: string | null }[]; deals: { id: string; name: string; amount: number; currency: string; company_name: string | null; stage_name: string }[]; tickets: { id: string; number: number; subject: string; status: string }[]; quotes: { id: string; number: string; status: string; total: number; deal_id: string }[]; contracts?: { id: string; number: string; title: string; status: string }[]; records?: { id: string; name: string; number: string | null; object_key: string; object_name: string }[] };

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
    res.contacts.forEach((c) => items.push({ label: `${c.first_name} ${c.last_name}`, sub: c.company_name ?? c.email ?? "", to: `/contactos/${c.id}`, group: t("nav.contacts"), icon: Users }));
    res.companies.forEach((c) => items.push({ label: c.name, sub: c.domain ?? c.city ?? "", to: `/empresas/${c.id}`, group: t("nav.companies"), icon: Building2 }));
    res.contracts?.forEach((c) => items.push({ label: `${c.number} ${c.title}`, sub: c.status, to: `/contratos/${c.id}`, group: t("nav.contracts"), icon: FileText }));
    res.deals.forEach((d) => items.push({ label: d.name, sub: `${d.stage_name} · ${fmtMoney(d.amount, d.currency)}`, to: `/negocios/${d.id}`, group: t("nav.deals"), icon: Handshake }));
    res.tickets.forEach((x) => items.push({ label: `#${x.number} ${x.subject}`, sub: x.status, to: `/tickets/${x.id}`, group: t("nav.tickets"), icon: LifeBuoy }));
    res.records?.forEach((x) => items.push({ label: x.number ? `${x.number} ${x.name}` : x.name, sub: x.object_name, to: `/o/${x.object_key}/${x.id}`, group: x.object_name, icon: Search }));
    res.quotes.forEach((x) => items.push({ label: `${x.number}`, sub: `${x.status} · ${fmtMoney(x.total)}`, to: `/negocios/${x.deal_id}`, group: t("nav.quotes"), icon: FileText }));
  } else if (!q.trim()) {
    recent.forEach((r) => items.push({ label: r.label, to: r.to, group: t("shell.recent"), icon: Search }));
    [{ label: t("shell.newContact"), to: "/contactos?new=1" }, { label: t("shell.newDeal"), to: "/negocios?new=1" }, { label: t("shell.newTask"), to: "/tareas?new=1" }, { label: t("nav.myday"), to: "/mi-dia" }, { label: t("shell.importCsv"), to: "/ajustes/importar" }].forEach((a) => items.push({ ...a, group: t("shell.actions"), icon: Search }));
  }
  const go = (it: { label: string; to: string }) => {
    const r = [{ label: it.label, to: it.to }, ...recent.filter((x) => x.to !== it.to)].slice(0, 6);
    localStorage.setItem("crm:recent", JSON.stringify(r)); setRecent(r);
    nav(it.to); onClose();
  };
  let lastGroup = "";
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={t("sc.palette")}>
        <input ref={inputRef} aria-label={t("sc.search")} role="combobox" aria-expanded={items.length > 0} aria-controls="palette-results" aria-activedescendant={items[active] ? `pal-${active}` : undefined} value={q} onChange={(e) => { setQ(e.target.value); setActive(0); }} placeholder={t("shell.searchPh")} onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); } if (e.key === "Enter" && items[active]) go(items[active]); if (e.key === "Escape") onClose(); }} />
        <div className="results" id="palette-results" role="listbox">
          {items.length === 0 && q.trim().length >= 2 && <div className="muted" style={{ padding: 14 }}>{t("shell.noResults", { q })}</div>}
          {items.map((it, i) => { const showGroup = it.group !== lastGroup; lastGroup = it.group; return (<div key={it.to + i} role="presentation">{showGroup && <div className="group" role="presentation">{it.group}</div>}<div id={`pal-${i}`} role="option" aria-selected={i === active} className={`item ${i === active ? "active" : ""}`} onMouseEnter={() => setActive(i)} onClick={() => go(it)}><it.icon /><span className="grow ell">{it.label}</span><span className="muted small ell">{it.sub}</span></div></div>); })}
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
      <button className="iconbtn" onClick={() => setOpen((o) => !o)} aria-label={data.unread ? `${t("shell.notifications")} (${data.unread})` : t("shell.notifications")} aria-expanded={open}><Bell size={18} />{data.unread > 0 && <span className="dot">{data.unread}</span>}</button>
      {open && (
        <div className="notif-panel">
          <div className="row between" style={{ padding: "10px 14px", borderBottom: "1px solid var(--rule)" }}><strong>{t("shell.notifications")}</strong>{data.unread > 0 && <button className="btn xs ghost" onClick={markAll}>{t("shell.markAll")}</button>}</div>
          <div className="list">
            {data.items.length === 0 && <div className="empty small">{t("shell.nothingNew")}</div>}
            {data.items.map((n) => <a key={n.id} href={n.link ?? "#"} className={`notif ${n.read_at ? "" : "unread"}`} onClick={async (e) => { e.preventDefault(); await api.post("notifications/read", { ids: [n.id] }); load(); setOpen(false); if (n.link) nav(n.link); }}><div className="t">{n.title}</div>{n.body && <div className="b">{n.body}</div>}<div className="xs muted">{relTime(n.created_at)}</div></a>)}
          </div>
        </div>
      )}
    </div>
  );
}
