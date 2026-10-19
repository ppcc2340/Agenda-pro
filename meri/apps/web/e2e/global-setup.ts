import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_NOW } from "./helpers";

/**
 * `pnpm e2e` targets the servers of `pnpm demo` (DEMO_MODE=1, DEMO_NOW frozen). The demo workspace is reset and
 * reseeded before the run so the prototype specs start from the same data every time (D-048). Set
 * E2E_SKIP_SEED=1 to keep the current workspace.
 */
export default function globalSetup(): void {
  if (process.env.E2E_SKIP_SEED === "1") return;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  execSync("pnpm demo:seed -- --reset", {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, DEMO_NOW: process.env.DEMO_NOW ?? DEMO_NOW },
  });
}
