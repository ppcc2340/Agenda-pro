import { expect, test } from "@playwright/test";
import { demoLogin, expectAccessible, goto, pressWithKeyboard, reseedDemo, shot } from "./helpers";

/**
 * Desktop prototype (PROTOTYPE.md criteria 1–10, 1280×800) over the seeded demo workspace. Each test signs in
 * on its own; the suite is serial because some steps build on the previous ones (the reorganisation).
 */
test.describe.configure({ mode: "serial" });
test.beforeAll(() => {
  reseedDemo();
});

const BLOCKS = 'main button[aria-pressed][aria-label*="–"]';

test("DEMO_MODE: /login signs in as the demo user by itself", async ({ page }) => {
  await page.goto("/login");
  await page.waitForURL(/\/hoy/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/martes 20 de octubre/i);
});

test("1. Hoy: day line by the planner, now line, hatched margin, four questions, why here", async ({ page }) => {
  await demoLogin(page);
  await expect(page.locator(BLOCKS).first()).toBeVisible();
  await expect(page.getByTestId("margin")).toBeVisible();
  await expect(page.getByTestId("margin")).toHaveAttribute("title", /margen para imprevistos/i);
  await expect(page.getByText("10:40", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/llamada semanal con acme/i).first()).toBeVisible();
  for (const q of [/qué hago ahora/i, /lo más importante hoy/i, /qué podría salir mal/i, /esperando de otras personas/i])
    await expect(page.getByRole("heading", { name: q })).toBeVisible();
  await shot(page, "desktop-hoy");
  await expectAccessible(page, "hoy");
  // Keyboard only: focus a block, Enter → the explanation region receives focus with a visible ring.
  await pressWithKeyboard(page, page.locator(BLOCKS).first());
  const detail = page.getByRole("region", { name: /./ }).first();
  await expect(detail).toBeFocused();
  await expect(detail).toContainText(/por qué está aquí/i);
  expect(await page.evaluate(() => document.activeElement?.matches(":focus-visible") ?? false)).toBe(true);
  await shot(page, "desktop-hoy-detalle");
});

test("2. Capture with Ctrl K: dashed chips from the real parser, proposal in Entrada in < 1 s, undo", async ({ page }) => {
  await demoLogin(page);
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog");
  await palette.getByRole("combobox").fill("Informe para Acme el jueves, 2 h");
  await expect(palette).toContainText(/acme corp/i);
  await expect(palette).toContainText(/2 h/);
  await expect(palette).toContainText(/jueves|jue/i);
  await shot(page, "desktop-captura");
  await expectAccessible(page, "captura (palette open)");
  const started = Date.now();
  await palette.getByRole("combobox").press("Enter");
  await expect(page.getByRole("status")).toContainText(/capturado en entrada/i);
  const elapsed = Date.now() - started;
  test.info().annotations.push({ type: "capture-ms", description: String(elapsed) });
  expect(elapsed).toBeLessThan(1000);
  // Undo from the toast removes the proposal.
  await page.getByRole("status").getByRole("button", { name: /deshacer/i }).click();
  await goto(page, "/entrada");
  await expect(page.locator("article", { hasText: /informe para acme/i })).toHaveCount(0);
});

test("3. Entrada: confirm, edit and dismiss, by mouse and keyboard; dismissal recorded as feedback", async ({ page }) => {
  await demoLogin(page);
  await goto(page, "/entrada");
  const cards = page.locator("article", { hasText: /se compromete contigo|te comprometes con/i });
  await expect.poll(() => cards.count()).toBeGreaterThanOrEqual(3);
  await shot(page, "desktop-entrada");
  await expectAccessible(page, "entrada");
  const before = await page.locator("article").count();
  await cards.first().getByRole("button", { name: /^confirmar$/i }).click();
  await expect(page.getByRole("status")).toContainText(/ya está en tus compromisos/i);
  await cards.first().getByRole("button", { name: /^editar$/i }).click();
  await cards.first().getByRole("button", { name: /guardar y confirmar/i }).click();
  await expect(page.locator("article")).toHaveCount(before - 2);
  await pressWithKeyboard(page, cards.first().getByRole("button", { name: /^descartar$/i }));
  await expect(page.getByRole("status")).toContainText(/descartada/i);
  await expect(page.locator("article")).toHaveCount(before - 3);
  const audit = await (await page.request.get("/api/v1/audit?limit=3")).json();
  expect((audit as { items: { action: string }[] }).items.map((i) => i.action)).toContain("proposal.dismissed");
});

test("4. Reorganize: real planner diff, accept writes Meri blocks only, audited and undoable", async ({ page }) => {
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
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(/ninguna reunión se mueve/i);
  await shot(page, "desktop-reorganizar");
  await expectAccessible(page, "reorganizar (dialog)");
  await page.getByRole("button", { name: /aceptar cambios/i }).click();
  await expect(page.getByRole("status")).toContainText(/cambios aplicados/i);
  // Only Meri blocks reach the (fake) calendar: the meeting is still exactly where it was.
  const events = (await (await page.request.get("/api/v1/calendar/events?from=2026-10-20T00:00:00Z&to=2026-10-21T00:00:00Z")).json()) as {
    items: { title: string; origin: string; startsAt: string }[];
  };
  const acme = events.items.find((e) => /llamada semanal con acme/i.test(e.title));
  expect(acme?.startsAt).toBe("2026-10-20T07:30:00.000Z");
  await goto(page, "/control");
  const accepted = page.locator("li", { hasText: /aceptaste una reorganización/i }).first();
  await accepted.getByRole("button", { name: /deshacer/i }).click();
  await expect(page.getByRole("status")).toContainText(/deshecha/i);
  await expect(accepted).toContainText(/deshecho/i);
  expect((await page.request.put("/api/v1/preferences", { headers: csrf, data: { workEnd: "18:00" } })).status()).toBe(200);
});

test("5. Commitments: Debo / Me deben, client filter, follow-up draft in FakeGmail, no send route", async ({ page }) => {
  await demoLogin(page);
  await goto(page, "/proyectos?tab=compromisos&dir=owed_to_me");
  await expect(page.getByRole("button", { name: /me deben/i })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: /^acme corp$/i }).click();
  await expect(page.locator("li", { hasText: /luna legal|beta logística/i })).toHaveCount(0);
  const overdue = page.locator("li", { hasText: /datos de ventas/i }).first();
  await expect(overdue).toContainText(/vencido/i);
  await shot(page, "desktop-compromisos");
  await expectAccessible(page, "compromisos");
  await overdue.getByRole("button", { name: /preparar seguimiento/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(/meri solo crea borradores/i);
  await expect(dialog.getByRole("textbox", { name: /borrador/i })).toHaveValue(/datos de ventas/i, { timeout: 20_000 });
  await dialog.getByRole("button", { name: /guardar borrador en gmail/i }).click();
  await expect(page.getByRole("status")).toContainText(/borrador guardado en gmail/i);
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: /^debo/i }).click();
  await expect(page.locator("li", { hasText: /informe trimestral|propuesta revisada/i }).first()).toBeVisible();
  for (const url of ["/api/v1/mail/send", "/api/v1/gmail/send", "/api/v1/commitments/send"]) {
    const res = await page.request.post(url, { headers: { "x-requested-with": "meri" }, data: {} });
    expect(res.status(), url).toBe(404);
  }
});

test("6. Time: suggested from events and blocks, approve one and all, CSV with the documented columns", async ({ page }) => {
  await demoLogin(page);
  await goto(page, "/proyectos?tab=tiempo");
  await expect(page.getByText(/aprobadas esta semana/i)).toBeVisible();
  await expect(page.getByText(/sugeridas, esperan tu revisión/i)).toBeVisible();
  const suggested = page.locator("li", { hasText: /sugerida/i });
  await expect.poll(() => suggested.count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByText(/bloque completado/i).first()).toBeVisible();
  await expect(page.getByText(/evento de calendario/i).first()).toBeVisible();
  await expect(page.getByText(/evento sin tiempo registrado/i).first()).toBeVisible();
  await shot(page, "desktop-tiempo");
  await expectAccessible(page, "tiempo");
  const n = await suggested.count();
  await suggested.first().getByRole("button", { name: /^aprobar$/i }).click();
  await expect(page.getByRole("status")).toContainText(/entrada aprobada/i);
  await expect(suggested).toHaveCount(n - 1);
  await page.getByRole("button", { name: new RegExp(`aprobar la(s)? ${String(n - 1)}|aprobar la sugerida`, "i") }).click();
  await expect(page.getByRole("status")).toContainText(/aprobada/i);
  await expect(suggested).toHaveCount(0);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: /exportar csv/i }).click()]);
  expect(download.suggestedFilename()).toMatch(/^meri-tiempo-2026-W43\.csv$/);
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk));
  const lines = Buffer.concat(chunks).toString("utf8").slice(1).trim().split("\r\n");
  expect(lines[0]).toBe('"fecha","cliente","asunto","descripcion","minutos","horas","origen","estado","aprobada_el"');
  expect(lines.length).toBeGreaterThanOrEqual(1 + n);
});

test("7. Clients: rows with colour and risk, briefing with linked sources from that client only", async ({ page }) => {
  await demoLogin(page);
  await goto(page, "/proyectos?tab=clientes");
  const rows = page.getByRole("list", { name: /clientes/i }).getByRole("listitem");
  await expect(rows).toHaveCount(4);
  await expect(page.getByText(/sin riesgos|en riesgo/i).first()).toBeVisible();
  await shot(page, "desktop-clientes");
  await expectAccessible(page, "clientes");
  await rows.filter({ hasText: /^Acme/ }).getByRole("button", { name: /generar briefing/i }).click();
  const briefing = page.getByRole("dialog");
  await expect(briefing).toContainText(/briefing de acme corp/i);
  await expect(briefing.getByRole("link", { name: /ver fuente/i }).first()).toBeVisible({ timeout: 20_000 });
  await expect(briefing).toContainText(/entrega del informe a acme/i);
  await expect(briefing).not.toContainText(/luna legal|beta logística|estudio norte/i);
  await shot(page, "desktop-briefing");
  await expectAccessible(page, "briefing (dialog)");
  await page.keyboard.press("Escape");
  await expect(briefing).toBeHidden();
});

test("8. Calendar: week with fixed meetings and Meri blocks told apart", async ({ page }) => {
  await demoLogin(page);
  await goto(page, "/calendario");
  const week = page.getByTestId("week-view");
  await expect(week).toBeVisible();
  await expect(week).toContainText(/llamada semanal con acme/i);
  const plan = (await (await page.request.get("/api/v1/plan")).json()) as { blocks: { taskId: string }[]; tasks: { id: string; title: string }[] };
  const scheduled = plan.tasks.find((t) => plan.blocks.some((b) => b.taskId === t.id));
  expect(scheduled).toBeDefined();
  await expect(week).toContainText(scheduled?.title ?? "");
  await expect(page.getByText(/bloques de meri/i).first()).toBeVisible();
  await shot(page, "desktop-calendario");
  await expectAccessible(page, "calendario");
});

test("9. Control centre: autonomy, connections, credits, activity with undo, privacy export and delete", async ({ page }) => {
  await demoLogin(page);
  await goto(page, "/control");
  const group = page.getByRole("group", { name: /autonomía/i });
  await group.getByRole("button", { name: /actuar en lo de bajo riesgo/i }).click();
  await expect(page.getByRole("status")).toContainText(/cambiaste la autonomía/i);
  await expect(page.getByText(/cambios seguros del plan/i)).toBeVisible();
  await group.getByRole("button", { name: /solo sugerir/i }).click();
  await expect(page.getByText(/meri propone y tú confirmas todo/i)).toBeVisible();
  await expect(page.getByText(/demo: cuenta simulada/i).first()).toBeVisible();
  await expect(page.getByText(/outlook y notion/i)).toBeVisible();
  await expect(page.getByText(/próximamente/i)).toBeVisible();
  await expect(page.getByRole("heading", { name: /créditos de ia/i })).toBeVisible();
  await expect(page.locator("li", { hasText: /cambiaste la autonomía/i }).first()).toBeVisible();
  await expect(page.locator("li").filter({ has: page.getByRole("button", { name: /deshacer/i }) }).first()).toBeVisible();
  await shot(page, "desktop-control");
  await expectAccessible(page, "control");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: /exportar mis datos/i }).click()]);
  expect(download.suggestedFilename()).toMatch(/^meri-export-\d{4}-\d{2}-\d{2}\.json$/);
  const chunks: Buffer[] = [];
  for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk));
  const doc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { format: string; clients: unknown[] };
  expect(doc.format).toBe("meri-export/1");
  expect(doc.clients).toHaveLength(4);
  await page.getByRole("button", { name: /eliminar mi cuenta/i }).click();
  await expect(page.getByRole("status")).toContainText(/en la demo no se elimina nada/i);
  await expect(page.getByText(/pausar lectura/i)).toBeVisible();
});

test("10. Quality: dark theme and English", async ({ page }) => {
  await demoLogin(page);
  await page.emulateMedia({ colorScheme: "dark" });
  await goto(page, "/hoy");
  await shot(page, "desktop-hoy-oscuro");
  await expectAccessible(page, "hoy (dark)");
  await page.emulateMedia({ colorScheme: "light" });
  await page.context().addCookies([{ name: "meri.locale", value: "en", url: "http://localhost:3000" }]);
  await goto(page, "/hoy");
  await expect(page.getByRole("heading", { name: /what do i do now/i })).toBeVisible();
  await shot(page, "desktop-hoy-en");
  await page.context().clearCookies({ name: "meri.locale" });
});
