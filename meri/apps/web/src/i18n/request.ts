import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { DEFAULT_LOCALE, isLocale, LOCALE_COOKIE } from "./locale";
import en from "../../messages/en.json";
import es from "../../messages/es.json";

const MESSAGES = { es, en } as const;

/** Locale from the preference cookie (set in Centro de control); `es` by default. No URL prefixes in the MVP. */
export default getRequestConfig(async () => {
  const store = await cookies();
  const raw = store.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(raw) ? raw : DEFAULT_LOCALE;
  return { locale, messages: MESSAGES[locale], timeZone: "UTC" };
});
