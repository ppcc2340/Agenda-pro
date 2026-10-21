import { expect, test, type Page } from "@playwright/test";
import { demoLogin, expectAccessible, goto, hydrated } from "./helpers";

/**
 * Phase 5 E2E (phases/05 PLAN): «Permisos» from the granted scopes, retention editor, ZIP export link, and «Cerrar
 * sesión en todos los dispositivos» ending the session (a fresh account, never the shared demo one).
 */
const email = () => `e2e5-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@meri.local`;

async function signUp(page: Page): Promise<void> {
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

test.describe("phase 5: permissions, retention, export and sessions", () => {
  test("«Cómo protegemos tus datos» is public, linked from login, pricing and the legal pages, and accessible", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const from of ["/login?manual=1", "/precios", "/privacy", "/terms"]) {
      await page.goto(from);
      await expect(page.getByRole("link", { name: "Cómo protegemos tus datos" })).toHaveAttribute(
        "href",
        "/seguridad",
      );
    }
    await page.goto("/seguridad");
    await expect(page).toHaveURL(/\/seguridad$/);
    await expect(page.getByRole("heading", { level: 1, name: "Cómo protegemos tus datos" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Qué no hacemos nunca" })).toBeVisible();
    await expectAccessible(page, "security-page");
    await context.close();
  });

  test("Control shows the real permissions, what Meri never does, and the export formats", async ({
    page,
  }) => {
    await demoLogin(page);
    await goto(page, "/control");
    await expect(page.getByRole("heading", { name: "Permisos" })).toBeVisible();
    await expect(page.getByText("Meri nunca, con ningún permiso:")).toBeVisible();
    await expect(page.getByText("Envía un correo en tu nombre.")).toBeVisible();
    await expect(page.getByRole("link", { name: /exportar en zip/i })).toHaveAttribute(
      "href",
      "/api/v1/account/export?format=zip",
    );
    await expectAccessible(page, "control-permissions");
  });

  test("the retention window can be changed and «Cerrar sesión en todos los dispositivos» ends the session", async ({
    page,
  }, info) => {
    test.skip(info.project.name === "mobile", "runs once, on desktop");
    await signUp(page);
    await goto(page, "/control");
    const retention = page.getByLabel(/conservar citas y propuestas descartadas/i);
    await retention.selectOption("30");
    await expect(page.getByRole("status").filter({ hasText: /retención guardada: 30 días/i })).toBeVisible();
    const cookies = await page.context().cookies();
    await page.getByRole("button", { name: /cerrar sesión en todos los dispositivos/i }).click();
    await page.waitForURL(/\/login/);
    // The old cookie, replayed, is refused by the API.
    const replay = await page.request.get("/api/v1/me", {
      headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") },
    });
    expect(replay.status()).toBe(401);
  });
});
