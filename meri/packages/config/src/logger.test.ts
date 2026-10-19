import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import { REDACTED_PATHS } from "./logger";

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
    log.info({ account: { refreshToken: "rt-123", email: "a@b.c" }, req: { headers: { cookie: "s=1" } } }, "x");
    const out = lines.join("");
    expect(out).not.toContain("rt-123");
    expect(out).not.toContain("a@b.c");
    expect(out).not.toContain("s=1");
    expect(out).toContain("[redacted]");
  });
});
