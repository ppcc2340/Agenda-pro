/**
 * Weekly AI quality review sample (D-103, plan review SEC-H2). Exports discarded or edited proposals of accounts that
 * consented (`preferences.eval_consent`), never mail-derived ones, with every string redacted, to a local JSONL file
 * (0600, in a 0700 folder ignored by git and by Docker) for a person to label. Files older than 30 days are deleted.
 * Each workspace that contributed gets an `ai.review_sampled` audit entry with the count.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isReviewEligible, redactValue } from "@meri/core";
import { ADMIN_WORKSPACE_CONTEXT, createDb, newId } from "@meri/db";

export const SAMPLE_KEEP_DAYS = 30;

export interface SampleRecord {
  sample: string;
  kind: string;
  status: string;
  day: string;
  explanation: unknown;
  proposed: unknown;
  edited: unknown;
}

interface Row {
  workspace_id: string;
  kind: string;
  status: string;
  source_type: string | null;
  payload: unknown;
  resolution: { editedPayload?: unknown } | null;
  explanation: string | null;
  resolved_at: string;
}

export async function exportReviewSample(options: {
  adminUrl: string;
  now: Date;
  outDir: string;
  days?: number;
  limit?: number;
}): Promise<{ file: string | null; records: number; workspaces: number; pruned: number }> {
  const days = options.days ?? 7;
  const limit = Math.min(options.limit ?? 50, 500);
  const since = new Date(options.now.getTime() - days * 86_400_000).toISOString();
  const handle = createDb(options.adminUrl, {
    max: 1,
    connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT },
  });
  try {
    // The SQL already narrows to consenting, non-mail proposals; isReviewEligible() checks each row again.
    const rows = await handle.sql<Row[]>`
      select p.workspace_id, p.kind::text as kind, p.status::text as status, p.source_ref ->> 'type' as source_type,
             p.payload, p.resolution, p.explanation, p.resolved_at::text as resolved_at
      from proposals p
      join workspaces w on w.id = p.workspace_id and w.deleted_at is null
      join preferences pr on pr.workspace_id = p.workspace_id and pr.eval_consent
      where p.status in ('dismissed', 'edited') and p.resolved_at >= ${since}::timestamptz
        and p.kind not in ('followup', 'client_link')
        and coalesce(p.source_ref ->> 'type', '') not in ('thread', 'message', 'gmail', 'mail')
      order by p.resolved_at desc
      limit ${limit}`;
    const eligible = rows.filter((r) =>
      isReviewEligible({ kind: r.kind, status: r.status, sourceType: r.source_type }),
    );
    const workspaces = [...new Set(eligible.map((r) => r.workspace_id))];
    const names = new Map<string, string[]>();
    if (workspaces.length > 0) {
      const people = await handle.sql<{ workspace_id: string; name: string | null }[]>`
        select workspace_id, name from clients where workspace_id in ${handle.sql(workspaces)}
        union all
        select workspace_id, name from contacts where workspace_id in ${handle.sql(workspaces)}`;
      for (const p of people)
        if (p.name) names.set(p.workspace_id, [...(names.get(p.workspace_id) ?? []), p.name]);
    }
    const records: SampleRecord[] = eligible.map((r) => {
      const own = names.get(r.workspace_id) ?? [];
      return {
        sample: randomUUID(),
        kind: r.kind,
        status: r.status,
        day: r.resolved_at.slice(0, 10),
        explanation: r.explanation ? redactValue(r.explanation, own) : null,
        proposed: redactValue(r.payload, own),
        edited: r.resolution?.editedPayload ? redactValue(r.resolution.editedPayload, own) : null,
      };
    });

    mkdirSync(options.outDir, { recursive: true, mode: 0o700 });
    chmodSync(options.outDir, 0o700);
    let file: string | null = null;
    if (records.length > 0) {
      file = join(options.outDir, `${options.now.toISOString().slice(0, 10)}.jsonl`);
      writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
      for (const ws of workspaces) {
        const count = eligible.filter((r) => r.workspace_id === ws).length;
        await handle.sql.begin(async (tx) => {
          await tx`select set_config('app.workspace_id', ${ws}, true)`;
          await tx`insert into audit_log (id, workspace_id, actor, action, entity_type, entity_id, after)
                   values (${newId()}, ${ws}, 'system', 'ai.review_sampled', 'workspace', ${ws},
                           ${JSON.stringify({ count, days })}::jsonb)`;
        });
      }
    }
    // Samples are working material, not an archive.
    let pruned = 0;
    for (const name of readdirSync(options.outDir)) {
      const path = join(options.outDir, name);
      if (
        name.endsWith(".jsonl") &&
        options.now.getTime() - statSync(path).mtimeMs > SAMPLE_KEEP_DAYS * 86_400_000
      ) {
        unlinkSync(path);
        pruned += 1;
      }
    }
    return { file, records: records.length, workspaces: workspaces.length, pruned };
  } finally {
    await handle.close();
  }
}
