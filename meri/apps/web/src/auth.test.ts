import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// NextAuth itself pulls next/server (not resolvable under vitest); the config builder is what we test.
vi.mock("next-auth", () => ({
  default: () => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }),
}));

const BASE_ENV = {
  DATABASE_URL: "postgres://x",
  AUTH_SECRET: "a".repeat(40),
  INTERNAL_API_SECRET: "internal-secret-1234567890",
  API_URL: "http://api.test",
  LOCAL_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
  GOOGLE_MODE: "fake",
  NODE_ENV: "test",
};

describe("auth config (ADR 0001)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, BASE_ENV);
    vi.resetModules();
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });

  it("jwt callback bootstraps the account through the internal route and stores workspaceId", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          userId: "0192aaaa-0000-7000-8000-000000000001",
          workspaceId: "0192aaaa-0000-7000-8000-000000000002",
          email: "a@b.co",
          name: "A",
          locale: "es",
          created: true,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { buildAuthConfig } = await import("./auth");
    const config = buildAuthConfig();
    const ids = config.providers.map((p) =>
      typeof p === "function" ? "fn" : ((p as { options?: { id?: string } }).options?.id ?? p.id),
    );
    expect(ids).toEqual(["dev"]);
    const jwt = config.callbacks?.jwt;
    if (!jwt) throw new Error("jwt callback missing");
    const token = await jwt({
      token: {},
      user: { id: "a@b.co", email: "a@b.co", name: "A" },
      account: null,
    });
    expect(token).toMatchObject({
      authTime: expect.any(Number) as number,
      sub: "0192aaaa-0000-7000-8000-000000000001",
      workspaceId: "0192aaaa-0000-7000-8000-000000000002",
      email: "a@b.co",
      locale: "es",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/internal/auth/bootstrap");
    expect((init.headers as Record<string, string>)["x-internal-secret"]).toBe(BASE_ENV.INTERNAL_API_SECRET);
    expect(JSON.parse(init.body as string)).toMatchObject({ email: "a@b.co", subject: "dev:a@b.co" });
    // Subsequent refreshes (no user) keep the token (and its sign-in instant) and do not call the API again.
    type JwtArgs = Parameters<typeof jwt>[0];
    const authTime = Date.now() - 1000;
    const refresh = { token: { sub: "x", workspaceId: "w", authTime }, account: null } as unknown as JwtArgs;
    expect(await jwt(refresh)).toMatchObject({ sub: "x", workspaceId: "w", authTime });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A token without a sign-in instant (issued before ADR 0007) or past the absolute lifetime ends the session.
    const legacy = { token: { sub: "x", workspaceId: "w" }, account: null } as unknown as JwtArgs;
    expect(await jwt(legacy)).toBeNull();
    const stale = { token: { sub: "x", authTime: Date.now() - 15 * 86_400_000 }, account: null } as unknown as JwtArgs;
    expect(await jwt(stale)).toBeNull();
  });

  it("fails the sign-in when the bootstrap route rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));
    const { buildAuthConfig } = await import("./auth");
    const jwt = buildAuthConfig().callbacks?.jwt;
    if (!jwt) throw new Error("jwt callback missing");
    await expect(jwt({ token: {}, user: { id: "a@b.co", email: "a@b.co" }, account: null })).rejects.toThrow(
      /bootstrap failed/,
    );
  });

  it("binds Google sign-ins to the Google subject and refuses unverified addresses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          userId: "0192aaaa-0000-7000-8000-000000000001",
          workspaceId: "0192aaaa-0000-7000-8000-000000000002",
          email: "a@b.co",
          name: null,
          locale: "es",
          created: false,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { buildAuthConfig } = await import("./auth");
    const callbacks = buildAuthConfig().callbacks;
    const signIn = callbacks?.signIn;
    const jwt = callbacks?.jwt;
    if (!signIn || !jwt) throw new Error("callbacks missing");
    type SignInArgs = Parameters<typeof signIn>[0];
    const google = { provider: "google", providerAccountId: "1234567890", type: "oidc" };
    const args = (emailVerified: boolean) =>
      ({ user: { email: "a@b.co" }, account: google, profile: { email_verified: emailVerified } }) as unknown as SignInArgs;
    expect(await signIn(args(true))).toBe(true);
    expect(await signIn(args(false))).toBe(false);
    type JwtArgs = Parameters<typeof jwt>[0];
    await jwt({ token: {}, user: { id: "x", email: "a@b.co" }, account: google } as unknown as JwtArgs);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ subject: "google:1234567890" });
  });

  it("refuses the development provider in production", async () => {
    Object.assign(process.env, { NODE_ENV: "production" });
    const { buildAuthConfig } = await import("./auth");
    expect(() => buildAuthConfig()).toThrow(/forbidden in production/);
  });
});
