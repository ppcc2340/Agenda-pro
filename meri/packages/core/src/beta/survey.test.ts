import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  SURVEY_FIRST_AFTER_DAYS,
  SURVEY_MAX_DISMISSALS,
  SURVEY_RETRY_AFTER_DAYS,
  seanEllisEligibility,
  seanEllisScore,
  type SurveyEvent,
} from "./survey";

const day = 86_400_000;
const onboarded = new Date("2026-09-01T09:00:00Z");
const at = (days: number) => new Date(onboarded.getTime() + days * day);
const dismissed = (days: number): SurveyEvent => ({
  answer: null,
  dismissedAt: at(days),
  createdAt: at(days),
});

describe("Sean Ellis eligibility (D-101)", () => {
  it("waits two weeks after onboarding, and never before onboarding", () => {
    expect(seanEllisEligibility({ onboardedAt: null, now: at(100), history: [] })).toEqual({
      eligible: false,
      reason: "not_onboarded",
    });
    expect(seanEllisEligibility({ onboardedAt: onboarded, now: at(13.9), history: [] })).toMatchObject({
      reason: "too_soon",
    });
    expect(
      seanEllisEligibility({ onboardedAt: onboarded, now: at(SURVEY_FIRST_AFTER_DAYS), history: [] }),
    ).toEqual({
      eligible: true,
    });
  });

  it("is answered once per account", () => {
    const history: SurveyEvent[] = [{ answer: "somewhat", dismissedAt: null, createdAt: at(15) }];
    expect(seanEllisEligibility({ onboardedAt: onboarded, now: at(400), history })).toMatchObject({
      reason: "answered",
    });
  });

  it("a dismissal postpones it 30 days, and the second one ends it", () => {
    const once = [dismissed(15)];
    expect(seanEllisEligibility({ onboardedAt: onboarded, now: at(44), history: once })).toMatchObject({
      reason: "dismissed_recently",
    });
    expect(
      seanEllisEligibility({ onboardedAt: onboarded, now: at(15 + SURVEY_RETRY_AFTER_DAYS), history: once }),
    ).toEqual({
      eligible: true,
    });
    const twice = [dismissed(15), dismissed(50)];
    expect(seanEllisEligibility({ onboardedAt: onboarded, now: at(1000), history: twice })).toMatchObject({
      reason: "dismissed_max",
    });
  });

  it("property: it is never offered to someone who answered, more than twice, or within 14 days", () => {
    const event = fc.record({
      answered: fc.boolean(),
      day: fc.double({ min: 0, max: 400, noNaN: true }),
    });
    fc.assert(
      fc.property(
        fc.array(event, { maxLength: 5 }),
        fc.double({ min: 0, max: 500, noNaN: true }),
        (events, nowDay) => {
          const history: SurveyEvent[] = events.map((e) =>
            e.answered
              ? { answer: "very", dismissedAt: null, createdAt: at(e.day) }
              : { answer: null, dismissedAt: at(e.day), createdAt: at(e.day) },
          );
          const result = seanEllisEligibility({ onboardedAt: onboarded, now: at(nowDay), history });
          if (!result.eligible) return;
          expect(history.some((h) => h.answer !== null)).toBe(false);
          expect(history.length).toBeLessThan(SURVEY_MAX_DISMISSALS);
          expect(nowDay).toBeGreaterThanOrEqual(SURVEY_FIRST_AFTER_DAYS);
          for (const h of history)
            expect(nowDay - (h.createdAt.getTime() - onboarded.getTime()) / day).toBeGreaterThanOrEqual(
              SURVEY_RETRY_AFTER_DAYS,
            );
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("Sean Ellis score", () => {
  it("is the share of «very disappointed» among opinions, leaving out «I no longer use it»", () => {
    expect(seanEllisScore([])).toBeNull();
    expect(seanEllisScore(["na", "na"])).toBeNull();
    expect(seanEllisScore(["very", "somewhat", "not", "na"])).toEqual({ veryPct: 33.3, n: 3 });
    expect(seanEllisScore(["very", "very"])).toEqual({ veryPct: 100, n: 2 });
  });
});
