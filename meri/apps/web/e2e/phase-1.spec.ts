import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 1 E2E (docs/10): onboarding → connect calendar (fake) → capture → plan → accept → undo, with axe on every
 * area (F-06 AC2). Needs api + worker + web running with DEMO_NOW=2026-10-20T08:40:00Z (Tuesday 10:40 Madrid).
 */
const email = () => `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@meri.local`;

async function expectAccessible(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `${name}: ${serious.map((v) => `${v.id} (${v.nodes.length})`).join(", ")}`).toEqual([]);
}

/** Server actions and client handlers need hydration; dev mode is slow to hydrate, so wait before interacting. */
async function hydrated(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  // React attaches fiber keys to DOM nodes once hydrated; dev tooling keeps sockets open, so networkidle is unusable.
  await page.waitForFunction(
    () => Object.keys(document.body).some((k) => k.startsWith("__reactFiber")),
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(250);
}

async function login(page: Page): Promise<void> {
  await page.goto("/login?manual=1");
  await hydrated(page);
  await page.getByLabel(/correo|email/i).fill(email());
  await page.getByRole("button", { name: /entrar|continuar|sign in|iniciar/i }).click();
  await page.waitForURL(/onboarding/);
  await hydrated(page);
  await page.getByLabel(/zona horaria|time zone/i).selectOption("Europe/Madrid");
  await page.getByRole("button", { name: /guardar|empezar|continuar|save|start/i }).click();
  await page.waitForURL(/\/hoy/);
  await hydrated(page);
}

test("onboarding → capture → plan → connect calendar → reorganize (accept) → undo, accessible in every area", async ({
  page,
  isMobile,
}) => {
  await login(page);
  await expectAccessible(page, "hoy (empty)");

  // Capture with the palette (desktop) or the mobile capture button; confirm it in Entrada.
  if (isMobile) {
    await page
      .getByRole("button", { name: /capturar/i })
      .first()
      .click();
  } else {
    await page.keyboard.press("Control+k");
  }
  const captureInput = page.getByRole("dialog").getByRole(isMobile ? "textbox" : "combobox").first();
  await captureInput.fill("Informe trimestral el jueves, 2 h");
  await captureInput.press("Enter");
  await page.goto("/entrada");
  await hydrated(page);
  await expect(page.locator("article")).toHaveCount(1);
  await expectAccessible(page, "entrada");
  await page
    .locator("article")
    .getByRole("button", { name: /confirmar/i })
    .first()
    .click();
  await expect(page.locator("article")).toHaveCount(0);

  // A second task from Proyectos → Tareas so the plan has two blocks today.
  await page.goto("/proyectos?tab=tareas");
  await hydrated(page);
  await page.getByRole("button", { name: /nueva tarea/i }).click();
  await page.getByLabel(/^título/i).fill("Revisar factura de Estudio Norte");
  await page.getByLabel(/duración/i).fill("45");
  await page.getByRole("button", { name: /crear tarea/i }).click();
  await expect(page.getByText("Revisar factura de Estudio Norte").first()).toBeVisible();

  // The worker replans in the background (debounced). Desktop shows the day line; mobile keeps the day in the
  // Agenda tab (demo/mobile.html), so there the "¿Qué hago ahora?" card is the evidence.
  await page.goto("/hoy");
  await hydrated(page);
  if (isMobile) {
    await expect(page.getByRole("button", { name: /marcar como hecho/i }).first()).toBeVisible({
      timeout: 60_000,
    });
    await expectAccessible(page, "hoy (plan)");
  } else {
    const blocks = page.locator('main button[aria-pressed][aria-label*="–"]');
    await expect
      .poll(async () => blocks.count(), { timeout: 60_000, intervals: [1000] })
      .toBeGreaterThanOrEqual(1);
    await expectAccessible(page, "hoy (plan)");
    // Explanation and pin on the first block (keyboard: the detail receives focus).
    await blocks.first().click();
    const detail = page.getByRole("region", { name: /./ }).first();
    await expect(detail).toBeFocused();
    await expect(page.getByText(/por qué está aquí/i).first()).toBeVisible();
    await page.getByRole("button", { name: /anclar/i }).click();
    await expect(page.getByRole("status")).toContainText(/anclado/i);
  }

  // Connect the fake calendar: its sample meeting overlaps today's plan → reschedule proposal.
  await page.goto("/control");
  await hydrated(page);
  await page.getByRole("button", { name: /conectar google calendar/i }).click();
  await page.waitForURL(/integration=connected/);
  await expectAccessible(page, "control");
  await page.goto("/hoy");
  await hydrated(page);
  const reorganize = page.getByRole("button", { name: /ver cómo reorganizar/i }).first();
  await expect(reorganize).toBeVisible({ timeout: 60_000 });
  await reorganize.click();
  await expect(page.getByRole("dialog")).toContainText(/ninguna reunión se mueve/i);
  // A background replan (calendar poll, time inference) can supersede the proposal between opening the diff and
  // accepting it (ADR 0003 basePlanVersion); then the latest proposal is opened and accepted once more.
  const accept = async () => {
    await page.getByRole("button", { name: /aceptar cambios/i }).click();
    await expect(page.getByRole("status")).toContainText(/cambios aplicados/i, { timeout: 10_000 });
  };
  try {
    await accept();
  } catch {
    await page.goto("/hoy");
    await hydrated(page);
    await page.getByRole("button", { name: /ver cómo reorganizar/i }).first().click();
    await accept();
  }

  await page.goto("/calendario");
  await hydrated(page);
  await expect(
    page.locator(isMobile ? '[data-testid="agenda-view"]' : '[data-testid="week-view"]'),
  ).toBeVisible();
  await expectAccessible(page, "calendario");

  // Undo the accepted reorganization from Activity (append-only compensation).
  await page.goto("/control");
  await hydrated(page);
  const accepted = page.locator("li", { hasText: /aceptaste una reorganización/i }).first();
  await accepted.getByRole("button", { name: /deshacer/i }).click();
  await expect(page.getByRole("status")).toContainText(/deshecha/i);
  await expect(page.locator("li", { hasText: /aceptaste una reorganización/i }).first()).toContainText(
    /deshecho/i,
  );
});
