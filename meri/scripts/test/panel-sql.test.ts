import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ADMIN_WORKSPACE_CONTEXT, createDb } from "@meri/db";
import { describe, expect, it } from "vitest";

const TEST_ADMIN_URL = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";
const PANEL = fileURLToPath(new URL("../../docs/analytics/panel.sql", import.meta.url));

/** Splits panel.sql into its named queries ("-- name: <key>"). */
function queries(text: string): { name: string; sql: string }[] {
  return text
    .split(/^-- name: /m)
    .slice(1)
    .map((chunk) => {
      const [name = "", ...rest] = chunk.split("\n");
      return { name: name.trim(), sql: rest.join("\n").trim() };
    });
}

describe("docs/analytics/panel.sql (D-065)", () => {
  const all = queries(readFileSync(PANEL, "utf8"));

  it("covers the decision indicators of docs/09", () => {
    expect(all.map((q) => q.name)).toEqual(
      expect.arrayContaining(["activation", "retention", "proposal_quality", "trial_conversion", "gross_margin", "gmail_kept_30d"]),
    );
  });

  it("every query runs read-only against the current schema with the admin read context", async () => {
    const handle = createDb(TEST_ADMIN_URL, { max: 1, connection: { "app.workspace_id": ADMIN_WORKSPACE_CONTEXT } });
    try {
      for (const q of all)
        await handle.sql.begin("read only", async (tx) => {
          await tx.unsafe(q.sql);
        });
    } finally {
      await handle.close();
    }
  });
});
