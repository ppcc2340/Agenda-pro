import { afterEach, describe, expect, it, vi } from "vitest";
import { clientApi, ClientApiError } from "./client-api";

describe("clientApi", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the CSRF header, parses JSON, returns null on 204 and throws problems", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: "FORBIDDEN", title: "Forbidden", status: 403 }), { status: 403 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    expect(await clientApi<{ ok: boolean }>("/v1/me")).toEqual({ ok: true });
    // DELETE /v1/account and POST /v1/account/sessions/revoke answer 204: success, not a parse error.
    expect(await clientApi<null>("/v1/account", { method: "DELETE" })).toBeNull();
    await expect(clientApi("/v1/x", { method: "POST" })).rejects.toBeInstanceOf(ClientApiError);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["x-requested-with"]).toBe("meri");
  });
});
