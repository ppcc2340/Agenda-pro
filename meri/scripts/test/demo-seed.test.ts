import { describe, expect, it } from "vitest";
import { createDb, latestPlanRun, listAudit, listBlocks, listCalendarEvents, listClients, listProposals, listTasks, listTimeEntries, withWorkspace, type WorkspaceId } from "@meri/db";
import { seedDemo } from "../demo-seed";

const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const TEST_ADMIN_URL = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";
const NOW = new Date("2026-10-20T08:40:00Z");
const env = { ...process.env, LOCAL_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"), AUTH_SECRET: "x".repeat(40), INTERNAL_API_SECRET: "y".repeat(20), NODE_ENV: "test" };

describe("pnpm demo:seed (PROTOTYPE.md, D-048)", () => {
  it("seeds the demo workspace through the real repos and handlers, deterministically and idempotently", async () => {
    const first = await seedDemo({ now: NOW, reset: true, databaseUrl: TEST_APP_URL, adminUrl: TEST_ADMIN_URL, env });
    expect(first.status).toBe("seeded");
    expect(first.counts).toEqual({ clients: 4, tasks: 9, events: 7, commitments: 6, proposals: 3 });
    const again = await seedDemo({ now: NOW, databaseUrl: TEST_APP_URL, env });
    expect(again).toEqual({ status: "skipped", workspaceId: first.workspaceId });
    const handle = createDb(TEST_APP_URL, { max: 1 });
    const ws = first.workspaceId as WorkspaceId;
    try {
      const [clients, tasks, time, pending] = await withWorkspace(handle.db, ws, (tx) =>
        Promise.all([
          listClients(tx, ws),
          listTasks(tx, ws, { includeCompleted: true }, { limit: 50 }),
          listTimeEntries(tx, ws, { from: "2026-10-12", to: "2026-10-25" }),
          listProposals(tx, ws, { status: "pending" }, { limit: 50 }),
        ]),
      );
      expect(clients.map((c) => c.name)).toEqual(["Acme Corp", "Beta Logística", "Estudio Norte", "Luna Legal"]);
      expect(clients.every((c) => c.color !== null)).toBe(true);
      expect(tasks.items).toHaveLength(9);
      // Derived by the real handlers: inferred time (approved last week, suggested today) and the follow-up scan.
      expect(time.filter((t) => t.status === "approved")).toHaveLength(3);
      expect(time.filter((t) => t.status === "suggested")).toHaveLength(2);
      expect(pending.items.filter((p) => p.kind === "commitment")).toHaveLength(3);
      expect(pending.items.filter((p) => p.kind === "followup").length).toBeGreaterThanOrEqual(1);
      // The plan of the day is the planner's own (no hand-written live blocks): no pending reorganisation, and
      // the only AI-looking activity is what the handlers produced.
      expect(pending.items.filter((p) => p.kind === "reschedule")).toHaveLength(0);
      const [plan, activity] = await withWorkspace(handle.db, ws, (tx) =>
        Promise.all([latestPlanRun(tx, ws), listAudit(tx, ws, 100)]),
      );
      expect(plan).not.toBeNull();
      expect(activity.items.some((a) => a.action === "plan.generated")).toBe(true);
      expect(activity.items.filter((a) => a.action === "time.approved")).toHaveLength(3);
    } finally {
      await handle.close();
    }
  }, 60_000);

  it("is deterministic: two seeds from scratch at the same clock give the same workspace (ids aside)", async () => {
    const snapshot = async () => {
      const seeded = await seedDemo({ now: NOW, reset: true, databaseUrl: TEST_APP_URL, adminUrl: TEST_ADMIN_URL, env });
      const ws = seeded.workspaceId as WorkspaceId;
      const handle = createDb(TEST_APP_URL, { max: 1 });
      try {
        return await withWorkspace(handle.db, ws, async (tx) => {
          const tasks = await listTasks(tx, ws, { includeCompleted: true }, { limit: 50 });
          const events = await listCalendarEvents(tx, ws, { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") });
          const blocks = await listBlocks(tx, ws);
          const time = await listTimeEntries(tx, ws, { from: "2026-10-01", to: "2026-11-01" });
          const proposals = await listProposals(tx, ws, { status: "pending" }, { limit: 50 });
          const titleOf = new Map<string, string>(tasks.items.map((t) => [t.id, t.title]));
          return {
            tasks: tasks.items.map((t) => `${t.title}|${t.status}|${t.dueAt?.toISOString() ?? ""}`).sort(),
            events: events.map((e) => `${e.title ?? ""}|${e.startsAt.toISOString()}|${e.endsAt.toISOString()}`).sort(),
            blocks: blocks.map((b) => `${titleOf.get(b.taskId) ?? ""}|${b.startsAt.toISOString()}|${b.endsAt.toISOString()}`).sort(),
            time: time.map((e) => `${e.day}|${String(e.minutes)}|${e.status}|${e.description ?? ""}`).sort(),
            proposals: proposals.items.map((p) => `${p.kind}|${String(p.confidence)}`).sort(),
          };
        });
      } finally {
        await handle.close();
      }
    };
    const a = await snapshot();
    const b = await snapshot();
    expect(a.blocks.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  }, 120_000);

  it("seeds on the first day of a month (date bounds use calendar arithmetic)", async () => {
    const first = await seedDemo({ now: new Date("2026-11-01T09:00:00Z"), reset: true, databaseUrl: TEST_APP_URL, adminUrl: TEST_ADMIN_URL, env });
    expect(first.status).toBe("seeded");
    const handle = createDb(TEST_APP_URL, { max: 1 });
    const ws = first.workspaceId as WorkspaceId;
    try {
      const time = await withWorkspace(handle.db, ws, (tx) => listTimeEntries(tx, ws, { from: "2026-10-19", to: "2026-11-02" }));
      expect(time.filter((t) => t.status === "approved").length).toBeGreaterThan(0);
    } finally {
      await handle.close();
    }
  }, 60_000);
});
