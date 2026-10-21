/**
 * Static checks for SQL migrations (phase 6, D-098, review items CR-11 and SEC-M7). A migration runs before the new
 * code is live and while the old code still serves traffic, so it must be backwards compatible; and it runs as the
 * database owner, so it can silently weaken tenant isolation or the audit trail. Both kinds of statement are
 * refused unless the file carries `-- meri:destructive-approved <reason>` (a reviewed exception, CODEOWNERS).
 */

export interface MigrationFinding {
  kind: "destructive" | "security";
  rule: string;
  statement: string;
}

export interface MigrationReport {
  findings: MigrationFinding[];
  /** Reason given by the approval marker, if any (at least 10 characters). */
  approval: string | null;
}

export const APPROVAL_MARKER = "meri:destructive-approved";
const MIN_REASON = 10;

/**
 * Splits SQL into top-level statements without comments. Quoted strings, quoted identifiers and dollar-quoted
 * bodies (`DO $$ … $$`, functions) are kept intact, so a `;` or `--` inside them neither splits nor hides anything.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const push = () => {
    const text = current.replace(/\s+/g, " ").trim();
    if (text) statements.push(text);
    current = "";
  };
  while (i < sql.length) {
    const ch = sql[i] ?? "";
    const next = sql[i + 1] ?? "";
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      current += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      current += " ";
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch && sql[j + 1] === ch) j += 2;
        else if (sql[j] === ch) break;
        else j += 1;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ";") {
      push();
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  push();
  return statements;
}

interface Rule {
  kind: MigrationFinding["kind"];
  rule: string;
  test: (statement: string, all: string[]) => boolean;
}

const has = (re: RegExp) => (s: string) => re.test(s);

const RULES: Rule[] = [
  { kind: "destructive", rule: "DROP TABLE", test: has(/\bDROP\s+TABLE\b/i) },
  { kind: "destructive", rule: "DROP COLUMN", test: has(/\bDROP\s+COLUMN\b/i) },
  { kind: "destructive", rule: "TRUNCATE", test: has(/\bTRUNCATE\b/i) },
  {
    kind: "destructive",
    rule: "ALTER COLUMN … TYPE",
    test: has(/\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i),
  },
  { kind: "destructive", rule: "RENAME", test: has(/\bALTER\s+TABLE\b[\s\S]*\bRENAME\b/i) },
  {
    kind: "destructive",
    rule: "DROP CONSTRAINT without replacement",
    test: (s, all) => {
      const name = /\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?("?[\w]+"?)/i.exec(s)?.[1];
      if (!name) return false;
      const bare = name.replace(/"/g, "").toLowerCase();
      return !all.some((o) => new RegExp(`\\bADD\\s+CONSTRAINT\\s+"?${bare}"?(\\s|$)`, "i").test(o));
    },
  },
  {
    kind: "destructive",
    rule: "DROP INDEX without replacement",
    test: (s, all) => {
      const name = /\bDROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?("?[\w.]+"?)/i.exec(s)?.[1];
      if (!name) return false;
      const bare = name.replace(/"/g, "").split(".").pop()?.toLowerCase() ?? "";
      // The old code's upserts target the index: dropping it without recreating it breaks them mid-deploy.
      return !all.some((o) =>
        new RegExp(
          `\\bCREATE\\s+(UNIQUE\\s+)?INDEX\\s+(CONCURRENTLY\\s+)?(IF\\s+NOT\\s+EXISTS\\s+)?"?${bare}"?(\\s|$)`,
          "i",
        ).test(o),
      );
    },
  },
  {
    kind: "destructive",
    rule: "DROP SCHEMA/FUNCTION/TYPE/VIEW/SEQUENCE",
    test: has(/\bDROP\s+(SCHEMA|FUNCTION|TYPE|VIEW|MATERIALIZED\s+VIEW|SEQUENCE)\b/i),
  },
  {
    kind: "destructive",
    rule: "CASCADE",
    // DROP … CASCADE or TRUNCATE … CASCADE; a foreign key's ON DELETE CASCADE is a normal definition.
    test: has(/\b(DROP|TRUNCATE)\b[\s\S]*\bCASCADE\b/i),
  },
  { kind: "destructive", rule: "SET NOT NULL", test: has(/\bSET\s+NOT\s+NULL\b/i) },
  {
    kind: "destructive",
    rule: "ADD COLUMN NOT NULL without DEFAULT",
    test: (s) => /\bADD\s+COLUMN\b[^,;]*\bNOT\s+NULL\b/i.test(s) && !/\bDEFAULT\b/i.test(s),
  },
  {
    kind: "security",
    rule: "DISABLE ROW LEVEL SECURITY",
    test: has(/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i),
  },
  { kind: "security", rule: "CREATE/ALTER POLICY", test: has(/\b(CREATE|ALTER)\s+POLICY\b/i) },
  { kind: "security", rule: "DISABLE TRIGGER", test: has(/\bDISABLE\s+TRIGGER\b/i) },
  { kind: "security", rule: "ALTER ROLE", test: has(/\bALTER\s+(ROLE|USER)\b/i) },
  { kind: "security", rule: "GRANT … TO PUBLIC", test: has(/\bGRANT\b[\s\S]*\bTO\s+PUBLIC\b/i) },
  {
    kind: "security",
    rule: "replaces an audit_log function",
    test: has(/\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\s+"?audit_log/i),
  },
  { kind: "security", rule: "dynamic SQL (EXECUTE in DO)", test: has(/^\s*DO\b[\s\S]*\bEXECUTE\b/i) },
  {
    kind: "security",
    rule: "NO FORCE ROW LEVEL SECURITY",
    test: has(/\bNO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\b/i),
  },
  { kind: "security", rule: "DROP POLICY", test: has(/\bDROP\s+POLICY\b/i) },
  {
    kind: "security",
    rule: "DROP TRIGGER audit_log_*",
    test: has(/\bDROP\s+TRIGGER\s+(IF\s+EXISTS\s+)?"?audit_log/i),
  },
  { kind: "security", rule: "GRANT … meri_app", test: has(/\bGRANT\b[\s\S]*\bTO\s+"?meri_app\b/i) },
  { kind: "security", rule: "SECURITY DEFINER", test: has(/\bSECURITY\s+DEFINER\b/i) },
  {
    kind: "security",
    rule: "DELETE/UPDATE without WHERE",
    test: (s) =>
      // Top-level statements and CTEs (`WITH d AS (DELETE FROM t RETURNING 1) …`). A DO block or function body is
      // one statement and is judged by the rules above.
      !/^\s*(DO|CREATE)\b/i.test(s) &&
      /\b(DELETE\s+FROM|UPDATE\s+\S+\s+SET)\b/i.test(s) &&
      !/\bWHERE\b/i.test(s),
  },
];

/** Analyzes one migration file. */
export function checkMigration(sql: string): MigrationReport {
  // Only a comment line of its own approves: never text inside a string or a function body.
  const marker = new RegExp(`^[ \\t]*--[ \\t]*${APPROVAL_MARKER}[ \\t]+(.+)$`, "m").exec(sql);
  const reason = marker?.[1]?.trim() ?? "";
  const statements = splitStatements(sql.replace(/-->\s*statement-breakpoint/g, ";"));
  const findings: MigrationFinding[] = [];
  for (const statement of statements)
    for (const rule of RULES)
      if (rule.test(statement, statements))
        findings.push({ kind: rule.kind, rule: rule.rule, statement: statement.slice(0, 160) });
  return { findings, approval: reason.length >= MIN_REASON ? reason : null };
}

/** Migration number from its file name (`0021_calendar_ids.sql` → 21), or null. */
export const migrationNumber = (file: string): number | null => {
  const m = /^(\d{4})_.*\.sql$/.exec(file);
  return m?.[1] ? Number(m[1]) : null;
};

/** Migrations before this one were reviewed by hand before the check existed (baseline). */
export const BASELINE = 21;
