import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import { createLogger, REDACTED_PATHS, serializeRequest } from "./logger";

describe("logger redaction", () => {
  it("censors secrets and personal content", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = pino({ redact: { paths: [...REDACTED_PATHS], censor: "[redacted]" } }, sink);
    log.info(
      { account: { refreshToken: "rt-123", email: "a@b.c" }, req: { headers: { cookie: "s=1" } } },
      "x",
    );
    const out = lines.join("");
    expect(out).not.toContain("rt-123");
    expect(out).not.toContain("a@b.c");
    expect(out).not.toContain("s=1");
    expect(out).toContain("[redacted]");
  });

  it("logs request paths without their query string (OAuth code and state, search terms)", () => {
    expect(
      serializeRequest({
        method: "GET",
        url: "/v1/integrations/google/callback?code=4/abc&state=xyz",
        host: "api",
        ip: "10.0.0.1",
      }),
    ).toEqual({
      method: "GET",
      url: "/v1/integrations/google/callback",
      host: "api",
      remoteAddress: "10.0.0.1",
    });
    expect(createLogger({ name: "t", level: "silent" })).toBeDefined();
  });

  it("censors OAuth exchange material", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = pino({ redact: { paths: [...REDACTED_PATHS], censor: "[redacted]" } }, sink);
    log.info({ grant: { codeVerifier: "v-1", id_token: "idt-1", client_secret: "cs-1" } }, "x");
    const out = lines.join("");
    for (const secret of ["v-1", "idt-1", "cs-1"]) expect(out).not.toContain(secret);
  });
});
