import { describe, expect, it } from "vitest";
import {
  CALENDAR_SCOPES,
  FORBIDDEN_SCOPES,
  GMAIL_SCOPES,
  hasCalendarScopes,
  hasForbiddenScope,
  hasGmailScopes,
  scopesFor,
} from "./scopes";

describe("Google scopes (docs/06 §1, D-093)", () => {
  it("never requests a forbidden scope for any feature", () => {
    for (const feature of ["calendar", "gmail", "all"] as const)
      for (const scope of scopesFor(feature)) expect(FORBIDDEN_SCOPES).not.toContain(scope);
  });

  it("asks for calendar read plus app-created calendars only, and Gmail read plus drafts only", () => {
    expect([...CALENDAR_SCOPES].sort()).toEqual([
      "https://www.googleapis.com/auth/calendar.app.created",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
    expect([...GMAIL_SCOPES].sort()).toEqual([
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
  });

  it("still recognises calendar access granted before D-093 (calendar.events + calendar.readonly)", () => {
    expect(
      hasCalendarScopes([
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar.readonly",
      ]),
    ).toBe(true);
    expect(hasCalendarScopes(["https://www.googleapis.com/auth/gmail.readonly"])).toBe(false);
  });

  it("every connection asks for the identity scopes; Gmail needs both read and drafts", () => {
    for (const feature of ["calendar", "gmail", "all"] as const)
      expect(scopesFor(feature).slice(0, 2)).toEqual(["openid", "email"]);
    expect(hasGmailScopes([...GMAIL_SCOPES])).toBe(true);
    expect(hasGmailScopes(["https://www.googleapis.com/auth/gmail.readonly"])).toBe(false);
    expect(hasForbiddenScope(["openid", "https://www.googleapis.com/auth/gmail.send"])).toBe(true);
    expect(hasForbiddenScope(scopesFor("all"))).toBe(false);
  });
});
