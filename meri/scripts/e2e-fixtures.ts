/**
 * E2E fixtures that the UI cannot reach in reasonable time (phase 4: a workspace with its AI credits used up).
 * Test tooling only: refuses a production configuration and any account outside the `@meri.local` test domain.
 * Usage: pnpm e2e:fixture --exhaust-credits=<email>
 */
import { isProductionEnv, loadDotenv, parseEnv } from "@meri/config";
import { createDb, getCreditBalance, recordAiUsage, withWorkspace, type WorkspaceId } from "@meri/db";

export async function exhaustCredits(databaseUrl: string, email: string, now: Date): Promise<{ used: number }> {
  if (!email.endsWith("@meri.local")) throw new Error("only @meri.local test accounts can be modified");
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    const user = await handle.db.query.users.findFirst({ where: (u, { eq }) => eq(u.email, email.toLowerCase()) });
    if (!user) throw new Error(`no account for ${email}`);
    const ws = await handle.db.query.workspaces.findFirst({ where: (w, { eq }) => eq(w.ownerId, user.id) });
    if (!ws) throw new Error(`no workspace for ${email}`);
    const workspaceId = ws.id as WorkspaceId;
    return await withWorkspace(handle.db, workspaceId, async (tx) => {
      const balance = await getCreditBalance(tx, workspaceId, now);
      if (balance.remaining > 0)
        await recordAiUsage(
          tx,
          workspaceId,
          { operation: "summary", model: "e2e-fixture", inputTokens: 0, outputTokens: 0, cachedTokens: 0, costMicroUsd: 0, credits: balance.remaining },
          now,
        );
      return { used: (await getCreditBalance(tx, workspaceId, now)).used };
    });
  } finally {
    await handle.close();
  }
}

async function main(): Promise<void> {
  loadDotenv(".env");
  const env = parseEnv(process.env);
  if (isProductionEnv(env)) throw new Error("e2e fixtures are never run against a production configuration");
  const email = process.argv.find((a) => a.startsWith("--exhaust-credits="))?.slice("--exhaust-credits=".length);
  if (!email) throw new Error("usage: pnpm e2e:fixture --exhaust-credits=<email>");
  const now = env.DEMO_NOW ? new Date(env.DEMO_NOW) : new Date();
  const result = await exhaustCredits(env.DATABASE_URL, email, now);
  console.warn(`credits exhausted for ${email} (${String(result.used)} used)`);
}

if (process.argv[1]?.endsWith("e2e-fixtures.ts")) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
