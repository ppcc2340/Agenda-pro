import {
  addMailExclusion,
  createCommitment,
  createProposal,
  insertBlocks,
  insertInferredEntries,
  insertNotification,
  listAudit,
  listTimeEntries,
  upsertCalendarEvent,
  upsertContact,
  withWorkspace,
  type AccountIdentity,
} from "@meri/db";
import { csrf, NOW, type TestApp } from "./harness";

/** One resource of every kind a route can address by id, all in one workspace (P5-06 authorization matrix). */
export interface Fixtures {
  account: AccountIdentity;
  cookie: string;
  task: string;
  /** A second task of the same workspace (dependency cases need two). */
  otherTask: string;
  client: string;
  project: string;
  commitment: string;
  proposal: string;
  timeEntry: string;
  notification: string;
  block: string;
  audit: string;
  integration: string;
  event: string;
  contact: string;
  exclusion: string;
  /** Distinctive strings of this workspace that must never appear in another workspace's responses. */
  secrets: string[];
}

/** A fixture that silently fell back to "" would turn `/v1/x/:id` into `/v1/x/` (404) and pass without testing. */
function must(id: string | undefined, name: string): string {
  if (!id) throw new Error(`authz fixture "${name}" was not created`);
  return id;
}

export async function makeFixtures(t: TestApp, label: string): Promise<Fixtures> {
  const account = await t.createAccount(label);
  const cookie = await t.cookieFor(account);
  const ws = account.workspaceId;
  const tag = `${label}-${Date.now().toString(36)}`;
  const post = async (url: string, payload: Record<string, unknown>) => {
    const res = await t.app.inject({ method: "POST", url, headers: { cookie, ...csrf }, payload });
    if (res.statusCode >= 300) throw new Error(`${url} → ${String(res.statusCode)} ${res.body}`);
    return res.json<{ id: string }>();
  };
  const client = await post("/v1/clients", { name: `Cliente ${tag}`, domains: [`${tag}.example`] });
  const project = await post("/v1/projects", { clientId: client.id, name: `Asunto ${tag}` });
  const task = await post("/v1/tasks", {
    title: `Tarea secreta ${tag}`,
    clientId: client.id,
    estimateMinutes: 60,
  });
  const otherTask = await post("/v1/tasks", { title: `Otra tarea ${tag}`, estimateMinutes: 30 });
  // Google connection through the real OAuth flow (state + PKCE).
  const start = await t.app.inject({
    method: "POST",
    // Calendar and Gmail, so the mail routes are exercised for real (not refused for lack of scopes).
    url: "/v1/integrations/google/connect?feature=all",
    headers: { cookie, ...csrf },
  });
  const state = start.cookies.find((c) => c.name === "meri.oauth.state")?.value ?? "";
  const url = new URL(start.json<{ url: string }>().url);
  await t.app.inject({
    url: `${url.pathname}${url.search}`,
    headers: { cookie: `${cookie}; meri.oauth.state=${state}` },
  });
  const integration = (await t.app.inject({ url: "/v1/integrations", headers: { cookie } })).json<{
    items: { id: string }[];
  }>().items[0]?.id;
  if (!integration) throw new Error("no integration");
  const rest = await withWorkspace(t.handle.db, ws, async (tx) => {
    const commitment = await createCommitment(
      tx,
      ws,
      {
        clientId: client.id,
        direction: "owed_to_me",
        kind: "explicit",
        status: "confirmed",
        counterpartyEmail: `ana@${tag}.example`,
        action: `Enviar contrato ${tag}`,
        dueAt: NOW,
        dueText: null,
        confidence: 0.9,
        evidence: null,
        threadId: null,
        externalMessageId: null,
        dedupeHash: `authz:${tag}`,
      },
      NOW,
    );
    if (!commitment) throw new Error("commitment not created");
    const proposal = await createProposal(
      tx,
      ws,
      {
        kind: "capture",
        // A complete capture payload, as the capture route writes it (a partial one would make confirm fail for
        // everyone and the denial would prove nothing).
        payload: {
          text: `Propuesta ${tag}`,
          title: `Propuesta ${tag}`,
          clientId: null,
          clientName: null,
          dueAt: null,
          dueText: null,
          estimateMinutes: 30,
          priority: 3,
          kind: "shallow",
          deadlineType: null,
          source: "rules",
        },
      },
      NOW,
    );
    const start = new Date(NOW.getTime() - 86_400_000);
    const event = await upsertCalendarEvent(
      tx,
      ws,
      {
        integrationAccountId: integration,
        externalId: `ev-${tag}`,
        etag: "1",
        title: `Reunión ${tag}`,
        startsAt: start,
        endsAt: new Date(start.getTime() + 3_600_000),
        allDay: false,
        attendees: [`ana@${tag}.example`],
        busy: true,
        origin: "external",
        clientId: client.id,
      },
      NOW,
    );
    await insertInferredEntries(
      tx,
      ws,
      [
        {
          sourceType: "calendar_event",
          sourceId: event.id,
          clientId: client.id,
          taskId: null,
          day: start.toISOString().slice(0, 10),
          minutes: 60,
          description: `Reunión ${tag}`,
        },
      ],
      NOW,
    );
    const entries = await listTimeEntries(tx, ws, { from: "2026-10-01", to: "2026-11-01" });
    const [block] = await insertBlocks(
      tx,
      ws,
      [
        {
          taskId: task.id,
          startsAt: new Date(NOW.getTime() + 3_600_000),
          endsAt: new Date(NOW.getTime() + 7_200_000),
          reason: [],
        },
      ],
      1,
      NOW,
    );
    const notification = await insertNotification(
      tx,
      ws,
      {
        kind: "risk",
        title: "Aviso",
        body: "Aviso",
        template: "risk.grouped",
        params: { count: 1 },
        refs: [],
        day: "2026-10-19",
      },
      NOW,
    );
    const contact = await upsertContact(tx, ws, { email: `ana@${tag}.example`, clientId: client.id });
    const exclusion = await addMailExclusion(tx, ws, { kind: "domain", value: `${tag}-spam.example` });
    // An undoable entry (task.created), so the owner's own undo succeeds.
    const audit = (await listAudit(tx, ws, 50)).items.find((e) => e.action === "task.created");
    return {
      commitment: commitment.id,
      proposal: proposal.id,
      event: event.id,
      timeEntry: must(entries[0]?.id, "timeEntry"),
      block: must(block?.id, "block"),
      notification: notification.id,
      contact: contact.id,
      exclusion: exclusion.id,
      audit: must(audit?.id, "audit"),
    };
  });
  return {
    account,
    cookie,
    task: task.id,
    otherTask: otherTask.id,
    client: client.id,
    project: project.id,
    integration,
    ...rest,
    secrets: [
      ws,
      client.id,
      task.id,
      `Tarea secreta ${tag}`,
      `Cliente ${tag}`,
      `Enviar contrato ${tag}`,
      `ana@${tag}.example`,
    ],
  };
}
