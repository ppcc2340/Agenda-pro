import { expect, test, type Page } from "@playwright/test";
import { demoLogin, goto, hydrated } from "./helpers";

/**
 * Phase 5 (D-080): the real servers send a per-request CSP nonce, no inline script runs without it, and the main
 * screens load with zero CSP violations (the listener is injected by Playwright, outside the page's CSP).
 */
async function recordViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
}
const violations = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

test.describe("security headers and CSP", () => {
  test("every page response carries a fresh nonce and the hardening headers", async ({ request }) => {
    const first = await request.get("/precios");
    const second = await request.get("/precios");
    const csp = first.headers()["content-security-policy"] ?? "";
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(second.headers()["content-security-policy"]).not.toBe(csp);
    expect(first.headers()["x-content-type-options"]).toBe("nosniff");
    expect(first.headers()["x-frame-options"]).toBe("SAMEORIGIN");
    expect(first.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    // Next stamps the nonce on its own scripts; no script tag is left without it.
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1] ?? "";
    const html = await first.text();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);
  });

  test("the app loads without CSP violations (public page, Hoy, Control)", async ({ page }) => {
    await recordViolations(page);
    await goto(page, "/precios");
    await hydrated(page);
    expect(await violations(page)).toEqual([]);
    await demoLogin(page);
    for (const url of ["/hoy", "/control"]) {
      await goto(page, url);
      await hydrated(page);
      expect(await violations(page), url).toEqual([]);
    }
  });
});
