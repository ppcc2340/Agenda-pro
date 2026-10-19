import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type DbHandle } from "./client";
import { TEST_APP_URL } from "./test/urls";

/**
 * Guard against a future tenant table shipped without RLS (every table with workspace_id must be FORCE RLS with
 * the ws_isolation policy). Tables with a nullable workspace_id (feature_flags) are global and excluded.
 */
describe("RLS coverage", () => {
  let handle: DbHandle;
  beforeAll(() => {
    handle = createDb(TEST_APP_URL, { max: 1 });
  });
  afterAll(() => handle.close());

  it("every table with a NOT NULL workspace_id has forced RLS and the ws_isolation policy", async () => {
    const rows = await handle.sql<{ table_name: string; forced: boolean; has_policy: boolean }[]>`
      select c.table_name,
             coalesce(cl.relforcerowsecurity, false) as forced,
             exists (select 1 from pg_policies p where p.tablename = c.table_name and p.policyname = 'ws_isolation') as has_policy
      from information_schema.columns c
      join pg_class cl on cl.relname = c.table_name and cl.relnamespace = 'public'::regnamespace
      where c.table_schema = 'public' and c.column_name = 'workspace_id' and c.is_nullable = 'NO'
      order by c.table_name`;
    expect(rows.length).toBeGreaterThanOrEqual(20);
    const unprotected = rows.filter((r) => !r.forced || !r.has_policy).map((r) => r.table_name);
    expect(unprotected).toEqual([]);
  });
});
