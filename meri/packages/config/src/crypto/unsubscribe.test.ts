import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "./unsubscribe";

const SECRET = "x".repeat(40);
const WS = "0192aaaa-0000-7000-8000-000000000042";

describe("email unsubscribe tokens (D-116)", () => {
  it("round-trips the workspace id and is stable", () => {
    const token = signUnsubscribeToken(SECRET, WS);
    expect(token).toBe(signUnsubscribeToken(SECRET, WS));
    expect(verifyUnsubscribeToken(SECRET, token)).toBe(WS);
  });

  it("rejects another secret, another workspace, tampering and malformed input", () => {
    const token = signUnsubscribeToken(SECRET, WS);
    const [, sig] = token.split(".");
    expect(verifyUnsubscribeToken("y".repeat(40), token)).toBeNull();
    expect(verifyUnsubscribeToken(SECRET, `0192aaaa-0000-7000-8000-000000000043.${sig ?? ""}`)).toBeNull();
    expect(verifyUnsubscribeToken(SECRET, `${token}x`)).toBeNull();
    expect(verifyUnsubscribeToken(SECRET, `${token}.extra`)).toBeNull();
    expect(verifyUnsubscribeToken(SECRET, WS)).toBeNull();
    expect(verifyUnsubscribeToken(SECRET, "")).toBeNull();
    expect(verifyUnsubscribeToken(SECRET, `not-a-uuid.${sig ?? ""}`)).toBeNull();
    expect(() => signUnsubscribeToken(SECRET, "nope")).toThrow(/UUID/);
  });

  it("property: no arbitrary string verifies", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (s) => verifyUnsubscribeToken(SECRET, s) === null),
      { numRuns: 1_000, seed: 42 },
    );
  });
});
