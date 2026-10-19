/** Small formatting helpers shared by client components. */
export function formatMinutes(
  min: number,
  t: (key: "minutes" | "hours", values: { n: string | number }) => string,
): string {
  if (min < 60) return t("minutes", { n: min });
  const h = Math.round(min / 6) / 10;
  return t("hours", { n: h.toString().replace(".", ",") });
}

export function formatDate(iso: string, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone,
  }).format(new Date(iso));
}

export function formatDateTime(iso: string, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(iso));
}

export function formatTime(iso: string, locale: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(iso));
}
