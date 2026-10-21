import { bootstrapAccount, createDb } from "@meri/db";
import { afterAll, describe, expect, it } from "vitest";
import { collectPanel, renderReport, renderText } from "../lib/beta-panel";

const APP = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const ADMIN = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";

describe("pnpm beta:panel / beta:report (D-100, D-104)", () => {
  const app = createDb(APP, { max: 1 });
  afterAll(() => app.close());

  it("with no data recommends nothing, reads queues from the worker, and the report is aggregates only", async () => {
    const acc = await bootstrapAccount(app.db, {
      email: `panel-${Date.now().toString(36)}@test.local`,
      now: new Date(),
    });
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            queues: { "calendar.sync": { failed: 2 }, "gmail.sync": { failed: 0 } },
            deadLetter: 1,
          }),
        ),
      )) as unknown as typeof fetch;
    const result = await collectPanel({
      adminUrl: ADMIN,
      now: new Date(),
      workspaceIds: [acc.workspaceId],
      workerReadyUrl: "http://worker/ready",
      fetch: fakeFetch,
    });
    expect(result.panel.recommendation).toBe("no_data");
    expect(result.panel.indicators.every((i) => i.verdict === "no_data")).toBe(true);
    expect(result.reliability).toMatchObject({
      failedByQueue: { "calendar.sync": 2, "gmail.sync": 0 },
      deadLetter: 1,
    });
    const text = renderText(result);
    expect(text).toContain("calendar.sync=2");
    expect(text).toContain("sin datos");
    const report = renderReport(result);
    expect(report).toContain("Solo es válido con datos reales");
    expect(report).not.toMatch(/@|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("an unreachable worker leaves the queues without data instead of failing", async () => {
    const down = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
    const result = await collectPanel({
      adminUrl: ADMIN,
      now: new Date(),
      workspaceIds: ["0192aaaa-0000-7000-8000-000000000000"],
      workerReadyUrl: "http://x",
      fetch: down,
    });
    expect(result.reliability.failedByQueue).toBeNull();
    expect(renderText(result)).toContain("Worker no disponible");
  });

  it("the panel session is read-only", async () => {
    const ro = createDb(ADMIN, { max: 1, connection: { default_transaction_read_only: "on" } });
    try {
      await expect(ro.sql`create temporary table panel_probe (x int)`).rejects.toSatisfy((e) =>
        /read-only/.test(`${(e as Error).message} ${(e as { cause?: Error }).cause?.message ?? ""}`),
      );
    } finally {
      await ro.close();
    }
  });
});
