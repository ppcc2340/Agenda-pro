import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { isAccountActive, type Db } from "@meri/db";

interface AccountGuardOptions {
  db: Db;
  /** How long a liveness answer is reused (wall clock). */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 60_000;
/** userId:workspaceId → liveness, by wall clock (DEMO_NOW freezes the injected clock, so it is not used here). */
const liveness = new Map<string, { active: boolean; checkedAt: number }>();

const keyOf = (userId: string, workspaceId: string) => `${userId}:${workspaceId}`;

/** Called by `DELETE /v1/account`: the deleted session stops working at once in this process. */
export function markAccountDeleted(userId: string, workspaceId: string): void {
  liveness.set(keyOf(userId, workspaceId), { active: false, checkedAt: Number.POSITIVE_INFINITY });
}

/** Test helper: forget cached answers. */
export function resetAccountGuard(): void {
  liveness.clear();
}

/**
 * D-054: Auth.js sessions are stateless JWTs (14 days), so a logically deleted account would keep answering
 * with its old cookie. This hook (after the session plugin) drops the session of a deleted user/workspace; the
 * answer is cached per user for `ttlMs` so it costs one cheap query per minute, not one per request.
 */
export const accountGuardPlugin = fp<AccountGuardOptions>((app: FastifyInstance, options, done) => {
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  app.addHook("onRequest", async (request) => {
    const session = request.session;
    if (!session) return;
    const key = keyOf(session.userId, session.workspaceId);
    const hit = liveness.get(key);
    const fresh = hit !== undefined && Date.now() - hit.checkedAt < ttl;
    const active = fresh ? hit.active : await isAccountActive(options.db, session.userId, session.workspaceId);
    if (!fresh) liveness.set(key, { active, checkedAt: Date.now() });
    if (!active) request.session = null;
  });
  done();
});
