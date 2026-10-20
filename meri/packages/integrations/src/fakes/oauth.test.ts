import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeGoogleOAuth } from "./oauth";

describe("FakeGoogleOAuth", () => {
  const now = () => new Date("2026-10-19T10:40:00Z");
  it("mints single-use codes bound to the login hint and refreshes/revokes like the live flow", async () => {
    const oauth = new FakeGoogleOAuth(now);
    const url = new URL(
      oauth.authorizationUrl({
        state: "s1",
        scopes: ["a"],
        redirectUri: "http://localhost:4000/cb",
        loginHint: "ana@acme.com",
        codeChallenge: createHash("sha256").update("verifier-1").digest("base64url"),
      }),
    );
    expect(url.searchParams.get("state")).toBe("s1");
    const code = url.searchParams.get("code") ?? "";
    const tokens = await oauth.exchangeCode({
      code,
      redirectUri: "http://localhost:4000/cb",
      codeVerifier: "verifier-1",
    });
    expect(tokens).toMatchObject({
      email: "ana@acme.com",
      scopes: ["a"],
      expiresAt: "2026-10-19T11:40:00.000Z",
    });
    await expect(oauth.exchangeCode({ code, redirectUri: "x", codeVerifier: "verifier-1" })).rejects.toMatchObject({ kind: "Permanent" });
    const refreshed = await oauth.refresh(tokens.refreshToken ?? "");
    expect(refreshed.email).toBe("ana@acme.com");
    await oauth.revoke(tokens.refreshToken ?? "");
    await expect(oauth.refresh(tokens.refreshToken ?? "")).rejects.toMatchObject({ kind: "AuthExpired" });
  });

  it("refuses a code exchanged with another PKCE verifier, and burns the code", async () => {
    const oauth = new FakeGoogleOAuth(now);
    const url = new URL(
      oauth.authorizationUrl({
        state: "s",
        scopes: ["a"],
        redirectUri: "http://localhost:4000/cb",
        codeChallenge: createHash("sha256").update("right").digest("base64url"),
      }),
    );
    const code = url.searchParams.get("code") ?? "";
    await expect(oauth.exchangeCode({ code, redirectUri: "x", codeVerifier: "wrong" })).rejects.toMatchObject({
      kind: "Permanent",
    });
    await expect(oauth.exchangeCode({ code, redirectUri: "x", codeVerifier: "right" })).rejects.toMatchObject({
      kind: "Permanent",
    });
  });
});
