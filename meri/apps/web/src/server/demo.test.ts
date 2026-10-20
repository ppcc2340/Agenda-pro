import { describe, expect, it } from "vitest";
import { safeNext } from "./demo";

describe("safeNext (open-redirect guard of the demo sign-in)", () => {
  it("keeps same-origin paths and falls back to /hoy for anything else", () => {
    expect(safeNext("/entrada")).toBe("/entrada");
    expect(safeNext("/clientes/1?briefing=1")).toBe("/clientes/1?briefing=1");
    expect(safeNext("//evil.test")).toBe("/hoy");
    expect(safeNext("/\\evil.test")).toBe("/hoy");
    expect(safeNext("https://evil.test")).toBe("/hoy");
    expect(safeNext("/\t/evil.test")).toBe("/hoy");
    expect(safeNext("/\n/evil.test")).toBe("/hoy");
    expect(safeNext("/a\\b")).toBe("/hoy");
    expect(safeNext(null)).toBe("/hoy");
    expect(safeNext(undefined)).toBe("/hoy");
  });
});
