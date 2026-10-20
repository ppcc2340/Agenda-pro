import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against the running demo servers: `DEMO_NOW=2026-10-20T08:40:00Z pnpm demo` (api + worker + web in fake
 * mode with DEMO_MODE=1), so the day line, the sample meetings and the seeded workspace are deterministic. The
 * prototype specs reseed the demo workspace before they start (E2E_SKIP_SEED=1 keeps it). Chromium only; the
 * preinstalled browser is used (PLAYWRIGHT_BROWSERS_PATH).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  outputDir: "./e2e/.results",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "es-ES",
  },
  projects: [
    {
      name: "desktop",
      testIgnore: /mobile\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    { name: "mobile", testIgnore: /desktop\.spec\.ts/, use: { ...devices["Pixel 7"] } },
  ],
});
