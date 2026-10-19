/**
 * followups.scan (F-08, D-035): overdue third-party commitments and sent threads without a reply become ONE
 * `followup` proposal each (dedupe hash), overdue commitments move to `at_risk`, and the user gets a grouped
 * notification under the daily cap. Mutes per contact/client are applied by the pure rules in core.
 */
import { detectFollowups, gmailThreadUrl, localDateKey, type FollowupCandidate } from "@meri/core";
import {
  audit,
  countNotificationsForDay,
  createProposalIfAbsent,
  getThreadsByIds,
  insertNotification,
  listClients,
  listContacts,
  listIntegrationAccounts,
  listOverdueOwedToMe,
  listUnansweredThreads,
  mutedClientIds,
  proposalHashExists,
  getPreferences,
  updateCommitment,
  withWorkspace,
  type WorkspaceId,
} from "@meri/db";
import type { HandlerDeps } from "./context";

export interface FollowupsScanResult {
  status: "done" | "skipped";
  candidates: number;
  proposals: number;
  notified: boolean;
}

export const followupDedupeHash = (c: Pick<FollowupCandidate, "kind" | "refId">) =>
  `followup:${c.kind}:${c.refId}`;

export async function scanFollowups(
  deps: HandlerDeps,
  workspaceId: WorkspaceId,
): Promise<FollowupsScanResult> {
  const now = deps.now();
  return withWorkspace(deps.db, workspaceId, async (tx) => {
    const prefs = await getPreferences(tx, workspaceId);
    if (!prefs) return { status: "skipped", candidates: 0, proposals: 0, notified: false };
    const accounts = await listIntegrationAccounts(tx, workspaceId);
    const me = accounts.find((a) => a.provider === "google" && a.email)?.email ?? "";
    const contacts = await listContacts(tx, workspaceId);
    const clients = await listClients(tx, workspaceId);
    const overdue = await listOverdueOwedToMe(tx, workspaceId, now);
    const unanswered = await listUnansweredThreads(
      tx,
      workspaceId,
      new Date(now.getTime() - Math.max(1, prefs.followupDays) * 86_400_000),
    );
    const candidates = detectFollowups({
      now: now.toISOString(),
      me,
      followupDays: prefs.followupDays,
      overdue: overdue
        .filter((c) => c.dueAt !== null)
        .map((c) => ({
          id: c.id,
          dueAt: (c.dueAt ?? now).toISOString(),
          counterpartyEmail: c.counterpartyEmail,
          clientId: c.clientId,
          action: c.action,
        })),
      unanswered: unanswered.map((t) => ({
        id: t.id,
        lastMessageAt: (t.lastMessageAt ?? now).toISOString(),
        participants: t.participants,
        clientId: t.clientId,
        subject: t.subject,
      })),
      mutedEmails: new Set(contacts.filter((c) => c.muted).map((c) => c.email.toLowerCase())),
      mutedClientIds: await mutedClientIds(tx, workspaceId),
    });
    const threads = await getThreadsByIds(
      tx,
      workspaceId,
      overdue.map((c) => c.threadId).filter((x): x is string => x !== null),
    );
    const nameOf = (email: string | null) => contacts.find((c) => c.email === email)?.name ?? null;
    let proposals = 0;
    for (const c of candidates) {
      const commitment = c.kind === "overdue_commitment" ? overdue.find((o) => o.id === c.refId) : undefined;
      const thread =
        c.kind === "unanswered_thread"
          ? unanswered.find((t) => t.id === c.refId)
          : commitment?.threadId
            ? threads.get(commitment.threadId)
            : undefined;
      // One alert per item, ever: a dismissed or handled follow-up is feedback, not something to re-propose.
      if (await proposalHashExists(tx, workspaceId, followupDedupeHash(c))) continue;
      const created = await createProposalIfAbsent(
        tx,
        workspaceId,
        {
          kind: "followup",
          confidence: null,
          explanation: c.kind,
          dedupeHash: followupDedupeHash(c),
          sourceRef: thread
            ? {
                type: "thread",
                id: thread.id,
                url: gmailThreadUrl(thread.externalThreadId),
              }
            : commitment
              ? { type: "commitment", id: commitment.id }
              : null,
          payload: {
            kind: c.kind,
            commitmentId: commitment?.id ?? null,
            threadId: thread?.id ?? null,
            externalThreadId: thread?.externalThreadId ?? null,
            subject: thread?.subject ?? null,
            action: c.action,
            dueAt: commitment?.dueAt ? commitment.dueAt.toISOString() : null,
            dueText: commitment?.dueText ?? null,
            daysLate: c.daysLate,
            counterpartyEmail: c.counterpartyEmail,
            counterpartyName: nameOf(c.counterpartyEmail),
            clientId: c.clientId,
            clientName: clients.find((x) => x.id === c.clientId)?.name ?? null,
            suggestedAction: c.suggestedAction,
          },
        },
        now,
      );
      if (!created) continue;
      proposals++;
      if (commitment && commitment.status === "confirmed") {
        await updateCommitment(tx, workspaceId, commitment.id, { status: "at_risk" }, now);
        await audit(
          tx,
          { workspaceId, actor: "system" },
          {
            action: "commitment.at_risk",
            entityType: "commitment",
            entityId: commitment.id,
            reason: `overdue ${String(c.daysLate)} days`,
            before: { status: "confirmed" },
            after: { status: "at_risk", proposalId: created.id },
          },
        );
      }
    }
    let notified = false;
    const day = localDateKey(now.getTime(), prefs.timezone);
    if (proposals > 0 && (await countNotificationsForDay(tx, workspaceId, day)) < prefs.maxAlertsPerDay) {
      await insertNotification(
        tx,
        workspaceId,
        {
          kind: "proposals",
          template: "followups.due",
          params: { count: proposals },
          title: "Seguimientos pendientes",
          body: `${String(proposals)} seguimientos sugeridos en Entrada.`,
          refs: [],
          day,
        },
        now,
      );
      notified = true;
    }
    return { status: "done", candidates: candidates.length, proposals, notified };
  });
}
