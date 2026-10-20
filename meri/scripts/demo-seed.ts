/**
 * Demo seed (PROTOTYPE.md, D-048): the `demo@meri.local` workspace with the four clients, meetings, tasks,
 * commitments, proposals, time and activity of demo/src/shared.js, dated in the week of DEMO_NOW (or today) in
 * Europe/Madrid. Written through the real repositories (RLS on) and derived through the real handlers
 * (planner, time inference, follow-up scan). Idempotent: an already seeded workspace is left alone.
 * Usage: pnpm demo:seed [--reset]   (--reset deletes the demo workspace first; needs DATABASE_ADMIN_URL)
 */
import { createLogger, DEMO_USER, loadConfig, loadDotenv } from "@meri/config";
import { fromLocalParts, toLocalParts, addLocalDays } from "@meri/core";
import {
  ADMIN_WORKSPACE_CONTEXT,
  audit,
  bootstrapAccount,
  createClient,
  createCommitment,
  createDb,
  createProposalIfAbsent,
  createTask,
  insertBlocks,
  listClients,
  listTimeEntries,
  setTimeEntriesStatus,
  hardDeleteAccountByEmail,
  updateBlock,
  updatePreferences,
  upsertCalendarEvent,
  upsertContact,
  upsertIntegrationAccount,
  setSyncCursor,
  upsertThread,
  withWorkspace,
  type WorkspaceId,
} from "@meri/db";
import { CALENDAR_SCOPES, DEMO_MAIL_MESSAGE_COUNT, DEMO_MAIL_THREADS, GMAIL_SCOPES, createIntegrations, demoMailDate, demoMessageId, demoThreadId } from "@meri/integrations";
import { encryptTokens, inferTime, runReplan, scanFollowups, type HandlerDeps } from "@meri/jobs";

export const DEMO_EMAIL = DEMO_USER.email;
export const DEMO_TIMEZONE = "Europe/Madrid";

const CLIENTS = [
  { key: "acme", name: "Acme Corp", color: "#3A6EDB", domains: ["acme.com"], tags: ["mercantil"] },
  { key: "norte", name: "Estudio Norte", color: "#2F8A5C", domains: ["estudionorte.cl"], tags: ["consultoría"] },
  { key: "luna", name: "Luna Legal", color: "#B07414", domains: ["lunalegal.es"], tags: ["litigio"] },
  { key: "beta", name: "Beta Logística", color: "#B0407E", domains: ["betalogistica.com"], tags: ["contrato"] },
] as const;
type ClientKey = (typeof CLIENTS)[number]["key"];

const PEOPLE = [
  { email: "ana@acme.com", name: "Ana Ruiz", client: "acme" },
  { email: "carlos@acme.com", name: "Carlos Ibáñez", client: "acme" },
  { email: "laura@estudionorte.cl", name: "Laura Vidal", client: "norte" },
  { email: "marta@lunalegal.es", name: "Marta Díaz", client: "luna" },
  { email: "pablo@betalogistica.com", name: "Pablo Soto", client: "beta" },
] as const;

export interface SeedResult {
  status: "seeded" | "skipped";
  workspaceId: string;
  counts?: { clients: number; tasks: number; events: number; commitments: number; proposals: number };
}

export async function seedDemo(options: { now: Date; reset?: boolean; databaseUrl: string; adminUrl?: string | undefined; env: NodeJS.ProcessEnv }): Promise<SeedResult> {
  const { now } = options;
  const config = loadConfig({ ...options.env, DATABASE_URL: options.databaseUrl });
  // The demo only ever runs against the fake adapters and never on a production configuration (D-047).
  if (config.isProduction || config.modes.google === "live" || config.modes.ai === "live")
    throw new Error("demo:seed only runs with GOOGLE_MODE=fake and AI_MODE=fake outside production");
  const handle = createDb(options.databaseUrl, { max: 2 });
  const integrations = createIntegrations(config, { now: () => now });
  const deps: HandlerDeps = { db: handle.db, integrations, keys: integrations.kms.keys, logger: createLogger({ name: "demo-seed", level: "warn" }), now: () => now };
  try {
    if (options.reset) await resetDemo(options.adminUrl);
    const account = await bootstrapAccount(handle.db, { email: DEMO_EMAIL, name: DEMO_USER.name, now });
    const ws = account.workspaceId;
    const existing = await withWorkspace(handle.db, ws, (tx) => listClients(tx, ws));
    if (existing.length > 0) return { status: "skipped", workspaceId: ws };

    // Local calendar of the demo week: "today" is the local date of `now`; offsets are whole local days.
    const local = toLocalParts(now.getTime(), DEMO_TIMEZONE);
    const at = (dayOffset: number, hour: number, minute = 0) => {
      const d = addLocalDays(local, dayOffset);
      return new Date(fromLocalParts({ ...d, hour, minute }, DEMO_TIMEZONE));
    };
    const actorUser = { workspaceId: ws, actor: "user" as const, actorUserId: account.userId };

    const counts = await withWorkspace(handle.db, ws, async (tx) => {
      await updatePreferences(
        tx,
        ws,
        { timezone: DEMO_TIMEZONE, workStart: "09:00", workEnd: "18:00", workDays: [1, 2, 3, 4, 5], contingencyPct: 20, vertical: "legal", autonomy: "suggest_only" },
        { now, completeOnboarding: true },
      );
      const ids = {} as Record<ClientKey, string>;
      for (const c of CLIENTS) {
        const created = await createClient(tx, ws, { name: c.name, domains: [...c.domains], color: c.color, verticalTags: [...c.tags] }, now);
        ids[c.key] = created.id;
      }
      for (const p of PEOPLE) await upsertContact(tx, ws, { email: p.email, name: p.name, clientId: ids[p.client] });

      // Google account (fake) with calendar + Gmail scopes and encrypted demo tokens.
      const scopes = [...CALENDAR_SCOPES, ...GMAIL_SCOPES];
      const pre = await upsertIntegrationAccount(tx, ws, { provider: "google", externalAccountId: "demo-sub", email: DEMO_EMAIL, scopes, encryptedTokens: "pending", keyId: "local" }, now);
      const blob = await encryptTokens({ keys: integrations.kms.keys }, ws, pre.id, {
        accessToken: "demo-access",
        refreshToken: "demo-refresh",
        expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        scopes,
        externalAccountId: "demo-sub",
        email: DEMO_EMAIL,
      });
      const accountRow = await upsertIntegrationAccount(tx, ws, { provider: "google", externalAccountId: "demo-sub", email: DEMO_EMAIL, scopes, encryptedTokens: blob, keyId: "local" }, now);

      // Meetings: today, the week ahead, and last week's (ended → time inference, one without client).
      const events: { id: string; title: string; day: number; h: number; m: number; minutes: number; client: ClientKey | null; attendees: string[] }[] = [
        { id: "llamada-acme", title: "Llamada semanal con Acme", day: 0, h: 9, m: 30, minutes: 45, client: "acme", attendees: ["ana@acme.com"] },
        { id: "almuerzo", title: "Almuerzo", day: 0, h: 12, m: 30, minutes: 60, client: null, attendees: [] },
        { id: "estrategia-norte", title: "Reunión de estrategia con Estudio Norte", day: 0, h: 16, m: 30, minutes: 60, client: "norte", attendees: ["laura@estudionorte.cl"] },
        { id: "comite-luna", title: "Comité con Luna Legal", day: 1, h: 11, m: 0, minutes: 60, client: "luna", attendees: ["marta@lunalegal.es"] },
        { id: "entrega-acme", title: "Entrega del informe a Acme", day: 3, h: 16, m: 0, minutes: 30, client: "acme", attendees: ["ana@acme.com", "carlos@acme.com"] },
        { id: "llamada-beta", title: "Llamada con Beta Logística", day: -1, h: 10, m: 0, minutes: 60, client: null, attendees: ["externo@proveedor.test"] },
        { id: "cierre-norte", title: "Reunión de cierre trimestral", day: -3, h: 15, m: 0, minutes: 90, client: "norte", attendees: ["laura@estudionorte.cl"] },
      ];
      for (const e of events) {
        const start = at(e.day, e.h, e.m);
        await upsertCalendarEvent(
          tx,
          ws,
          { integrationAccountId: accountRow.id, externalId: `demo-${e.id}`, etag: "1", title: e.title, startsAt: start, endsAt: new Date(start.getTime() + e.minutes * 60_000), allDay: false, attendees: [DEMO_EMAIL, ...e.attendees], busy: true, origin: "external", clientId: e.client ? ids[e.client] : null },
          now,
        );
      }

      // Tasks (demo/src/shared.js), with the completed ones carrying a completed block (time source).
      const task = (input: { title: string; client: ClientKey | null; kind: "deep" | "shallow"; minutes: number; priority: number; due?: Date; hard?: boolean; status?: "pending" | "completed" }) =>
        createTask(
          tx,
          ws,
          { title: input.title, clientId: input.client ? ids[input.client] : null, kind: input.kind, estimateMinutes: input.minutes, priority: input.priority, dueAt: input.due ? input.due.toISOString() : null, deadlineType: input.hard ? "hard" : "soft", status: input.status ?? "pending", tags: [], origin: "user" },
          now,
        );
      const done = async (title: string, client: ClientKey, minutes: number, day: number, h: number, m = 0) => {
        const t = await task({ title, client, kind: minutes >= 90 ? "deep" : "shallow", minutes, priority: 3, status: "completed" });
        const start = at(day, h, m);
        const [block] = await insertBlocks(tx, ws, [{ taskId: t.id, startsAt: start, endsAt: new Date(start.getTime() + minutes * 60_000), pinned: false, reason: [] }], 1, now);
        if (block) await updateBlock(tx, ws, block.id, { completedAt: new Date(start.getTime() + minutes * 60_000) });
        return t;
      };
      await done("Responder consultas de Luna", "luna", 45, 0, 8, 45);
      await done("Redacción del informe", "acme", 150, -4, 15, 0);
      await done("Revisión de cláusulas de transporte", "beta", 120, -3, 9, 30);
      await task({ title: "Informe trimestral de Acme", client: "acme", kind: "deep", minutes: 120, priority: 1, due: at(3, 18) });
      await task({ title: "Borrador de contestación para Beta", client: "beta", kind: "deep", minutes: 270, priority: 1, due: at(2, 18), hard: true });
      await task({ title: "Revisar factura de Estudio Norte", client: "norte", kind: "shallow", minutes: 60, priority: 3 });
      await task({ title: "Preparar briefing de Luna Legal", client: "luna", kind: "shallow", minutes: 45, priority: 2, due: at(1, 10) });
      await task({ title: "Enviar la propuesta revisada a Acme", client: "acme", kind: "shallow", minutes: 60, priority: 2, due: at(1, 18) });
      await task({ title: "Confirmar la fecha de audiencia", client: "luna", kind: "shallow", minutes: 30, priority: 2, due: at(4, 12), hard: true });
      const tasksSeeded = 9;

      // Confirmed commitments (radar) and three proposals from indexed threads (Entrada).
      const threads: Record<string, string> = {};
      // Same threads and message ids as the demo FakeGmail (D-052): drafts reply to real messages.
      for (const t of DEMO_MAIL_THREADS) {
        const { thread: row } = await upsertThread(tx, ws, { integrationAccountId: accountRow.id, externalThreadId: demoThreadId(t.key), subject: t.subject, participants: [DEMO_EMAIL, t.from.email], clientId: ids[t.clientKey as ClientKey], lastMessageAt: new Date(demoMailDate(now, t.daysAgo)), lastMessageFromMe: t.fromMe, lastExternalMessageId: demoMessageId(t.key, 0) });
        threads[t.key] = row.id;
      }
      // The mailbox is already indexed: the worker's incremental sync starts after the demo messages.
      await setSyncCursor(tx, ws, accountRow.id, "gmail.history", String(DEMO_MAIL_MESSAGE_COUNT), now);

      const commit = (c: { client: ClientKey; dir: "owed_by_me" | "owed_to_me"; action: string; who: (typeof PEOPLE)[number]; due: Date | null; status: "confirmed" | "proposed"; kind: "explicit" | "inferred" | "suggested"; confidence: number; evidence: string | null; thread: string | null; dueText?: string }) =>
        createCommitment(
          tx,
          ws,
          { clientId: ids[c.client], direction: c.dir, kind: c.kind, status: c.status, counterpartyEmail: c.who.email, action: c.action, dueAt: c.due, dueText: c.dueText ?? null, confidence: c.confidence, evidence: c.evidence, threadId: c.thread ? threads[c.thread] ?? null : null, externalMessageId: c.thread ? demoMessageId(c.thread, 0) : null, dedupeHash: `demo:${c.dir}:${c.action}`, origin: c.status === "proposed" ? "ai_confirmed" : "user" },
          now,
        );
      await commit({ client: "acme", dir: "owed_by_me", action: "Entregar el informe trimestral", who: PEOPLE[0], due: at(3, 18), status: "confirmed", kind: "explicit", confidence: 0.95, evidence: null, thread: null });
      await commit({ client: "acme", dir: "owed_by_me", action: "Enviar la propuesta revisada", who: PEOPLE[0], due: at(1, 18), status: "confirmed", kind: "explicit", confidence: 0.9, evidence: null, thread: null });
      await commit({ client: "luna", dir: "owed_by_me", action: "Confirmar la fecha de audiencia", who: PEOPLE[3], due: at(4, 12), status: "confirmed", kind: "explicit", confidence: 0.9, evidence: null, thread: "poder" });
      await commit({ client: "acme", dir: "owed_to_me", action: "Datos de ventas del tercer trimestre", who: PEOPLE[1], due: at(-1, 18), status: "confirmed", kind: "explicit", confidence: 0.9, evidence: "te paso los datos de ventas del tercer trimestre mañana", thread: "ventas" });
      await commit({ client: "luna", dir: "owed_to_me", action: "Poder notarial firmado", who: PEOPLE[3], due: at(2, 18), status: "confirmed", kind: "explicit", confidence: 0.9, evidence: "te envío el poder notarial firmado el miércoles", thread: "poder" });
      await commit({ client: "beta", dir: "owed_to_me", action: "Aprobación del presupuesto", who: PEOPLE[4], due: at(4, 18), status: "confirmed", kind: "explicit", confidence: 0.9, evidence: "apruebo el presupuesto el viernes", thread: "presupuesto" });

      const proposals = [
        { client: "acme" as const, dir: "owed_to_me" as const, action: "Enviar el contrato firmado", who: PEOPLE[0], due: at(2, 18), dueText: "el miércoles", kind: "explicit" as const, confidence: 0.94, evidence: "te envío el contrato firmado el miércoles", thread: "contrato", subject: "RE: Contrato de servicios 2026" },
        { client: "beta" as const, dir: "owed_by_me" as const, action: "Revisar el presupuesto de transporte", who: PEOPLE[4], due: null, dueText: null, kind: "inferred" as const, confidence: 0.71, evidence: "¿Podrías mirar el presupuesto cuando puedas?", thread: "presupuesto", subject: "Presupuesto transporte Q4" },
        { client: "norte" as const, dir: "owed_by_me" as const, action: "Agendar la reunión de cierre", who: PEOPLE[2], due: at(10, 18), dueText: "fin de mes", kind: "suggested" as const, confidence: 0.55, evidence: "Quizá podríamos vernos a fin de mes", thread: "cierre", subject: "Cierre de proyecto" },
      ];
      let proposalsSeeded = 0;
      for (const p of proposals) {
        const c = await commit({ client: p.client, dir: p.dir, action: p.action, who: p.who, due: p.due, status: "proposed", kind: p.kind, confidence: p.confidence, evidence: p.evidence, thread: p.thread, dueText: p.dueText ?? undefined });
        if (!c) continue;
        const created = await createProposalIfAbsent(
          tx,
          ws,
          {
            kind: "commitment",
            confidence: p.confidence,
            explanation: p.kind,
            dedupeHash: `proposal:demo:${p.action}`,
            sourceRef: { type: "thread", id: threads[p.thread] ?? "", url: `https://mail.google.com/mail/u/0/#all/${demoThreadId(p.thread)}` },
            payload: { commitmentId: c.id, direction: p.dir, action: p.action, dueAt: p.due ? p.due.toISOString() : null, dueText: p.dueText, kind: p.kind, confidence: p.confidence, evidence: p.evidence, counterpartyEmail: p.who.email, counterpartyName: p.who.name, clientId: ids[p.client], threadId: threads[p.thread] ?? null, externalThreadId: demoThreadId(p.thread), subject: p.subject, externalMessageId: demoMessageId(p.thread, 0), eventId: null },
          },
          now,
        );
        if (created) proposalsSeeded++;
      }
      return { clients: CLIENTS.length, tasks: tasksSeeded, events: events.length, commitments: 6, proposals: proposalsSeeded };
    });

    // Derived data through the real handlers: today's plan, inferred time, follow-ups.
    await runReplan(deps, ws, { reason: "manual" });
    await inferTime(deps, ws);
    await scanFollowups(deps, ws);
    // Last week's entries were reviewed by the user: approve them (audited as the user, like the API does).
    await withWorkspace(handle.db, ws, async (tx) => {
      // Calendar arithmetic, never `day - 1`: on the 1st of a month that would build "YYYY-MM-00".
      const dayKey = (d: { year: number; month: number; day: number }) =>
        `${String(d.year)}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
      const entries = await listTimeEntries(tx, ws, { from: dayKey(addLocalDays(local, -6)), to: dayKey(addLocalDays(local, -1)) });
      const approved = await setTimeEntriesStatus(tx, ws, entries.map((e) => e.id), "approved", new Date(now.getTime() - 86_400_000));
      for (const e of approved) await audit(tx, actorUser, { action: "time.approved", entityType: "time_entry", entityId: e.id, before: { status: "suggested" }, after: { status: "approved", minutes: e.minutes } });
    });
    return { status: "seeded", workspaceId: ws, counts };
  } finally {
    await handle.close();
  }
}

async function resetDemo(adminUrl: string | undefined): Promise<void> {
  if (!adminUrl) throw new Error("--reset needs DATABASE_ADMIN_URL");
  const admin = createDb(adminUrl, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
  try {
    await hardDeleteAccountByEmail(admin.db, DEMO_EMAIL);
  } finally {
    await admin.close();
  }
}

async function main(): Promise<void> {
  loadDotenv(".env");
  const env = process.env;
  const now = env.DEMO_NOW ? new Date(env.DEMO_NOW) : new Date();
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const result = await seedDemo({ now, reset: process.argv.includes("--reset"), databaseUrl: env.DATABASE_URL, adminUrl: env.DATABASE_ADMIN_URL, env });
  console.warn(result.status === "seeded" ? `demo seeded (${JSON.stringify(result.counts)}) for ${DEMO_EMAIL}` : `demo already seeded for ${DEMO_EMAIL}`);
}

if (process.argv[1]?.endsWith("demo-seed.ts")) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
