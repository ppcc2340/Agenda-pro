import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D-079 [CR-L14]: the threat model, the runbooks and the compliance package cite files as evidence. A cited path that
 * no longer exists makes the evidence false, so every repository path in backticks and every relative link must
 * resolve.
 */
const root = resolve(import.meta.dirname, "..", "..");
const docs = [
  "docs/threat-model.md",
  "docs/google-verification.md",
  ...readdirSync(join(root, "docs/runbooks")).map((f) => `docs/runbooks/${f}`),
  ...readdirSync(join(root, "docs/compliance")).map((f) => `docs/compliance/${f}`),
].filter((f) => f.endsWith(".md"));

const REPO_PATH = /^(apps|packages|scripts|docs|evals|phases|\.github)\/[\w./@[\]()-]+$/;
/** A shortened citation such as `plugins/csrf.ts` or `logger.test.ts`: must be the tail of some tracked file. */
const FILE_LIKE = /^[\w./@[\]()-]+\.(ts|tsx|mjs|sql|md|yml|json)$/;
/** `.github/` lives at the git root, one level above the app folder: paths are listed from there. */
const gitRoot = resolve(root, "..");
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
  cwd: gitRoot,
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);
const isTrackedTail = (p: string) => tracked.some((f) => f === p || f.endsWith(`/${p}`));

function citedPaths(markdown: string): string[] {
  const inCode = [...markdown.matchAll(/`([^`\s]+)`/g)].map((m) => m[1] ?? "");
  return inCode
    .map((p) => p.replace(/:\d+(-\d+)?$/, "").replace(/#.*$/, ""))
    .filter((p) => REPO_PATH.test(p) && !/[{}*<>]/.test(p));
}

function citedFiles(markdown: string): string[] {
  return [...markdown.matchAll(/`([^`\s]+)`/g)]
    .map((m) => (m[1] ?? "").replace(/:\d+(-\d+)?$/, ""))
    .filter((p) => FILE_LIKE.test(p) && !REPO_PATH.test(p) && !/[{}*<>]/.test(p));
}

function relativeLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => (m[1] ?? "").replace(/#.*$/, ""))
    .filter((href) => href !== "" && !/^[a-z]+:/i.test(href));
}

describe("paths cited in the security and compliance docs exist", () => {
  it.each(docs)("%s", (doc) => {
    const text = readFileSync(join(root, doc), "utf8");
    const missing = [
      ...citedPaths(text).filter((p) => !existsSync(join(root, p)) && !existsSync(join(gitRoot, p))),
      ...citedFiles(text).filter((p) => !isTrackedTail(p)),
      ...relativeLinks(text).filter((href) => !existsSync(resolve(root, dirname(doc), href))),
    ];
    expect(missing).toEqual([]);
  });

  it("covers the documents this phase relies on", () => {
    expect(docs).toEqual(
      expect.arrayContaining([
        "docs/threat-model.md",
        "docs/runbooks/incident-response.md",
        "docs/runbooks/key-rotation.md",
        "docs/runbooks/provider-outage.md",
        "docs/runbooks/backup-restore.md",
        "docs/runbooks/disaster-recovery.md",
        "docs/compliance/deletion-verification.md",
      ]),
    );
  });
});
