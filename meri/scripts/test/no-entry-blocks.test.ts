import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "packages");
/** Command-line entry points: never imported by an app, so a main-module check is safe there. */
const ENTRY_POINTS = new Set(["db/src/migrate-cli.ts", "db/src/seed/dev.ts"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name === "dist") return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe("library packages carry no command-line entry blocks", () => {
  it("no module bundled into the apps checks process.argv[1] (it would fire inside the bundle)", () => {
    const offenders = walk(root)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => relative(root, f))
      .filter((f) => f.includes("/src/") && !ENTRY_POINTS.has(f))
      .filter((f) => readFileSync(join(root, f), "utf8").includes("process.argv[1]"));
    expect(offenders).toEqual([]);
  });
});
