import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveStateKey, newPkce, OAUTH_STATE_TTL_MS, openState, sealState } from "./oauth-state";

const key = deriveStateKey("test-auth-secret-at-least-32-characters-long");
const state = {
  s: "state-value-0123456789abcdef",
  v: newPkce().verifier,
  w: "0192aaaa-0000-7000-8000-000000000002",
  f: "calendar" as const,
};

describe("signed OAuth state (ADR 0007)", () => {
  it("round-trips within its lifetime and expires after", () => {
    const sealed = sealState(key, state, 1_000);
    expect(openState(key, sealed, 2_000)).toMatchObject(state);
    expect(openState(key, sealed, 1_000 + OAUTH_STATE_TTL_MS + 1)).toBeNull();
  });

  it("rejects tampering, another key and garbage", () => {
    const sealed = sealState(key, state, 0);
    const [body, tag] = sealed.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...state, w: "0192aaaa-0000-7000-8000-000000000003", e: 9e15 }),
    ).toString("base64url");
    expect(openState(key, `${forged}.${tag}`, 0)).toBeNull();
    expect(openState(deriveStateKey("another-secret-of-at-least-32-characters"), sealed, 0)).toBeNull();
    expect(openState(key, `${body}.${tag}.x`, 0)).toBeNull();
    expect(openState(key, "nope", 0)).toBeNull();
    expect(openState(key, undefined, 0)).toBeNull();
  });

  it("derives the key (never the raw secret) and makes S256 PKCE pairs", () => {
    expect(key).toHaveLength(32);
    expect(key.toString("utf8")).not.toContain("test-auth-secret");
    const { verifier, challenge } = newPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(newPkce().verifier).not.toBe(verifier);
  });
});
