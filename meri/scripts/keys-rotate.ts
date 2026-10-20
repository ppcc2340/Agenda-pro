/**
 * Key rotation for stored OAuth tokens (ADR 0007, docs/runbooks/key-rotation.md). Lists the connections that hold
 * tokens through the admin read context, then rotates each one with the application role inside its workspace
 * (RLS) with compare-and-swap. Prints counts and key ids only, never tokens.
 * Usage: pnpm keys:rotate [--reencrypt]   (needs DATABASE_URL and DATABASE_ADMIN_URL; the KMS configuration in env)
 */
import { loadConfig, loadDotenv } from "@meri/config";
import { ADMIN_WORKSPACE_CONTEXT, createDb, listTokenHoldingAccounts } from "@meri/db";
import { createIntegrations } from "@meri/integrations";
import { rotateIntegrationKeys, type RotationReport } from "@meri/jobs";

export async function rotateKeys(options: {
  appUrl: string;
  adminUrl: string;
  keys: Parameters<typeof rotateIntegrationKeys>[0]["keys"];
  reencrypt: boolean;
}): Promise<RotationReport> {
  const admin = createDb(options.adminUrl, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
  const app = createDb(options.appUrl, { max: 2 });
  try {
    const targets = await listTokenHoldingAccounts(admin.db);
    return await rotateIntegrationKeys({ db: app.db, keys: options.keys }, targets, { reencrypt: options.reencrypt });
  } finally {
    await admin.close();
    await app.close();
  }
}

async function main(): Promise<void> {
  loadDotenv(".env");
  const config = loadConfig(process.env);
  if (!config.env.DATABASE_ADMIN_URL) throw new Error("DATABASE_ADMIN_URL is required to list connections.");
  const integrations = createIntegrations(config, { now: () => new Date() });
  const reencrypt = process.argv.includes("--reencrypt");
  const report = await rotateKeys({
    appUrl: config.env.DATABASE_URL,
    adminUrl: config.env.DATABASE_ADMIN_URL,
    keys: integrations.kms.keys,
    reencrypt,
  });
  process.stdout.write(
    `key rotation (${reencrypt ? "re-encrypt" : "re-wrap"}) to ${integrations.kms.keys.keyId}: scanned=${String(report.scanned)} rotated=${String(report.rotated)} current=${String(report.alreadyCurrent)} empty=${String(report.empty)} retried=${String(report.retried)} failed=${String(report.failed.length)}\n`,
  );
  for (const f of report.failed) process.stdout.write(`  failed workspace=${f.workspaceId} account=${f.accountId} reason=${f.reason}\n`);
  if (report.failed.length > 0) process.exitCode = 2;
}

if (process.argv[1]?.endsWith("keys-rotate.ts")) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
