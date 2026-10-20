import { describe, expect, it } from "vitest";
import { bootstrapAccount, createDb, upsertRollup, withWorkspace, type RollupRow } from "@meri/db";
import { formatMarginReport, reportMargins } from "../report-margins";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const TEST_ADMIN_URL = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";
const NOW = new Date("2026-10-20T08:40:00Z");

const row = (overrides: Partial<RollupRow>): RollupRow => ({
  workspaceId: "01a15596-f037-71e4-bfce-25b2f4a80b44",
  period: "2026-10",
  plan: "pro",
  charged: true,
  creditsUsed: 120.4,
  aiCostMicroUsd: 1_500_000,
  revenueMicroUsd: 29_000_000,
  infraCostMicroUsd: 3_000_000,
  paymentFeeMicroUsd: 1_141_000,
  grossMarginPct: 80.3,
  marginAlarm: false,
  computedAt: NOW,
  ...overrides,
});

describe("pnpm report:margins (D-062)", () => {
  it("formats one row per workspace with totals and the alarm marker", () => {
    const report = formatMarginReport("2026-10", [
      row({}),
      row({ workspaceId: "01a15596-f037-71e4-bfce-25b2f4a80b45", plan: "trial", charged: false, revenueMicroUsd: 0, paymentFeeMicroUsd: 0, grossMarginPct: null }),
      row({ workspaceId: "01a15596-f037-71e4-bfce-25b2f4a80b46", aiCostMicroUsd: 9_000_000, grossMarginPct: 54.4, marginAlarm: true }),
    ]);
    expect(report.lines[0]).toContain("2026-10");
    expect(report.lines).toHaveLength(6);
    expect(report.lines[2]).toMatch(/^01a15596-f037-71e4-bfce-25b2f4a80b44\s+pro\s+120\.4\s+1\.50\s+29\.00\s+3\.00\s+1\.14\s+80\.3$/);
    expect(report.lines[3]).toMatch(/trial .* - *$/);
    expect(report.lines[4]).toMatch(/ALARM$/);
    expect(report.totals).toEqual({ workspaces: 3, paying: 2, alarms: 1, revenueMicroUsd: 58_000_000, aiCostMicroUsd: 12_000_000 });
  });

  it("reads every workspace's rollup through the admin context and prints no personal data", async () => {
    const handle = createDb(TEST_APP_URL, { max: 1 });
    const email = `margins-${crypto.randomUUID()}@test.local`;
    const account = await bootstrapAccount(handle.db, { email, name: "Persona Secreta", now: NOW });
    const { workspaceId: _ws, computedAt: _at, ...input } = row({ period: "2031-01" });
    await withWorkspace(handle.db, account.workspaceId, (tx) => upsertRollup(tx, account.workspaceId, input, NOW));
    await handle.close();
    const report = await reportMargins({ adminUrl: TEST_ADMIN_URL, period: "2031-01" });
    const text = report.lines.join("\n");
    expect(text).toContain(account.workspaceId);
    expect(text).not.toContain(email);
    expect(text).not.toContain("Persona Secreta");
  });
});
