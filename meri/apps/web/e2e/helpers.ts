import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Clock of the demo servers (`pnpm demo` with DEMO_NOW): Tuesday 2026-10-20 10:40 in Madrid. */
export const DEMO_NOW = "2026-10-20T08:40:00Z";
export const DEMO_EMAIL = "demo@meri.local";
/** Screenshots land in docs/prototype (PROTOTYPE.md criterion 11). */
export const SHOTS = path.resolve(here, "../../../docs/prototype");

export async function expectAccessible(page: Page, name: string): Promise<void> {
  // Never analyse a document mid-navigation (a router refresh can swap it): wait for the app's own <html>.
  await page.waitForFunction(() => document.title !== "" && document.documentElement.lang !== "", undefined, {
    timeout: 15_000,
  });
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `${name}: ${serious.map((v) => `${v.id} (${v.nodes.length})`).join(", ")}`).toEqual([]);
}

/** Client handlers need hydration; React attaches fiber keys to DOM nodes once hydrated. */
export async function hydrated(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => Object.keys(document.body).some((k) => k.startsWith("__reactFiber")),
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(250);
}

/**
 * Signs in as the demo user through the dev form (D-053): independent of the automatic sign-in of `/login`,
 * which has its own test. The workspace is the one `pnpm demo:seed` created (global setup reseeds it).
 */
export async function demoLogin(page: Page): Promise<void> {
  await page.goto("/login?manual=1");
  await hydrated(page);
  await page.getByLabel(/correo|email/i).fill(DEMO_EMAIL);
  await page.getByRole("button", { name: /entrar|continuar|sign in|iniciar/i }).click();
  await page.waitForURL(/\/hoy/);
  await hydrated(page);
  // Every expectation below assumes the frozen clock: fail fast (and clearly) when the servers run without it.
  await expect(
    page.getByRole("heading", { level: 1 }),
    `start the servers with DEMO_NOW=${DEMO_NOW} (pnpm demo); the demo clock is not frozen`,
  ).toContainText(/20 de octubre|october 20/i, { timeout: 5_000 });
}

/**
 * Opens «Ver cómo reorganizar» and accepts it. A background replan (debounced after captures, confirmations or a
 * calendar poll) can supersede the proposal between opening the diff and accepting it (ADR 0003
 * basePlanVersion): then the latest proposal is opened and accepted once more.
 */
export async function acceptReorganization(page: Page, afterOpen?: () => Promise<void>): Promise<void> {
  const open = async () => {
    const reorganize = page.getByRole("button", { name: /ver cómo reorganizar/i }).first();
    await expect(reorganize).toBeVisible({ timeout: 60_000 });
    await reorganize.click();
    await expect(page.getByRole("dialog")).toContainText(/ninguna reunión se mueve/i);
  };
  const accept = async () => {
    await page.getByRole("button", { name: /aceptar cambios/i }).click();
    await expect(page.getByRole("status")).toContainText(/cambios aplicados/i, { timeout: 10_000 });
  };
  await open();
  if (afterOpen) await afterOpen();
  try {
    await accept();
  } catch {
    await page.goto("/hoy");
    await hydrated(page);
    await open();
    await accept();
  }
}

/** Pending proposals whose payload mentions `text` (read through the API rewrite with the page's session). */
export async function pendingProposalsMentioning(page: Page, text: string): Promise<number> {
  const res = await page.request.get("/api/v1/proposals?status=pending&limit=100");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { items: unknown[] };
  return body.items.filter((p) => JSON.stringify(p).includes(text)).length;
}

export async function goto(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await hydrated(page);
}

/** Stable capture: animations off (prefers-reduced-motion is honoured, criterion 10). */
export async function shot(page: Page, name: string): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

/** Presses a button with the keyboard only (focus + Enter), as a keyboard user would. */
export async function pressWithKeyboard(page: Page, locator: ReturnType<Page["locator"]>): Promise<void> {
  await locator.focus();
  await expect(locator).toBeFocused();
  await page.keyboard.press("Enter");
}

/**
 * Resets and reseeds the demo workspace (D-048) so each prototype spec starts from the same data, whatever
 * the project order. `E2E_SKIP_SEED=1` keeps the current workspace.
 */
export function reseedDemo(): void {
  if (process.env.E2E_SKIP_SEED === "1") return;
  execSync("pnpm demo:seed -- --reset", {
    cwd: path.resolve(here, "../../.."),
    stdio: "inherit",
    env: { ...process.env, DEMO_NOW: process.env.DEMO_NOW ?? DEMO_NOW },
  });
}
