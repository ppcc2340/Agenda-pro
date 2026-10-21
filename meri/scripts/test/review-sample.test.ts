import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_WORKSPACE_CONTEXT, bootstrapAccount, createDb, newId } from "@meri/db";
import { afterAll, describe, expect, it } from "vitest";
import { exportReviewSample } from "../lib/review-sample";

const APP = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const ADMIN = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";

describe("pnpm ai:review-sample (D-103, SEC-H2)", () => {
  const app = createDb(APP, { max: 1 });
  const owner = createDb(ADMIN, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
  afterAll(async () => {
    await app.close();
    await owner.close();
  });
  const inWs = (ws: string, fn: (tx: typeof owner.sql) => Promise<unknown>) =>
    owner.sql.begin(async (tx) => {
      await tx`select set_config('app.workspace_id', ${ws}, true)`;
      await fn(tx as unknown as typeof owner.sql);
    });
  const proposal = (
    tx: typeof owner.sql,
    ws: string,
    kind: string,
    status: string,
    source: string | null,
    text: string,
  ) =>
    tx`insert into proposals (id, workspace_id, kind, status, payload, source_ref, resolved_at)
       values (${newId()}, ${ws}, ${kind}, ${status}, ${JSON.stringify({ title: text, eventId: "ev-1" })}::jsonb,
               ${source ? JSON.stringify({ type: source, id: "x" }) : null}::jsonb, now() - interval '1 day')`;

  it("exports only consenting, non-mail, discarded or edited proposals, redacted, 0600, audited; prunes old files", async () => {
    const now = new Date();
    const a = await bootstrapAccount(app.db, { email: `rs-a-${newId()}@test.local`, now });
    const b = await bootstrapAccount(app.db, { email: `rs-b-${newId()}@test.local`, now });
    const marker = `zq${newId().slice(-6)}`;
    await inWs(a.workspaceId, async (tx) => {
      await tx`update preferences set eval_consent = true where workspace_id = ${a.workspaceId}`;
      await tx`insert into clients (id, workspace_id, name, domains) values (${newId()}, ${a.workspaceId}, 'Estudio Norte', '{}')`;
      await proposal(
        tx,
        a.workspaceId,
        "capture",
        "dismissed",
        null,
        `Enviar a Estudio Norte ${marker} info@norte.cl`,
      );
      await proposal(tx, a.workspaceId, "commitment", "dismissed", "thread", `${marker} from mail`);
      await proposal(tx, a.workspaceId, "followup", "dismissed", null, `${marker} follow-up`);
      await proposal(tx, a.workspaceId, "capture", "confirmed", null, `${marker} confirmed`);
    });
    await inWs(b.workspaceId, (tx) =>
      proposal(tx, b.workspaceId, "capture", "dismissed", null, `${marker} no consent`),
    );

    const outDir = mkdtempSync(join(tmpdir(), "meri-candidates-"));
    const stale = join(outDir, "2020-01-01.jsonl");
    writeFileSync(stale, "{}\n");
    utimesSync(stale, new Date("2020-01-01"), new Date("2020-01-01"));
    const r = await exportReviewSample({ adminUrl: ADMIN, now, outDir, days: 7, limit: 500 });
    expect(r.file).not.toBeNull();
    expect(r.pruned).toBe(1);
    expect(existsSync(stale)).toBe(false);
    const lines = readFileSync(r.file ?? "", "utf8")
      .trim()
      .split("\n")
      .filter((l) => l.includes(marker));
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0] ?? "{}") as {
      proposed: { title: string; eventId?: string };
      kind: string;
    };
    expect(rec.kind).toBe("capture");
    expect(rec.proposed.title).toBe(`Enviar a [nombre] ${marker} [correo]`);
    expect(rec.proposed.eventId).toBeUndefined();
    expect(readFileSync(r.file ?? "", "utf8")).not.toContain(a.workspaceId);
    expect(statSync(r.file ?? "").mode & 0o777).toBe(0o600);
    expect(statSync(outDir).mode & 0o777).toBe(0o700);
    const audited = await owner.sql<{ after: { count: number } }[]>`
      select after from audit_log where workspace_id = ${a.workspaceId} and action = 'ai.review_sampled'`;
    expect(audited[0]?.after.count).toBeGreaterThanOrEqual(1);
    const notAudited =
      await owner.sql`select 1 from audit_log where workspace_id = ${b.workspaceId} and action = 'ai.review_sampled'`;
    expect(notAudited.length).toBe(0);
  });
});
