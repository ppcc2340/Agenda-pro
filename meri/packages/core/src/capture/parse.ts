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

const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

interface Match {
  text: string;
  index: number;
}

function findDate(lower: string, ctx: CaptureContext): { dueAt: string; match: Match } | null {
  const nowMs = Date.parse(ctx.now);
  const local = toLocalParts(nowMs, ctx.timezone);
  const hour = ctx.defaultDueHour ?? 18;
  const at = (dayOffset: number, h = hour, m = 0) => {
    const d = addLocalDays(local, dayOffset);
    return new Date(fromLocalParts({ ...d, hour: h, minute: m }, ctx.timezone)).toISOString();
  };
  let m: RegExpExecArray | null;
  if ((m = /\b(hoy|today)\b/.exec(lower))) return { dueAt: at(0), match: { text: m[0], index: m.index } };
  if ((m = /\b(manana|tomorrow)\b/.exec(lower)))
    return { dueAt: at(1), match: { text: m[0], index: m.index } };
  for (const wd of WEEKDAYS) {
    for (const name of wd.names) {
      const re = new RegExp(
        `\\b(?:(?:el|para el|para|on|by|next|el proximo|proximo)\\s+)?${normalize(name)}\\b`,
      );
      const hit = re.exec(lower);
      if (hit) {
        const offset = (wd.day - local.weekday + 7) % 7 || 7;
        return { dueAt: at(offset), match: { text: hit[0], index: hit.index } };
      }
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
  const m = /(\d+(?:[.,]\d+)?)\s*(h|hs|hr|hrs|horas?|hours?|min|mins|minutos?|minutes?)\b/.exec(lower);
  if (!m) return null;
  const n = parseFloat((m[1] ?? "0").replace(",", "."));
  const unit = m[2] ?? "";
  const minutes = Math.round(/^h/.test(unit) ? n * 60 : n);
  return minutes > 0 ? { minutes, match: { text: m[0], index: m.index } } : null;
}

function findPriority(lower: string): { priority: number; match: Match } | null {
  const m = /\b(urgente|urgent|asap|prioridad alta|high priority|importante|important)\b/.exec(lower);
  if (!m) return null;
  return { priority: /urgente|urgent|asap/.test(m[0]) ? 1 : 2, match: { text: m[0], index: m.index } };
}

function findClient(
  lower: string,
  clients: CaptureContext["clients"],
): { client: { id: string; name: string }; match: Match } | null {
  let best: { client: { id: string; name: string }; match: Match } | null = null;
  for (const client of clients) {
    const full = normalize(client.name);
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
  const lower = normalize(text);
  const date = findDate(lower, ctx);
  const duration = findDuration(lower);
  const priority = findPriority(lower);
  const client = findClient(lower, ctx.clients);

  // Remove recognised fragments from the title, keeping the user's wording otherwise.
  const removals = [date?.match, duration?.match, priority?.match].filter(
    (m): m is Match => m !== undefined,
  );
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
  const kind = estimate === null ? null : estimate >= 90 ? "deep" : "shallow";
  const signals = [date, duration, priority, client].filter(Boolean).length;
  return {
    title,
    clientId: client?.client.id ?? null,
    clientName: client?.client.name ?? null,
    dueAt: date?.dueAt ?? null,
    dueText: date?.match.text ?? null,
    estimateMinutes: estimate,
    priority: priority?.priority ?? null,
    kind,
    confidence: Math.min(1, 0.55 + signals * 0.12),
  };
}
