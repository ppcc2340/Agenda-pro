import { describe, expect, it } from "vitest";
import { parseCapture } from "./parse";

const ctx = {
  now: "2026-10-19T13:40:00Z", // Monday 10:40 in Santiago (UTC-3)
  timezone: "America/Santiago",
  clients: [
    { id: "c1", name: "Acme Corp" },
    { id: "c2", name: "Estudio Norte" },
    { id: "c3", name: "Beta Logística" },
  ],
};

describe("parseCapture (F-02 rules fallback)", () => {
  it("understands the demo sentence: client, weekday and duration", () => {
    const s = parseCapture("Informe para Acme el jueves, 2 h", ctx);
    expect(s.clientId).toBe("c1");
    expect(s.dueAt).toBe("2026-10-22T21:00:00.000Z"); // Thursday 18:00 local
    expect(s.dueText).toBe("el jueves");
    expect(s.estimateMinutes).toBe(120);
    expect(s.kind).toBe("deep");
    expect(s.title).toBe("Informe para Acme");
    expect(s.confidence).toBeCloseTo(0.91, 2);
  });

  it("handles today, tomorrow, numeric dates, minutes and priority in es/en", () => {
    expect(parseCapture("Llamar a Beta hoy 30 min urgente", ctx)).toMatchObject({
      clientId: "c3",
      dueAt: "2026-10-19T21:00:00.000Z",
      estimateMinutes: 30,
      kind: "shallow",
      priority: 1,
      title: "Llamar a Beta",
    });
    expect(parseCapture("Review budget tomorrow 1.5 hours", ctx)).toMatchObject({
      dueAt: "2026-10-20T21:00:00.000Z",
      estimateMinutes: 90,
      title: "Review budget",
    });
    expect(parseCapture("Enviar contrato 03/11 importante", ctx)).toMatchObject({
      dueAt: "2026-11-03T21:00:00.000Z",
      priority: 2,
      title: "Enviar contrato",
    });
    expect(parseCapture("Audiencia el lunes", ctx).dueAt).toBe("2026-10-26T21:00:00.000Z"); // next Monday, never today
  });

  it("keeps a plain title as is with low confidence and ignores short client fragments", () => {
    const s = parseCapture("  Revisar   factura  ", { ...ctx, clients: [{ id: "x", name: "Re" }] });
    expect(s).toMatchObject({
      title: "Revisar factura",
      clientId: null,
      dueAt: null,
      estimateMinutes: null,
      priority: null,
      kind: null,
    });
    expect(s.confidence).toBeCloseTo(0.55, 2);
    expect(parseCapture("mañana", ctx).title).toBe("mañana");
  });

  it("respects the injected clock and time zone (Europe/Madrid, DST change week)", () => {
    const madrid = { ...ctx, now: "2026-10-23T08:00:00Z", timezone: "Europe/Madrid" }; // Friday
    expect(parseCapture("Cierre el lunes", madrid).dueAt).toBe("2026-10-26T17:00:00.000Z"); // after DST end: 18:00 CET = 17:00Z
    expect(parseCapture("Cierre el sábado", madrid).dueAt).toBe("2026-10-24T16:00:00.000Z"); // still CEST
  });
});
