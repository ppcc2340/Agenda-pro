import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { demoLogin, expectAccessible, goto, hydrated } from "./helpers";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Phase 6 E2E (phases/06 PLAN): the closed-beta waitlist on /login (through the web proxy, so CSRF and Origin are the
 * real ones), «Enviar comentarios», and the AI review consent (off by default) on a fresh account.
 */
const email = (p: string) =>
  `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@meri.local`;

async function signUp(page: Page): Promise<string> {
  const address = email("e2e6");
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

test.describe("phase 6: closed beta, feedback and AI review consent", () => {
  test("a sign-in without invitation lands on the waitlist, which takes an address with consent", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/login?manual=1&beta=invite");
    await hydrated(page);
    const beta = page.getByRole("region", { name: "Meri está en beta cerrada" });
    // A neutral note, not an error, followed directly by the waitlist.
    await expect(beta.getByRole("status")).toContainText("este correo todavía no tiene una");
    // Scoped to the page: Next.js keeps its own route announcer with role="alert".
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await expectAccessible(page, "login-waitlist");
    await beta.getByLabel("Correo", { exact: true }).fill(email("waitlist"));
    // Consent is required by the form and by the API.
    await beta.getByRole("button", { name: "Unirme a la lista" }).click();
    await expect(page.getByText("Te uniste a la lista")).toHaveCount(0);
    await beta.getByRole("checkbox").check();
    await beta.getByRole("button", { name: "Unirme a la lista" }).click();
    const done = page.getByText("Te uniste a la lista. Te escribiremos si se abre una plaza.");
    await expect(done).toBeVisible();
    await expect(done).toBeFocused();
    await context.close();
  });

  test("«Enviar comentarios» stores the comment and confirms it", async ({ page, isMobile }) => {
    await demoLogin(page);
    // Desktop: in the rail. Mobile: there is no rail; it lives in «Más».
    if (isMobile) await goto(page, "/mas");
    await page.getByRole("button", { name: "Enviar comentarios" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Enviar comentarios" });
    await expect(dialog).toBeVisible();
    await expectAccessible(page, "feedback-dialog");
    await dialog.getByRole("button", { name: "Algo falla" }).click();
    await expect(dialog.getByRole("button", { name: "Enviar" })).toBeDisabled();
    await dialog.getByLabel("Comentario").fill("El resumen del viernes no aparece en el móvil.");
    await dialog.getByRole("button", { name: "Enviar" }).click();
    await expect(page.getByText("Gracias. Comentario enviado.")).toBeVisible();
    await expect(dialog).toBeHidden();
  });

  test("the AI review consent is off by default and can be turned on and off", async ({ page }) => {
    await signUp(page);
    await goto(page, "/control");
    const consent = page.getByRole("checkbox", { name: /Ayudar a mejorar la IA de Meri/ });
    await expect(consent).not.toBeChecked();
    await consent.check();
    await expect(page.getByText(/podrán entrar en la revisión de calidad/)).toBeVisible();
    await page.reload();
    await hydrated(page);
    await expect(page.getByRole("checkbox", { name: /Ayudar a mejorar la IA de Meri/ })).toBeChecked();
    await page.getByRole("checkbox", { name: /Ayudar a mejorar la IA de Meri/ }).uncheck();
    await expect(page.getByText(/ya no entrarán en nuevas muestras/)).toBeVisible();
  });

  test("email preference: «Solo lo esencial» by default, changed in Control and kept", async ({ page }) => {
    await signUp(page);
    await goto(page, "/control#correo");
    const group = page.getByRole("group", { name: "Recibir por correo" });
    await expect(group.getByRole("radio", { name: /Solo lo esencial/ })).toBeChecked();
    await expectAccessible(page, "control-email");
    await group.getByRole("radio", { name: /^Todo/ }).check();
    await expect(page.getByText("Preferencia de correo guardada.")).toBeVisible();
    await page.reload();
    await hydrated(page);
    await expect(
      page.getByRole("group", { name: "Recibir por correo" }).getByRole("radio", { name: /^Todo/ }),
    ).toBeChecked();
  });

  test("the public unsubscribe page never acts on open and refuses an invalid link", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/correo/baja?t=not-a-token");
    await hydrated(page);
    await expect(page.getByRole("heading", { name: "Dejar de recibir correos" })).toBeVisible();
    await expectAccessible(page, "unsubscribe");
    await page.getByRole("button", { name: "Dejar de recibir correos" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Este enlace no es válido");
    await page.goto("/correo/baja");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Este enlace no es válido");
    await context.close();
  });

  test("the Sean Ellis question appears in Hoy after two weeks and is answered once", async ({ page }) => {
    const address = await signUp(page);
    // No survey on day one.
    await expect(page.getByText("Una pregunta rápida")).toHaveCount(0);
    execSync(`pnpm e2e:fixture --onboarded-days-ago=${address}:20`, { cwd: root, stdio: "inherit" });
    await page.reload();
    await hydrated(page);
    const card = page.getByRole("region", { name: "¿Cómo te sentirías si ya no pudieras usar Meri?" });
    await expect(card).toBeVisible();
    await expectAccessible(page, "sean-ellis");
    await card.getByRole("radio", { name: "Me decepcionaría mucho" }).check();
    await card.getByLabel(/Qué es lo que más te aporta/).fill("Ver los plazos de todos mis clientes juntos.");
    await card.getByRole("button", { name: "Enviar" }).click();
    await expect(page.getByText("Gracias por responder.")).toBeVisible();
    await expect(card).toBeHidden();
    await page.reload();
    await hydrated(page);
    await expect(page.getByText("Una pregunta rápida")).toHaveCount(0);
  });

  test("the public pricing page says beta prices may differ per account", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/precios");
    await hydrated(page);
    await expect(page.getByText(/algunas cuentas ven precios distintos/)).toBeVisible();
    await context.close();
  });
});
