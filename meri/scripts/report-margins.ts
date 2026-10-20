/**
 * Operator margin report (D-062): one row per workspace for a month, read from `billing_rollups` with the admin
 * read context (D-037). Ids and figures only: no email, name or client data is ever printed.
 * Usage: pnpm report:margins [--period=YYYY-MM]   (needs DATABASE_ADMIN_URL; defaults to the current month)
 */
import { loadConfig, loadDotenv } from "@meri/config";
import { ADMIN_WORKSPACE_CONTEXT, createDb, listRollupsForPeriod, type RollupRow } from "@meri/db";

const usd = (micro: number) => (micro / 1_000_000).toFixed(2);

export interface MarginReport {
  period: string;
  lines: string[];
  totals: {
    workspaces: number;
    paying: number;
    alarms: number;
    revenueMicroUsd: number;
    aiCostMicroUsd: number;
  };
}

/** Pure formatter (tested): a fixed-width table plus totals. */
export function formatMarginReport(period: string, rows: readonly RollupRow[]): MarginReport {
  const header = [
    "workspace",
    "plan",
    "credits",
    "ai_usd",
    "revenue_usd",
    "infra_usd",
    "fees_usd",
    "margin_%",
    "alarm",
  ];
  const body = rows.map((r) => [
    r.workspaceId,
    r.plan,
    r.creditsUsed.toFixed(1),
    usd(r.aiCostMicroUsd),
    usd(r.revenueMicroUsd),
    usd(r.infraCostMicroUsd),
    usd(r.paymentFeeMicroUsd),
    r.grossMarginPct === null ? "-" : r.grossMarginPct.toFixed(1),
    r.marginAlarm ? "ALARM" : "",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] ?? "").length)));
  const fmt = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  const totals = {
    workspaces: rows.length,
    paying: rows.filter((r) => r.charged).length,
    alarms: rows.filter((r) => r.marginAlarm).length,
    revenueMicroUsd: rows.reduce((s, r) => s + r.revenueMicroUsd, 0),
    aiCostMicroUsd: rows.reduce((s, r) => s + r.aiCostMicroUsd, 0),
  };
  const lines = [
    `Meri margin report ${period} (revenue estimated from the plan catalogue)`,
    fmt(header),
    ...body.map(fmt),
    `workspaces=${String(totals.workspaces)} paying=${String(totals.paying)} alarms=${String(totals.alarms)} revenue_usd=${usd(totals.revenueMicroUsd)} ai_usd=${usd(totals.aiCostMicroUsd)}`,
  ];
  return { period, lines, totals };
}

export async function reportMargins(options: { adminUrl: string; period: string }): Promise<MarginReport> {
  const handle = createDb(options.adminUrl, {
    max: 1,
    connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT },
  });
  try {
    return formatMarginReport(options.period, await listRollupsForPeriod(handle.db, options.period));
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  loadDotenv(".env");
  const { env } = loadConfig(process.env);
  const arg = process.argv.find((a) => a.startsWith("--period="))?.slice("--period=".length);
  const period = arg ?? new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error(`--period must be YYYY-MM, got ${period}`);
  if (!env.DATABASE_ADMIN_URL)
    throw new Error("DATABASE_ADMIN_URL is required (operator report across workspaces).");
  const report = await reportMargins({ adminUrl: env.DATABASE_ADMIN_URL, period });
  process.stdout.write(`${report.lines.join("\n")}\n`);
}

if (process.argv[1]?.endsWith("report-margins.ts")) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
