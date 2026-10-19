import { createDb } from "../client";
import { bootstrapAccount } from "../repos/accounts";
import { updatePreferences } from "../repos/preferences";
import { withWorkspace } from "../workspace";
import { clients } from "../schema";
import { newId } from "../ids";

/** Development seed (docs/12 §4: test data only through seeds, never real data). Idempotent. */
export async function seedDev(
  databaseUrl: string,
  now = new Date(),
): Promise<{ email: string; workspaceId: string }> {
  const handle = createDb(databaseUrl, { max: 1 });
  try {
    const acc = await bootstrapAccount(handle.db, { email: "dev@meri.local", name: "Dev Meri", now });
    await withWorkspace(handle.db, acc.workspaceId, async (tx) => {
      await updatePreferences(
        tx,
        acc.workspaceId,
        { timezone: "Europe/Madrid" },
        { now, completeOnboarding: true },
      );
      const existing = await tx.select({ id: clients.id }).from(clients);
      if (existing.length === 0) {
        await tx.insert(clients).values([
          {
            id: newId(),
            workspaceId: acc.workspaceId,
            name: "Acme Corp",
            domains: ["acme.com"],
            color: "#3A6EDB",
          },
          {
            id: newId(),
            workspaceId: acc.workspaceId,
            name: "Estudio Norte",
            domains: ["estudionorte.cl"],
            color: "#2F8A5C",
          },
          {
            id: newId(),
            workspaceId: acc.workspaceId,
            name: "Luna Legal",
            domains: ["lunalegal.es"],
            color: "#B07414",
          },
          {
            id: newId(),
            workspaceId: acc.workspaceId,
            name: "Beta Logística",
            domains: ["betalogistica.com"],
            color: "#B0407E",
          },
        ]);
      }
    });
    return { email: acc.email, workspaceId: acc.workspaceId };
  } finally {
    await handle.close();
  }
}

const isMain = process.argv[1]?.endsWith("seed/dev.ts") ?? false;
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }
  seedDev(url)
    .then((r) => {
      console.warn(`seeded ${r.email} (workspace ${r.workspaceId})`);
    })
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
