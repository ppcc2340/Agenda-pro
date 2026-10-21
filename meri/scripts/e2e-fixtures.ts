/**
 * E2E fixtures that the UI cannot reach in reasonable time: a workspace with its AI credits used up (phase 4), an
 * account onboarded weeks ago so the Sean Ellis survey is due (phase 6). Test tooling only: refuses a production
 * configuration and any account outside the `@meri.local` test domain.
 * Usage: pnpm e2e:fixture --exhaust-credits=<email> | --onboarded-days-ago=<email>:<days> | --unsubscribe-token=<email>
 */
import { isProductionEnv, loadDotenv, parseEnv } from "@meri/config";
import { signUnsubscribeToken } from "@meri/config/crypto";
import {
  createDb,
  getCreditBalance,
  recordAiUsage,
  withWorkspace,
  type DbHandle,
  type WorkspaceId,
} from "@meri/db";

async function workspaceOf(handle: DbHandle, email: string): Promise<WorkspaceId> {
  if (!email.endsWith("@meri.local")) throw new Error("only @meri.local test accounts can be modified");
  const user = await handle.db.query.users.findFirst({
    where: (u, { eq }) => eq(u.email, email.toLowerCase()),
  });
  if (!user) throw new Error(`no account for ${email}`);
  const ws = await handle.db.query.workspaces.findFirst({ where: (w, { eq }) => eq(w.ownerId, user.id) });
  if (!ws) throw new Error(`no workspace for ${email}`);
  return ws.id as WorkspaceId;
}

/** Moves the onboarding date back so time-based prompts (the Sean Ellis survey after 14 days) become due. */
export async function backdateOnboarding(
  databaseUrl: string,
  email: string,
  days: number,
  now: Date,
): Promise<void> {
  if (!Number.isInteger(days) || days < 0 || days > 365)
    throw new Error("days must be an integer from 0 to 365");
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    const workspaceId = await workspaceOf(handle, email);
    const at = new Date(now.getTime() - days * 86_400_000).toISOString();
    await handle.sql.begin(async (tx) => {
      await tx`select set_config('app.workspace_id', ${workspaceId}, true)`;
      await tx`update preferences set onboarded_at = ${at}::timestamptz where workspace_id = ${workspaceId}`;
    });
  } finally {
    await handle.close();
  }
}

/** The signed one-click unsubscribe token of a test account (the link every email carries, D-116). */
export async function unsubscribeToken(
  databaseUrl: string,
  authSecret: string,
  email: string,
): Promise<string> {
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    return signUnsubscribeToken(authSecret, await workspaceOf(handle, email));
  } finally {
    await handle.close();
  }
}

export async function exhaustCredits(
  databaseUrl: string,
  email: string,
  now: Date,
): Promise<{ used: number }> {
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    const workspaceId = await workspaceOf(handle, email);
    return await withWorkspace(handle.db, workspaceId, async (tx) => {
      const balance = await getCreditBalance(tx, workspaceId, now);
      if (balance.remaining > 0)
        await recordAiUsage(
          tx,
          workspaceId,
          {
            operation: "summary",
            model: "e2e-fixture",
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            costMicroUsd: 0,
            credits: balance.remaining,
          },
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
  const now = env.DEMO_NOW ? new Date(env.DEMO_NOW) : new Date();
  const unsubscribe = process.argv
    .find((a) => a.startsWith("--unsubscribe-token="))
    ?.slice("--unsubscribe-token=".length);
  if (unsubscribe) {
    // stdout carries only the token so the E2E can read it.
    process.stdout.write(`${await unsubscribeToken(env.DATABASE_URL, env.AUTH_SECRET, unsubscribe)}\n`);
    return;
  }
  const onboarded = process.argv
    .find((a) => a.startsWith("--onboarded-days-ago="))
    ?.slice("--onboarded-days-ago=".length);
  if (onboarded) {
    const at = onboarded.lastIndexOf(":");
    const address = onboarded.slice(0, at);
    await backdateOnboarding(env.DATABASE_URL, address, Number(onboarded.slice(at + 1)), now);
    console.warn(`onboarding of ${address} moved back`);
    return;
  }
  const email = process.argv
    .find((a) => a.startsWith("--exhaust-credits="))
    ?.slice("--exhaust-credits=".length);
  if (!email)
    throw new Error(
      "usage: pnpm e2e:fixture --exhaust-credits=<email> | --onboarded-days-ago=<email>:<days>",
    );
  const result = await exhaustCredits(env.DATABASE_URL, email, now);
  console.warn(`credits exhausted for ${email} (${String(result.used)} used)`);
}

if (process.argv[1]?.endsWith("e2e-fixtures.ts")) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
