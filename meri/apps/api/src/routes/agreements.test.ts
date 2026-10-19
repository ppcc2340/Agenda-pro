import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listCommitments, upsertCalendarEvent, upsertContact, upsertIntegrationAccount, withWorkspace, type AccountIdentity } from "@meri/db";
import { createTestApp, csrf, NOW, type TestApp } from "../test/harness";

interface ProposalJson {
  id: string;
  kind: string;
  sourceRef: { type: string; id: string } | null;
  payload: Record<string, unknown>;
}

describe("POST /v1/events/:id/agreements (D-044, P3-06)", () => {
  let t: TestApp;
  let a: AccountIdentity;
  let cookie: string;
  let eventId = "";
  let acme = "";
  beforeAll(async () => {
    t = await createTestApp();
    a = await t.createAccount("agree-a");
    cookie = await t.cookieFor(a);
    acme = (await t.app.inject({ method: "POST", url: "/v1/clients", headers: { cookie, ...csrf }, payload: { name: "Acme", domains: ["acme.test"] } })).json<{ id: string }>().id;
    await withWorkspace(t.handle.db, a.workspaceId, async (tx) => {
      const account = await upsertIntegrationAccount(tx, a.workspaceId, { provider: "google", externalAccountId: "sub", email: "yo@mifirma.test", scopes: [], encryptedTokens: "x", keyId: "local" }, NOW);
      await upsertContact(tx, a.workspaceId, { email: "ana@acme.test", name: "Ana Ruiz", clientId: acme });
      const ev = await upsertCalendarEvent(
        tx,
        a.workspaceId,
        { integrationAccountId: account.id, externalId: "kickoff", etag: null, title: "Kickoff Acme", startsAt: new Date("2026-10-19T08:00:00Z"), endsAt: new Date("2026-10-19T09:00:00Z"), allDay: false, attendees: ["yo@mifirma.test", "Ana@acme.test"], busy: true, origin: "external", clientId: acme },
        NOW,
      );
      eventId = ev.id;
    });
  });
  afterAll(() => t.close());

  it("turns lines into commitment or capture proposals bound to the event; nothing is confirmed; replays dedupe", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: `/v1/events/${eventId}/agreements`,
      headers: { cookie, ...csrf },
      payload: { lines: ["Enviaré la propuesta de honorarios el viernes", "¿Puedes enviarme el contrato firmado mañana?", "Preparar informe de riesgos 2 h"] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ proposals: ProposalJson[]; skipped: number }>();
    expect(body.skipped).toBe(0);
    expect(body.proposals.map((p) => p.kind)).toEqual(["commitment", "commitment", "capture"]);
    expect(body.proposals.every((p) => p.sourceRef?.type === "event" && p.sourceRef.id === eventId)).toBe(true);
    const [mine, theirs, capture] = body.proposals;
    expect(mine?.payload).toMatchObject({ direction: "owed_by_me", counterpartyEmail: "ana@acme.test", counterpartyName: "Ana Ruiz", clientId: acme, threadId: null, eventId });
    expect(theirs?.payload).toMatchObject({ direction: "owed_to_me", clientId: acme });
    expect(capture?.payload).toMatchObject({ clientId: acme, estimateMinutes: 120 });
    // Nothing confirmed: commitments stay proposed and are not listed by default.
    const listed = await withWorkspace(t.handle.db, a.workspaceId, (tx) => listCommitments(tx, a.workspaceId, {}, { limit: 20 }));
    expect(listed.items).toHaveLength(0);
    // Confirming from Entrada works without a thread (H3) and lands in the radar.
    const confirm = await t.app.inject({ method: "POST", url: `/v1/proposals/${mine?.id ?? ""}/confirm`, headers: { cookie, ...csrf }, payload: {} });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json<{ commitment: { status: string; threadUrl: string | null } }>().commitment).toMatchObject({ status: "confirmed", threadUrl: null });
    // confirm-batch skips non-explicit event commitments; the explicit one (date + promise) is accepted.
    const batch = await t.app.inject({ method: "POST", url: "/v1/proposals/confirm-batch", headers: { cookie, ...csrf }, payload: { ids: [theirs?.id ?? ""] } });
    expect(batch.json<{ skipped: { reason: string }[] }>().skipped[0]?.reason).toBe("low_confidence");
    // Same lines again: deduplicated on the event hash.
    const again = await t.app.inject({ method: "POST", url: `/v1/events/${eventId}/agreements`, headers: { cookie, ...csrf }, payload: { lines: ["Enviaré la propuesta de honorarios el viernes"] } });
    expect(again.json<{ proposals: unknown[]; skipped: number }>()).toMatchObject({ proposals: [], skipped: 1 });
    const other = await t.cookieFor(await t.createAccount("agree-b"));
    expect((await t.app.inject({ method: "POST", url: `/v1/events/${eventId}/agreements`, headers: { cookie: other, ...csrf }, payload: { lines: ["x y z"] } })).statusCode).toBe(404);
  });

  it("requires a client on the meeting, keeps the counterparty null when no attendee is the client's, validates lines", async () => {
    const ids = await withWorkspace(t.handle.db, a.workspaceId, async (tx) => {
      const noClient = await upsertCalendarEvent(tx, a.workspaceId, { integrationAccountId: "01a15596-f037-71e4-bfce-25b2f4a80b88", externalId: "no-client", etag: null, title: "Sin cliente", startsAt: new Date("2026-10-19T10:00:00Z"), endsAt: new Date("2026-10-19T11:00:00Z"), allDay: false, attendees: ["x@otro.test"], busy: true, origin: "external", clientId: null }, NOW);
      const noAttendee = await upsertCalendarEvent(tx, a.workspaceId, { integrationAccountId: "01a15596-f037-71e4-bfce-25b2f4a80b88", externalId: "no-attendee", etag: null, title: "Interna", startsAt: new Date("2026-10-19T12:00:00Z"), endsAt: new Date("2026-10-19T13:00:00Z"), allDay: false, attendees: ["yo@mifirma.test", "x@otro.test"], busy: true, origin: "external", clientId: acme }, NOW);
      return { noClient: noClient.id, noAttendee: noAttendee.id };
    });
    expect((await t.app.inject({ method: "POST", url: `/v1/events/${ids.noClient}/agreements`, headers: { cookie, ...csrf }, payload: { lines: ["Enviaré el informe mañana"] } })).statusCode).toBe(400);
    const res = await t.app.inject({ method: "POST", url: `/v1/events/${ids.noAttendee}/agreements`, headers: { cookie, ...csrf }, payload: { lines: ["Enviaré el informe mañana"] } });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ proposals: ProposalJson[] }>().proposals[0]?.payload).toMatchObject({ counterpartyEmail: null, clientId: acme });
    expect((await t.app.inject({ method: "POST", url: `/v1/events/${ids.noAttendee}/agreements`, headers: { cookie, ...csrf }, payload: { lines: [] } })).statusCode).toBe(400);
    expect((await t.app.inject({ method: "POST", url: `/v1/events/${ids.noAttendee}/agreements`, headers: { cookie, ...csrf }, payload: { lines: ["ab"] } })).statusCode).toBe(400);
  });
});
