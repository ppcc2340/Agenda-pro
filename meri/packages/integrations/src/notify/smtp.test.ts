import type { AddressInfo } from "node:net";
import { SMTPServer, type SMTPServerOptions } from "smtp-server";
import { afterEach, describe, expect, it } from "vitest";
import { IntegrationError } from "../errors";
import { SmtpNotifier } from "./smtp";
import type { OutboundEmail } from "./types";

/** A real SMTP server in process: the adapter speaks the actual protocol, not a mocked transport. */
async function startServer(options: Partial<SMTPServerOptions> = {}) {
  const received: { from: string; to: string[]; raw: string; user?: string }[] = [];
  const server = new SMTPServer({
    disabledCommands: ["STARTTLS"],
    authOptional: true,
    logger: false,
    onAuth(auth, _session, cb) {
      if (auth.username === "meri" && auth.password === "s3cret") cb(null, { user: auth.username });
      else cb(new Error("bad credentials"));
    },
    onData(stream, session, cb) {
      let raw = "";
      stream.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      stream.on("end", () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          raw,
          ...(typeof session.user === "string" ? { user: session.user } : {}),
        });
        cb();
      });
    },
    ...options,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.server.address() as AddressInfo).port;
  return { server, port, received };
}

const email = (over: Partial<OutboundEmail> = {}): OutboundEmail => ({
  to: "ana@example.com",
  subject: "Tu día en Meri",
  text: "Hoy: 3 bloques.",
  html: "<p>Hoy: 3 bloques.</p>",
  unsubscribeUrl: "https://app.example.com/api/v1/email/unsubscribe?t=abc",
  reference: "0192aaaa-0000-7000-8000-000000000001",
  ...over,
});

describe("SmtpNotifier (D-113)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });
  const notifier = (port: number, auth = "meri:s3cret@") => {
    const n = new SmtpNotifier({
      url: `smtp://${auth}127.0.0.1:${String(port)}`,
      from: "Meri <avisos@example.com>",
      timeoutMs: 2_000,
    });
    cleanups.push(() => {
      n.close();
    });
    return n;
  };

  it("delivers with authentication, one-click unsubscribe headers and the reference", async () => {
    const { server, port, received } = await startServer();
    cleanups.push(() => {
      server.close();
    });
    await notifier(port).send(email());
    expect(received).toHaveLength(1);
    const [msg] = received;
    expect(msg?.user).toBe("meri");
    expect(msg?.from).toBe("avisos@example.com");
    expect(msg?.to).toEqual(["ana@example.com"]);
    expect(msg?.raw).toContain("List-Unsubscribe: <https://app.example.com/api/v1/email/unsubscribe?t=abc>");
    expect(msg?.raw).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(msg?.raw).toContain("X-Meri-Ref: 0192aaaa-0000-7000-8000-000000000001");
    expect(msg?.raw).toMatch(/Content-Type: multipart\/alternative/);
  });

  it("a subject can never inject a header", async () => {
    const { server, port, received } = await startServer();
    cleanups.push(() => {
      server.close();
    });
    await notifier(port).send(email({ subject: "Hola\r\nBcc: victima@example.com\nX-Evil: 1" }));
    const raw = received[0]?.raw ?? "";
    expect(raw).not.toMatch(/^Bcc:/m);
    expect(raw).not.toMatch(/^X-Evil:/m);
    expect(received[0]?.to).toEqual(["ana@example.com"]);
  });

  it("maps a 5xx rejection to Permanent and a 4xx deferral to Transient", async () => {
    const rejecting = await startServer({
      onRcptTo(_address, _session, cb) {
        cb(Object.assign(new Error("mailbox unavailable"), { responseCode: 550 }));
      },
    });
    cleanups.push(() => {
      rejecting.server.close();
    });
    await expect(notifier(rejecting.port).send(email())).rejects.toSatisfy(
      (e: unknown) => e instanceof IntegrationError && e.kind === "Permanent" && !e.retryable,
    );
    const deferring = await startServer({
      onRcptTo(_address, _session, cb) {
        cb(Object.assign(new Error("try later"), { responseCode: 451 }));
      },
    });
    cleanups.push(() => {
      deferring.server.close();
    });
    await expect(notifier(deferring.port).send(email())).rejects.toSatisfy(
      (e: unknown) => e instanceof IntegrationError && e.kind === "Transient" && e.retryable,
    );
  });

  it("rejected credentials are Permanent; an unreachable server is Transient", async () => {
    const { server, port } = await startServer();
    cleanups.push(() => {
      server.close();
    });
    await expect(notifier(port, "meri:wrong@").send(email())).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof IntegrationError && e.kind === "Permanent" && /authentication/.test(e.message),
    );
    server.close();
    await expect(notifier(port).send(email())).rejects.toSatisfy(
      (e: unknown) => e instanceof IntegrationError && e.kind === "Transient",
    );
  });

  it("refuses an invalid recipient and a non-SMTP URL before connecting", async () => {
    const { server, port, received } = await startServer();
    cleanups.push(() => {
      server.close();
    });
    await expect(notifier(port).send(email({ to: "not-an-address" }))).rejects.toThrow(/invalid recipient/);
    await expect(notifier(port).send(email({ to: "a@b.c\r\nBcc: x@y.z" }))).rejects.toThrow(
      /invalid recipient/,
    );
    expect(received).toHaveLength(0);
    expect(() => new SmtpNotifier({ url: "https://mail.example.com", from: "x@example.com" })).toThrow(
      /smtp:\/\/ or smtps:\/\//,
    );
  });
});
