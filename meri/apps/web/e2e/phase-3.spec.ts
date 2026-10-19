import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Phase 3 E2E (phases/03 PLAN step 9): client → meeting (fake calendar, resolved by domain) → briefing with
 * sources → record agreements after the meeting → weekly time review (inferred, approved by the user) → CSV
 * export with the documented columns → client view and client-scoped search. Same servers and clock as the
 * other phases (DEMO_NOW=2026-10-20T08:40:00Z).
 */
const email = () => `e2e3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@meri.local`;

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
  // P3-07: the vertical template is one click in the onboarding.
  await page.getByText(/despacho de abogados/i).click();
  await page.getByRole("button", { name: /guardar|empezar|continuar|save|start/i }).click();
  await page.waitForURL(/\/hoy/);
  await hydrated(page);
}

test("client → meeting → briefing → agreements → weekly time → CSV → client view", async ({ page }) => {
  test.setTimeout(300_000);
  const isMobile = test.info().project.name === "mobile";
  await login(page);

  // Calendar (fake): yesterday's kickoff with ana@acme.com, today's weekly call, later meetings.
  await page.goto("/control");
  await hydrated(page);
  await page.getByRole("button", { name: /conectar google calendar/i }).click();
  await page.waitForURL(/integration=connected/);
  await hydrated(page);
  await expect(page.getByRole("radio", { name: /despacho de abogados/i })).toBeChecked();

  // Client with a domain: meetings resolve to it automatically (D-039/D-040).
  await page.goto("/proyectos?tab=clientes");
  await hydrated(page);
  await page.getByRole("button", { name: /nuevo cliente/i }).click();
  const form = page.getByRole("dialog");
  await form.getByLabel(/^nombre/i).fill("Acme");
  await form.getByLabel(/dominios de correo/i).fill("acme.com");
  await form.getByRole("button", { name: /guardar cliente/i }).click();
  await expect(page.getByRole("status")).toContainText(/cliente creado/i);
  const card = page.locator("li", { hasText: /^Acme/ }).first();
  await expect(card).toContainText("acme.com");
  await expectAccessible(page, "clientes");

  // A task for the client through capture (the legal vocabulary makes a dated "vista" a hard deadline).
  await page.goto("/proyectos?tab=tareas");
  await hydrated(page);
  await page.getByRole("button", { name: /nueva tarea/i }).click();
  await page.getByLabel(/^título/i).fill("Informe para Acme");
  await page.getByLabel(/^cliente/i).selectOption({ label: "Acme" });
  await page.getByLabel(/duración/i).fill("120");
  await page.getByRole("button", { name: /crear tarea/i }).click();
  await expect(page.getByText("Informe para Acme").first()).toBeVisible();

  // Briefing (AI-4, rules in fake mode): every item cites a source; the meeting and the task are there.
  await page.goto("/proyectos?tab=clientes");
  await hydrated(page);
  await page.locator("li", { hasText: /^Acme/ }).first().getByRole("button", { name: /^briefing$/i }).click();
  const briefing = page.getByRole("dialog");
  await expect(briefing).toContainText(/briefing de acme/i);
  await expect(briefing).toContainText(/informe para acme/i, { timeout: 20_000 });
  await expect(briefing).toContainText(/llamada semanal con acme/i);
  await expect(briefing.getByRole("link", { name: /ver fuente/i }).first()).toBeVisible();
  await expectAccessible(page, "briefing");
  await page.keyboard.press("Escape");
  await expect(briefing).toBeHidden();

  // Client view (P3-08): header, month hours, timeline with the meeting and the task.
  await page.locator("li", { hasText: /^Acme/ }).first().getByRole("link", { name: "Acme" }).click();
  await page.waitForURL(/\/clientes\//);
  await hydrated(page);
  await expect(page.getByRole("heading", { name: "Acme" }).first()).toBeVisible();
  await expect(page.getByText(/llamada semanal con acme/i).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/informe para acme/i).first()).toBeVisible();
  await expectAccessible(page, "cliente");

  // Post-meeting (D-044): agreements become proposals in Entrada; nothing is confirmed automatically.
  await page.goto("/hoy");
  await hydrated(page);
  const meetings = page.locator("section", { hasText: /reuniones de hoy con cliente/i });
  await expect(meetings).toContainText(/llamada semanal con acme/i, { timeout: 30_000 });
  await meetings.getByRole("button", { name: /registrar acuerdos/i }).first().click();
  const agreements = page.getByRole("dialog");
  await agreements
    .getByRole("textbox", { name: /acuerdos/i })
    .fill("Enviaré la propuesta de honorarios el viernes\nNos envían el contrato firmado mañana");
  await agreements.getByRole("button", { name: /proponer 2 acuerdos/i }).click();
  await expect(agreements).toContainText(/2 propuestas en entrada/i);
  await page.keyboard.press("Escape");
  await expect(agreements).toBeHidden();
  await page.goto("/entrada");
  await hydrated(page);
  const mine = page.locator("article", { hasText: /propuesta de honorarios/i }).first();
  await expect(mine).toContainText(/te comprometes con/i);
  await expect(mine.getByRole("link", { name: /ver hilo en gmail/i })).toHaveCount(0);
  await expect(page.locator("article", { hasText: /contrato firmado/i }).first()).toContainText(/se compromete contigo/i);
  await mine.getByRole("button", { name: /^confirmar$/i }).click();
  await expect(page.getByRole("status")).toContainText(/ya está en tus compromisos/i);

  // Weekly time (F-10): yesterday's kickoff (50 min → 54 with 6-minute rounding) is suggested, never approved alone.
  await page.goto("/proyectos?tab=tiempo");
  await hydrated(page);
  const row = page.locator("li", { hasText: /reunión de arranque con acme/i }).first();
  await expect(row).toBeVisible({ timeout: 90_000 });
  await expect(row).toContainText(/sugerida/i);
  await expect(row).toContainText(/54 min/);
  await expectAccessible(page, "tiempo");
  await row.getByRole("button", { name: /^aprobar$/i }).click();
  await expect(page.getByRole("status")).toContainText(/entrada aprobada/i);
  await expect(row).toContainText(/aprobada/i);
  await expect(page.getByLabel(/resumen semanal/i)).toContainText(/54 min/);

  // CSV export (D-046): BOM, documented columns, the approved row only.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: /exportar csv/i }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^meri-tiempo-2026-W43\.csv$/);
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const csv = Buffer.concat(chunks).toString("utf8");
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  const lines = csv.slice(1).trim().split("\r\n");
  expect(lines[0]).toBe('"fecha","cliente","asunto","descripcion","minutos","horas","origen","estado","aprobada_el"');
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain('"Acme"');
  expect(lines[1]).toContain('"54"');
  expect(lines[1]).toContain('"calendar_event","approved"');

  // Activity: the approval is audited and undoable; the client-scoped search finds the task (desktop palette).
  await page.goto("/control");
  await hydrated(page);
  await expect(page.locator("li", { hasText: /aprobaste una entrada de tiempo/i }).first()).toBeVisible();
  if (!isMobile) {
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog");
    await palette.getByRole("textbox").fill("informe en Acme");
    await expect(palette).toContainText(/buscando en acme/i);
    await expect(palette.getByRole("option", { name: /informe para acme/i })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");
  }
});
