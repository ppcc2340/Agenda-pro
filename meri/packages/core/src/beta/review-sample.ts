/**
 * AI quality review sample (D-103, plan review SEC-H2): which proposals may enter it and how their text is redacted.
 * Pure: the script reads the database and writes the file. Only proposals that do not come from the mailbox are
 * eligible (Google limited use, confidentiality of third parties), and every string is redacted before it leaves.
 */

/** Proposal kinds whose content can derive from mail even without a thread source (follow-ups, contact links). */
const MAIL_KINDS = new Set(["followup", "client_link"]);
/** Source types that point at the mailbox. */
const MAIL_SOURCES = new Set(["thread", "message", "gmail", "mail"]);

export function isReviewEligible(p: { kind: string; status: string; sourceType: string | null }): boolean {
  if (p.status !== "dismissed" && p.status !== "edited") return false;
  if (MAIL_KINDS.has(p.kind)) return false;
  return p.sourceType === null || !MAIL_SOURCES.has(p.sourceType);
}

/** Identifiers pasted into text (a workspace, task or event id): they point back at an account. */
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/giu;
/** Chilean RUT, with or without dots: 12.345.678-5, 12345678-K. */
const RUT = /\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/gu;
/** Phone-like runs: optional +, digits with spaces, dots, dashes or parentheses, 8+ digits overall. */
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d(?:[\s.-]?\d){7,}/gu;
/** Any other long number (accounts, case files, amounts with many digits). */
const LONG_NUMBER = /\b\d{6,}\b/gu;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Redacts one string: identifiers, addresses, links, RUTs, phones, long numbers, and the workspace's own client and contact
 * names (longest first, whole words, any case). Short names (< 3 letters) are left alone to avoid shredding words.
 */
export function redactForReview(text: string, names: readonly string[] = []): string {
  let out = text
    .replace(UUID, "[id]")
    .replace(EMAIL, "[correo]")
    .replace(URL_RE, "[enlace]")
    .replace(RUT, "[rut]")
    .replace(PHONE, "[teléfono]")
    .replace(LONG_NUMBER, "[número]");
  const usable = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 3))].sort(
    (a, b) => b.length - a.length,
  );
  for (const name of usable)
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(name)}(?![\\p{L}\\p{N}])`, "giu"), "[nombre]");
  return out;
}

/** Keys that carry identifiers, never content: dropped from the sample. */
const ID_KEY = /(^id$|Id$|_id$|^ids?$|externalId|dedupeHash)/;

/** Redacts every string of a JSON value and drops identifier keys; depth-limited. */
export function redactValue(value: unknown, names: readonly string[], depth = 0): unknown {
  if (depth > 6) return null;
  if (typeof value === "string") return redactForReview(value, names);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, names, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !ID_KEY.test(k))
        .map(([k, v]) => [k, redactValue(v, names, depth + 1)]),
    );
  return value;
}
