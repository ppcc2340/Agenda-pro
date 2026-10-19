/**
 * "Hoy" load-time measurement (P1-10): 30 loads of /hoy as the perf-seed user (500 tasks / 5 000 events),
 * p50/p75/p95 of navigation start → network idle (server render + plan/events/notifications requests).
 * Usage: pnpm seed:perf && pnpm perf:hoy  (web, api and worker running; optimized web build: `APP_ENV=development ALLOW_FAKES_ON_PRODUCTION_BUILD=1 pnpm --filter @meri/web build && pnpm --filter @meri/web start`)
 */
import { chromium } from "@playwright/test";

const base = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const runs = Number(process.env.PERF_RUNS ?? 30);
const email = process.env.PERF_EMAIL ?? "perf@meri.local";

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
await page.goto(`${base}/login`);
await page.waitForLoadState("networkidle");
await page.fill('input[name="email"]', email);
await page.click('button[type="submit"]');
await page.waitForURL(/\/(hoy|onboarding)/, { timeout: 60_000 });
if (page.url().includes("onboarding")) {
  await page.waitForLoadState("networkidle");
  await page.selectOption("select[name=timezone]", "Europe/Madrid");
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/hoy/, { timeout: 60_000 });
}
// One synchronous replan so the seed has a plan (also reports the planner's wall time on 500 tasks).
const t0 = Date.now();
const replan = await page.request.post(`${base}/api/v1/plan/replan`, {
  headers: { "x-requested-with": "meri" },
});
const replanMs = Date.now() - t0;
const replanBody = await replan.json();
console.log(`replan: ${replan.status()} ${JSON.stringify(replanBody)} in ${replanMs} ms`);
// Warm-up (route compilation / caches), not counted.
await page.goto(`${base}/hoy`);
await page.waitForLoadState("networkidle");

const total = [];
const server = [];
const plan = [];
for (let i = 0; i < runs; i++) {
  const t0 = Date.now();
  await page.goto(`${base}/hoy`, { waitUntil: "networkidle" });
  total.push(Date.now() - t0);
  const nav = await page.evaluate(() => {
    const [n] = performance.getEntriesByType("navigation");
    return n ? { ttfb: n.responseStart - n.startTime, dcl: n.domContentLoadedEventEnd - n.startTime } : null;
  });
  if (nav) server.push(nav.ttfb);
  const planMs = await page.evaluate(() => {
    const entry = performance.getEntriesByType("resource").find((e) => e.name.includes("/api/v1/plan?"));
    return entry ? entry.duration : null;
  });
  if (planMs !== null) plan.push(planMs);
}
const blocks = await page.locator('main button[aria-pressed][aria-label*="–"]').count();
await browser.close();

const row = (name, xs) =>
  `| ${name} | ${Math.round(pct(xs, 50))} | ${Math.round(pct(xs, 75))} | ${Math.round(pct(xs, 95))} | ${Math.round(Math.max(...xs))} |`;
console.log(`runs: ${runs} · user: ${email} · blocks today: ${blocks}`);
console.log("| metric | p50 ms | p75 ms | p95 ms | max ms |");
console.log("|---|---|---|---|---|");
console.log(row("Hoy navigation → network idle", total));
console.log(row("server TTFB (/hoy)", server));
console.log(row("GET /api/v1/plan", plan));
if (pct(total, 75) > 1500) {
  console.error("FAIL: p75 above 1.5 s");
  process.exit(1);
}
