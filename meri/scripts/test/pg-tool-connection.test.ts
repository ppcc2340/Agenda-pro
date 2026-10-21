import { describe, expect, it } from "vitest";
import { pgToolConnection } from "../lib/backup";

/** Security review (phase 5): the owner's password must never reach pg_dump/pg_restore arguments (`ps` shows them). */
describe("pgToolConnection", () => {
  it("moves the password to PGPASSWORD and keeps everything else in the URL", () => {
    const c = pgToolConnection("postgres://meri:s3cr%40t@db.internal:6543/meri?sslmode=require");
    expect(c.dbname).toBe("postgres://meri@db.internal:6543/meri?sslmode=require");
    expect(c.dbname).not.toContain("s3cr");
    expect(c.env).toEqual({ PGPASSWORD: "s3cr@t" });
  });

  it("adds nothing when the URL has no password", () => {
    expect(pgToolConnection("postgres://meri@localhost:5432/meri")).toEqual({
      dbname: "postgres://meri@localhost:5432/meri",
      env: {},
    });
  });
});
