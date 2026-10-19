import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listCalendarEvents, upsertCalendarEvent, withWorkspace, type AccountIdentity } from "@meri/db";
import type { FakeCalendar } from "@meri/integrations";
import { createTestApp, csrf, NOW, type TestApp } from "../test/harness";

interface BlockJson {
  id: string;
  taskId: string;
  startsAt: string;
  endsAt: string;
  pinned: boolean;
  planVersion: number;
  completedAt: string | null;
  calendarEventId: string | null;
}
interface PlanJson {
  planVersion: number;
  blocks: BlockJson[];
  tasks: { id: string; title: string; status: string }[];
  risks: { taskId: string }[];
  conflicts: { code: string; taskIds: string[]; alternatives: string[] }[];
  pendingProposal: {
    id: string;
    basePlanVersion: number;
    summary: { moved: number; removed: number };
  } | null;
}
interface AuditJson {
  items: { id: string; action: string; undoneAt: string | null; undoOfAuditId: string | null }[];
}

describe("/v1/plan, /v1/audit/:id/undo (F-05, F-13, ADR 0003)", () => {
  let t: TestApp;
  let a: AccountIdentity;
  let cookieA: string;
  let cookieB: string;
  const post = (cookie: string, url: string, payload: Record<string, unknown> = {}) =>
    t.app.inject({ method: "POST", url, headers: { cookie, ...csrf }, payload });
  const getPlan = (cookie: string) => t.app.inject({ url: "/v1/plan", headers: { cookie } });

  beforeAll(async () => {
    t = await createTestApp();
    a = await t.createAccount("plan-a");
    const b = await t.createAccount("plan-b");
    cookieA = await t.cookieFor(a);
    cookieB = await t.cookieFor(b);
    await t.app.inject({
      method: "PUT",
      url: "/v1/preferences",
      headers: { cookie: cookieA, ...csrf },
      payload: { timezone: "Europe/Madrid", completeOnboarding: true },
    });
  });
  afterAll(() => t.close());

  it("replans on demand, applies the additive plan, and GET /v1/plan returns blocks with their tasks", async () => {
    await post(cookieA, "/v1/tasks", { title: "Informe", kind: "deep", estimateMinutes: 90, priority: 1 });
    await post(cookieA, "/v1/tasks", { title: "Llamar a Acme", kind: "shallow", estimateMinutes: 30 });
    // Task changes enqueue a debounced replan through the hook (api main wires it to the dispatcher).
    const replan = await post(cookieA, "/v1/plan/replan");
    expect(replan.statusCode).toBe(200);
    expect(replan.json<{ outcome: string; planVersion: number }>()).toMatchObject({
      outcome: "applied",
      planVersion: 1,
    });

    const plan = getPlan(cookieA);
    const body = (await plan).json<PlanJson>();
    expect(body.planVersion).toBe(1);
    expect(body.blocks.length).toBeGreaterThanOrEqual(2);
    expect(body.tasks.map((x) => x.status).every((s) => s === "scheduled")).toBe(true);
    expect(body.pendingProposal).toBeNull();
    // Tenant isolation: B sees nothing of A.
    const planB = (await getPlan(cookieB)).json<PlanJson>();
    expect(planB.blocks).toEqual([]);
    expect(planB.planVersion).toBe(0);
  });

  it("pins and completes blocks with audit entries, and both are undoable append-only", async () => {
    const plan = (await getPlan(cookieA)).json<PlanJson>();
    const block = plan.blocks[0];
    if (!block) throw new Error("expected a block");
    const pinned = await post(cookieA, `/v1/plan/blocks/${block.id}/pin`, { pinned: true });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json<BlockJson>().pinned).toBe(true);
    // Other tenant cannot touch it.
    expect((await post(cookieB, `/v1/plan/blocks/${block.id}/pin`, { pinned: false })).statusCode).toBe(404);

    const done = await post(cookieA, `/v1/plan/blocks/${block.id}/complete`, { taskDone: true });
    expect(done.statusCode).toBe(200);
    const doneBody = done.json<{ block: BlockJson; task: { status: string } | null }>();
    expect(doneBody.block.completedAt).toBe(NOW.toISOString());
    expect(doneBody.task?.status).toBe("completed");
    expect((await post(cookieA, `/v1/plan/blocks/${block.id}/complete`)).statusCode).toBe(409);

    const audit = (await t.app.inject({ url: "/v1/audit", headers: { cookie: cookieA } })).json<AuditJson>();
    const completed = audit.items.find((e) => e.action === "block.completed");
    const pinEntry = audit.items.find((e) => e.action === "block.pinned");
    if (!completed || !pinEntry) throw new Error("expected audit entries");

    const undo = await post(cookieA, `/v1/audit/${completed.id}/undo`);
    expect(undo.statusCode).toBe(200);
    expect(undo.json<{ action: string }>().action).toBe("block.completed");
    const after = (await getPlan(cookieA)).json<PlanJson>();
    expect(after.blocks.find((b) => b.id === block.id)?.completedAt).toBeNull();
    expect(after.tasks.find((x) => x.id === block.taskId)?.status).not.toBe("completed");
    expect((await post(cookieA, `/v1/audit/${completed.id}/undo`)).statusCode).toBe(409); // already undone
    expect((await post(cookieB, `/v1/audit/${pinEntry.id}/undo`)).statusCode).toBe(404); // isolation

    const undoPin = await post(cookieA, `/v1/audit/${pinEntry.id}/undo`);
    expect(undoPin.statusCode).toBe(200);
    expect((await getPlan(cookieA)).json<PlanJson>().blocks.find((b) => b.id === block.id)?.pinned).toBe(
      false,
    );
    const trail = (await t.app.inject({ url: "/v1/audit", headers: { cookie: cookieA } })).json<AuditJson>();
    expect(trail.items.filter((e) => e.undoOfAuditId !== null).map((e) => e.action)).toEqual([
      "block.pinned.undone",
      "block.completed.undone",
    ]);
    expect(trail.items.find((e) => e.id === completed.id)?.undoneAt).toBeTruthy();
  });

  it("a conflicting meeting yields a reschedule proposal; accept writes Meri events; undo restores and conflicts on stale", async () => {
    // Connect the fake Google account so accepted plans reach the calendar.
    const connect = await post(cookieA, "/v1/integrations/google/connect");
    const stateCookie = connect.cookies.find((c) => c.name === "meri.oauth.state");
    const url = new URL(connect.json<{ url: string }>().url);
    const callback = await t.app.inject({
      url: `${url.pathname}${url.search}`,
      headers: { cookie: `${cookieA}; meri.oauth.state=${stateCookie?.value ?? ""}` },
    });
    expect(callback.statusCode).toBe(302);
    const accounts = (await t.app.inject({ url: "/v1/integrations", headers: { cookie: cookieA } })).json<{
      items: { id: string; email: string | null }[];
    }>();
    const account = accounts.items[0];
    if (!account?.email) throw new Error("expected a connected account");

    const before = (await getPlan(cookieA)).json<PlanJson>();
    const live = before.blocks.find((b) => b.completedAt === null);
    if (!live) throw new Error("expected a live block");
    await withWorkspace(t.handle.db, a.workspaceId, (tx) =>
      upsertCalendarEvent(
        tx,
        a.workspaceId,
        {
          integrationAccountId: account.id,
          externalId: "ext-clash",
          etag: "1",
          title: "Reunión",
          startsAt: new Date(new Date(live.startsAt).getTime() - 60_000),
          endsAt: new Date(new Date(live.startsAt).getTime() + 15 * 60_000),
          allDay: false,
          attendees: ["x@acme.com"],
          busy: true,
          origin: "external",
        },
        NOW,
      ),
    );
    const replan = await post(cookieA, "/v1/plan/replan");
    expect(replan.json<{ outcome: string; proposalId: string | null }>().outcome).toBe("proposed");
    const plan = (await getPlan(cookieA)).json<PlanJson>();
    expect(
      plan.pendingProposal?.summary.moved ?? 0 + (plan.pendingProposal?.summary.removed ?? 0),
    ).toBeGreaterThan(0);
    const proposalId = plan.pendingProposal?.id ?? "";

    expect((await post(cookieB, "/v1/plan/accept", { proposalId })).statusCode).toBe(404);
    const accept = await post(cookieA, "/v1/plan/accept", { proposalId });
    expect(accept.statusCode).toBe(200);
    const accepted = accept.json<{
      planVersion: number;
      added: number;
      calendar: { created: number } | null;
    }>();
    expect(accepted.planVersion).toBe(2);
    expect(accepted.calendar?.created).toBe(accepted.added);
    const cal = t.integrations.calendarFor(account.email) as FakeCalendar;
    const meriEvents = [...cal.events.values()].filter((e) => e.meri && e.status === "confirmed");
    expect(meriEvents).toHaveLength(accepted.added);
    const mirrored = await withWorkspace(t.handle.db, a.workspaceId, (tx) =>
      listCalendarEvents(tx, a.workspaceId, { from: new Date(0), to: new Date("2027-01-01") }),
    );
    expect(mirrored.filter((e) => e.origin === "meri")).toHaveLength(accepted.added);
    expect((await post(cookieA, "/v1/plan/accept", { proposalId })).statusCode).toBe(409);

    const audit = (await t.app.inject({ url: "/v1/audit", headers: { cookie: cookieA } })).json<AuditJson>();
    const entry = audit.items.find((e) => e.action === "plan.accepted");
    if (!entry) throw new Error("expected plan.accepted");
    const undo = await post(cookieA, `/v1/audit/${entry.id}/undo`);
    expect(undo.statusCode).toBe(200);
    expect(undo.json<{ calendar: { deleted: number } | null }>().calendar?.deleted).toBe(accepted.added);
    const restored = (await getPlan(cookieA)).json<PlanJson>();
    expect(restored.blocks.some((b) => b.id === live.id)).toBe(true);
    expect(restored.blocks.every((b) => b.planVersion <= 1)).toBe(true);
    expect([...cal.events.values()].filter((e) => e.meri && e.status === "confirmed")).toHaveLength(0);
  });

  it("exposes grouped notifications per tenant and marks them read", async () => {
    const list = (await t.app.inject({ url: "/v1/notifications", headers: { cookie: cookieA } })).json<{
      items: { id: string; template: string; readAt: string | null; refs: { id: string }[] }[];
    }>();
    const proposed = list.items.find((n) => n.template === "plan.proposed");
    expect(proposed).toBeDefined();
    expect(proposed?.refs[0]?.id).toBeTruthy();
    expect(
      (await t.app.inject({ url: "/v1/notifications", headers: { cookie: cookieB } })).json<{
        items: unknown[];
      }>().items,
    ).toEqual([]);
    expect((await post(cookieB, `/v1/notifications/${proposed?.id ?? ""}/read`)).statusCode).toBe(404);
    const read = await post(cookieA, `/v1/notifications/${proposed?.id ?? ""}/read`);
    expect(read.statusCode).toBe(200);
    expect(read.json<{ readAt: string | null }>().readAt).toBe(NOW.toISOString());
  });

  it("rejects unauthenticated and CSRF-less calls", async () => {
    expect((await t.app.inject({ url: "/v1/plan" })).statusCode).toBe(401);
    const noCsrf = await t.app.inject({
      method: "POST",
      url: "/v1/plan/replan",
      headers: { cookie: cookieA },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});
