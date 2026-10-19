import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccountIdentity } from "@meri/db";
import { createTestApp, csrf, type TestApp } from "../test/harness";

interface ProposalJson {
  id: string;
  status: string;
  confidence: number | null;
  payload: {
    title: string;
    dueAt: string | null;
    estimateMinutes: number | null;
    clientId: string | null;
    source: string;
  };
}

describe("capture and proposals (F-02)", () => {
  let t: TestApp;
  let a: AccountIdentity;
  let cookieA: string;
  let cookieB: string;
  const capture = (cookie: string, text: string, headers: Record<string, string> = {}) =>
    t.app.inject({
      method: "POST",
      url: "/v1/capture",
      headers: { cookie, ...csrf, ...headers },
      payload: { text },
    });

  beforeAll(async () => {
    t = await createTestApp();
    a = await t.createAccount("cap-a");
    const b = await t.createAccount("cap-b");
    cookieA = await t.cookieFor(a);
    cookieB = await t.cookieFor(b);
  });
  afterAll(() => t.close());

  it("creates a capture proposal with suggested fields in well under a second", async () => {
    const started = Date.now();
    const res = await capture(cookieA, "Informe trimestral el jueves, 2 h");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.statusCode).toBe(201);
    const p = res.json<ProposalJson>();
    expect(p.status).toBe("pending");
    expect(p.payload).toMatchObject({ title: "Informe trimestral", estimateMinutes: 120, source: "rules" });
    expect(p.payload.dueAt).toBe("2026-10-22T18:00:00.000Z"); // UTC workspace, 18:00 default hour
    const list = await t.app.inject({ url: "/v1/proposals", headers: { cookie: cookieA } });
    expect(list.json<{ items: ProposalJson[] }>().items.map((i) => i.id)).toContain(p.id);
  });

  it("confirms with edits into a task, refuses double resolution and records dismissals as feedback", async () => {
    const p = (await capture(cookieA, "Llamar a Marta mañana")).json<ProposalJson>();
    const confirm = await t.app.inject({
      method: "POST",
      url: `/v1/proposals/${p.id}/confirm`,
      headers: { cookie: cookieA, ...csrf },
      payload: { edits: { priority: 1 } },
    });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json<{ task: { title: string; priority: number; origin: string } }>().task).toMatchObject({
      title: "Llamar a Marta",
      priority: 1,
      origin: "ai_confirmed",
    });
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `/v1/proposals/${p.id}/confirm`,
          headers: { cookie: cookieA, ...csrf },
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    const q = (await capture(cookieA, "Algo que no quiero")).json<ProposalJson>();
    const dismiss = await t.app.inject({
      method: "POST",
      url: `/v1/proposals/${q.id}/dismiss`,
      headers: { cookie: cookieA, ...csrf },
      payload: { reason: "not a task" },
    });
    expect(dismiss.json<ProposalJson>().status).toBe("dismissed");
    const audit = await t.app.inject({ url: "/v1/audit?limit=20", headers: { cookie: cookieA } });
    expect(audit.json<{ items: { action: string }[] }>().items.map((i) => i.action)).toEqual(
      expect.arrayContaining(["capture.created", "proposal.edited", "task.created", "proposal.dismissed"]),
    );
  });

  it("confirms a batch only for high-confidence proposals", async () => {
    const high = (
      await capture(cookieA, "Enviar propuesta a Acme el viernes 1 h urgente")
    ).json<ProposalJson>();
    const low = (await capture(cookieA, "Pensar")).json<ProposalJson>();
    const res = await t.app.inject({
      method: "POST",
      url: "/v1/proposals/confirm-batch",
      headers: { cookie: cookieA, ...csrf },
      payload: { ids: [high.id, low.id] },
    });
    expect(res.json()).toEqual({ confirmed: [high.id], skipped: [{ id: low.id, reason: "low_confidence" }] });
  });

  it("honours Idempotency-Key: replay returns the same proposal, reuse with another body conflicts", async () => {
    const key = `cap-${Date.now().toString(36)}`;
    const first = await capture(cookieA, "Revisar contrato", { "idempotency-key": key });
    const replay = await capture(cookieA, "Revisar contrato", { "idempotency-key": key });
    expect(replay.statusCode).toBe(201);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(replay.json<ProposalJson>().id).toBe(first.json<ProposalJson>().id);
    const other = await capture(cookieA, "Otra cosa", { "idempotency-key": key });
    expect(other.statusCode).toBe(409);
    // The key is scoped to the workspace: B can use the same key.
    expect((await capture(cookieB, "Revisar contrato", { "idempotency-key": key })).statusCode).toBe(201);
  });

  it("isolates tenants: B cannot confirm or dismiss A's proposals", async () => {
    const p = (await capture(cookieA, "Solo A")).json<ProposalJson>();
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `/v1/proposals/${p.id}/confirm`,
          headers: { cookie: cookieB, ...csrf },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await t.app.inject({
          method: "POST",
          url: `/v1/proposals/${p.id}/dismiss`,
          headers: { cookie: cookieB, ...csrf },
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await t.app.inject({ url: "/v1/proposals", headers: { cookie: cookieB } }))
        .json<{ items: ProposalJson[] }>()
        .items.some((i) => i.id === p.id),
    ).toBe(false);
  });
});
