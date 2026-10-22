import { addLocalDays, fromLocalParts, toLocalParts } from "../time/local";

/**
 * Rule-based natural-language capture (F-02, AI-1 fallback). Spanish and English. Pure: the clock, time zone
 * and client names are injected. Everything returned is a SUGGESTION the user confirms.
 */
export interface CaptureContext {
  now: string; // ISO
  timezone: string;
  clients: { id: string; name: string }[];
  /** Hour used when a date is found without a time (local). */
  defaultDueHour?: number;
  /** D-045 vertical vocabulary (optional: phase-2 behaviour when absent). */
  vocabulary?: { deadlineNouns: string[]; deliverableNouns: string[] } | undefined;
}

export interface CaptureSuggestion {
  title: string;
  clientId: string | null;
  clientName: string | null;
  dueAt: string | null;
  dueText: string | null;
  estimateMinutes: number | null;
  priority: number | null;
  kind: "deep" | "shallow" | null;
  /** Hard when a dated capture names a deadline noun of the vertical ("audiencia el 3 de noviembre"). */
  deadlineType: "hard" | "soft" | null;
  confidence: number;
}

const WEEKDAYS: { names: string[]; day: number }[] = [
  { names: ["domingo", "sunday", "sun"], day: 0 },
  { names: ["lunes", "monday", "mon"], day: 1 },
  { names: ["martes", "tuesday", "tue"], day: 2 },
  { names: ["miércoles", "miercoles", "wednesday", "wed"], day: 3 },
  { names: ["jueves", "thursday", "thu"], day: 4 },
  { names: ["viernes", "friday", "fri"], day: 5 },
  { names: ["sábado", "sabado", "saturday", "sat"], day: 6 },
];

export const normalizeText = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

interface Match {
  text: string;
  index: number;
}

/**
 * The words of `original` that a match on its normalised form covers, as the person wrote them ("el miércoles",
 * not "el miercoles"). Falls back to the normalised text when normalising changed the length.
 */
export function originalSpan(original: string, match: Match): string {
  return normalizeText(original).length === original.length
    ? original.slice(match.index, match.index + match.text.length)
    : match.text;
}

/**
 * Resolves the date in a sentence relative to when it was written (`writtenAt`, ISO): "el viernes" in a message
 * sent on Sunday 18 is Friday 23. Returns the phrase as written, or null when the sentence names no exact date
 * ("fin de mes", "cuando puedas").
 */
export function resolveDatePhrase(
  sentence: string,
  writtenAt: string,
  timezone: string,
  defaultDueHour = 18,
): { dueAt: string; dueText: string } | null {
  const date = findDate(normalizeText(sentence), { now: writtenAt, timezone, clients: [], defaultDueHour });
  return date ? { dueAt: date.dueAt, dueText: originalSpan(sentence, date.match) } : null;
}

export function findDate(lower: string, ctx: CaptureContext): { dueAt: string; match: Match } | null {
  const nowMs = Date.parse(ctx.now);
  const local = toLocalParts(nowMs, ctx.timezone);
  const hour = ctx.defaultDueHour ?? 18;
  const at = (dayOffset: number, h = hour, m = 0) => {
    const d = addLocalDays(local, dayOffset);
    return new Date(fromLocalParts({ ...d, hour: h, minute: m }, ctx.timezone)).toISOString();
  };
  let m: RegExpExecArray | null;
  if ((m = /\b(pasado manana|day after tomorrow)\b/.exec(lower)))
    return { dueAt: at(2), match: { text: m[0], index: m.index } };
  if ((m = /\b(hoy|today)\b/.exec(lower))) return { dueAt: at(0), match: { text: m[0], index: m.index } };
  // "mañana" alone is tomorrow; "por/de la mañana" is a time of day, not a date.
  if ((m = /\b(?<!(?:por|de|en) la )(manana|tomorrow)\b/.exec(lower)))
    return { dueAt: at(1), match: { text: m[0], index: m.index } };
  if (
    (m =
      /\b(?:en|in)\s+(\d+|una|un|dos|tres|cuatro|one|two|three|four)\s+(dias?|days?|semanas?|weeks?)\b/.exec(
        lower,
      ))
  ) {
    const words: Record<string, number> = {
      una: 1,
      un: 1,
      one: 1,
      dos: 2,
      two: 2,
      tres: 3,
      three: 3,
      cuatro: 4,
      four: 4,
    };
    const n = words[m[1] ?? ""] ?? Number(m[1]);
    const days = /^(semana|week)/.test(m[2] ?? "") ? n * 7 : n;
    if (Number.isFinite(days) && days > 0) return { dueAt: at(days), match: { text: m[0], index: m.index } };
  }
  for (const wd of WEEKDAYS) {
    for (const name of wd.names) {
      const re = new RegExp(
        `\\b(?:(?:el|para el|para|on|by|next|el proximo|proximo|este|this)\\s+)?${normalizeText(name)}\\b`,
      );
      const hit = re.exec(lower);
      if (hit) {
        // "next lunes" / "el próximo lunes": the one in the following week; otherwise the coming occurrence.
        const nextWeek = /^(next|el proximo|proximo)\s/.test(hit[0]);
        let offset = (wd.day - local.weekday + 7) % 7 || 7;
        if (nextWeek && offset < 7) offset += 7;
        return { dueAt: at(offset), match: { text: hit[0], index: hit.index } };
      }
    }
  }
  if (
    (m =
      /\b(?:el\s+)?(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/.exec(
        lower,
      ))
  ) {
    const months = [
      "enero",
      "febrero",
      "marzo",
      "abril",
      "mayo",
      "junio",
      "julio",
      "agosto",
      "septiembre",
      "octubre",
      "noviembre",
      "diciembre",
    ];
    const day = Number(m[1]);
    const monthName = (m[2] ?? "") === "setiembre" ? "septiembre" : (m[2] ?? "");
    const month = months.indexOf(monthName) + 1;
    if (day >= 1 && day <= 31 && month >= 1) {
      const year =
        month < local.month || (month === local.month && day < local.day) ? local.year + 1 : local.year;
      const dueAt = new Date(
        fromLocalParts({ year, month, day, hour, minute: 0 }, ctx.timezone),
      ).toISOString();
      return { dueAt, match: { text: m[0], index: m.index } };
    }
  }
  if ((m = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/.exec(lower))) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : local.year;
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const dueAt = new Date(
        fromLocalParts({ year, month, day, hour, minute: 0 }, ctx.timezone),
      ).toISOString();
      return { dueAt, match: { text: m[0], index: m.index } };
    }
  }
  return null;
}

function findDuration(lower: string): { minutes: number; match: Match } | null {
  const hm =
    /(\d{1,2})\s*(?:h|hs|hr|hrs|horas?|hours?)\s*(?:y\s+|and\s+)?(\d{1,2})(?:\s*(?:min|mins|minutos?|minutes?))?\b/.exec(
      lower,
    );
  if (hm) {
    const minutes = Number(hm[1]) * 60 + Number(hm[2]);
    if (minutes > 0) return { minutes, match: { text: hm[0], index: hm.index } };
  }
  const m = /(\d+(?:[.,]\d+)?)\s*(h|hs|hr|hrs|horas?|hours?|min|mins|minutos?|minutes?)\b/.exec(lower);
  if (!m) return null;
  const n = parseFloat((m[1] ?? "0").replace(",", "."));
  const unit = m[2] ?? "";
  const minutes = Math.round(/^h/.test(unit) ? n * 60 : n);
  return minutes > 0 ? { minutes, match: { text: m[0], index: m.index } } : null;
}

function findPriority(lower: string): { priority: number; match: Match } | null {
  const m =
    /\b(urgente|urgent|asap|prioridad alta|alta prioridad|high priority|importante|important|baja prioridad|prioridad baja|low priority|poco importante|sin prisa)\b/.exec(
      lower,
    );
  if (!m) return null;
  const priority = /urgente|urgent|asap/.test(m[0]) ? 1 : /baja|low|poco|sin prisa/.test(m[0]) ? 4 : 2;
  return { priority, match: { text: m[0], index: m.index } };
}

function findClient(
  lower: string,
  clients: CaptureContext["clients"],
): { client: { id: string; name: string }; match: Match } | null {
  let best: { client: { id: string; name: string }; match: Match } | null = null;
  for (const client of clients) {
    const full = normalizeText(client.name);
    const first = full.split(/\s+/)[0] ?? full;
    for (const candidate of [full, first]) {
      if (candidate.length < 3) continue;
      const idx = lower.indexOf(candidate);
      if (idx >= 0 && (!best || candidate.length > best.match.text.length)) {
        best = { client, match: { text: candidate, index: idx } };
      }
    }
  }
  return best;
}

export function parseCapture(raw: string, ctx: CaptureContext): CaptureSuggestion {
  const text = raw.trim().replace(/\s+/g, " ");
  const lower = normalizeText(text);
  const date = findDate(lower, ctx);
  const duration = findDuration(lower);
  const priority = findPriority(lower);
  const client = findClient(lower, ctx.clients);

  // Remove recognised fragments from the title, keeping the user's wording otherwise.
  const removals = [date?.match, duration?.match, priority?.match].filter((m): m is Match => m !== undefined);
  let title = text;
  for (const m of removals.sort((a, b) => b.index - a.index)) {
    title = title.slice(0, m.index) + title.slice(m.index + m.text.length);
  }
  title = title
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*,/g, ",")
    .replace(/^[\s,;]+|[\s,;]+$/g, "")
    .trim();
  if (title.length === 0) title = text;

  const estimate = duration?.minutes ?? null;
  const mentions = (nouns: string[] | undefined) =>
    (nouns ?? []).some((n) =>
      new RegExp(`\\b${normalizeText(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(lower),
    );
  const hardDeadline = date !== null && mentions(ctx.vocabulary?.deadlineNouns);
  const deliverable = estimate === null && mentions(ctx.vocabulary?.deliverableNouns);
  const kind = estimate === null ? (deliverable ? "deep" : null) : estimate >= 90 ? "deep" : "shallow";
  const signals = [date, duration, priority, client].filter(Boolean).length;
  return {
    title,
    clientId: client?.client.id ?? null,
    clientName: client?.client.name ?? null,
    dueAt: date?.dueAt ?? null,
    dueText: date ? originalSpan(text, date.match) : null,
    estimateMinutes: estimate,
    priority: priority?.priority ?? (hardDeadline ? 2 : null),
    kind,
    deadlineType: hardDeadline ? "hard" : null,
    confidence: Math.min(1, 0.55 + signals * 0.12),
  };
}
