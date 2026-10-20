import type { FastifyRequest } from "fastify";
import { planWithFeature, type PlanFeature } from "@meri/core";
import { getEntitlements, type WorkspaceId, type WorkspaceTx } from "@meri/db";
import { ApiError } from "../errors";
import { sessionOf } from "./session";

/** 402 ENTITLEMENT_REQUIRED naming the plan that includes the feature (docs/13, D-058). */
export async function assertEntitlement(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  feature: PlanFeature,
): Promise<void> {
  const ent = await getEntitlements(tx, workspaceId);
  if (ent.features.includes(feature)) return;
  throw new ApiError(
    "ENTITLEMENT_REQUIRED",
    `This feature is included in the ${planWithFeature(feature)} plan.`,
    [{ path: "plan", message: planWithFeature(feature) }],
  );
}

/** Route preHandler: the session's workspace must have `feature` in its entitlements. */
export function requireEntitlement(feature: PlanFeature) {
  return async (request: FastifyRequest): Promise<void> => {
    const session = sessionOf(request);
    await request.withWorkspace((tx) => assertEntitlement(tx, session.workspaceId, feature));
  };
}
