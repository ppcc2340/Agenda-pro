/**
 * Performance seed (P1-10): one workspace with 500 tasks and 5 000 calendar events, through the same repos the app
 * uses (RLS on). Idempotent per e-mail: re-running adds nothing. Usage: pnpm seed:perf [--email perf@meri.local]
 */
import { loadConfig, loadDotenv } from "@meri/config";
import {
  bootstrapAccount,
  createDb,
  createTask,
  listIntegrationAccounts,
  listTasks,
  updatePreferences,
  upsertCalendarEvent,
  upsertIntegrationAccount,
  withWorkspace,
} from "@meri/db";
import { createIntegrations } from "@meri/integrations";
import { encryptTokens } from "@meri/jobs";

const TASKS = 500;
const EVENTS = 5_000;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

async function main(): Promise<void> {
  loadDotenv(".env");
  const config = loadConfig(process.env);
  const email = process.argv.includes("--email")
    ? (process.argv[process.argv.indexOf("--email") + 1] ?? "perf@meri.local")
    : "perf@meri.local";
  const now = config.env.DEMO_NOW ? new Date(config.env.DEMO_NOW) : new Date();
  const handle = createDb(config.env.DATABASE_URL, { max: 2 });
  const integrations = createIntegrations(config, { now: () => now });
  const random = rng(42);
  try {
    const acc = await bootstrapAccount(handle.db, { email, name: "Perf Seed", now });
    const ws = acc.workspaceId;
    const existing = await withWorkspace(handle.db, ws, (tx) =>
      listTasks(tx, ws, { includeCompleted: true }, { limit: 1 }),
    );
    if (existing.items.length > 0) {
      console.warn(`perf seed already present for ${email} (workspace ${ws})`);
      return;
    }
    await withWorkspace(handle.db, ws, async (tx) => {
      await updatePreferences(tx, ws, { timezone: "Europe/Madrid" }, { now, completeOnboarding: true });
      let accounts = await listIntegrationAccounts(tx, ws);
      if (accounts.length === 0) {
        const pre = await upsertIntegrationAccount(
          tx,
          ws,
          {
            provider: "google",
            externalAccountId: "perf-sub",
            email,
            scopes: ["calendar"],
            encryptedTokens: "pending",
            keyId: "local",
          },
          now,
        );
        const blob = await encryptTokens({ keys: integrations.kms.keys }, ws, pre.id, {
          accessToken: "perf-access",
          refreshToken: "perf-refresh",
          expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
          scopes: ["calendar"],
          externalAccountId: "perf-sub",
          email,
        });
        await upsertIntegrationAccount(
          tx,
          ws,
          {
            provider: "google",
            externalAccountId: "perf-sub",
            email,
            scopes: ["calendar"],
            encryptedTokens: blob,
            keyId: "local",
          },
          now,
        );
        accounts = await listIntegrationAccounts(tx, ws);
      }
      const account = accounts[0];
      if (!account) throw new Error("integration account missing");
      for (let i = 0; i < TASKS; i++) {
        const deep = random() < 0.4;
        await createTask(
          tx,
          ws,
          {
            title: `Tarea de carga ${String(i + 1).padStart(3, "0")}`,
            kind: deep ? "deep" : "shallow",
            estimateMinutes: deep ? 60 + Math.floor(random() * 4) * 30 : 15 + Math.floor(random() * 3) * 15,
            priority: 1 + Math.floor(random() * 4),
            dueAt:
              random() < 0.5
                ? new Date(now.getTime() + (1 + Math.floor(random() * 30)) * 86_400_000).toISOString()
                : null,
            status: random() < 0.3 ? "completed" : "pending",
          },
          now,
        );
      }
      // 5 000 events spread over ±180 days, working hours, 30–90 minutes.
      for (let i = 0; i < EVENTS; i++) {
        const dayOffset = Math.floor(random() * 360) - 180;
        const start = new Date(now);
        start.setUTCDate(start.getUTCDate() + dayOffset);
        start.setUTCHours(
          7 + Math.floor(random() * 10),
          [0, 15, 30, 45][Math.floor(random() * 4)] ?? 0,
          0,
          0,
        );
        const minutes = [30, 45, 60, 90][Math.floor(random() * 4)] ?? 30;
        await upsertCalendarEvent(
          tx,
          ws,
          {
            integrationAccountId: account.id,
            externalId: `perf-ev-${String(i)}`,
            etag: "1",
            title: `Reunión ${String(i)}`,
            startsAt: start,
            endsAt: new Date(start.getTime() + minutes * 60_000),
            allDay: false,
            attendees: [],
            busy: true,
            origin: "external",
          },
          now,
        );
      }
    });
    console.warn(
      `perf seed ready: ${email} (workspace ${ws}): ${String(TASKS)} tasks, ${String(EVENTS)} events`,
    );
  } finally {
    await handle.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
