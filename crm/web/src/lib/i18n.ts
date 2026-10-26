/**
 * Traducciones: t("clave", { var }) busca en el catálogo del idioma del usuario y cae al español.
 * Las claves que no existen se devuelven tal cual, así la migración puede ser gradual.
 */
import es from "../i18n/es.json";
import en from "../i18n/en.json";
import { getLang } from "./prefs";

type Catalog = Record<string, string>;
const CATALOGS: Record<string, Catalog> = { es, en };
const lang = getLang();
if (typeof document !== "undefined") document.documentElement.lang = lang;

export function t(key: string, vars?: Record<string, string | number>): string {
  const s = CATALOGS[lang]?.[key] ?? (es as Catalog)[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : s;
}
export const currentLang = lang;
