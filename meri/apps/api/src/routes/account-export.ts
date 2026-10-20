import {
  getPreferences,
  listAudit,
  listBlocks,
  listCalendarEvents,
  listClientsFull,
  listCommitments,
  listContacts,
  listIntegrationAccounts,
  listNotifications,
  listProjects,
  listProposals,
  listTasks,
  listTimeEntries,
  type WorkspaceId,
  type WorkspaceTx,
} from "@meri/db";
import { AccountExportV1 } from "./account-export.schema";

export { AccountExportV1 };

const iso = (d: Date | null) => (d ? d.toISOString() : null);
/** At most this many rows per collection; larger accounts get the phase 5 zip job. */
export const EXPORT_MAX_ROWS = 5000;
const PAGE = 100;

/**
 * Reads pages until the collection ends or exceeds `max`; a collection cut at `max` is named in `truncated`
 * (never silently cut). Reading one row past the cap tells "exactly max" apart from "more than max".
 */
export async function drainCapped<T>(
  name: string,
  truncated: string[],
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
  max = EXPORT_MAX_ROWS,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    all.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && all.length <= max);
  if (all.length > max) truncated.push(name);
  return all.slice(0, max);
}

/** Same cap for collections that are read in one query. */
export function capList<T>(name: string, truncated: string[], rows: T[], max = EXPORT_MAX_ROWS): T[] {
  if (rows.length > max) truncated.push(name);
  return rows.slice(0, max);
}

/** Every event the workspace mirrors (no date window: the export is complete or says what it cut). */
const ALL_TIME = { from: new Date("1970-01-01T00:00:00Z"), to: new Date("2100-01-01T00:00:00Z") };

/** Allow-list serialisers (never `select *`, docs/06), validated again by `AccountExportV1` on the way out. */
export async function buildAccountExport(
  tx: WorkspaceTx,
  input: {
    workspaceId: WorkspaceId;
    now: Date;
    me: { email: string; name: string | null; locale: string };
    workspace: { name: string; vertical: string | null };
  },
): Promise<AccountExportV1> {
  const ws = input.workspaceId;
  const prefs = await getPreferences(tx, ws);
  const truncated: string[] = [];
  const [clients, projects, contacts, tasks, commitments, proposals, timeEntries, events, blocks, notifications, activity, accounts] =
    await Promise.all([
      listClientsFull(tx, ws, { includeArchived: true }),
      listProjects(tx, ws),
      listContacts(tx, ws),
      drainCapped("tasks", truncated, (cursor) => listTasks(tx, ws, { includeCompleted: true }, { limit: PAGE, cursor })),
      drainCapped("commitments", truncated, (cursor) => listCommitments(tx, ws, { includeProposed: true }, { limit: PAGE, cursor })),
      drainCapped("proposals", truncated, (cursor) => listProposals(tx, ws, {}, { limit: PAGE, cursor })),
      listTimeEntries(tx, ws, { from: "1970-01-01", to: "2100-01-01", includeRejected: true }),
      listCalendarEvents(tx, ws, ALL_TIME),
      listBlocks(tx, ws),
      drainCapped("notifications", truncated, (cursor) => listNotifications(tx, ws, { limit: PAGE, cursor })),
      drainCapped("activity", truncated, (cursor) => listAudit(tx, ws, PAGE, cursor)),
      listIntegrationAccounts(tx, ws),
    ]);
  return {
    format: "meri-export/1",
    exportedAt: input.now.toISOString(),
    truncated,
    user: { email: input.me.email, name: input.me.name, locale: input.me.locale },
    workspace: { name: input.workspace.name, vertical: input.workspace.vertical },
    preferences: prefs ? { ...prefs, onboardedAt: iso(prefs.onboardedAt) } : null,
    clients: clients.map((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      domains: c.domains,
      notes: c.notes,
      verticalTags: c.verticalTags,
      followupsMuted: c.followupsMuted,
      archivedAt: iso(c.archivedAt),
      createdAt: c.createdAt.toISOString(),
    })),
    projects: projects.map((p) => ({ id: p.id, clientId: p.clientId, name: p.name, kind: p.kind, dueAt: iso(p.dueAt), status: p.status, createdAt: p.createdAt.toISOString() })),
    contacts: contacts.map((c) => ({ id: c.id, clientId: c.clientId, email: c.email, name: c.name, muted: c.muted, createdAt: c.createdAt.toISOString() })),
    tasks: tasks.map((t) => ({
      id: t.id,
      clientId: t.clientId,
      projectId: t.projectId,
      parentId: t.parentId,
      title: t.title,
      notes: t.notes,
      status: t.status,
      kind: t.kind,
      priority: t.priority,
      dueAt: iso(t.dueAt),
      deadlineType: t.deadlineType,
      estimateMinutes: t.estimateMinutes,
      tags: t.tags,
      origin: t.origin,
      blockedBy: t.blockedBy,
      completedAt: iso(t.completedAt),
      createdAt: t.createdAt.toISOString(),
    })),
    commitments: commitments.map((c) => ({
      id: c.id,
      clientId: c.clientId,
      direction: c.direction,
      kind: c.kind,
      status: c.status,
      counterpartyEmail: c.counterpartyEmail,
      action: c.action,
      dueAt: iso(c.dueAt),
      dueText: c.dueText,
      confidence: c.confidence,
      evidence: c.evidence,
      taskId: c.taskId,
      origin: c.origin,
      createdAt: c.createdAt.toISOString(),
    })),
    proposals: proposals.map((p) => ({
      id: p.id,
      kind: p.kind,
      status: p.status,
      payload: p.payload,
      confidence: p.confidence,
      explanation: p.explanation,
      resolution: p.resolution,
      resolvedAt: iso(p.resolvedAt),
      createdAt: p.createdAt.toISOString(),
    })),
    timeEntries: capList("timeEntries", truncated, timeEntries).map((e) => ({
      id: e.id,
      clientId: e.clientId,
      projectId: e.projectId,
      taskId: e.taskId,
      day: e.day,
      minutes: e.minutes,
      description: e.description,
      status: e.status,
      sourceType: e.sourceType,
      approvedAt: iso(e.approvedAt),
      createdAt: e.createdAt.toISOString(),
    })),
    calendarEvents: capList("calendarEvents", truncated, events).map((e) => ({
      id: e.id,
      title: e.title,
      startsAt: e.startsAt.toISOString(),
      endsAt: e.endsAt.toISOString(),
      allDay: e.allDay,
      attendees: e.attendees,
      clientId: e.clientId,
      origin: e.origin,
      busy: e.busy,
    })),
    blocks: capList("blocks", truncated, blocks).map((b) => ({
      id: b.id,
      taskId: b.taskId,
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
      pinned: b.pinned,
      reason: b.reason,
      planVersion: b.planVersion,
      completedAt: iso(b.completedAt),
    })),
    notifications: notifications.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, day: n.day, readAt: iso(n.readAt), createdAt: n.createdAt.toISOString() })),
    activity: activity.map((a) => ({
      id: a.id,
      actor: a.actor,
      action: a.action,
      entityType: a.entityType,
      entityId: a.entityId,
      reason: a.reason,
      undoneAt: iso(a.undoneAt),
      createdAt: a.createdAt.toISOString(),
    })),
    connections: accounts.map((a) => ({ provider: a.provider, email: a.email, status: a.status, scopes: a.scopes, lastSyncAt: iso(a.lastSyncAt), createdAt: a.createdAt.toISOString() })),
  };
}

