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

/** ISO instant → value for `<input type="datetime-local">` in the user's zone (YYYY-MM-DDTHH:MM). */
export function isoToLocalInput(iso: string, timeZone: string): string {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(iso)))
    parts[p.type] = p.value;
  const hour = parts.hour === "24" ? "00" : (parts.hour ?? "00");
  return `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""}T${hour}:${parts.minute ?? "00"}`;
}

/** `datetime-local` value (user's zone) → ISO instant; resolves the zone offset at that local time. */
export function localInputToIso(value: string, timeZone: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return new Date(value).toISOString();
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map((x) => Number(x));
  const wall = Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0);
  const offsetAt = (instant: number) => {
    const p = isoToLocalInput(new Date(instant).toISOString(), timeZone);
    const asUtc = Date.UTC(
      Number(p.slice(0, 4)),
      Number(p.slice(5, 7)) - 1,
      Number(p.slice(8, 10)),
      Number(p.slice(11, 13)),
      Number(p.slice(14, 16)),
    );
    return asUtc - instant;
  };
  let instant = wall - offsetAt(wall);
  instant = wall - offsetAt(instant);
  return new Date(instant).toISOString();
}
