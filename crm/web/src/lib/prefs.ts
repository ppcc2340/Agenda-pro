/** Preferencias de interfaz por usuario (tema e idioma), guardadas en este navegador. */
export type Theme = "system" | "light" | "dark";
export type Lang = "es" | "en";
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

export const getTheme = (): Theme => { const v = read("crm:theme"); return v === "light" || v === "dark" ? v : "system"; };
export function applyTheme(t: Theme = getTheme()) {
  const el = document.documentElement;
  if (t === "system") el.removeAttribute("data-theme"); else el.setAttribute("data-theme", t);
  const dark = t === "dark" || (t === "system" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  el.style.colorScheme = dark ? "dark" : "light";
}
export function setTheme(t: Theme) { write("crm:theme", t); applyTheme(t); }

/** Español por defecto (idioma de la empresa); el inglés se elige en el menú de usuario. */
export const getLang = (): Lang => { const v = read("crm:lang"); return v === "en" ? "en" : "es"; };
export function setLang(l: Lang) { write("crm:lang", l); window.location.reload(); }
export const locale = () => (getLang() === "en" ? "en-GB" : "es-ES");
