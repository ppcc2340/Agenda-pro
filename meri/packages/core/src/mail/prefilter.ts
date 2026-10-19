/**
 * Rule prefilter (docs/05 §3.1, F-07 AC4): discards automated mail before any AI call. Pure.
 */
export interface PrefilterMessage {
  from: string;
  to: string[];
  subject: string | null;
  headers: Record<string, string>;
  labels: string[];
}

export interface Exclusion {
  kind: "sender" | "domain" | "label";
  value: string;
}

export type DiscardReason =
  | "list_unsubscribe"
  | "bulk_precedence"
  | "auto_submitted"
  | "noreply_sender"
  | "category_label"
  | "calendar_notification"
  | "excluded_sender"
  | "excluded_domain"
  | "excluded_label"
  | "spam_or_trash";

export interface PrefilterResult {
  keep: boolean;
  reason: DiscardReason | null;
}

const NOREPLY =
  /(^|[.\-_])(no[-_.]?reply|noreply|do[-_.]?not[-_.]?reply|notifications?|mailer-daemon|postmaster|newsletter|news|marketing|bounce)([.\-_+]|@)/i;
const CATEGORY_LABELS = new Set([
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]);
const CALENDAR_SUBJECT =
  /^(invitaci[oó]n|invitation|updated invitation|accepted|aceptad[oa]|declined|rechazad[oa]|tentative|invitaci[oó]n actualizada)[:\s]/i;

export const emailAddress = (raw: string): string => {
  const m = /<([^>]+)>/.exec(raw);
  return (m?.[1] ?? raw).trim().toLowerCase();
};
export const emailDomain = (raw: string): string => emailAddress(raw).split("@")[1] ?? "";

function header(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

export function prefilterMessage(message: PrefilterMessage, exclusions: Exclusion[] = []): PrefilterResult {
  const from = emailAddress(message.from);
  const domain = emailDomain(message.from);
  const labels = new Set(message.labels.map((l) => l.toUpperCase()));
  const discard = (reason: DiscardReason): PrefilterResult => ({ keep: false, reason });

  if (labels.has("SPAM") || labels.has("TRASH")) return discard("spam_or_trash");
  for (const ex of exclusions) {
    const value = ex.value.toLowerCase();
    if (ex.kind === "sender" && from === value) return discard("excluded_sender");
    if (ex.kind === "domain" && (domain === value || domain.endsWith(`.${value}`)))
      return discard("excluded_domain");
    if (ex.kind === "label" && labels.has(value.toUpperCase())) return discard("excluded_label");
  }
  if (header(message.headers, "List-Unsubscribe") !== undefined) return discard("list_unsubscribe");
  const precedence = header(message.headers, "Precedence")?.toLowerCase();
  if (precedence && ["bulk", "list", "junk"].includes(precedence)) return discard("bulk_precedence");
  const auto = header(message.headers, "Auto-Submitted")?.toLowerCase();
  if (auto && auto !== "no") return discard("auto_submitted");
  if (NOREPLY.test(from)) return discard("noreply_sender");
  for (const l of labels) if (CATEGORY_LABELS.has(l)) return discard("category_label");
  if (
    from.startsWith("calendar-notification@") ||
    (message.subject && CALENDAR_SUBJECT.test(message.subject))
  )
    return discard("calendar_notification");
  return { keep: true, reason: null };
}
