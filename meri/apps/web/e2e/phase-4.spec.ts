import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { demoLogin, expectAccessible, goto, hydrated, reseedDemo } from "./helpers";

/**
 * Phase 4 E2E (phases/04 PLAN step 13): /precios → Control → «Añadir tarjeta» (simulated hosted checkout through
 * the real webhook handler) → buy credits → cancel with survey → reactivate; the value report with its method and
 * sources and the weekly review on the demo workspace; credits used up → «IA en pausa» banner while Hoy and the
 * calendar keep working. Same servers and frozen clock as the other phases (DEMO_NOW=2026-10-20T08:40:00Z).
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const email = () => `e2e4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@meri.local`;

async function signUp(page: Page): Promise<string> {
  const address = email();
  await page.goto("/login?manual=1");
  await hydrated(page);
  await page.getByLabel(/correo|email/i).fill(address);
  await page.getByRole("button", { name: /entrar|continuar|sign in|iniciar/i }).click();
  await page.waitForURL(/onboarding/);
  await hydrated(page);
  await page.getByLabel(/zona horaria|time zone/i).selectOption("Europe/Madrid");
  await page.getByRole("button", { name: /guardar|empezar|continuar|save|start/i }).click();
  await page.waitForURL(/\/hoy/);
  await hydrated(page);
  return address;
}

test.describe("phase 4: plans, credits, value and reviews", () => {
  test.beforeAll(() => {
    reseedDemo();
  });

  test("the public pricing page compares the catalogue plans, monthly and yearly", async ({ page }) => {
    await goto(page, "/precios");
    await expect(page.getByRole("heading", { level: 1, name: /precios/i })).toBeVisible();
    await expect(page.getByText(/precios en prueba/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pro", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Pro+" })).toBeVisible();
    await expect(page.getByText("1500 créditos de IA al mes").or(page.getByText("1.500 créditos de IA al mes"))).toBeVisible();
    await page.getByRole("radio", { name: /anual/i }).click();
    await expect(page.getByText(/al año/).first()).toBeVisible();
    await expectAccessible(page, "precios");
    await expect(page.getByRole("link", { name: /empezar la prueba/i }).first()).toHaveAttribute("href", "/login");
  });

  test("trial → add a card → buy credits → cancel with survey → reactivate", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "the billing lifecycle runs once, on desktop");
    await signUp(page);
    await goto(page, "/control#plan");
    const plan = page.locator("#plan");
    await expect(plan.getByText("En prueba")).toBeVisible();
    await expect(plan.getByText(/la prueba termina el/i)).toBeVisible();
    await expectAccessible(page, "control-plan");

    await plan.getByRole("button", { name: /añadir tarjeta/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: /elige tu plan/i })).toBeVisible();
    await dialog.getByRole("button", { name: "Elegir Pro", exact: true }).click();
    await page.waitForURL(/\/control\?billing=success|\/control#plan|\/control$/);
    await hydrated(page);
    await expect(page.getByRole("status").filter({ hasText: /tu plan está actualizado/i })).toBeVisible();
    await expect(plan.getByText("Prueba con tarjeta")).toBeVisible();
    await expect(plan.getByText(/el primer cobro será/i)).toBeVisible();

    await plan.getByRole("button", { name: /comprar créditos/i }).click();
    await page.getByRole("dialog").getByRole("button", { name: /^500 créditos$/ }).click();
    await page.waitForURL(/\/control/);
    await hydrated(page);
    await expect(page.locator("#plan").getByText(/de 800 créditos este mes/)).toBeVisible();

    await page.locator("#plan").getByRole("button", { name: /cancelar suscripción/i }).click();
    const cancel = page.getByRole("dialog");
    await expect(cancel.getByRole("button", { name: /cancelar al final del periodo/i })).toBeDisabled();
    await cancel.getByLabel("Es caro para mí").check();
    await cancel.getByLabel(/algo más que quieras contarnos/i).fill("Probando la encuesta");
    await expectAccessible(page, "cancel-dialog");
    await cancel.getByRole("button", { name: /cancelar al final del periodo/i }).click();
    await expect(page.getByRole("status").filter({ hasText: /cancelada/i })).toBeVisible();
    await expect(page.locator("#plan").getByText("Termina al final del periodo")).toBeVisible();

    await page.locator("#plan").getByRole("button", { name: /reactivar/i }).click();
    await expect(page.locator("#plan").getByText("Termina al final del periodo")).toHaveCount(0);
    await expect(page.locator("#plan").getByRole("button", { name: /cancelar suscripción/i })).toBeVisible();
  });

  test("value report: every figure explains its method and links its sources; weekly review", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "covered on mobile by the Más pages test");
    await demoLogin(page);
    await goto(page, "/control");
    const saved = page.getByRole("listitem").filter({ hasText: "Compromisos salvados" });
    await expect(saved).toContainText("1");
    await saved.getByRole("button", { name: /cómo se calcula/i }).click();
    await expect(saved).toContainText("Compromiso cumplido antes de su fecha.");
    await expect(saved.getByRole("link", { name: "Enviar el acta de la reunión" })).toBeVisible();
    const hours = page.getByRole("listitem").filter({ hasText: "Horas recuperadas" });
    await expect(hours).toContainText(/estimadas/);
    await page.getByRole("radio", { name: /este mes/i }).click();
    await expect(saved).toContainText("1");
    await expect(page.getByRole("heading", { name: "Revisión semanal" })).toBeVisible();
    await expect(page.getByRole("list", { name: /carga por día/i })).toBeVisible();
    await expectAccessible(page, "control-value");
  });

  test("Más → Plan y créditos and Valor y revisión", async ({ page }) => {
    await demoLogin(page);
    await goto(page, "/mas");
    await page.getByRole("link", { name: /plan y créditos/i }).click();
    await page.waitForURL(/\/mas\/plan/);
    await hydrated(page);
    await expect(page.locator("#plan").getByText("En prueba")).toBeVisible();
    await expect(page.locator("#plan").getByText(/quedan 9 días/)).toBeVisible();
    await expectAccessible(page, "mas-plan");
    await goto(page, "/mas");
    await page.getByRole("link", { name: /valor y revisión/i }).click();
    await page.waitForURL(/\/mas\/valor/);
    await hydrated(page);
    await expect(page.getByText("Compromisos salvados")).toBeVisible();
    await expectAccessible(page, "mas-valor");
  });

  test("credits used up: the AI pauses with a banner while Hoy and the calendar keep working", async ({ page }, info) => {
    test.skip(info.project.name === "mobile", "runs once, on desktop");
    const address = await signUp(page);
    execSync(`pnpm e2e:fixture --exhaust-credits=${address}`, { cwd: root, stdio: "inherit" });
    await goto(page, "/hoy");
    const banner = page.getByRole("status").filter({ hasText: /ia en pausa/i });
    await expect(banner).toContainText(/se agotaron los créditos/i);
    await expect(banner).toContainText(/el plan y el calendario siguen funcionando/i);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/20 de octubre/i);
    // Capture still works (rules path) and the calendar renders.
    await goto(page, "/calendario");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await goto(page, "/control#plan");
    await expect(page.locator("#plan").getByText(/créditos agotados/i)).toBeVisible();
  });
});
