import { eq } from "drizzle-orm";
import { z } from "zod";
import { preferences } from "../schema";
import type { WorkspaceTx } from "../workspace";
import type { WorkspaceId } from "../ids";

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected HH:MM");

export const PreferencesSchema = z.object({
  timezone: z.string().min(1).max(64),
  workStart: HHMM,
  workEnd: HHMM,
  workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  deepWorkWindows: z.array(z.object({ start: HHMM, end: HHMM })).max(8),
  minBlockMinutes: z.number().int().min(15).max(240),
  minDeepBlockMinutes: z.number().int().min(30).max(480),
  bufferMinutes: z.number().int().min(0).max(60),
  contingencyPct: z.number().int().min(0).max(60),
  riskThresholdHours: z.number().int().min(0).max(80),
  maxAlertsPerDay: z.number().int().min(0).max(50),
  autonomy: z.enum(["suggest_only", "auto_low_risk"]),
  timeRoundingMinutes: z.number().int().min(1).max(60),
});
export type Preferences = z.infer<typeof PreferencesSchema>;
export const PreferencesPatchSchema = PreferencesSchema.partial().refine(
  (p) => !(p.workStart && p.workEnd) || p.workStart < p.workEnd,
  { message: "workStart must be before workEnd", path: ["workEnd"] },
);
export type PreferencesPatch = z.infer<typeof PreferencesPatchSchema>;

export interface PreferencesView extends Preferences {
  onboardedAt: Date | null;
}

type PreferencesRow = typeof preferences.$inferSelect;
const toView = (row: PreferencesRow): PreferencesView => {
  const { workspaceId: _ws, updatedAt: _u, ...rest } = row;
  return rest;
};

export async function getPreferences(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
): Promise<PreferencesView | null> {
  const row = await tx.query.preferences.findFirst({ where: eq(preferences.workspaceId, workspaceId) });
  return row ? toView(row) : null;
}

export interface UpdatePreferencesOptions {
  /** Injected clock. */
  now: Date;
  /** Mark onboarding as completed (idempotent). */
  completeOnboarding?: boolean;
}

export async function updatePreferences(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  patch: PreferencesPatch,
  options: UpdatePreferencesOptions,
): Promise<PreferencesView> {
  const current = await tx.query.preferences.findFirst({ where: eq(preferences.workspaceId, workspaceId) });
  if (!current) throw new Error("preferences row missing for workspace");
  const [row] = await tx
    .update(preferences)
    .set({
      ...patch,
      updatedAt: options.now,
      onboardedAt: options.completeOnboarding ? (current.onboardedAt ?? options.now) : current.onboardedAt,
    })
    .where(eq(preferences.workspaceId, workspaceId))
    .returning();
  if (!row) throw new Error("preferences row missing for workspace");
  return toView(row);
}
