import { describe, expect, it } from "vitest";
import { reportRequestError } from "./error-reporting";

describe("reportRequestError (D-118)", () => {
  it("sends the route template, method and digest only", () => {
    const captured: { error: unknown; context: Record<string, unknown> | undefined }[] = [];
    const errors = () => ({
      captureException: (error: unknown, context?: Record<string, unknown>) => {
        captured.push({ error, context });
      },
      flush: () => Promise.resolve(),
    });
    const err = Object.assign(new Error("render failed"), { digest: "123456" });
    reportRequestError(err, { method: "GET", routePath: "/clientes/[id]", routeType: "render" }, errors);
    reportRequestError(
      "thrown",
      { method: "POST", routePath: "/api/demo/sign-in", routeType: "route" },
      errors,
    );
    expect(captured.map((c) => c.context)).toEqual([
      { source: "next.render", route: "/clientes/[id]", method: "GET", digest: "123456" },
      { source: "next.route", route: "/api/demo/sign-in", method: "POST" },
    ]);
    expect(captured[0]?.error).toBe(err);
  });
});
