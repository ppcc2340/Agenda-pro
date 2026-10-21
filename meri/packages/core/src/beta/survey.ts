/**
 * Sean Ellis survey eligibility (D-101): «How would you feel if you could no longer use Meri?». Offered once the
 * person has had two weeks with the product; answered once per account; a dismissal postpones it 30 days, and after
 * the second dismissal it is never offered again (the beta should not nag).
 */
export const SURVEY_FIRST_AFTER_DAYS = 14;
export const SURVEY_RETRY_AFTER_DAYS = 30;
export const SURVEY_MAX_DISMISSALS = 2;

export type SeanEllisAnswer = "very" | "somewhat" | "not" | "na";

export interface SurveyEvent {
  answer: SeanEllisAnswer | null;
  dismissedAt: Date | null;
  createdAt: Date;
}

export type SurveyEligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason: "not_onboarded" | "too_soon" | "answered" | "dismissed_recently" | "dismissed_max";
    };

const DAY_MS = 86_400_000;

export function seanEllisEligibility(input: {
  onboardedAt: Date | null;
  now: Date;
  history: readonly SurveyEvent[];
}): SurveyEligibility {
  if (!input.onboardedAt) return { eligible: false, reason: "not_onboarded" };
  if (input.history.some((e) => e.answer !== null)) return { eligible: false, reason: "answered" };
  const dismissals = input.history.filter((e) => e.dismissedAt !== null);
  if (dismissals.length >= SURVEY_MAX_DISMISSALS) return { eligible: false, reason: "dismissed_max" };
  if (input.now.getTime() - input.onboardedAt.getTime() < SURVEY_FIRST_AFTER_DAYS * DAY_MS)
    return { eligible: false, reason: "too_soon" };
  const last = Math.max(...dismissals.map((e) => (e.dismissedAt ?? e.createdAt).getTime()), -Infinity);
  if (input.now.getTime() - last < SURVEY_RETRY_AFTER_DAYS * DAY_MS)
    return { eligible: false, reason: "dismissed_recently" };
  return { eligible: true };
}

/**
 * The Sean Ellis score: share of «very disappointed» among people who answered with an opinion (`na`, «I no longer
 * use it», is left out as in the original method). `null` without answers.
 */
export function seanEllisScore(answers: readonly SeanEllisAnswer[]): { veryPct: number; n: number } | null {
  const counted = answers.filter((a) => a !== "na");
  if (counted.length === 0) return null;
  const very = counted.filter((a) => a === "very").length;
  return { veryPct: Math.round((very / counted.length) * 1000) / 10, n: counted.length };
}
