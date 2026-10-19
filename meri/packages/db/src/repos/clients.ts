import { and, asc, count, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { calendarEvents, clients, commitments, contacts, projects, tasks, threadsIndex, timeEntries } from "../schema";
import type { WorkspaceTx } from "../workspace";
import { newId, type WorkspaceId } from "../ids";

export interface ClientSummary {
  id: string;
  name: string;
  color: string | null;
  domains: string[];
  followupsMuted: boolean;
}

export interface ClientView extends ClientSummary {
  notes: string | null;
  verticalTags: string[];
  archivedAt: Date | null;
  createdAt: Date;
}

type Row = typeof clients.$inferSelect;
const toView = (r: Row): ClientView => ({
  id: r.id,
  name: r.name,
  color: r.color,
  domains: r.domains,
  followupsMuted: r.followupsMuted,
  notes: r.notes,
  verticalTags: r.verticalTags,
  archivedAt: r.archivedAt,
  createdAt: r.createdAt,
});

/** Active clients of the workspace (names feed the capture context). */
export async function listClients(tx: WorkspaceTx, workspaceId: WorkspaceId): Promise<ClientSummary[]> {
  const rows = await tx
    .select({
      id: clients.id,
      name: clients.name,
      color: clients.color,
      domains: clients.domains,
      followupsMuted: clients.followupsMuted,
    })
    .from(clients)
    .where(and(eq(clients.workspaceId, workspaceId), isNull(clients.deletedAt), isNull(clients.archivedAt)))
    .orderBy(asc(clients.name));
  return rows;
}

/** Clients with resolution data (domains + contact e-mails) for `resolveClient` (mail and calendar). */
export async function listClientRefs(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
): Promise<{ id: string; name: string; domains: string[]; contactEmails: string[] }[]> {
  const [rows, people] = await Promise.all([
    listClients(tx, workspaceId),
    listContactEmails(tx, workspaceId),
  ]);
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    domains: c.domains,
    contactEmails: people.filter((p) => p.clientId === c.id).map((p) => p.email),
  }));
}

async function listContactEmails(tx: WorkspaceTx, workspaceId: WorkspaceId) {
  return tx
    .select({ email: contacts.email, clientId: contacts.clientId })
    .from(contacts)
    .where(eq(contacts.workspaceId, workspaceId));
}

export async function listClientsFull(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  options: { includeArchived?: boolean } = {},
): Promise<ClientView[]> {
  const rows = await tx
    .select()
    .from(clients)
    .where(
      and(
        eq(clients.workspaceId, workspaceId),
        isNull(clients.deletedAt),
        options.includeArchived ? undefined : isNull(clients.archivedAt),
      ),
    )
    .orderBy(asc(clients.name));
  return rows.map(toView);
}

export async function getClient(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
): Promise<ClientView | null> {
  const row = await tx.query.clients.findFirst({
    where: and(eq(clients.workspaceId, workspaceId), eq(clients.id, id), isNull(clients.deletedAt)),
  });
  return row ? toView(row) : null;
}

export async function countActiveClients(tx: WorkspaceTx, workspaceId: WorkspaceId): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(clients)
    .where(and(eq(clients.workspaceId, workspaceId), isNull(clients.deletedAt), isNull(clients.archivedAt)));
  return row?.n ?? 0;
}

export interface NewClient {
  name: string;
  domains?: string[];
  color?: string | null;
  notes?: string | null;
  verticalTags?: string[];
}

export async function createClient(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: NewClient,
  now: Date,
): Promise<ClientView> {
  const [row] = await tx
    .insert(clients)
    .values({
      id: newId(),
      workspaceId,
      name: input.name,
      domains: (input.domains ?? []).map((d) => d.toLowerCase()),
      color: input.color ?? null,
      notes: input.notes ?? null,
      verticalTags: input.verticalTags ?? [],
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error("client insert returned no row");
  return toView(row);
}

export async function updateClient(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
  patch: Partial<NewClient & { followupsMuted: boolean; archived: boolean }>,
  now: Date,
): Promise<ClientView | null> {
  const { archived, domains, ...rest } = patch;
  const [row] = await tx
    .update(clients)
    .set({
      ...rest,
      ...(domains !== undefined ? { domains: domains.map((d) => d.toLowerCase()) } : {}),
      ...(archived !== undefined ? { archivedAt: archived ? now : null } : {}),
    })
    .where(and(eq(clients.workspaceId, workspaceId), eq(clients.id, id), isNull(clients.deletedAt)))
    .returning();
  return row ? toView(row) : null;
}

/** Soft delete: the client disappears and its elements are detached (tasks, commitments, contacts, projects keep existing). */
/**
 * Soft delete only: linked tasks, commitments, time entries, threads and events keep their `client_id` so
 * approved time and history stay intact (views label them "(cliente eliminado)"); nothing is detached.
 */
export async function softDeleteClient(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
  now: Date,
): Promise<boolean> {
  const [row] = await tx
    .update(clients)
    .set({ deletedAt: now })
    .where(and(eq(clients.workspaceId, workspaceId), eq(clients.id, id), isNull(clients.deletedAt)))
    .returning({ id: clients.id });
  return Boolean(row);
}

const emailDomainSql = (col: SQL) => sql`lower(split_part(${col}, '@', 2))`;
const domainList = (domains: string[]) => sql.join(domains.map((d) => sql`${d}`), sql`, `);
const participantMatches = (col: SQL, domains: string[]) =>
  sql`exists (select 1 from jsonb_array_elements_text(${col}) p where ${emailDomainSql(sql`p`)} in (${domainList(domains)}))`;

/**
 * H1 (phase 3): when a client's domains change, link the still-unassigned contacts, threads and external
 * calendar events whose participants belong to those domains. Domains claimed by another active client are
 * skipped and an item that also involves another client's domain stays unassigned (same "never ambiguous"
 * rule as `resolveClient`). Returns the number of linked rows per table.
 */
export async function relinkClientByDomains(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  clientId: string,
  domains: string[],
): Promise<{ contacts: number; threads: number; events: number }> {
  const others = (await listClients(tx, workspaceId)).filter((c) => c.id !== clientId);
  const taken = new Set(others.flatMap((c) => c.domains.map((d) => d.toLowerCase())));
  const mine = [...new Set(domains.map((d) => d.toLowerCase()))].filter((d) => !taken.has(d));
  if (mine.length === 0) return { contacts: 0, threads: 0, events: 0 };
  const foreign = [...taken];
  const linkedContacts = await tx
    .update(contacts)
    .set({ clientId })
    .where(
      and(
        eq(contacts.workspaceId, workspaceId),
        isNull(contacts.clientId),
        sql`${emailDomainSql(sql`${contacts.email}`)} in (${domainList(mine)})`,
      ),
    )
    .returning({ id: contacts.id });
  const linkedThreads = await tx
    .update(threadsIndex)
    .set({ clientId })
    .where(
      and(
        eq(threadsIndex.workspaceId, workspaceId),
        isNull(threadsIndex.clientId),
        participantMatches(sql`${threadsIndex.participants}`, mine),
        foreign.length ? sql`not ${participantMatches(sql`${threadsIndex.participants}`, foreign)}` : undefined,
      ),
    )
    .returning({ id: threadsIndex.id });
  const linkedEvents = await tx
    .update(calendarEvents)
    .set({ clientId })
    .where(
      and(
        eq(calendarEvents.workspaceId, workspaceId),
        isNull(calendarEvents.clientId),
        eq(calendarEvents.origin, "external"),
        participantMatches(sql`${calendarEvents.attendees}`, mine),
        foreign.length ? sql`not ${participantMatches(sql`${calendarEvents.attendees}`, foreign)}` : undefined,
      ),
    )
    .returning({ id: calendarEvents.id });
  return { contacts: linkedContacts.length, threads: linkedThreads.length, events: linkedEvents.length };
}

export interface ClientStats {
  clientId: string;
  openCommitments: number;
  overdueCommitments: number;
  atRiskTasks: number;
  minutesApproved: number;
  minutesSuggested: number;
}

/** Per-client counters for the Clientes tab (demo tabClientes): commitments, risks and this week's minutes. */
export async function clientStats(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  week: { from: string; to: string },
): Promise<Map<string, ClientStats>> {
  const ids = (await listClients(tx, workspaceId)).map((c) => c.id);
  const out = new Map<string, ClientStats>(
    ids.map((id) => [
      id,
      {
        clientId: id,
        openCommitments: 0,
        overdueCommitments: 0,
        atRiskTasks: 0,
        minutesApproved: 0,
        minutesSuggested: 0,
      },
    ]),
  );
  if (ids.length === 0) return out;
  const byCommitment = await tx
    .select({
      clientId: commitments.clientId,
      open: sql<number>`count(*) filter (where ${commitments.status} in ('confirmed', 'at_risk', 'broken'))::int`,
      overdue: sql<number>`count(*) filter (where ${commitments.status} in ('at_risk', 'broken'))::int`,
    })
    .from(commitments)
    .where(and(eq(commitments.workspaceId, workspaceId), inArray(commitments.clientId, ids)))
    .groupBy(commitments.clientId);
  for (const r of byCommitment) {
    const s = r.clientId ? out.get(r.clientId) : undefined;
    if (s) {
      s.openCommitments = r.open;
      s.overdueCommitments = r.overdue;
    }
  }
  const byTask = await tx
    .select({ clientId: tasks.clientId, n: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.workspaceId, workspaceId),
        inArray(tasks.clientId, ids),
        eq(tasks.status, "at_risk"),
        isNull(tasks.deletedAt),
      ),
    )
    .groupBy(tasks.clientId);
  for (const r of byTask) {
    const s = r.clientId ? out.get(r.clientId) : undefined;
    if (s) s.atRiskTasks = r.n;
  }
  const byTime = await tx
    .select({
      clientId: timeEntries.clientId,
      approved: sql<number>`coalesce(sum(${timeEntries.minutes}) filter (where ${timeEntries.status} = 'approved'), 0)::int`,
      suggested: sql<number>`coalesce(sum(${timeEntries.minutes}) filter (where ${timeEntries.status} = 'suggested'), 0)::int`,
    })
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.workspaceId, workspaceId),
        inArray(timeEntries.clientId, ids),
        gte(timeEntries.day, week.from),
        lte(timeEntries.day, week.to),
      ),
    )
    .groupBy(timeEntries.clientId);
  for (const r of byTime) {
    const s = r.clientId ? out.get(r.clientId) : undefined;
    if (s) {
      s.minutesApproved = r.approved;
      s.minutesSuggested = r.suggested;
    }
  }
  return out;
}

// ---------- Projects (matters) ----------
export interface ProjectView {
  id: string;
  clientId: string | null;
  name: string;
  kind: string | null;
  dueAt: Date | null;
  status: string;
  createdAt: Date;
}
const toProject = (r: typeof projects.$inferSelect): ProjectView => ({
  id: r.id,
  clientId: r.clientId,
  name: r.name,
  kind: r.kind,
  dueAt: r.dueAt,
  status: r.status,
  createdAt: r.createdAt,
});

export async function projectExists(tx: WorkspaceTx, workspaceId: WorkspaceId, id: string): Promise<boolean> {
  const row = await tx.query.projects.findFirst({
    columns: { id: true },
    where: and(eq(projects.workspaceId, workspaceId), eq(projects.id, id), isNull(projects.deletedAt)),
  });
  return row !== undefined;
}

export async function listProjects(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  filters: { clientId?: string | undefined } = {},
): Promise<ProjectView[]> {
  const rows = await tx
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, workspaceId),
        isNull(projects.deletedAt),
        filters.clientId ? eq(projects.clientId, filters.clientId) : undefined,
      ),
    )
    .orderBy(asc(projects.name));
  return rows.map(toProject);
}

export async function createProject(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  input: { clientId: string | null; name: string; kind?: string | null; dueAt?: Date | null },
  now: Date,
): Promise<ProjectView> {
  const [row] = await tx
    .insert(projects)
    .values({
      id: newId(),
      workspaceId,
      clientId: input.clientId,
      name: input.name,
      kind: input.kind ?? null,
      dueAt: input.dueAt ?? null,
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error("project insert returned no row");
  return toProject(row);
}

export async function updateProject(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
  id: string,
  patch: Partial<{
    name: string;
    kind: string | null;
    dueAt: Date | null;
    status: string;
    clientId: string | null;
  }>,
): Promise<ProjectView | null> {
  const [row] = await tx
    .update(projects)
    .set(patch)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, id), isNull(projects.deletedAt)))
    .returning();
  return row ? toProject(row) : null;
}

/** D-040: domains of every client of the workspace, active, archived or deleted (never re-proposed). */
export async function listAllClientDomains(tx: WorkspaceTx, workspaceId: WorkspaceId): Promise<string[]> {
  const rows = await tx.select({ domains: clients.domains }).from(clients).where(eq(clients.workspaceId, workspaceId));
  return [...new Set(rows.flatMap((r) => r.domains.map((d) => d.toLowerCase())))];
}

export interface DomainSightingRow {
  domain: string;
  contacts: number;
  threads: number;
}

/**
 * D-040: how often each e-mail domain appears among contacts and indexed threads that have no client yet.
 * Counts only, never names or subjects; the pure rules in core decide which ones become `client_link` proposals.
 */
export async function listUnlinkedDomainSightings(
  tx: WorkspaceTx,
  workspaceId: WorkspaceId,
): Promise<DomainSightingRow[]> {
  const rows = await tx.execute<{ domain: string; contacts: string | number; threads: string | number }>(sql`
    with c as (
      select lower(split_part(${contacts.email}, '@', 2)) as domain, count(*) as n
      from ${contacts} where ${contacts.workspaceId} = ${workspaceId} and ${contacts.clientId} is null group by 1),
    t as (
      select lower(split_part(p, '@', 2)) as domain, count(distinct ${threadsIndex.id}) as n
      from ${threadsIndex}, jsonb_array_elements_text(${threadsIndex.participants}) as p
      where ${threadsIndex.workspaceId} = ${workspaceId} and ${threadsIndex.clientId} is null group by 1)
    select coalesce(c.domain, t.domain) as domain, coalesce(c.n, 0) as contacts, coalesce(t.n, 0) as threads
    from c full outer join t on c.domain = t.domain
    where coalesce(c.domain, t.domain) <> ''
    order by coalesce(c.n, 0) + coalesce(t.n, 0) desc, 1
    limit 200`);
  return [...rows].map((r) => ({ domain: r.domain, contacts: Number(r.contacts), threads: Number(r.threads) }));
}
