import { FEATURE_FLAGS, type FeatureFlag, type FeatureFlagStore } from "@meri/config";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Db } from "./client";
import { newId } from "./ids";
import { featureFlags } from "./schema";

/**
 * Feature flags stored in `feature_flags` (docs/02): a workspace row overrides the global row (`workspace_id`
 * null). The application role can only read; flags are changed by a person with `pnpm flags:set` (owner role).
 * Reads are cached briefly so a flag check is not a query per request.
 */
export class DbFlagStore implements FeatureFlagStore {
  private readonly cache = new Map<string, { value: boolean; at: number }>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 30_000,
    private readonly clock: () => number = Date.now,
  ) {}

  async isEnabled(flag: FeatureFlag, workspaceId?: string): Promise<boolean> {
    const key = `${flag}:${workspaceId ?? "*"}`;
    const hit = this.cache.get(key);
    if (hit && this.clock() - hit.at < this.ttlMs) return hit.value;
    const rows = await this.db
      .select({ workspaceId: featureFlags.workspaceId, enabled: featureFlags.enabled })
      .from(featureFlags)
      .where(
        and(
          eq(featureFlags.key, flag),
          workspaceId
            ? or(isNull(featureFlags.workspaceId), eq(featureFlags.workspaceId, workspaceId))
            : isNull(featureFlags.workspaceId),
        ),
      );
    const own = rows.find((r) => r.workspaceId !== null);
    const global = rows.find((r) => r.workspaceId === null);
    const value = (own ?? global)?.enabled ?? false;
    this.cache.set(key, { value, at: this.clock() });
    return value;
  }
}

/** Owner connection only (`pnpm flags:set`): turns a flag on or off, globally or for one workspace. */
export async function setFlag(
  ownerDb: Db,
  input: { flag: string; enabled: boolean; workspaceId?: string | null },
): Promise<void> {
  if (!(FEATURE_FLAGS as readonly string[]).includes(input.flag))
    throw new Error(`unknown flag: ${input.flag}`);
  const ws = input.workspaceId ?? null;
  // The unique index treats nulls as distinct: update first, insert when nothing matched.
  const updated = await ownerDb
    .update(featureFlags)
    .set({ enabled: input.enabled })
    .where(
      and(
        eq(featureFlags.key, input.flag),
        ws ? eq(featureFlags.workspaceId, ws) : isNull(featureFlags.workspaceId),
      ),
    )
    .returning({ id: featureFlags.id });
  if (updated.length === 0)
    await ownerDb
      .insert(featureFlags)
      .values({ id: newId(), key: input.flag, workspaceId: ws, enabled: input.enabled });
}

/** For the decision panel: the global state of every flag. */
export async function listGlobalFlags(db: Db): Promise<Record<string, boolean>> {
  const rows = await db
    .select({ key: featureFlags.key, enabled: featureFlags.enabled })
    .from(featureFlags)
    .where(sql`${featureFlags.workspaceId} is null`);
  return Object.fromEntries(rows.map((r) => [r.key, r.enabled]));
}
