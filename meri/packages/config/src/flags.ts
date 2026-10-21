/** Feature flags (docs/02 "Feature flags"). The DB-backed store lives in @meri/db; this is the contract + memory impl. */
export const FEATURE_FLAGS = [
  "gmail_autoconfirm",
  "ai_briefings",
  "time_inference",
  "ai_capture",
  /** D-102: price anchor experiment (cohorts A/B). Global only. */
  "price_experiment",
] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

export interface FeatureFlagStore {
  isEnabled(flag: FeatureFlag, workspaceId?: string): Promise<boolean>;
}

export class InMemoryFlagStore implements FeatureFlagStore {
  private readonly global = new Map<FeatureFlag, boolean>();
  private readonly perWorkspace = new Map<string, Map<FeatureFlag, boolean>>();

  constructor(defaults: Partial<Record<FeatureFlag, boolean>> = {}) {
    for (const [k, v] of Object.entries(defaults)) this.global.set(k as FeatureFlag, v);
  }

  set(flag: FeatureFlag, enabled: boolean, workspaceId?: string): void {
    if (!workspaceId) {
      this.global.set(flag, enabled);
      return;
    }
    const m = this.perWorkspace.get(workspaceId) ?? new Map<FeatureFlag, boolean>();
    m.set(flag, enabled);
    this.perWorkspace.set(workspaceId, m);
  }

  isEnabled(flag: FeatureFlag, workspaceId?: string): Promise<boolean> {
    const local = workspaceId ? this.perWorkspace.get(workspaceId)?.get(flag) : undefined;
    return Promise.resolve(local ?? this.global.get(flag) ?? false);
  }
}
