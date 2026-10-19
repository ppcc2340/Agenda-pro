import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Clock of the demo servers (`pnpm demo` with DEMO_NOW): Tuesday 2026-10-20 10:40 in Madrid. */
export const DEMO_NOW = "2026-10-20T08:40:00Z";
export const DEMO_EMAIL = "demo@meri.local";
/** Screenshots land in docs/prototype (PROTOTYPE.md criterion 11). */
export const SHOTS = path.resolve(here, "../../../docs/prototype");

export async function expectAccessible(page: Page, name: string): Promise<void> {
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
