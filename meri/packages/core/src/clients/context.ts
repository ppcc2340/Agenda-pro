/**
 * D-041 ContextBuilder (F-09 AC1): the ONE place that decides what the AI may see about a client.
 * Pure: takes a workspace snapshot, returns only the target client's items. Unassigned items (clientId null)
 * never enter a client context; nothing of any other client does either. The rendered text is the exact
 * prompt payload, delimited and declared untrusted (docs/05 §6).
 */

export type ContextItemType = "task" | "commitment" | "thread" | "event" | "time" | "proposal" | "contact";

interface Owned {
  id: string;
  clientId: string | null;
}
export interface SnapshotTask extends Owned {
  title: string;
  status: string;
  dueAt: string | null;
  atRisk?: boolean;
}
export interface SnapshotCommitment extends Owned {
  direction: "owed_by_me" | "owed_to_me";
  action: string;
  status: string;
  dueAt: string | null;
  counterparty: string | null;
}
export interface SnapshotThread extends Owned {
  subject: string | null;
  lastMessageAt: string | null;
  lastMessageFromMe: boolean | null;
  externalThreadId: string;
}
export interface SnapshotEvent extends Owned {
  title: string | null;
  startsAt: string;
  endsAt: string;
}
export interface SnapshotTimeEntry extends Owned {
  day: string;
  minutes: number;
  status: string;
}
export interface SnapshotProposal extends Owned {
  kind: string;
  summary: string;
  createdAt: string;
}
export interface SnapshotContact extends Owned {
  email: string;
  name: string | null;
}

export interface WorkspaceSnapshot {
  clients: { id: string; name: string }[];
  tasks: SnapshotTask[];
  commitments: SnapshotCommitment[];
  threads: SnapshotThread[];
  events: SnapshotEvent[];
  timeEntries: SnapshotTimeEntry[];
  proposals: SnapshotProposal[];
  contacts: SnapshotContact[];
}

export interface ContextItem {
  type: ContextItemType;
  id: string;
  title: string;
  date: string | null;
  /** Small typed facts (status, direction, minutes…); never free text from another entity. */
  facts: Record<string, string | number | boolean | null>;
}

export interface ClientContext {
  clientId: string;
  clientName: string;
  items: ContextItem[];
  /** Ids the AI may cite; anything else in its output is discarded (D-043). */
  sourceIds: ReadonlySet<string>;
  /** Stable fingerprint of the context: unchanged → a stored briefing can be reused. */
  hash: string;
  truncated: boolean;
}

export interface ContextOptions {
  now: string;
  maxItems?: number;
  maxChars?: number;
}

export const CLIENT_CONTEXT_OPEN = "<client_data>";
export const CLIENT_CONTEXT_CLOSE = "</client_data>";
export const MAX_CLIENT_CONTEXT_ITEMS = 60;
export const MAX_CLIENT_CONTEXT_CHARS = 12_000;
const TITLE_MAX = 200;

const clip = (s: string) => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s);
/** Entity text may never close the data block or forge a tag. */
const escapeDelims = (s: string) => s.replace(/<\/?(client_data|item|system|instructions)\b/gi, "‹tag›");

/** FNV-1a (64-bit split in two 32-bit lanes) over a canonical rendering: pure, no crypto dependency. */
export function stableHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x0100019b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

const ofClient = <T extends Owned>(rows: T[], clientId: string) => rows.filter((r) => r.clientId === clientId);

export function buildClientContext(
  snapshot: WorkspaceSnapshot,
  clientId: string,
  options: ContextOptions,
): ClientContext | null {
  const client = snapshot.clients.find((c) => c.id === clientId);
  if (!client) return null;
  const items: ContextItem[] = [];
  for (const t of ofClient(snapshot.tasks, clientId))
    items.push({
      type: "task",
      id: t.id,
      title: clip(t.title),
      date: t.dueAt,
      facts: { status: t.status, atRisk: t.atRisk ?? false },
    });
  for (const c of ofClient(snapshot.commitments, clientId))
    items.push({
      type: "commitment",
      id: c.id,
      title: clip(c.action),
      date: c.dueAt,
      facts: { direction: c.direction, status: c.status, counterparty: c.counterparty },
    });
  for (const th of ofClient(snapshot.threads, clientId))
    items.push({
      type: "thread",
      id: th.id,
      title: clip(th.subject ?? "(sin asunto)"),
      date: th.lastMessageAt,
      facts: { lastMessageFromMe: th.lastMessageFromMe, externalThreadId: th.externalThreadId },
    });
  for (const e of ofClient(snapshot.events, clientId))
    items.push({
      type: "event",
      id: e.id,
      title: clip(e.title ?? "(reunión)"),
      date: e.startsAt,
      facts: { endsAt: e.endsAt, upcoming: e.startsAt >= options.now },
    });
  for (const te of ofClient(snapshot.timeEntries, clientId))
    items.push({
      type: "time",
      id: te.id,
      title: `${String(te.minutes)} min`,
      date: te.day,
      facts: { minutes: te.minutes, status: te.status },
    });
  for (const p of ofClient(snapshot.proposals, clientId))
    items.push({ type: "proposal", id: p.id, title: clip(p.summary), date: p.createdAt, facts: { kind: p.kind } });
  for (const ct of ofClient(snapshot.contacts, clientId))
    items.push({ type: "contact", id: ct.id, title: clip(ct.name ?? ct.email), date: null, facts: { email: ct.email } });
  // Deterministic: newest first, then by id; bounded.
  items.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id));
  const max = options.maxItems ?? MAX_CLIENT_CONTEXT_ITEMS;
  const kept = items.slice(0, max);
  const hash = stableHash(JSON.stringify(kept));
  return {
    clientId,
    clientName: client.name,
    items: kept,
    sourceIds: new Set(kept.map((i) => i.id)),
    hash,
    truncated: kept.length < items.length,
  };
}

const factsOf = (facts: ContextItem["facts"]) =>
  Object.entries(facts)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${escapeDelims(String(v)).replace(/["<>\r\n]/g, " ")}`)
    .join(" ");

/** The prompt payload: one line per item inside the untrusted-data block, size-capped. */
export function renderClientContext(ctx: ClientContext, options: { now: string; maxChars?: number }): string {
  const header = `Client: ${escapeDelims(ctx.clientName)}\nNow: ${options.now}`;
  const lines = ctx.items.map(
    (i) => `<item type="${i.type}" id="${i.id}" date="${i.date ?? ""}" ${factsOf(i.facts)}>${escapeDelims(i.title)}</item>`,
  );
  const body = `${CLIENT_CONTEXT_OPEN}\n${lines.join("\n")}\n${CLIENT_CONTEXT_CLOSE}`;
  const max = options.maxChars ?? MAX_CLIENT_CONTEXT_CHARS;
  const full = `${header}\n${body}`;
  if (full.length <= max) return full;
  // Drop whole items from the end until it fits; never cut an item in half.
  const keep: string[] = [];
  let size = header.length + CLIENT_CONTEXT_OPEN.length + CLIENT_CONTEXT_CLOSE.length + 3;
  for (const line of lines) {
    if (size + line.length + 1 > max) break;
    keep.push(line);
    size += line.length + 1;
  }
  return `${header}\n${CLIENT_CONTEXT_OPEN}\n${keep.join("\n")}\n${CLIENT_CONTEXT_CLOSE}`;
}

/** Parses a rendered context back (the fake AI handler builds its rules briefing from the same payload). */
export function parseClientContext(text: string): { clientName: string; items: ContextItem[] } | null {
  const clientName = /^Client: (.+)$/m.exec(text)?.[1]?.trim();
  if (!clientName) return null;
  const items: ContextItem[] = [];
  const re = /<item type="(\w+)" id="([^"]+)" date="([^"]*)"([^>]*)>([^<]*)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const facts: ContextItem["facts"] = {};
    for (const kv of (m[4] ?? "").trim().split(/\s+/).filter(Boolean)) {
      const eq = kv.indexOf("=");
      if (eq > 0) {
        const v = kv.slice(eq + 1);
        facts[kv.slice(0, eq)] = v === "true" ? true : v === "false" ? false : /^\d+$/.test(v) ? Number(v) : v;
      }
    }
    items.push({
      type: m[1] as ContextItemType,
      id: m[2] ?? "",
      date: m[3] ? m[3] : null,
      facts,
      title: m[5] ?? "",
    });
  }
  return { clientName, items };
}
