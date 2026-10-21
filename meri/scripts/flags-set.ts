/**
 * Turns a feature flag on or off (docs/02, D-102). Run by a person with the owner connection; the app only reads.
 *   pnpm flags:set <flag> on|off [--workspace <id>]
 * Example: pnpm flags:set price_experiment on   (confirm anchor B and its Stripe prices first: docs/runbooks/beta.md)
 * Needs DATABASE_ADMIN_URL. The running API picks the change up within 30 s.
 */
import { FEATURE_FLAGS, loadDotenv } from "@meri/config";
import { createDb, setFlag } from "@meri/db";

export async function setFeatureFlag(
  adminUrl: string,
  args: string[],
): Promise<{ flag: string; enabled: boolean; workspaceId: string | null }> {
  const [flag, state] = args;
  const wsIndex = args.indexOf("--workspace");
  const workspaceId = wsIndex >= 0 ? (args[wsIndex + 1] ?? null) : null;
  if (!flag || !(FEATURE_FLAGS as readonly string[]).includes(flag) || (state !== "on" && state !== "off"))
    throw new Error(`Usage: pnpm flags:set <${FEATURE_FLAGS.join("|")}> on|off [--workspace <id>]`);
  if (wsIndex >= 0 && !workspaceId) throw new Error("--workspace needs an id");
  const handle = createDb(adminUrl, { max: 1 });
  try {
    await setFlag(handle.db, { flag, enabled: state === "on", workspaceId });
  } finally {
    await handle.close();
  }
  return { flag, enabled: state === "on", workspaceId };
}

if (process.argv[1]?.endsWith("flags-set.ts")) {
  loadDotenv(".env");
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  (adminUrl
    ? setFeatureFlag(adminUrl, process.argv.slice(2))
    : Promise.reject(new Error("DATABASE_ADMIN_URL is required."))
  )
    .then((r) => {
      console.warn(
        `${r.flag} ${r.enabled ? "on" : "off"}${r.workspaceId ? ` for workspace ${r.workspaceId}` : " (global)"}`,
      );
    })
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
}
