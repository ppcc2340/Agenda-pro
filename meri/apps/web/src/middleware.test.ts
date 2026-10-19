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
});
