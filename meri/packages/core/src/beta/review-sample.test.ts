import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isReviewEligible, redactForReview, redactValue } from "./review-sample";

describe("AI review sample (D-103, SEC-H2)", () => {
  it("only discarded or edited proposals that do not come from the mailbox", () => {
    expect(isReviewEligible({ kind: "capture", status: "dismissed", sourceType: null })).toBe(true);
    expect(isReviewEligible({ kind: "commitment", status: "edited", sourceType: "event" })).toBe(true);
    expect(isReviewEligible({ kind: "reschedule", status: "dismissed", sourceType: "plan_run" })).toBe(true);
    expect(isReviewEligible({ kind: "commitment", status: "dismissed", sourceType: "thread" })).toBe(false);
    expect(isReviewEligible({ kind: "followup", status: "dismissed", sourceType: null })).toBe(false);
    expect(isReviewEligible({ kind: "client_link", status: "edited", sourceType: null })).toBe(false);
    expect(isReviewEligible({ kind: "capture", status: "confirmed", sourceType: null })).toBe(false);
    expect(isReviewEligible({ kind: "capture", status: "pending", sourceType: null })).toBe(false);
  });

  it("redacts addresses, links, RUTs, phones, long numbers and the workspace's names", () => {
    const text =
      "Llamar a Ana Pérez (+56 9 8765 4321) de Acme SpA, RUT 76.123.456-K, ana.perez@acme.cl, ver https://acme.cl/x?id=9 expediente 512345";
    const out = redactForReview(text, ["Ana Pérez", "Acme SpA", "Acme", "Al"]);
    expect(out).toBe(
      "Llamar a [nombre] ([teléfono]) de [nombre], RUT [rut], [correo], ver [enlace] expediente [número]",
    );
    // A short name is not used (it would shred ordinary words), and words merely containing a name survive.
    expect(redactForReview("Alta prioridad para Acmeware", ["Al", "Acme"])).toBe(
      "Alta prioridad para Acmeware",
    );
  });

  it("drops identifier keys and redacts nested strings", () => {
    expect(
      redactValue(
        {
          title: "Enviar a Bruno",
          eventId: "01a1-…",
          nested: { note: "bruno@x.com", list: ["Bruno"] },
          n: 3,
        },
        ["Bruno"],
      ),
    ).toEqual({ title: "Enviar a [nombre]", nested: { note: "[correo]", list: ["[nombre]"] }, n: 3 });
  });

  it("property: no email address or name survives redaction", () => {
    const local = fc.stringMatching(/^[a-z][a-z0-9._-]{0,10}$/);
    const domain = fc.stringMatching(/^[a-z]{2,10}\.(com|cl|es)$/);
    const name = fc.stringMatching(/^[A-Z][a-z]{3,9}$/);
    fc.assert(
      fc.property(local, domain, name, fc.string({ maxLength: 40 }), (l, d, n, filler) => {
        const out = redactForReview(`${filler} ${n} ${l}@${d} ${filler}`, [n]);
        expect(out).not.toContain(`${l}@${d}`);
        expect(out).not.toMatch(new RegExp(`(?<![\\p{L}\\p{N}])${n}(?![\\p{L}\\p{N}])`, "iu"));
      }),
      { numRuns: 300 },
    );
  });
});
