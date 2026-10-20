import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { isAccountActive, type Db } from "@meri/db";

interface AccountGuardOptions {
  db: Db;
  /** How long a liveness answer is reused (wall clock: DEMO_NOW freezes the injected clock). */
  ttlMs?: number;
  /** Bound on cached sessions; the oldest answer is evicted first. */
  maxEntries?: number;
}

export interface AccountGuard {
  /** Called by `DELETE /v1/account`: the deleted session stops working at once in this process. */
  markDeleted(userId: string, workspaceId: string): void;
  /** Forgets every cached answer (tests; equivalent to every TTL expiring). */
  reset(): void;
}

declare module "fastify" {
  interface FastifyInstance {
    accountGuard: AccountGuard;
  }
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 10_000;
/** Sentinel `checkedAt` of a deletion recorded in this process: never expires, never overwritten. */
const DELETED = Number.POSITIVE_INFINITY;

const keyOf = (userId: string, workspaceId: string) => `${userId}:${workspaceId}`;

/**
 * D-054: Auth.js sessions are stateless JWTs (14 days), so a logically deleted account would keep answering
 * with its old cookie. This hook (after the session plugin) drops the session of a deleted user/workspace; the
 * answer is cached per user for `ttlMs`, so it costs one cheap query per minute, not one per request. A deletion
 * made by another API instance is learnt from the database within `ttlMs`.
 */
export const accountGuardPlugin = fp<AccountGuardOptions>((app: FastifyInstance, options, done) => {
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const liveness = new Map<string, { active: boolean; checkedAt: number }>();
  const remember = (key: string, value: { active: boolean; checkedAt: number }) => {
    liveness.delete(key); // re-insert so Map order is "least recently checked first"
    liveness.set(key, value);
    while (liveness.size > maxEntries) {
      const oldest = liveness.keys().next().value;
      if (oldest === undefined) break;
      liveness.delete(oldest);
    }
  };
  app.decorate("accountGuard", {
    markDeleted: (userId: string, workspaceId: string) => {
      remember(keyOf(userId, workspaceId), { active: false, checkedAt: DELETED });
    },
    reset: () => {
      liveness.clear();
    },
  } satisfies AccountGuard);
  app.addHook("onRequest", async (request) => {
    const session = request.session;
    if (!session) return;
    const key = keyOf(session.userId, session.workspaceId);
    const hit = liveness.get(key);
    const fresh = hit !== undefined && Date.now() - hit.checkedAt < ttl;
    const active = fresh ? hit.active : await isAccountActive(options.db, session.userId, session.workspaceId);
    // A deletion recorded while this lookup was in flight wins: never overwrite the "deleted" sentinel.
    const deletedMeanwhile = liveness.get(key)?.checkedAt === DELETED;
    if (!fresh && !deletedMeanwhile) remember(key, { active, checkedAt: Date.now() });
    if (!active || deletedMeanwhile) request.session = null;
  });
  done();
});
