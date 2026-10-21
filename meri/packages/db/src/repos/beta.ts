import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../client";
import { newId, type WorkspaceId } from "../ids";
import { feedback, surveyResponses, waitlist } from "../schema";
import type { WorkspaceTx } from "../workspace";

/**
 * Waitlist (D-099, SEC-M4): the application role may only insert, so the answer is the same whether or not the
 * address was already there (no way to probe who signed up).
 */
export async function joinWaitlist(
  db: Db,
  input: { email: string; locale: "es" | "en"; now: Date },
): Promise<void> {
  await db
    .insert(waitlist)
    .values({ email: input.email.trim().toLowerCase(), locale: input.locale, consentAt: input.now })
    // No conflict target: naming one needs SELECT on the column, which the role deliberately lacks.
    .onConflictDoNothing();
}

/** Daily retention (SEC-M4): waitlist entries older than 180 days, with the owner connection. Returns the number removed. */
export async function pruneWaitlist(db: Db): Promise<number> {
  const [row] = await db.execute<{ n: number | string }>(sql`select prune_waitlist() as n`);
  return Number(row?.n ?? 0);
}

export type FeedbackKind = "bug" | "idea" | "other";

export async function insertFeedback(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: { kind: FeedbackKind; message: string; pagePath: string | null; now: Date },
): Promise<{ id: string }> {
  const id = newId();
  await tx.insert(feedback).values({
    id,
    workspaceId,
    kind: input.kind,
    message: input.message,
    pagePath: input.pagePath,
    createdAt: input.now,
  });
  return { id };
}

/** Feedback sent by this workspace since `since` (per-user limit, SEC-L). */
export async function countFeedbackSince(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  since: Date,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(feedback)
    .where(and(eq(feedback.workspaceId, workspaceId), gte(feedback.createdAt, since)));
  return row?.n ?? 0;
}

/** The workspace's feedback, newest first (account export, F-16). */
export async function listFeedback(tx: WorkspaceTx, workspaceId: WorkspaceId) {
  return tx
    .select({
      kind: feedback.kind,
      message: feedback.message,
      pagePath: feedback.pagePath,
      createdAt: feedback.createdAt,
    })
    .from(feedback)
    .where(eq(feedback.workspaceId, workspaceId))
    .orderBy(desc(feedback.createdAt));
}

export type SurveyAnswer = "very" | "somewhat" | "not" | "na";

export interface SurveyHistoryRow {
  answer: SurveyAnswer | null;
  comment: string | null;
  dismissedAt: Date | null;
  createdAt: Date;
}

/** Every Sean Ellis answer or dismissal of the workspace, newest first (D-101). */
export async function listSurveyHistory(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
): Promise<SurveyHistoryRow[]> {
  return tx
    .select({
      answer: surveyResponses.answer,
      comment: surveyResponses.comment,
      dismissedAt: surveyResponses.dismissedAt,
      createdAt: surveyResponses.createdAt,
    })
    .from(surveyResponses)
    .where(and(eq(surveyResponses.workspaceId, workspaceId), eq(surveyResponses.kind, "sean_ellis")))
    .orderBy(desc(surveyResponses.createdAt));
}

export async function recordSurvey(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: { answer: SurveyAnswer; comment: string | null; now: Date } | { dismissed: true; now: Date },
): Promise<boolean> {
  // A second answer from a concurrent tab hits `survey_one_answer_uq`: nothing is written and the caller says so.
  const rows = await tx
    .insert(surveyResponses)
    .values({
      id: newId(),
      workspaceId,
      kind: "sean_ellis",
      ...("dismissed" in input
        ? { answer: null, comment: null, dismissedAt: input.now }
        : { answer: input.answer, comment: input.comment, dismissedAt: null }),
      createdAt: input.now,
    })
    .onConflictDoNothing()
    .returning({ id: surveyResponses.id });
  return rows.length > 0;
}
