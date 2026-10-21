/**
 * Transactional email over SMTP (D-113, ADR 0009). Any provider works (SES, Postmark, Resend, Mailgun…), so the
 * choice is a person's and needs no code. TLS is required except towards localhost (tests, a local relay).
 */
import nodemailer, { type Transporter } from "nodemailer";
import { z } from "zod";
import { IntegrationError } from "../errors";
import type { Notifier, OutboundEmail } from "./types";

const PROVIDER = "smtp";
const Email = z.string().email().max(254);

export interface SmtpNotifierOptions {
  /** `smtps://user:pass@host:465` or `smtp://user:pass@host:587` (STARTTLS required). */
  url: string;
  /** `Meri <avisos@example.com>`. */
  from: string;
  timeoutMs?: number;
}

const isLocal = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/** One line, no control characters: the subject can never carry extra headers. */
const oneLine = (s: string) => {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out += code < 0x20 || code === 0x7f ? " " : s.charAt(i);
  }
  return out.replace(/ {2,}/g, " ").trim().slice(0, 200);
};

export class SmtpNotifier implements Notifier {
  readonly mode = "live" as const;
  private readonly transport: Transporter;
  private readonly from: string;

  constructor(options: SmtpNotifierOptions) {
    const url = new URL(options.url);
    if (url.protocol !== "smtp:" && url.protocol !== "smtps:")
      throw new IntegrationError("Permanent", PROVIDER, "SMTP_URL must start with smtp:// or smtps://");
    const timeout = options.timeoutMs ?? 15_000;
    this.from = options.from;
    this.transport = nodemailer.createTransport({
      host: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === "smtps:" ? 465 : 587,
      secure: url.protocol === "smtps:",
      requireTLS: url.protocol === "smtp:" && !isLocal(url.hostname),
      ...(url.username
        ? { auth: { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) } }
        : {}),
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async send(email: OutboundEmail): Promise<void> {
    const to = Email.safeParse(email.to);
    if (!to.success) throw new IntegrationError("Permanent", PROVIDER, "invalid recipient address");
    try {
      await this.transport.sendMail({
        from: this.from,
        to: to.data,
        subject: oneLine(email.subject),
        text: email.text,
        html: email.html,
        headers: {
          "List-Unsubscribe": `<${email.unsubscribeUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          "X-Meri-Ref": oneLine(email.reference),
        },
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    } catch (e) {
      throw toIntegrationError(e);
    }
  }

  close(): void {
    this.transport.close();
  }
}

/**
 * Only a permanent (5xx) rejection of this recipient, at RCPT TO, is final for this message; nodemailer also labels
 * sender rejections EENVELOPE, so the failing command decides. Every other failure (authentication, sender not
 * verified, policy at MAIL FROM, connection, 4xx) is about our side or temporary: it is retried and must never mark
 * every email in flight as failed (review M2).
 */
export function toIntegrationError(e: unknown): IntegrationError {
  const err = e as { code?: string; responseCode?: number; command?: string };
  const code = err.responseCode;
  const atRecipient = typeof err.command === "string" && /RCPT/i.test(err.command);
  if (typeof code === "number" && code >= 500 && atRecipient)
    return new IntegrationError("Permanent", PROVIDER, `SMTP rejected the recipient (${String(code)})`, {
      cause: e,
    });
  if (err.code === "EAUTH")
    return new IntegrationError("Transient", PROVIDER, "SMTP authentication rejected (check SMTP_URL)", {
      cause: e,
    });
  if (typeof code === "number")
    return new IntegrationError("Transient", PROVIDER, `SMTP refused the message (${String(code)})`, {
      cause: e,
    });
  return new IntegrationError("Transient", PROVIDER, `SMTP connection failed (${err.code ?? "unknown"})`, {
    cause: e,
  });
}
