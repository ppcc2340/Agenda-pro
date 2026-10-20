import { describe, expect, it } from "vitest";
import { buildCsp, newNonce } from "./csp";

const directive = (csp: string, name: string) =>
  csp
    .split("; ")
    .find((d) => d.startsWith(`${name} `))
    ?.slice(name.length + 1);

describe("buildCsp (D-080)", () => {
  it("allows scripts only by nonce (no unsafe-inline), and eval only in development", () => {
    const prod = buildCsp("abc", { dev: false });
    expect(directive(prod, "script-src")).toBe("'self' 'nonce-abc' 'strict-dynamic'");
    expect(prod).not.toContain("unsafe-eval");
    expect(directive(buildCsp("abc", { dev: true }), "script-src")).toContain("'unsafe-eval'");
  });

  it("locks down objects, base URI, forms, framing and images", () => {
    const csp = buildCsp("n", { dev: false });
    expect(directive(csp, "object-src")).toBe("'none'");
    expect(directive(csp, "base-uri")).toBe("'none'");
    expect(directive(csp, "form-action")).toBe("'self' https://accounts.google.com");
    expect(directive(csp, "frame-ancestors")).toBe("'self'");
    expect(directive(csp, "img-src")).toBe("'self' data: blob:");
    expect(directive(csp, "connect-src")).toBe("'self'");
  });

  it("nonces are 128-bit and never repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newNonce()));
    expect(seen.size).toBe(200);
    for (const n of seen) expect(atob(n)).toHaveLength(16);
  });
});
