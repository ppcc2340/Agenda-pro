import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BASELINE, checkMigration, migrationNumber, splitStatements } from "../lib/migration-check";

const rules = (sql: string) => checkMigration(sql).findings.map((f) => f.rule);

describe("migration check (D-098, CR-11, SEC-M7)", () => {
  it("splits statements, ignoring comments and keeping quoted and dollar-quoted bodies whole", () => {
    expect(
      splitStatements(`-- DROP TABLE x;\nCREATE TABLE a (b text default ';');/* TRUNCATE y; */
      DO $$ BEGIN EXECUTE 'DROP POLICY p ON t'; END $$;SELECT "we;ird" FROM t`),
    ).toEqual([
      "CREATE TABLE a (b text default ';')",
      "DO $$ BEGIN EXECUTE 'DROP POLICY p ON t'; END $$",
      'SELECT "we;ird" FROM t',
    ]);
  });

  it("allows additive, backwards-compatible changes", () => {
    expect(
      rules(`ALTER TABLE "t" ADD COLUMN "c" text;--> statement-breakpoint
CREATE INDEX "i" ON "t" ("c");--> statement-breakpoint
UPDATE "t" SET "c" = 'x' WHERE "c" IS NULL;--> statement-breakpoint
DROP INDEX "old_i";--> statement-breakpoint
CREATE INDEX "old_i" ON "t" ("c", "d");--> statement-breakpoint
ALTER TABLE "t" DROP CONSTRAINT "t_fk";--> statement-breakpoint
ALTER TABLE "t" ADD CONSTRAINT "t_fk" FOREIGN KEY ("c") REFERENCES "u"("id");`),
    ).toEqual([]);
  });

  it("flags destructive statements", () => {
    expect(rules('DROP TABLE "t"')).toEqual(["DROP TABLE"]);
    expect(rules('ALTER TABLE "t" DROP COLUMN "c"')).toEqual(["DROP COLUMN"]);
    expect(rules('truncate "t"')).toEqual(["TRUNCATE"]);
    expect(rules('ALTER TABLE "t" ALTER COLUMN "c" SET DATA TYPE integer')).toEqual(["ALTER COLUMN … TYPE"]);
    expect(rules('ALTER TABLE "t" ALTER COLUMN "c" TYPE integer USING c::int')).toEqual([
      "ALTER COLUMN … TYPE",
    ]);
    expect(rules('ALTER TABLE "t" RENAME COLUMN "a" TO "b"')).toEqual(["RENAME"]);
    expect(rules('ALTER TABLE "t" DROP CONSTRAINT "t_check"')).toEqual([
      "DROP CONSTRAINT without replacement",
    ]);
  });

  it("flags statements that weaken isolation or the audit trail, also inside DO blocks", () => {
    expect(rules('ALTER TABLE "t" DISABLE ROW LEVEL SECURITY')).toEqual(["DISABLE ROW LEVEL SECURITY"]);
    expect(rules('ALTER TABLE "t" NO FORCE ROW LEVEL SECURITY')).toEqual(["NO FORCE ROW LEVEL SECURITY"]);
    expect(rules("DO $$ BEGIN EXECUTE format('DROP POLICY ws_isolation ON %I', t); END $$")).toEqual(
      expect.arrayContaining(["DROP POLICY", "dynamic SQL (EXECUTE in DO)"]),
    );
    expect(rules("DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log")).toEqual([
      "DROP TRIGGER audit_log_*",
    ]);
    expect(rules("GRANT DELETE ON audit_log TO meri_app")).toEqual(["GRANT … meri_app"]);
    expect(rules("CREATE FUNCTION f() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$")).toEqual(
      ["SECURITY DEFINER"],
    );
    expect(rules('DELETE FROM "proposals"')).toEqual(["DELETE/UPDATE without WHERE"]);
    expect(rules("UPDATE users SET email = null")).toEqual(["DELETE/UPDATE without WHERE"]);
  });

  it("catches the evasions found in the phase 6 review", () => {
    expect(rules("WITH d AS (DELETE FROM tasks RETURNING 1) SELECT count(*) FROM d")).toContain(
      "DELETE/UPDATE without WHERE",
    );
    expect(rules("ALTER POLICY ws_isolation ON tasks USING (true)")).toContain("CREATE/ALTER POLICY");
    expect(rules("CREATE POLICY open ON tasks USING (true)")).toContain("CREATE/ALTER POLICY");
    expect(rules("ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable")).toContain("DISABLE TRIGGER");
    expect(
      rules(
        "CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$",
      ),
    ).toContain("replaces an audit_log function");
    expect(rules("DROP FUNCTION audit_log_immutable() CASCADE")).toEqual(
      expect.arrayContaining(["DROP SCHEMA/FUNCTION/TYPE/VIEW/SEQUENCE", "CASCADE"]),
    );
    expect(rules("GRANT SELECT ON beta_invites TO PUBLIC")).toContain("GRANT … TO PUBLIC");
    expect(rules("ALTER ROLE meri_app BYPASSRLS")).toContain("ALTER ROLE");
    expect(rules("DROP SCHEMA public CASCADE")).toContain("DROP SCHEMA/FUNCTION/TYPE/VIEW/SEQUENCE");
    expect(rules("DO $$ BEGIN EXECUTE 'DROP ' || 'TABLE tasks'; END $$")).toContain(
      "dynamic SQL (EXECUTE in DO)",
    );
    expect(rules('ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL')).toContain("SET NOT NULL");
    expect(rules('ALTER TABLE "t" ADD COLUMN "c" text NOT NULL')).toContain(
      "ADD COLUMN NOT NULL without DEFAULT",
    );
    expect(rules('ALTER TABLE "t" ADD COLUMN "c" text DEFAULT \'x\' NOT NULL')).toEqual([]);
    // An index dropped and recreated with the same name in the migration is fine; dropped alone, it is not.
    expect(
      rules('DROP INDEX "i";--> statement-breakpoint\nCREATE UNIQUE INDEX "i" ON "t" ("a","b")'),
    ).toEqual([]);
    expect(rules('DROP INDEX "i"')).toContain("DROP INDEX without replacement");
  });

  it("the approval marker counts only on a comment line of its own", () => {
    expect(
      checkMigration("SELECT '-- meri:destructive-approved hidden in a string literal';\nDROP TABLE t")
        .approval,
    ).toBeNull();
  });

  it("a hidden statement in a comment is not a finding, a disguised one is", () => {
    expect(rules("-- DROP TABLE t\nSELECT 1")).toEqual([]);
    expect(rules("/* x */ DROP/**/TABLE t")).toEqual(["DROP TABLE"]);
  });

  it("an approval needs a reason", () => {
    expect(checkMigration('-- meri:destructive-approved\nDROP TABLE "t"').approval).toBeNull();
    expect(checkMigration('-- meri:destructive-approved short\nDROP TABLE "t"').approval).toBeNull();
    expect(
      checkMigration('-- meri:destructive-approved table unused since 0019, contract step\nDROP TABLE "t"')
        .approval,
    ).toBe("table unused since 0019, contract step");
  });

  it("every migration from the baseline passes or carries an approval", () => {
    const dir = resolve(
      fileURLToPath(new URL(".", import.meta.url)),
      "..",
      "..",
      "packages",
      "db",
      "drizzle",
    );
    const files = readdirSync(dir).filter((f) => (migrationNumber(f) ?? -1) >= BASELINE);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const report = checkMigration(readFileSync(join(dir, f), "utf8"));
      expect(report.findings.length === 0 || report.approval !== null, f).toBe(true);
    }
  });
});
