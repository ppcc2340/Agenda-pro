import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotenv } from "./dotenv";

describe("loadDotenv", () => {
  it("parses simple, quoted and commented lines without overriding existing variables", () => {
    const dir = mkdtempSync(join(tmpdir(), "meri-env-"));
    const file = join(dir, ".env");
    writeFileSync(file, 'A=1\n# comment\nB="two words"\nC=\'x\'  # trailing\nexport D=4\nEMPTY=\nbad line\n');
    const target: Record<string, string | undefined> = { A: "keep" };
    const loaded = loadDotenv(file, target);
    expect(target).toEqual({ A: "keep", B: "two words", C: "x", D: "4", EMPTY: "" });
    expect(loaded).toEqual(["B", "C", "D", "EMPTY"]);
    expect(loadDotenv(join(dir, "missing"), target)).toEqual([]);
  });
});
