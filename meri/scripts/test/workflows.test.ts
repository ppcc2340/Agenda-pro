import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * GitHub silently skips a workflow file that is not valid YAML (an unquoted `: ` in a step name was enough to
 * disable CI). Every workflow must parse, every step must run or use something, and the guards ADR 0007 relies on
 * must stay in place.
 */
const workflowsDir = resolve(import.meta.dirname, "..", "..", "..", ".github", "workflows");
const files = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f));

interface Step {
  name?: string;
  uses?: string;
  run?: string;
}
interface Workflow {
  on: unknown;
  jobs: Record<string, { steps: Step[] }>;
}
const load = (file: string): Workflow => parse(readFileSync(resolve(workflowsDir, file), "utf8")) as Workflow;
const allSteps = (wf: Workflow): Step[] => Object.values(wf.jobs).flatMap((j) => j.steps);

describe("GitHub workflows", () => {
  it.each(files)("%s parses and every step has `run` or `uses`", (file) => {
    const wf = load(file);
    expect(wf.on).toBeDefined();
    expect(Object.keys(wf.jobs).length).toBeGreaterThan(0);
    for (const step of allSteps(wf)) expect(Boolean(step.run) || Boolean(step.uses)).toBe(true);
  });

  it("keeps the security guards: no email send path, gitleaks, audit, SBOM and CodeQL", () => {
    expect(files).toEqual(expect.arrayContaining(["ci.yml", "codeql.yml"]));
    const ci = allSteps(load("ci.yml"));
    expect(ci.some((s) => s.run?.includes("gmail\\.send"))).toBe(true);
    expect(ci.some((s) => s.uses?.startsWith("gitleaks/gitleaks-action"))).toBe(true);
    expect(ci.some((s) => s.run?.startsWith("pnpm audit --prod"))).toBe(true);
    expect(ci.some((s) => s.uses?.startsWith("anchore/sbom-action"))).toBe(true);
    expect(allSteps(load("codeql.yml")).some((s) => s.uses?.startsWith("github/codeql-action/analyze"))).toBe(
      true,
    );
  });
});
