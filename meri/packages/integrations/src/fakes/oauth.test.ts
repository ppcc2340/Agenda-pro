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
      }),
    );
    expect(url.searchParams.get("state")).toBe("s1");
    const code = url.searchParams.get("code") ?? "";
    const tokens = await oauth.exchangeCode({ code, redirectUri: "http://localhost:4000/cb" });
    expect(tokens).toMatchObject({
      email: "ana@acme.com",
      scopes: ["a"],
      expiresAt: "2026-10-19T11:40:00.000Z",
    });
    await expect(oauth.exchangeCode({ code, redirectUri: "x" })).rejects.toMatchObject({ kind: "Permanent" });
    const refreshed = await oauth.refresh(tokens.refreshToken ?? "");
    expect(refreshed.email).toBe("ana@acme.com");
    await oauth.revoke(tokens.refreshToken ?? "");
    await expect(oauth.refresh(tokens.refreshToken ?? "")).rejects.toMatchObject({ kind: "AuthExpired" });
  });
});
