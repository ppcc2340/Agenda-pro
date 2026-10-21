/**
 * ai.extract_commitments (docs/05 §3, ADR 0004 §3): bounded context per thread, AI-2 pipeline, commitments
 * (`proposed`) + deduplicated proposals in one transaction, optional auto-confirmation (D-034), AI budget cap,
 * usage accounting and a grouped notification. Bodies are read on demand and never stored.
 */
import { FakeAiClient, hasGmailScopes, type AiClient } from "@meri/integrations";
import { extractCommitments, registerFakeAiHandlers, type ExtractedCommitment } from "@meri/ai";
import {
  gmailThreadUrl,
  localDateKey,
  sanitizeMailBody,
  type ClientRef,
  type MailMessageInput,
} from "@meri/core";
import {
  audit,
  countNotificationsForDay,
  createCommitment,
  createProposalIfAbsent,
  getIntegrationAccount,
  getPreferences,
  getThread,
  insertNotification,
  listClients,
  listContacts,
  markThreadProcessed,
  resolveProposal,
  updateCommitment,
  withWorkspace,
  type WorkspaceId,
} from "@meri/db";
import { aiBudget, chargeAiUsage, notifyAiPaused } from "../budget";
import { googleAccess } from "../google-access";
import type { HandlerDeps } from "./context";

export interface ExtractResult {
  status: "done" | "skipped" | "budget_exhausted";
  proposals: number;
  autoconfirmed: number;
  rejected: number;
  usedRules: boolean;
}

export const AUTOCONFIRM_THRESHOLD = 0.9;

/** Rules-only client used when the AI budget is exhausted (docs/05 §5: rules keep working). */
function rulesClient(): AiClient {
  const ai = new FakeAiClient();
  registerFakeAiHandlers(ai);
  return ai;
}

export async function extractThreadCommitments(
  deps: HandlerDeps,
  workspaceId: WorkspaceId,
  input: { threadId: string; messageIds: string[]; costCapUsd: number },
): Promise<ExtractResult> {
  const now = deps.now();
  const skipped: ExtractResult = {
    status: "skipped",
    proposals: 0,
    autoconfirmed: 0,
    rejected: 0,
    usedRules: false,
  };
  const snap = await withWorkspace(deps.db, workspaceId, async (tx) => {
    const thread = await getThread(tx, workspaceId, input.threadId);
    if (!thread) return null;
    const account = await getIntegrationAccount(tx, workspaceId, thread.integrationAccountId);
    const prefs = await getPreferences(tx, workspaceId);
    if (!account || !prefs || !hasGmailScopes(account.scopes)) return null;
    const clients = await listClients(tx, workspaceId);
    const contacts = await listContacts(tx, workspaceId);
    const client = thread.clientId ? (clients.find((c) => c.id === thread.clientId) ?? null) : null;
    // One thread = one operation unit, whatever the number of model calls ([H3]).
    const budget = await aiBudget(tx, workspaceId, "extract_commitments", {
      now,
      aiMode: deps.integrations.ai.mode,
      costCapUsd: input.costCapUsd,
    });
    return { thread, account, prefs, client, contacts, budget };
  });
  if (!snap) return skipped;
  const access = await googleAccess(deps, workspaceId, snap.account.id);
  if (!access) return skipped;
  const me = (snap.account.email ?? access.email).toLowerCase();
  const mail = deps.integrations.mailFor(access);

  // Bodies are fetched on demand, sanitised in memory and never written anywhere (docs/06 §5).
  const messages: MailMessageInput[] = [];
  for (const id of input.messageIds) {
    const full = await mail.getMessageFull(id);
    messages.push({
      id: full.id,
      from: full.from,
      to: full.to,
      date: full.date,
      text: sanitizeMailBody(full.bodyText),
    });
  }
  const overBudget = !snap.budget.allow;
  const ai = overBudget ? rulesClient() : deps.integrations.ai;
  const clientRef: ClientRef | null = snap.client
    ? {
        id: snap.client.id,
        name: snap.client.name,
        domains: snap.client.domains,
        contactEmails: snap.contacts.filter((c) => c.clientId === snap.client?.id).map((c) => c.email),
      }
    : null;
  const outcome = await extractCommitments(
    ai,
    {
      me,
      now: now.toISOString(),
      timezone: snap.prefs.timezone,
      threadRef: snap.thread.id,
      subject: snap.thread.subject,
      messages,
      client: clientRef,
    },
    { escalateToSmart: true },
  );

  const counterpartyName = (email: string | null) =>
    snap.contacts.find((c) => c.email === email)?.name ?? null;
  const day = localDateKey(now.getTime(), snap.prefs.timezone);
  const result = await withWorkspace(deps.db, workspaceId, async (tx) => {
    let proposals = 0;
    let autoconfirmed = 0;
    for (const c of outcome.commitments) {
      const created = await persistCommitment(tx, workspaceId, snap.thread.id, snap.thread.clientId, c, now);
      if (!created) continue; // duplicate (same hash already known)
      const proposal = await createProposalIfAbsent(
        tx,
        workspaceId,
        {
          kind: "commitment",
          confidence: c.confidence,
          explanation: c.kind,
          sourceRef: {
            type: "thread",
            id: snap.thread.id,
            url: gmailThreadUrl(snap.thread.externalThreadId),
          },
          dedupeHash: c.dedupeHash,
          payload: {
            commitmentId: created.id,
            direction: c.direction,
            action: c.action,
            dueAt: c.dueAt,
            dueText: c.dueText,
            kind: c.kind,
            confidence: c.confidence,
            evidence: c.evidence,
            counterpartyEmail: c.counterpartyEmail,
            counterpartyName: counterpartyName(c.counterpartyEmail),
            clientId: snap.thread.clientId,
            threadId: snap.thread.id,
            externalThreadId: snap.thread.externalThreadId,
            subject: snap.thread.subject,
            externalMessageId: c.externalMessageId,
          },
        },
        now,
      );
      if (!proposal) continue;
      proposals++;
      // D-034: only explicit, high-confidence commitments, and only if the user opted in. Audited and undoable.
      if (snap.prefs.gmailAutoconfirm && c.kind === "explicit" && c.confidence >= AUTOCONFIRM_THRESHOLD) {
        await updateCommitment(tx, workspaceId, created.id, { status: "confirmed" }, now);
        await resolveProposal(
          tx,
          workspaceId,
          proposal.id,
          { status: "confirmed", action: "autoconfirmed" },
          now,
        );
        await audit(
          tx,
          { workspaceId, actor: "ai" },
          {
            action: "commitment.autoconfirmed",
            entityType: "commitment",
            entityId: created.id,
            reason: `explicit, confidence ${String(c.confidence)}`,
            before: { status: "proposed", proposalId: proposal.id },
            after: { status: "confirmed", proposalId: proposal.id, action: c.action },
          },
        );
        autoconfirmed++;
      }
    }
    if (!overBudget) await chargeAiUsage(tx, workspaceId, "extract_commitments", outcome.usage, { now });
    const pendingNew = proposals - autoconfirmed;
    if (
      pendingNew > 0 &&
      (await countNotificationsForDay(tx, workspaceId, day)) < snap.prefs.maxAlertsPerDay
    ) {
      await insertNotification(
        tx,
        workspaceId,
        {
          kind: "proposals",
          template: "proposals.new",
          params: { count: pendingNew },
          title: "Nuevas propuestas",
          body: `${String(pendingNew)} propuestas nuevas en Entrada.`,
          refs: [{ type: "thread", id: snap.thread.id }],
          day,
        },
        now,
      );
    }
    if (snap.budget.reason)
      await notifyAiPaused(
        tx,
        workspaceId,
        snap.budget.reason,
        now,
        snap.budget.reason === "cost_cap" ? { capUsd: input.costCapUsd } : {},
      );
    await markThreadProcessed(tx, workspaceId, snap.thread.id, now);
    return { proposals, autoconfirmed };
  });
  return {
    status: overBudget ? "budget_exhausted" : "done",
    proposals: result.proposals,
    autoconfirmed: result.autoconfirmed,
    rejected: outcome.rejected.length,
    usedRules: overBudget,
  };
}

async function persistCommitment(
  tx: Parameters<typeof createCommitment>[0],
  workspaceId: WorkspaceId,
  threadId: string,
  clientId: string | null,
  c: ExtractedCommitment,
  now: Date,
) {
  return createCommitment(
    tx,
    workspaceId,
    {
      clientId,
      direction: c.direction,
      kind: c.kind,
      status: "proposed",
      counterpartyEmail: c.counterpartyEmail,
      action: c.action,
      dueAt: c.dueAt ? new Date(c.dueAt) : null,
      dueText: c.dueText,
      confidence: c.confidence,
      evidence: c.evidence,
      threadId,
      externalMessageId: c.externalMessageId,
      dedupeHash: c.dedupeHash,
      origin: "ai_confirmed",
    },
    now,
  );
}
