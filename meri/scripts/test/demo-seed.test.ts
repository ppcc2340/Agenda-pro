import { describe, expect, it } from "vitest";
import { createDb, listClients, listProposals, listTasks, listTimeEntries, withWorkspace, type WorkspaceId } from "@meri/db";
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
    } finally {
      await handle.close();
    }
  }, 60_000);
});
