/**
 * Follow-up rules (F-08, D-035). Pure: decides which overdue commitments and unanswered threads deserve a single
 * follow-up proposal, honouring mutes per contact and per client. The job persists; this module never does I/O.
 */
export interface OverdueCommitmentInput {
  id: string;
  dueAt: string; // ISO
  counterpartyEmail: string | null;
  clientId: string | null;
  action: string;
}

export interface UnansweredThreadInput {
  id: string;
  lastMessageAt: string; // ISO, a message from me
  participants: string[];
  clientId: string | null;
  subject: string | null;
}

export interface FollowupInput {
  now: string; // ISO
  me: string;
  /** Days without a reply before a sent thread counts as unanswered (preferences.followup_days). */
  followupDays: number;
  overdue: OverdueCommitmentInput[];
  unanswered: UnansweredThreadInput[];
  mutedEmails: ReadonlySet<string>;
  mutedClientIds: ReadonlySet<string>;
}

export interface FollowupCandidate {
  kind: "overdue_commitment" | "unanswered_thread";
  refId: string;
  daysLate: number;
  counterpartyEmail: string | null;
  clientId: string | null;
  /** What the proposal suggests first; the user still chooses (draft, reminder or "waiting for" task). */
  suggestedAction: "draft" | "waiting_task";
  action: string;
  subject: string | null;
}

const DAY = 86_400_000;
const emailOf = (s: string) => (/[^\s<>@]+@[^\s<>@]+/.exec(s)?.[0] ?? s).toLowerCase();

export function detectFollowups(input: FollowupInput): FollowupCandidate[] {
  const nowMs = Date.parse(input.now);
  const me = emailOf(input.me);
  const muted = (email: string | null, clientId: string | null) =>
    (email !== null && input.mutedEmails.has(emailOf(email))) ||
    (clientId !== null && input.mutedClientIds.has(clientId));
  const out: FollowupCandidate[] = [];
  for (const c of input.overdue) {
    const due = Date.parse(c.dueAt);
    if (Number.isNaN(due) || due >= nowMs) continue;
    if (muted(c.counterpartyEmail, c.clientId)) continue;
    out.push({
      kind: "overdue_commitment",
      refId: c.id,
      daysLate: Math.max(1, Math.ceil((nowMs - due) / DAY)),
      counterpartyEmail: c.counterpartyEmail ? emailOf(c.counterpartyEmail) : null,
      clientId: c.clientId,
      suggestedAction: "draft",
      action: c.action,
      subject: null,
    });
  }
  const threshold = nowMs - Math.max(1, input.followupDays) * DAY;
  for (const t of input.unanswered) {
    const last = Date.parse(t.lastMessageAt);
    if (Number.isNaN(last) || last > threshold) continue;
    const counterparty = t.participants.map(emailOf).find((p) => p !== me) ?? null;
    if (muted(counterparty, t.clientId)) continue;
    out.push({
      kind: "unanswered_thread",
      refId: t.id,
      daysLate: Math.floor((nowMs - last) / DAY),
      counterpartyEmail: counterparty,
      clientId: t.clientId,
      suggestedAction: "waiting_task",
      action: t.subject ?? "",
      subject: t.subject,
    });
  }
  return out;
}
