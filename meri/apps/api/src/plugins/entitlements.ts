import { planWithFeature, type PlanFeature } from "@meri/core";
import {
  getAccess,
  getEntitlementMaxClients,
  getEntitlements,
  type WorkspaceId,
  type WorkspaceTx,
} from "@meri/db";
import { ApiError } from "../errors";

/**
 * 402 ENTITLEMENT_REQUIRED naming the plan that includes the feature (docs/13, D-058). Entitlements are never
 * downgraded on cancellation ([H2]), so the feature also needs active access: a cancelled Pro+ keeps its data,
 * not its paid features (security review M4).
 */
export async function assertEntitlement(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  feature: PlanFeature,
  now: Date,
): Promise<void> {
  const ent = await getEntitlements(tx, workspaceId);
  const plan = planWithFeature(feature);
  if (ent.features.includes(feature) && (await getAccess(tx, workspaceId, now)).active) return;
  throw new ApiError("ENTITLEMENT_REQUIRED", `This feature is included in the ${plan} plan.`, [
    { path: "plan", message: plan },
  ]);
}

/** D-058: new clients pause while access is inactive (existing ones stay, nothing is archived). */
export async function clientCapacity(tx: WorkspaceTx, workspaceId: WorkspaceId, now: Date): Promise<number> {
  if (!(await getAccess(tx, workspaceId, now)).active)
    throw new ApiError("ENTITLEMENT_REQUIRED", "An active plan is required to add clients.", [
      { path: "plan", message: "pro" },
    ]);
  return getEntitlementMaxClients(tx, workspaceId);
}
