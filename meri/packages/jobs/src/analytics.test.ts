import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ANALYTICS_EVENTS, NoopAnalytics } from "@meri/integrations";
import { ANALYTICS_SCHEMAS, track } from "./analytics";

const WS = "01a15596-f037-71e4-bfce-25b2f4a80b44";
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("typed analytics (D-065)", () => {
  it("has a closed schema for every event of docs/09", () => {
    expect(Object.keys(ANALYTICS_SCHEMAS).sort()).toEqual([...ANALYTICS_EVENTS].sort());
  });

  it("rejects free strings, unknown keys and non-uuid ids; never sends a rejected event", () => {
    const analytics = new NoopAnalytics();
    const bad: [string, unknown][] = [
      ["capture_created", { source: "Llamar a Ana de Acme" }],
      ["proposal_shown", { proposalId: "not-a-uuid", kind: "capture" }],
      ["signup", { email: "ana@acme.com" }],
      ["subscription_cancelled", { reason: "price", comment: "too expensive" }],
    ];
    for (const [event, props] of bad) track(analytics, event as "signup", WS, props as Record<string, never>);
    track(analytics, "signup", "workspace-name", {});
    expect(analytics.events).toEqual([]);
    expect(analytics.errors).toHaveLength(5);
    track(analytics, "capture_created", WS, { source: "ai" });
    expect(analytics.events).toEqual([{ event: "capture_created", distinctId: WS, props: { source: "ai" } }]);
  });

  it("every event is emitted by at least one track() call in the server code (no orphan events)", () => {
    const files = [
      join(ROOT, "apps/api/src"),
      join(ROOT, "apps/worker/src"),
      join(ROOT, "packages/jobs/src"),
    ].flatMap(sources);
    const emitted = new Set<string>();
    for (const file of files)
      for (const m of readFileSync(file, "utf8").matchAll(
        /track\(\s*[\w.]+,\s*(?:edited \? )?"(\w+)"(?:\s*:\s*"(\w+)")?/g,
      )) {
        if (m[1]) emitted.add(m[1]);
        if (m[2]) emitted.add(m[2]);
      }
    expect(ANALYTICS_EVENTS.filter((e) => !emitted.has(e))).toEqual([]);
  });
});
