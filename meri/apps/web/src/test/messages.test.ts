import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import es from "../../messages/es.json";

function keys(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [prefix];
  return Object.entries(obj).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe("i18n catalogues", () => {
  it("es and en expose exactly the same keys", () => {
    expect(keys(en).sort()).toEqual(keys(es).sort());
  });
  it("keeps the five areas and the product promises in both languages", () => {
    for (const m of [es, en]) {
      expect(Object.keys(m.nav.mobile)).toEqual(["hoy", "entrada", "agenda", "compromisos", "mas"]);
      expect([m.hoy.q1, m.hoy.q2, m.hoy.q3, m.hoy.q4].every((q) => q.endsWith("?"))).toBe(true);
      expect(m.control.connections.gmailScope.toLowerCase()).toMatch(
        /sin permiso de envío|no send permission/,
      );
    }
  });
});
