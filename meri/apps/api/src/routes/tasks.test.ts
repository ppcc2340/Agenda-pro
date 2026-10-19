import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AccountIdentity } from "@meri/db";
import { createTestApp, csrf, type TestApp } from "../test/harness";

interface TaskJson {
  id: string;
  title: string;
  status: string;
  blockedBy: string[];
  dueAt: string | null;
  completedAt: string | null;
}

describe("/v1/tasks (F-03)", () => {
  let t: TestApp;
  let a: AccountIdentity;
  let cookieA: string;
  let cookieB: string;
  const post = (cookie: string, payload: Record<string, unknown>) =>
    t.app.inject({ method: "POST", url: "/v1/tasks", headers: { cookie, ...csrf }, payload });

  beforeAll(async () => {
    t = await createTestApp();
    a = await t.createAccount("tasks-a");
    const b = await t.createAccount("tasks-b");
    cookieA = await t.cookieFor(a);
    cookieB = await t.cookieFor(b);
  });
  afterAll(() => t.close());

  it("creates, lists with filters and cursor, updates and completes tasks with audit entries", async () => {
    const created = await post(cookieA, {
      title: "  Informe trimestral  ",
      kind: "deep",
      priority: 1,
      dueAt: "2026-10-22T16:00:00Z",
      estimateMinutes: 240,
      tags: ["acme"],
    });
    expect(created.statusCode).toBe(201);
    const task = created.json<TaskJson>();
    expect(task.title).toBe("Informe trimestral");
    expect(task.dueAt).toBe("2026-10-22T16:00:00.000Z");
    await post(cookieA, { title: "Revisar factura" });
    await post(cookieA, { title: "Llamada", dueAt: "2026-10-20T10:00:00Z" });

    const page1 = await t.app.inject({ url: "/v1/tasks?limit=2", headers: { cookie: cookieA } });
    const body1 = page1.json<{ items: TaskJson[]; nextCursor: string | null }>();
    expect(body1.items).toHaveLength(2);
    expect(body1.nextCursor).toBeTruthy();
    const page2 = await t.app.inject({
      url: `/v1/tasks?limit=2&cursor=${body1.nextCursor ?? ""}`,
      headers: { cookie: cookieA },
    });
    expect(page2.json<{ items: TaskJson[] }>().items).toHaveLength(1);
    const due = await t.app.inject({
      url: "/v1/tasks?dueBefore=2026-10-21T00:00:00Z",
      headers: { cookie: cookieA },
    });
    expect(due.json<{ items: TaskJson[] }>().items.map((i) => i.title)).toEqual(["Llamada"]);

    const invalid = await post(cookieA, { title: "", priority: 9 });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "VALIDATION_FAILED" });

    const done = await t.app.inject({
      method: "PATCH",
      url: `/v1/tasks/${task.id}`,
      headers: { cookie: cookieA, ...csrf },
      payload: { status: "completed" },
    });
    expect(done.statusCode).toBe(200);
    expect(done.json<TaskJson>().completedAt).toBe("2026-10-19T10:40:00.000Z");
    const listDefault = await t.app.inject({ url: "/v1/tasks", headers: { cookie: cookieA } });
    expect(listDefault.json<{ items: TaskJson[] }>().items.some((i) => i.id === task.id)).toBe(false);
    const listAll = await t.app.inject({
      url: "/v1/tasks?includeCompleted=true",
      headers: { cookie: cookieA },
    });
    expect(listAll.json<{ items: TaskJson[] }>().items.some((i) => i.id === task.id)).toBe(true);

    const audit = await t.app.inject({ url: "/v1/audit?limit=10", headers: { cookie: cookieA } });
    expect(audit.json<{ items: { action: string }[] }>().items.map((i) => i.action)).toEqual(
      expect.arrayContaining(["task.created", "task.completed"]),
    );
  });

  it("validates dependencies: unknown ids, cycles and self-reference", async () => {
    const x = (await post(cookieA, { title: "X" })).json<TaskJson>();
    const y = (await post(cookieA, { title: "Y" })).json<TaskJson>();
    const z = (await post(cookieA, { title: "Z" })).json<TaskJson>();
    const dep = (id: string, blockedBy: string[]) =>
      t.app.inject({
        method: "PUT",
        url: `/v1/tasks/${id}/dependencies`,
        headers: { cookie: cookieA, ...csrf },
        payload: { blockedBy },
      });
    expect((await dep(x.id, [y.id])).json<TaskJson>().blockedBy).toEqual([y.id]);
    expect((await dep(y.id, [z.id])).statusCode).toBe(200);
    const cycle = await dep(z.id, [x.id]);
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json()).toMatchObject({ code: "CONFLICT" });
    expect((await dep(z.id, [z.id])).statusCode).toBe(409);
    expect((await dep(z.id, ["0192aaaa-0000-7000-8000-00000000dead"])).statusCode).toBe(400);
    expect(
      (await t.app.inject({ url: `/v1/tasks/${x.id}`, headers: { cookie: cookieA } })).json<TaskJson>()
        .blockedBy,
    ).toEqual([y.id]);
    // Deleting a dependency removes the edge from dependants.
    expect(
      (
        await t.app.inject({
          method: "DELETE",
          url: `/v1/tasks/${y.id}`,
          headers: { cookie: cookieA, ...csrf },
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await t.app.inject({ url: `/v1/tasks/${x.id}`, headers: { cookie: cookieA } })).json<TaskJson>()
        .blockedBy,
    ).toEqual([]);
  });

  it("isolates tenants: B cannot see, edit or delete A's tasks", async () => {
    const mine = (await post(cookieA, { title: "Solo A" })).json<TaskJson>();
    expect(
      (await t.app.inject({ url: `/v1/tasks/${mine.id}`, headers: { cookie: cookieB } })).statusCode,
    ).toBe(404);
    expect(
      (
        await t.app.inject({
          method: "PATCH",
          url: `/v1/tasks/${mine.id}`,
          headers: { cookie: cookieB, ...csrf },
          payload: { title: "hijack" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await t.app.inject({
          method: "DELETE",
          url: `/v1/tasks/${mine.id}`,
          headers: { cookie: cookieB, ...csrf },
        })
      ).statusCode,
    ).toBe(404);
    const listB = await t.app.inject({ url: "/v1/tasks", headers: { cookie: cookieB } });
    expect(listB.json<{ items: TaskJson[] }>().items.some((i) => i.id === mine.id)).toBe(false);
    expect(
      (await t.app.inject({ url: `/v1/tasks/${mine.id}`, headers: { cookie: cookieA } })).json<TaskJson>()
        .title,
    ).toBe("Solo A");
  });
});
