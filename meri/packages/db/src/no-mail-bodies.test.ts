import { describe, expect, it } from "vitest";
import { getTableColumns, getTableName } from "drizzle-orm";
import * as schema from "./schema";

/**
 * docs/06 §5 / F-07 AC3: no table stores e-mail bodies. Only ids, metadata and ≤ 200-character evidence snippets.
 * Any column whose name smells like a body on a mail-related table fails this test.
 */
describe("mail minimisation", () => {
  it("no mail-related table has a body/content/html column", () => {
    // Every table that touches e-mail data (docs/03): index, extractions, proposals, people, exclusions.
    const tables = [
      schema.threadsIndex,
      schema.commitments,
      schema.proposals,
      schema.contacts,
      schema.mailExclusions,
    ];
    const offenders: string[] = [];
    for (const table of tables) {
      const name = getTableName(table);
      for (const col of Object.keys(getTableColumns(table))) {
        if (/body|content|html|raw_message|message_text/i.test(col)) offenders.push(`${name}.${col}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(Object.keys(getTableColumns(schema.threadsIndex))).toEqual(
      expect.arrayContaining(["subject", "participants", "lastMessageAt", "processedAt"]),
    );
  });
});
