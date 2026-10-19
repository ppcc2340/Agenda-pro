/**
 * "Hoy" load-time measurement (P1-10): 30 loads of /hoy as the perf-seed user (500 tasks / 5 000 events),
 * p50/p75/p95 of navigation start → network idle (server render + plan/events/notifications requests).
 * Usage: pnpm seed:perf && pnpm perf:hoy  (web, api and worker running; optimized web build recommended)
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
// Warm-up (route compilation / caches), not counted.
await page.goto(`${base}/hoy`);
await page.waitForLoadState("networkidle");

const total = [];
const server = [];
const plan = [];
for (let i = 0; i < runs; i++) {
  const planTiming = page.waitForResponse((r) => r.url().includes("/api/v1/plan?"));
  const t0 = Date.now();
  await page.goto(`${base}/hoy`, { waitUntil: "networkidle" });
  total.push(Date.now() - t0);
  const nav = await page.evaluate(() => {
    const [n] = performance.getEntriesByType("navigation");
    return n ? { ttfb: n.responseStart - n.startTime, dcl: n.domContentLoadedEventEnd - n.startTime } : null;
  });
  if (nav) server.push(nav.ttfb);
  const res = await planTiming;
  const timing = await res.request().timing();
  plan.push(timing.responseEnd - timing.startTime > 0 ? timing.responseEnd - timing.startTime : 0);
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
