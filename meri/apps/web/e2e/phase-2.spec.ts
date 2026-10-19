import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 2 E2E (phases/02 PLAN step 11): connect Gmail (fake) → commitment proposals in Entrada (hostile mail
 * rejected) → confirm → radar (Debo / Me deben) → overdue → follow-up draft saved in Gmail (never sent) →
 * follow-up alert → privacy controls. Same servers and clock as phase 1 (DEMO_NOW=2026-10-20T08:40:00Z).
 */
const email = () => `e2e2-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@meri.local`;

async function expectAccessible(page: Page, name: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious, `${name}: ${serious.map((v) => `${v.id} (${v.nodes.length})`).join(", ")}`).toEqual([]);
}

async function hydrated(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => Object.keys(document.body).some((k) => k.startsWith("__reactFiber")),
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(250);
}

async function login(page: Page): Promise<void> {
  await page.goto("/login");
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

test("connect Gmail → proposals → confirm → radar → overdue follow-up draft → alert → privacy controls", async ({
  page,
}) => {
  test.setTimeout(300_000); // the follow-up scan runs every minute outside production
  await login(page);

  // Connect Gmail (incremental scopes, fake OAuth). The worker syncs and extracts in the background.
  await page.goto("/control");
  await hydrated(page);
  await page.getByRole("button", { name: /conectar gmail/i }).click();
  await page.waitForURL(/integration=connected/);
  await hydrated(page);
  await expect(page.getByRole("checkbox", { name: /confirmar automáticamente/i })).toBeVisible();
  await expectAccessible(page, "control (gmail)");

  // Entrada: commitment cards with quote, Gmail link and confidence; the hostile sample mail never appears.
  await page.goto("/entrada");
  await hydrated(page);
  const cards = page.locator("article", { hasText: /se compromete contigo|te comprometes con/i });
  await expect
    .poll(async () => cards.count(), { timeout: 90_000, intervals: [1500] })
    .toBeGreaterThanOrEqual(3);
  await expect(page.locator("article", { hasText: /premio|reenvía/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /ver hilo en gmail/i }).first()).toHaveAttribute(
    "href",
    /mail\.google\.com/,
  );
  await expectAccessible(page, "entrada (commitments)");
  const contract = page.locator("article", { hasText: /contrato firmado/i }).first();
  await expect(contract).toContainText(/ana ruiz se compromete contigo/i);
  await contract.getByRole("button", { name: /^confirmar$/i }).click();
  await expect(page.getByRole("status")).toContainText(/ya está en tus compromisos/i);
  // Pablo's budget (sent 6 days ago, "el jueves") is already overdue: confirm with the "Esperando a" task.
  const budget = page.locator("article", { hasText: /presupuesto aprobado/i }).first();
  await budget.getByRole("button", { name: /^editar$/i }).click();
  await budget.getByRole("button", { name: /guardar y confirmar/i }).click();
  await expect(page.locator("article", { hasText: /presupuesto aprobado/i })).toHaveCount(0);

  // Radar: Me deben shows both; the overdue one is flagged and offers the follow-up.
  await page.goto("/proyectos?tab=compromisos&dir=owed_to_me");
  await hydrated(page);
  await expect(page.getByRole("button", { name: /me deben \(2\)/i })).toHaveAttribute("aria-pressed", "true");
  const overdueRow = page.locator("li", { hasText: /presupuesto aprobado/i }).first();
  await expect(overdueRow).toContainText(/vencido/i);
  await expectAccessible(page, "compromisos");
  await overdueRow.getByRole("button", { name: /preparar seguimiento/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(/seguimiento para pablo soto/i);
  await expect(dialog).toContainText(/meri solo crea borradores/i);
  const body = dialog.getByRole("textbox", { name: /borrador/i });
  await expect(body).toHaveValue(/presupuesto/i, { timeout: 20_000 });
  await expectAccessible(page, "followup dialog");
  await dialog.getByRole("button", { name: /guardar borrador en gmail/i }).click();
  await expect(page.getByRole("status")).toContainText(/borrador guardado en gmail/i);
  await expect(dialog).toBeHidden();

  // Hoy Q4 lists what others owe, overdue first, with a follow-up action.
  await page.goto("/hoy");
  await hydrated(page);
  const waiting = page.locator("section", { hasText: /qué estoy esperando de otras personas/i });
  await expect(waiting).toContainText(/presupuesto aprobado/i);
  await expect(waiting.getByRole("button", { name: /seguimiento/i }).first()).toBeVisible();

  // The "Esperando a" task exists and the follow-up scan surfaces ONE alert for the overdue commitment.
  await page.goto("/proyectos?tab=tareas");
  await hydrated(page);
  await expect(page.getByText(/esperando a pablo soto/i).first()).toBeVisible();
  await page.goto("/entrada");
  await hydrated(page);
  const alert = page.locator("article", { hasText: /lleva .* de retraso/i });
  await expect.poll(async () => alert.count(), { timeout: 150_000, intervals: [3000] }).toBe(1);
  await expect(alert).toContainText(/pablo soto/i);
  await alert.getByRole("button", { name: /descartar/i }).click();
  await expect(alert).toHaveCount(0);

  // Privacy: auto-confirmation flag, exclusions with validation, activity shows the draft (never a send).
  await page.goto("/control");
  await hydrated(page);
  await page.getByRole("checkbox", { name: /confirmar automáticamente/i }).check();
  await expect(page.getByRole("status")).toContainText(/auto-confirmación activada/i);
  await page.getByLabel(/tipo de exclusión/i).selectOption("domain");
  await page.getByLabel(/^valor$/i).fill("not a domain");
  await page.getByRole("button", { name: /^excluir$/i }).click();
  await expect(page.getByRole("alert").filter({ hasText: /no es válido/i })).toBeVisible();
  await page.getByLabel(/^valor$/i).fill("boletines.example");
  await page.getByRole("button", { name: /^excluir$/i }).click();
  await expect(page.getByText("boletines.example")).toBeVisible();
  await expect(
    page.locator("li", { hasText: /borrador de seguimiento en gmail \(sin enviar\)/i }).first(),
  ).toBeVisible();
  await expectAccessible(page, "control (privacy)");
});
