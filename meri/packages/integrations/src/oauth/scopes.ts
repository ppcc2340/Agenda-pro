/** Google scopes per feature (docs/06 §1). Gmail: read-only + compose, never `gmail.send` (CLAUDE.md). */
export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
] as const;

export type GoogleFeature = "calendar" | "gmail" | "all";

export function scopesFor(feature: GoogleFeature): string[] {
  if (feature === "calendar") return [...CALENDAR_SCOPES];
  if (feature === "gmail") return [...GMAIL_SCOPES];
  return [...CALENDAR_SCOPES, ...GMAIL_SCOPES];
}

export const hasGmailScopes = (scopes: readonly string[]): boolean => scopes.includes(GMAIL_SCOPES[0]);
export const hasCalendarScopes = (scopes: readonly string[]): boolean => scopes.includes(CALENDAR_SCOPES[0]);
