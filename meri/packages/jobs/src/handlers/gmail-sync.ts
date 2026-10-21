/**
 * gmail.sync (docs/07, ADR 0004): incremental history with a cursor in sync_state, initial 30-day load, prefilter
 * by rules, thread index without bodies. Returns the threads that changed so the worker can enqueue extraction.
 */
import {
  emailAddress,
  looksLikeInjection,
  prefilterMessage,
  resolveClient,
  type Exclusion,
} from "@meri/core";
import {
  getIntegrationAccount,
  getSyncCursor,
  listClientRefs,
  listMailExclusions,
  setIntegrationStatus,
  setSyncCursor,
  upsertContact,
  upsertThread,
  withWorkspace,
  type WorkspaceId,
} from "@meri/db";
import {
  hasGmailScopes,
  IntegrationError,
  MessageGoneError,
  type MailMessageMeta,
  type MailProvider,
} from "@meri/integrations";
import { googleAccess, markNeedsReauth } from "../google-access";
import type { HandlerDeps } from "./context";
import { track } from "../analytics";

export const MAIL_RESOURCE = "gmail.history";
export const INITIAL_LOAD_DAYS = 30;
export const MAX_MESSAGES_PER_RUN = 500;

/** Display names are attacker-controlled metadata: bounded, and never stored when they read like an instruction. */
const safeName = (name: string | null): string | null =>
  name && !looksLikeInjection(name) ? name.slice(0, 120) : null;

export interface MailSyncResult {
  status: "synced" | "needs_reauth" | "paused" | "skipped";
  seen: number;
  discarded: number;
  /** Threads with new content, with the message ids that triggered the change (extraction input). */
  changed: { threadId: string; messageIds: string[] }[];
  fullResync: boolean;
}

const skipped = (status: MailSyncResult["status"]): MailSyncResult => ({
  status,
  seen: 0,
  discarded: 0,
  changed: [],
  fullResync: false,
});

const displayName = (raw: string): string | null => {
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(raw);
  return m?.[1]?.trim() ?? null;
};

async function collectMessageIds(
  mail: MailProvider,
  cursor: string | null,
  now: Date,
): Promise<{ ids: string[]; nextCursor: string; fullResync: boolean }> {
  if (cursor === null) {
    const after = new Date(now.getTime() - INITIAL_LOAD_DAYS * 86_400_000).toISOString();
    const [{ messageIds }, profile] = await Promise.all([
      mail.listMessages({ after, maxResults: MAX_MESSAGES_PER_RUN }),
      mail.profile(),
    ]);
    return { ids: messageIds, nextCursor: profile.historyId, fullResync: false };
  }
  const ids: string[] = [];
  let next = cursor;
  for (let page = 0; page < 10; page++) {
    const res = await mail.listHistory({ cursor: next, maxResults: 100 });
    if (res.fullResyncRequired) {
      const initial = await collectMessageIds(mail, null, now);
      return { ...initial, fullResync: true };
    }
    ids.push(...res.messageIds);
    if (!res.nextCursor || res.nextCursor === next || res.messageIds.length === 0) {
      next = res.nextCursor ?? next;
      break;
    }
    next = res.nextCursor;
    // Cap per run without losing anything: the cursor stays at the last page that was fully collected, so the
    // next run continues from there.
    if (ids.length >= MAX_MESSAGES_PER_RUN) break;
  }
  return { ids: [...new Set(ids)], nextCursor: next, fullResync: false };
}

export async function syncMailAccount(
  deps: HandlerDeps,
  workspaceId: WorkspaceId,
  accountId: string,
): Promise<MailSyncResult> {
  const now = deps.now();
  const account = await withWorkspace(deps.db, workspaceId, (tx) =>
    getIntegrationAccount(tx, workspaceId, accountId),
  );
  if (!account) return skipped("skipped");
  if (account.status === "paused" || account.status === "revoked") return skipped("paused");
  if (!hasGmailScopes(account.scopes)) return skipped("skipped");
  let access;
  try {
    access = await googleAccess(deps, workspaceId, accountId);
  } catch (err) {
    if (err instanceof IntegrationError && err.kind === "AuthExpired") {
      await withWorkspace(deps.db, workspaceId, (tx) => markNeedsReauth(tx, workspaceId, accountId, err, deps.now()));
      return skipped("needs_reauth");
    }
    throw err;
  }
  if (!access) return skipped("skipped");
  const me = emailAddress(account.email ?? access.email);
  const mail = deps.integrations.mailFor(access);

  try {
    const cursor = await withWorkspace(deps.db, workspaceId, (tx) =>
      getSyncCursor(tx, workspaceId, accountId, MAIL_RESOURCE),
    );
    const { ids, nextCursor, fullResync } = await collectMessageIds(mail, cursor, now);
    const { exclusions, clients } = await withWorkspace(deps.db, workspaceId, async (tx) => ({
      exclusions: (await listMailExclusions(tx, workspaceId)).map((e): Exclusion => ({
        kind: e.kind,
        value: e.value,
      })),
      clients: await listClientRefs(tx, workspaceId),
    }));

    const metas: MailMessageMeta[] = [];
    let discarded = 0;
    for (const id of ids) {
      let meta: MailMessageMeta;
      try {
        meta = await mail.getMessageMeta(id);
      } catch (err) {
        // Deleted since it was listed: skip it, the rest of the page and the cursor still move on (CR-9).
        if (err instanceof MessageGoneError) continue;
        throw err;
      }
      const verdict = prefilterMessage(
        { from: meta.from, to: meta.to, subject: meta.subject, headers: meta.headers, labels: meta.labels },
        exclusions,
      );
      if (!verdict.keep) {
        discarded++;
        continue;
      }
      metas.push(meta);
    }
    // Oldest first so `lastMessageAt` ends on the newest message of each thread.
    metas.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

    const changedByThread = new Map<string, string[]>();
    await withWorkspace(deps.db, workspaceId, async (tx) => {
      for (const meta of metas) {
        const participants = [...new Set([meta.from, ...meta.to].map(emailAddress))];
        const client = resolveClient(participants, me, clients);
        for (const raw of [meta.from, ...meta.to]) {
          const address = emailAddress(raw);
          if (address !== me)
            await upsertContact(tx, workspaceId, {
              email: address,
              name: safeName(displayName(raw)),
              clientId: client?.id ?? null,
            });
        }
        const { thread, changed } = await upsertThread(tx, workspaceId, {
          integrationAccountId: accountId,
          externalThreadId: meta.threadId,
          subject: meta.subject ? meta.subject.slice(0, 255) : null,
          participants: participants.slice(0, 50),
          clientId: client?.id ?? null,
          lastMessageAt: new Date(meta.date),
          lastMessageFromMe: emailAddress(meta.from) === me,
          lastExternalMessageId: meta.id,
        });
        if (changed) changedByThread.set(thread.id, [...(changedByThread.get(thread.id) ?? []), meta.id]);
      }
      await setSyncCursor(tx, workspaceId, accountId, MAIL_RESOURCE, nextCursor, now);
      await setIntegrationStatus(tx, workspaceId, accountId, {
        status: "healthy",
        lastError: null,
        lastSyncAt: now,
      });
    });
    return {
      status: "synced",
      seen: ids.length,
      discarded,
      changed: [...changedByThread.entries()].map(([threadId, messageIds]) => ({ threadId, messageIds })),
      fullResync,
    };
  } catch (err) {
    if (err instanceof IntegrationError)
      track(deps.integrations.analytics, "integration_error", workspaceId, {
        provider: "google",
        kind: err.kind,
      });
    if (err instanceof IntegrationError && err.kind === "AuthExpired") {
      await withWorkspace(deps.db, workspaceId, (tx) => markNeedsReauth(tx, workspaceId, accountId, err, deps.now()));
      return skipped("needs_reauth");
    }
    if (err instanceof IntegrationError && err.retryable) {
      await withWorkspace(deps.db, workspaceId, (tx) =>
        setIntegrationStatus(tx, workspaceId, accountId, { status: "degraded", lastError: err.kind }),
      );
    }
    throw err;
  }
}
