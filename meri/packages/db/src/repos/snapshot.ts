/**
 * D-041: loads the client-scoped slice of the workspace that feeds `buildClientContext`. The builder in core is
 * the isolation guard; this loader just keeps the query cheap (one client, bounded windows).
 */
import { and, desc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { WorkspaceSnapshot } from "@meri/core";
import { calendarEvents, clients, commitments, contacts, tasks, threadsIndex, timeEntries } from "../schema";
import type { WorkspaceTx } from "../workspace";
import type { WorkspaceId } from "../ids";
import { listProposals } from "./proposals";

const DAY = 86_400_000;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function loadClientSnapshot(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  clientId: string,
  now: Date,
  windowDays = 45,
): Promise<WorkspaceSnapshot> {
  const from = new Date(now.getTime() - windowDays * DAY);
  const to = new Date(now.getTime() + windowDays * DAY);
  const byClient = (t: { workspaceId: PgColumn; clientId: PgColumn }) =>
    and(eq(t.workspaceId, workspaceId), eq(t.clientId, clientId));
  const [clientRows, taskRows, commitmentRows, threadRows, eventRows, timeRows, contactRows, pending] =
    await Promise.all([
      tx.select({ id: clients.id, name: clients.name }).from(clients).where(eq(clients.workspaceId, workspaceId)),
      tx
        .select()
        .from(tasks)
        .where(and(byClient(tasks), isNull(tasks.deletedAt), sql`${tasks.status} <> 'completed'`))
        .orderBy(desc(tasks.dueAt))
        .limit(100),
      // Confirmed vs suggested stay apart: unconfirmed (`proposed`) extractions never read as facts in a briefing.
      tx
        .select()
        .from(commitments)
        .where(and(byClient(commitments), sql`${commitments.status} not in ('proposed', 'dismissed')`))
        .orderBy(desc(commitments.dueAt))
        .limit(100),
      tx
        .select()
        .from(threadsIndex)
        .where(byClient(threadsIndex))
        .orderBy(desc(threadsIndex.lastMessageAt))
        .limit(30),
      tx
        .select()
        .from(calendarEvents)
        .where(
          and(
            byClient(calendarEvents),
            eq(calendarEvents.origin, "external"),
            gte(calendarEvents.startsAt, from),
            lte(calendarEvents.startsAt, to),
          ),
        )
        .orderBy(desc(calendarEvents.startsAt))
        .limit(50),
      tx
        .select()
        .from(timeEntries)
        .where(and(byClient(timeEntries), gte(timeEntries.day, from.toISOString().slice(0, 10))))
        .orderBy(desc(timeEntries.day))
        .limit(100),
      tx.select().from(contacts).where(byClient(contacts)).limit(50),
      listProposals(tx, workspaceId, { status: "pending" }, { limit: 100 }),
    ]);
  return {
    clients: clientRows,
    tasks: taskRows.map((t) => ({
      id: t.id,
      clientId: t.clientId,
      title: t.title,
      status: t.status,
      dueAt: iso(t.dueAt),
      atRisk: t.risk !== null || t.status === "at_risk",
    })),
    commitments: commitmentRows.map((c) => ({
        id: c.id,
        clientId: c.clientId,
        direction: c.direction,
        action: c.action,
        status: c.status,
        dueAt: iso(c.dueAt),
        counterparty: c.counterpartyEmail,
    })),
    threads: threadRows.map((t) => ({
      id: t.id,
      clientId: t.clientId,
      subject: t.subject,
      lastMessageAt: iso(t.lastMessageAt),
      lastMessageFromMe: t.lastMessageFromMe,
      externalThreadId: t.externalThreadId,
    })),
    events: eventRows.map((e) => ({
      id: e.id,
      clientId: e.clientId,
      title: e.title,
      startsAt: e.startsAt.toISOString(),
      endsAt: e.endsAt.toISOString(),
    })),
    timeEntries: timeRows.map((t) => ({
      id: t.id,
      clientId: t.clientId,
      day: t.day,
      minutes: t.minutes,
      status: t.status,
    })),
    // Pending decisions: unresolved proposals whose payload points at this client (capture / commitment).
    proposals: pending.items
      .filter((p) => p.payload["clientId"] === clientId)
      .map((p) => ({
        id: p.id,
        clientId,
        kind: p.kind,
        summary: [p.payload["title"], p.payload["action"]].find((v): v is string => typeof v === "string") ?? p.kind,
        createdAt: p.createdAt.toISOString(),
      })),
    contacts: contactRows.map((c) => ({ id: c.id, clientId: c.clientId, email: c.email, name: c.name })),
  };
}
