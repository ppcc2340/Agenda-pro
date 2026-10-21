import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { IntegrationError } from "../errors";
import { SIGNATURE_TOLERANCE_SECONDS, signWebhook, verifyWebhookSignature } from "./signature";

/** P5-06: the `Stripe-Signature` parser takes attacker-controlled input; it may only accept or throw IntegrationError. */
const secret = fc.string({ minLength: 1, maxLength: 64 });
const body = fc.string({ maxLength: 512 });
const now = fc.integer({ min: 1_000_000_000, max: 4_000_000_000 });
const headerAlphabet = fc.constantFrom(..."t=v1v0,= \t0123456789abcdef-.;:\u0000é".split(""));
const hostileHeader = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc.string({ unit: headerAlphabet, maxLength: 200 }),
);

const verdict = (input: Parameters<typeof verifyWebhookSignature>[0]): "ok" | "rejected" => {
  try {
    verifyWebhookSignature(input);
    return "ok";
  } catch (e) {
    expect(e).toBeInstanceOf(IntegrationError);
    expect((e as IntegrationError).kind).toBe("Permanent");
    return "rejected";
  }
};

describe("verifyWebhookSignature properties", () => {
  it("accepts every signature it produced within the tolerance", () => {
    fc.assert(
      fc.property(
        secret,
        body,
        now,
        fc.integer({ min: -SIGNATURE_TOLERANCE_SECONDS, max: SIGNATURE_TOLERANCE_SECONDS }),
        (s, b, n, skew) => {
          expect(verdict({ secret: s, rawBody: b, header: signWebhook(s, b, n + skew), nowSeconds: n })).toBe(
            "ok",
          );
        },
      ),
    );
  });

  it("rejects a changed body, a different secret or a timestamp outside the tolerance", () => {
    fc.assert(
      fc.property(secret, body, now, fc.string({ minLength: 1, maxLength: 8 }), (s, b, n, extra) => {
        const header = signWebhook(s, b, n);
        expect(verdict({ secret: s, rawBody: b + extra, header, nowSeconds: n })).toBe("rejected");
        expect(verdict({ secret: s + extra, rawBody: b, header, nowSeconds: n })).toBe("rejected");
        const stale = signWebhook(s, b, n - SIGNATURE_TOLERANCE_SECONDS - 1);
        expect(verdict({ secret: s, rawBody: b, header: stale, nowSeconds: n })).toBe("rejected");
      }),
    );
  });

  it("keeps a valid v1 among unknown keys, v0 entries and decoy signatures", () => {
    fc.assert(
      fc.property(
        secret,
        body,
        now,
        fc.array(
          fc.string({
            unit: fc.integer({ min: 0, max: 15 }).map((n) => n.toString(16)),
            minLength: 64,
            maxLength: 64,
          }),
          {
            maxLength: 3,
          },
        ),
        (s, b, n, decoys) => {
          const signed = signWebhook(s, b, n);
          const header = [signed, ...decoys.map((d) => `v1=${d}`), "v0=deadbeef", "scheme=x"].join(",");
          expect(verdict({ secret: s, rawBody: b, header, nowSeconds: n })).toBe("ok");
        },
      ),
    );
  });

  it("never crashes and never accepts arbitrary headers", () => {
    fc.assert(
      fc.property(secret, body, now, hostileHeader, (s, b, n, header) => {
        expect(verdict({ secret: s, rawBody: b, header, nowSeconds: n })).toBe("rejected");
      }),
      { numRuns: 500 },
    );
  });
});
