import { expect, test } from "@playwright/test";
import { demoLogin, expectAccessible, goto, pressWithKeyboard, shot } from "./helpers";

/** Mobile prototype (PROTOTYPE.md, Pixel 7 = 412 px; plus a 360 px pass) over the seeded demo workspace. */
test.describe.configure({ mode: "serial" });

test("1. Hoy: «Ahora» card, why now, four questions", async ({ page }) => {
  await demoLogin(page);
  await expect(page.getByRole("button", { name: /marcar como hecho/i }).first()).toBeVisible();
  await expect(page.getByText(/por qué ahora/i).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /ver por qué está aquí/i })).toHaveCount(0);
  for (const q of [/qué hago ahora/i, /lo más importante hoy/i, /qué podría salir mal/i, /esperando de otras personas/i])
    await expect(page.getByRole("heading", { name: q })).toBeVisible();
  await shot(page, "mobile-hoy");
  await expectAccessible(page, "hoy");
});

test("2. Capture with the + button: dashed chips, Escape closes, proposal and undo", async ({ page }) => {
  await demoLogin(page);
  const plus = page.getByRole("button", { name: /capturar/i }).first();
  await plus.click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("textbox").fill("Informe para Acme el jueves, 2 h");
  await expect(sheet).toContainText(/acme corp/i);
  await expect(sheet).toContainText(/2 h/);
  await shot(page, "mobile-captura");
  await expectAccessible(page, "captura (sheet)");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(plus).toBeFocused();
  await plus.click();
  await sheet.getByRole("textbox").fill("Informe para Acme el jueves, 2 h");
  const started = Date.now();
  await sheet.getByRole("button", { name: /añadir a entrada/i }).click();
  await expect(page.getByRole("status")).toContainText(/capturado en entrada/i);
  test.info().annotations.push({ type: "capture-ms", description: String(Date.now() - started) });
  await page.getByRole("status").getByRole("button", { name: /deshacer/i }).click();
  await goto(page, "/entrada");
  await expect(page.locator("article", { hasText: /informe para acme/i })).toHaveCount(0);
});

test("3. Entrada: confirm with a tap, dismiss with the keyboard", async ({ page }) => {
  await demoLogin(page);
  await goto(page, "/entrada");
  const cards = page.locator("article", { hasText: /se compromete contigo|te comprometes con/i });
  await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(2);
  await shot(page, "mobile-entrada");
  await expectAccessible(page, "entrada");
  const before = await page.locator("article").count();
  await cards.first().getByRole("button", { name: /^confirmar$/i }).click();
  await expect(page.getByRole("status")).toContainText(/ya está en tus compromisos/i);
  await pressWithKeyboard(page, cards.first().getByRole("button", { name: /^descartar$/i }));
  await expect(page.getByRole("status")).toContainText(/descartada/i);
  await expect(page.locator("article")).toHaveCount(before - 2);
});

test("4. Reorganize from Hoy, undo from Más → Actividad", async ({ page }) => {
  await demoLogin(page);
  // A shorter work day (preferences) means the afternoon blocks no longer fit: the planner must move live
  // blocks, which is never applied by itself → reschedule proposal with the real diff (ADR 0003).
  const csrf = { "x-requested-with": "meri" };
  expect((await page.request.put("/api/v1/preferences", { headers: csrf, data: { workEnd: "15:00" } })).status()).toBe(200);
  const replan = await page.request.post("/api/v1/plan/replan", { headers: csrf, data: {} });
  expect(replan.status()).toBe(200);
  expect((await replan.json()) as { outcome: string }).toMatchObject({ outcome: "proposed" });
  await goto(page, "/hoy");
  const reorganize = page.getByRole("button", { name: /ver cómo reorganizar/i }).first();
  await expect(reorganize).toBeVisible();
  await reorganize.click();
  await expect(page.getByRole("dialog")).toContainText(/ninguna reunión se mueve/i);
  await shot(page, "mobile-reorganizar");
  await page.getByRole("button", { name: /aceptar cambios/i }).click();
  await expect(page.getByRole("status")).toContainText(/cambios aplicados/i);
  await goto(page, "/mas/actividad");
  const accepted = page.locator("li", { hasText: /aceptaste una reorganización/i }).first();
  await accepted.getByRole("button", { name: /deshacer/i }).click();
  await expect(page.getByRole("status")).toContainText(/deshecha/i);
  await expect(accepted).toContainText(/deshecho/i);
  expect((await page.request.put("/api/v1/preferences", { headers: csrf, data: { workEnd: "18:00" } })).status()).toBe(200);
});

test("5. Commitments tab: Me deben with client filter, follow-up draft", async ({ page }) => {
  await demoLogin(page);
  await page.getByRole("link", { name: /compromisos/i }).click();
  await page.waitForURL(/tab=compromisos/);
  await page.getByRole("button", { name: /me deben/i }).click();
  await page.getByRole("button", { name: /^acme corp$/i }).click();
  const overdue = page.locator("li", { hasText: /datos de ventas/i }).first();
  await expect(overdue).toContainText(/vencido/i);
  await shot(page, "mobile-compromisos");
  await expectAccessible(page, "compromisos");
  await overdue.getByRole("button", { name: /preparar seguimiento/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("textbox", { name: /borrador/i })).toHaveValue(/datos de ventas/i, { timeout: 20_000 });
  await dialog.getByRole("button", { name: /guardar borrador en gmail/i }).click();
  await expect(page.getByRole("status")).toContainText(/borrador guardado en gmail/i);
});

test("6. Agenda: day with the day strip, meetings and Meri blocks", async ({ page }) => {
  await demoLogin(page);
  await page.getByRole("link", { name: /agenda/i }).click();
  await page.waitForURL(/calendario/);
  const agenda = page.getByTestId("agenda-view");
  await expect(agenda).toBeVisible();
  await expect(agenda).toContainText(/llamada semanal con acme/i);
  await expect(page.getByRole("group", { name: /días de la semana/i }).getByRole("button")).toHaveCount(5);
  await shot(page, "mobile-agenda");
  await expectAccessible(page, "agenda");
});

test("7. Más: time (approve), clients and briefings, activity, autonomy and privacy", async ({ page }) => {
  await demoLogin(page);
  await page.getByRole("link", { name: /^más$/i }).click();
  await page.waitForURL(/\/mas$/);
  await expect(page.getByRole("link", { name: /tiempo/i })).toContainText(/entradas? sugeridas? por revisar/i);
  for (const name of [/clientes y briefings/i, /actividad/i, /autonomía y privacidad/i])
    await expect(page.getByRole("link", { name })).toBeVisible();
  await shot(page, "mobile-mas");
  await expectAccessible(page, "más");

  await page.getByRole("link", { name: /tiempo/i }).click();
  await page.waitForURL(/\/mas\/tiempo/);
  await expect(page.getByRole("button", { name: /capturar/i })).toHaveCount(0);
  await expect(page.getByText(/aprobadas/i).first()).toBeVisible();
  const suggested = page.locator("li", { hasText: /sugerida/i });
  await expect.poll(() => suggested.count()).toBeGreaterThanOrEqual(1);
  await shot(page, "mobile-tiempo");
  await expectAccessible(page, "tiempo");
  await suggested.first().getByRole("button", { name: /^aprobar$/i }).click();
  await expect(page.getByRole("status")).toContainText(/entrada aprobada/i);
  await page.getByRole("link", { name: /^más$/i }).first().click();
  await page.waitForURL(/\/mas$/);

  await page.getByRole("link", { name: /clientes y briefings/i }).click();
  await page.waitForURL(/\/mas\/clientes/);
  const rows = page.getByRole("list", { name: /clientes/i }).getByRole("listitem");
  await expect(rows).toHaveCount(4);
  await shot(page, "mobile-clientes");
  await rows.filter({ hasText: /^Acme/ }).getByRole("button", { name: /briefing/i }).click();
  const briefing = page.getByRole("dialog");
  await expect(briefing.getByRole("link", { name: /ver fuente/i }).first()).toBeVisible({ timeout: 20_000 });
  await expect(briefing).not.toContainText(/luna legal|beta logística|estudio norte/i);
  await expectAccessible(page, "briefing (sheet)");
  await page.keyboard.press("Escape");
  await expect(briefing).toBeHidden();

  await goto(page, "/mas/actividad");
  await expect(page.locator("li", { hasText: /aprobaste una entrada de tiempo/i }).first()).toBeVisible();
  await shot(page, "mobile-actividad");

  await goto(page, "/mas/ajustes");
  await page.getByRole("group", { name: /autonomía/i }).getByRole("button", { name: /bajo riesgo/i }).click();
  await expect(page.getByRole("status")).toContainText(/cambiaste la autonomía/i);
  await page.getByRole("group", { name: /autonomía/i }).getByRole("button", { name: /solo sugerir/i }).click();
  await expect(page.getByText(/demo: cuenta simulada/i).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: /créditos de ia/i })).toBeVisible();
  await page.getByRole("button", { name: /eliminar mi cuenta/i }).click();
  await expect(page.getByRole("status")).toContainText(/en la demo no se elimina nada/i);
  await shot(page, "mobile-ajustes");
  await expectAccessible(page, "ajustes");
});

test("10. Quality: 360 px without horizontal scroll, dark theme, English", async ({ page }) => {
  await demoLogin(page);
  await page.setViewportSize({ width: 360, height: 780 });
  for (const url of ["/hoy", "/entrada", "/proyectos?tab=compromisos", "/proyectos?tab=tareas", "/calendario", "/mas", "/mas/tiempo", "/mas/clientes"]) {
    await goto(page, url);
    expect(await page.evaluate(() => document.documentElement.scrollWidth), url).toBeLessThanOrEqual(360);
  }
  await goto(page, "/hoy");
  await shot(page, "mobile-hoy-360");
  await page.setViewportSize({ width: 412, height: 915 });
  await page.emulateMedia({ colorScheme: "dark" });
  await goto(page, "/hoy");
  await shot(page, "mobile-hoy-oscuro");
  await expectAccessible(page, "hoy (dark)");
  await page.emulateMedia({ colorScheme: "light" });
  await page.context().addCookies([{ name: "meri.locale", value: "en", url: "http://localhost:3000" }]);
  await goto(page, "/mas");
  await expect(page.getByRole("heading", { name: /^more$/i })).toBeVisible();
  await shot(page, "mobile-mas-en");
  await page.context().clearCookies({ name: "meri.locale" });
});
