import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const run = (env: Record<string, string>, ...args: string[]) =>
  spawnSync("node", ["scripts/check-blockers.mjs", ...args], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });

describe("pnpm blockers (scripts/check-blockers.mjs)", () => {
  it("reports every blocker as pending by default and exits 0", () => {
    const r = run({ HOME: "/nonexistent" });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Proyecto OAuth de Google.*\[crítico\]/);
    expect((r.stdout.match(/⏳ pendiente/g) ?? []).length).toBe(6);
    expect(r.stdout).toContain("docs/blockers/google-oauth.md");
  });

  it("flags live mode without credentials and fails in --strict", () => {
    const r = run({ GOOGLE_MODE: "live" }, "--strict");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/❌ error.*Proyecto OAuth de Google/);
    expect(r.stdout).toMatch(/GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET/);
  });

  it("shows ready-to-activate when credentials exist but the mode is still fake, without printing values", () => {
    const r = run(
      {
        STRIPE_SECRET_KEY: "sk_test_SECRETVALUE",
        STRIPE_WEBHOOK_SECRET: "whsec_x",
        STRIPE_PRICE_PRO: "price_1",
        STRIPE_PRICE_PRO_ANNUAL: "price_2",
      },
      "--id",
      "stripe",
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/🟡 listo para activar/);
    expect(r.stdout).not.toContain("SECRETVALUE");
  });
});
