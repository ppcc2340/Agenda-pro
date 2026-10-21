/** Google scopes per feature (docs/06 §1). Gmail: read-only + compose, never the send scope (CLAUDE.md). */
/**
 * Calendar (ADR 0007 addendum, D-093): read every calendar to plan around it, write only to calendars Meri created.
 * `calendar.app.created` is what `calendars.insert` needs for the dedicated «Meri» calendar and limits writes to it, so
 * third-party meetings are out of reach by permission, not only by code. Never `calendar` or `calendar.events`.
 */
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.app.created",
] as const;

/** Scopes Meri must never request (CLAUDE.md, docs/06 §1). */
export const FORBIDDEN_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send", // meri:send-guard (listed to be refused)
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;

export type GoogleFeature = "calendar" | "gmail" | "all";

/** Every connection also asks for the identity (userinfo `sub` + verified email, ADR 0008). */
export const IDENTITY_SCOPES = ["openid", "email"] as const;

export function scopesFor(feature: GoogleFeature): string[] {
  const featureScopes =
    feature === "calendar"
      ? CALENDAR_SCOPES
      : feature === "gmail"
        ? GMAIL_SCOPES
        : [...CALENDAR_SCOPES, ...GMAIL_SCOPES];
  return [...IDENTITY_SCOPES, ...featureScopes];
}

/** Gmail is usable only with both scopes: granular consent lets a user untick drafts (ADR 0008). */
export const hasGmailScopes = (scopes: readonly string[]): boolean =>
  GMAIL_SCOPES.every((s) => scopes.includes(s));

/** True when a grant includes a scope Meri must never hold (refused at connection time). */
export const hasForbiddenScope = (scopes: readonly string[]): boolean =>
  scopes.some((s) => (FORBIDDEN_SCOPES as readonly string[]).includes(s));
export const hasCalendarScopes = (scopes: readonly string[]): boolean => scopes.includes(CALENDAR_SCOPES[0]);
/** Writing blocks needs the «Meri» calendar scope too (a read-only calendar grant can only be mirrored). */
export const canWriteMeriCalendar = (scopes: readonly string[]): boolean =>
  CALENDAR_SCOPES.every((s) => scopes.includes(s));
