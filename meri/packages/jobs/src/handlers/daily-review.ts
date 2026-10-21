/**
 * daily.review (docs/13, D-020): start-of-day digest as a template (no AI), one per workspace and local day.
 * Writes the in-app inbox row; the `notify.email` job sends the email copy (D-115), never from the user's Gmail.
 */
import { localDateKey, toLocalParts } from "@meri/core";
import {
  countNotificationsForDay,
  countPending,
  getPreferences,
  insertNotification,
  latestPlanRun,
  listBlocks,
  withWorkspace,
  type WorkspaceId,
} from "@meri/db";
import type { HandlerDeps } from "./context";

export interface DailyReviewResult {
  status: "sent" | "duplicate" | "skipped";
  blocks: number;
  risks: number;
  proposals: number;
}

/** Workspaces whose local clock is past work start today and that did not get today's digest yet (dispatcher input). */
export function dueForDigest(
  rows: { workspaceId: string; timezone: string; workStart: string; lastDigestDay: string | null }[],
  now: Date,
): { workspaceId: string; date: string }[] {
  const due: { workspaceId: string; date: string }[] = [];
  for (const r of rows) {
    let date: string;
    let local: ReturnType<typeof toLocalParts>;
    try {
      date = localDateKey(now.getTime(), r.timezone);
      local = toLocalParts(now.getTime(), r.timezone);
    } catch {
      continue; // invalid zone: never block the others
    }
    const [h = "0", m = "0"] = r.workStart.split(":");
    const startMin = Number(h) * 60 + Number(m);
    if (local.hour * 60 + local.minute < startMin) continue;
    if (r.lastDigestDay === date) continue;
    due.push({ workspaceId: r.workspaceId, date });
  }
  return due;
}

/** Spanish default rendering (fallback for e-mail); the UI renders `template` + `params` in the user's locale. */
export function renderDigest(params: { blocks: number; risks: number; proposals: number }): {
  title: string;
  body: string;
} {
  return {
    title: "Resumen del día",
    body: `${String(params.blocks)} bloques planificados, ${String(params.risks)} riesgos, ${String(params.proposals)} propuestas pendientes.`,
  };
}

export async function runDailyReview(
  deps: HandlerDeps,
  workspaceId: WorkspaceId,
  input: { date: string },
): Promise<DailyReviewResult> {
  const now = deps.now();
  const result = await withWorkspace(deps.db, workspaceId, async (tx) => {
    const prefs = await getPreferences(tx, workspaceId);
    if (!prefs) return { status: "skipped" as const, blocks: 0, risks: 0, proposals: 0 };
    if ((await countNotificationsForDay(tx, workspaceId, input.date, "digest")) > 0) {
      return { status: "duplicate" as const, blocks: 0, risks: 0, proposals: 0 };
    }
    // Blocks of the local day: 00:00–24:00 in the user's zone, approximated by a 48 h window filtered by day key.
    const window = {
      from: new Date(now.getTime() - 36 * 3_600_000),
      to: new Date(now.getTime() + 36 * 3_600_000),
    };
    const blocks = (await listBlocks(tx, workspaceId, window)).filter(
      (b) => b.completedAt === null && localDateKey(b.startsAt.getTime(), prefs.timezone) === input.date,
    );
    const run = await latestPlanRun(tx, workspaceId);
    const params = {
      blocks: blocks.length,
      risks: (run?.risks.length ?? 0) + (run?.conflicts.length ?? 0),
      proposals: await countPending(tx, workspaceId),
    };
    const text = renderDigest(params);
    const notification = await insertNotification(
      tx,
      workspaceId,
      {
        kind: "digest",
        template: "daily.digest",
        params,
        title: text.title,
        body: text.body,
        refs: blocks.map((b) => ({ type: "schedule_block", id: b.id })),
        day: input.date,
      },
      now,
    );
    return { status: "sent" as const, ...params, notification };
  });
  return { status: result.status, blocks: result.blocks, risks: result.risks, proposals: result.proposals };
}
