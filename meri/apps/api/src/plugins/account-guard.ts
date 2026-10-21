import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { accountLiveness, type Db } from "@meri/db";

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
  /** Called by `POST /v1/account/sessions/revoke`: older sessions stop working at once in this process. */
  markSessionsRevoked(userId: string, workspaceId: string, at: Date): void;
  /** Forgets every cached answer (tests; equivalent to every TTL expiring). */
  reset(): void;
}

declare module "fastify" {
  interface FastifyInstance {
    accountGuard: AccountGuard;
  }
}

const DEFAULT_TTL_MS = 60_000;
/** Absolute session lifetime counted from sign-in (the JWT is re-issued on every read, so `exp` slides). */
export const SESSION_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;
/** Sentinel `checkedAt` of a deletion recorded in this process: never expires, never overwritten. */
const DELETED = Number.POSITIVE_INFINITY;

const keyOf = (userId: string, workspaceId: string) => `${userId}:${workspaceId}`;

/**
 * D-054: Auth.js sessions are stateless JWTs (14 days), so a logically deleted account would keep answering
 * with its old cookie. This hook (after the session plugin) drops the session of a deleted user/workspace, of a
 * session older than «sign out on all devices», and of one past its absolute lifetime (ADR 0007); the
 * answer is cached per user for `ttlMs`, so it costs one cheap query per minute, not one per request. A deletion
 * made by another API instance is learnt from the database within `ttlMs`.
 */
export const accountGuardPlugin = fp<AccountGuardOptions>((app: FastifyInstance, options, done) => {
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  type Answer = { active: boolean; validAfter: number; checkedAt: number };
  const liveness = new Map<string, Answer>();
  const remember = (key: string, value: Answer) => {
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
      remember(keyOf(userId, workspaceId), { active: false, validAfter: 0, checkedAt: DELETED });
    },
    markSessionsRevoked: (userId: string, workspaceId: string, at: Date) => {
      const key = keyOf(userId, workspaceId);
      const hit = liveness.get(key);
      if (hit?.checkedAt === DELETED) return;
      remember(key, { active: hit?.active ?? true, validAfter: at.getTime(), checkedAt: Date.now() });
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
    let answer: Answer;
    if (fresh) answer = hit;
    else {
      const live = await accountLiveness(options.db, session.userId, session.workspaceId);
      answer = {
        active: live.active,
        validAfter: live.sessionsValidAfter?.getTime() ?? 0,
        checkedAt: Date.now(),
      };
    }
    // A deletion or revocation recorded while this lookup was in flight wins over the database answer.
    const current = liveness.get(key);
    const deletedMeanwhile = current?.checkedAt === DELETED;
    if (!fresh && !deletedMeanwhile) {
      if (current && current.validAfter > answer.validAfter)
        answer = { ...answer, validAfter: current.validAfter };
      remember(key, answer);
    }
    const revoked = session.authTime < answer.validAfter;
    const expired = Date.now() - session.authTime > SESSION_MAX_AGE_MS;
    if (!answer.active || deletedMeanwhile || revoked || expired) request.session = null;
  });
  done();
});
