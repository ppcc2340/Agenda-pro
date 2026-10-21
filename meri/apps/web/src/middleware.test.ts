import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "./middleware";

const req = (path: string, cookie?: string) =>
  new NextRequest(`http://localhost:3000${path}`, { headers: cookie ? { cookie } : {} });

describe("middleware", () => {
  it("lets public pages through and redirects app areas without a session cookie", () => {
    expect(middleware(req("/privacy")).headers.get("location")).toBeNull();
    expect(middleware(req("/terms")).headers.get("location")).toBeNull();
    expect(middleware(req("/login")).headers.get("location")).toBeNull();
    expect(middleware(req("/hoy")).headers.get("location")).toBe("http://localhost:3000/login?next=%2Fhoy");
    expect(middleware(req("/")).headers.get("location")).toBe("http://localhost:3000/login");
    expect(middleware(req("/hoy", "authjs.session-token=x")).headers.get("location")).toBeNull();
    expect(middleware(req("/hoy", "__Secure-authjs.session-token=x")).headers.get("location")).toBeNull();
  });

  it("lets only the waitlist and the signed unsubscribe through without a session (D-099, D-116)", () => {
    expect(middleware(req("/api/v1/waitlist")).headers.get("location")).toBeNull();
    expect(middleware(req("/api/v1/feedback")).headers.get("location")).toBe(
      "http://localhost:3000/login?next=%2Fapi%2Fv1%2Ffeedback",
    );
    expect(middleware(req("/api/v1/waitlisted")).headers.get("location")).not.toBeNull();
    expect(middleware(req("/api/v1/email/unsubscribe")).headers.get("location")).toBeNull();
    expect(middleware(req("/correo/baja")).headers.get("location")).toBeNull();
    expect(middleware(req("/api/v1/email/other")).headers.get("location")).not.toBeNull();
  });

  it("sets a strict CSP with a fresh nonce on every page response and passes the nonce to the app", () => {
    const a = middleware(req("/hoy", "authjs.session-token=x"));
    const b = middleware(req("/privacy"));
    const cspA = a.headers.get("content-security-policy") ?? "";
    const cspB = b.headers.get("content-security-policy") ?? "";
    expect(cspA).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{24}' 'strict-dynamic'/);
    expect(cspA).not.toContain("'unsafe-inline' 'strict");
    expect(cspA).not.toEqual(cspB);
    // The request headers forwarded to the app carry the same nonce.
    const nonce = /'nonce-([^']+)'/.exec(cspA)?.[1];
    expect(a.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
  });
});
