/**
 * Bounded extraction context (docs/05 §3.3, F-09 AC1): only the thread and the resolved client's metadata.
 * Pure and testable: the output string is exactly what the model sees.
 */
import { emailAddress, emailDomain } from "./prefilter";
import type { MailMessageInput } from "./commitments";

export interface ClientRef {
  id: string;
  name: string;
  domains: string[];
  contactEmails?: string[];
}

/** Deep link to a Gmail thread (fixed origin; the id is encoded, never trusted as a URL). */
export const gmailThreadUrl = (externalThreadId: string) =>
  `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(externalThreadId)}`;

export const THREAD_OPEN = "<thread>";
export const THREAD_CLOSE = "</thread>";
export const MAX_CONTEXT_CHARS = 12_000;

/**
 * Client resolution by participant domain/contact. Ambiguous (two different clients among participants) → null,
 * so no client data enters the prompt (docs/05 §3.2).
 */
export function resolveClient(participants: string[], me: string, clients: ClientRef[]): ClientRef | null {
  const mine = emailAddress(me);
  const others = participants.map(emailAddress).filter((a) => a !== mine);
  const matches = new Set<string>();
  let found: ClientRef | null = null;
  for (const address of others) {
    const domain = emailDomain(address);
    for (const client of clients) {
      const byDomain = client.domains.some(
        (d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`),
      );
      const byContact = (client.contactEmails ?? []).some((c) => c.toLowerCase() === address);
      if (byDomain || byContact) {
        matches.add(client.id);
        found = client;
      }
    }
  }
  return matches.size === 1 ? found : null;
}

const escapeDelims = (s: string) => s.replace(/<\/?(thread|message|client)\b/gi, "‹tag›");
/** Attribute values: bare address when one is present, never a quote or a newline. */
const attr = (s: string) => escapeDelims(/[^\s<>@"]+@[^\s<>@"]+/.exec(s)?.[0] ?? s).replace(/["\r\n]/g, " ");

export interface ExtractionPromptInput {
  me: string;
  now: string;
  timezone: string;
  subject: string | null;
  messages: MailMessageInput[];
  client: ClientRef | null;
}

/** Builds the untrusted-data block. Message text is escaped so it can never close the delimiters. */
export function buildExtractionContext(input: ExtractionPromptInput): string {
  const header = [
    `Me: ${input.me}`,
    `Now: ${input.now}`,
    `Time zone: ${input.timezone}`,
    input.client ? `Client: ${escapeDelims(input.client.name)}` : "Client: (unresolved)",
  ].join("\n");
  const messages = input.messages.map(
    (m) =>
      `<message id="${attr(m.id)}" from="${attr(m.from)}" to="${m.to.map(attr).join(", ")}" date="${attr(m.date)}">\n${escapeDelims(m.text)}\n</message>`,
  );
  const body = `${THREAD_OPEN}\nSubject: ${escapeDelims(input.subject ?? "")}\n${messages.join("\n")}\n${THREAD_CLOSE}`;
  const full = `${header}\n${body}`;
  return full.length > MAX_CONTEXT_CHARS ? `${full.slice(0, MAX_CONTEXT_CHARS)}\n${THREAD_CLOSE}` : full;
}

/** Parses the context back (used by the fake AI handler, which runs the rules on the same bounded input). */
export function parseExtractionContext(context: string): ExtractionPromptInput | null {
  const me = /^Me: (.+)$/m.exec(context)?.[1]?.trim();
  const now = /^Now: (.+)$/m.exec(context)?.[1]?.trim();
  const timezone = /^Time zone: (.+)$/m.exec(context)?.[1]?.trim();
  const subject = /^Subject: (.*)$/m.exec(context)?.[1] ?? null;
  if (!me || !now || !timezone) return null;
  const messages: MailMessageInput[] = [];
  const re = /<message id="([^"]+)" from="([^"]*)" to="([^"]*)" date="([^"]*)">\n([\s\S]*?)\n<\/message>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(context))) {
    messages.push({
      id: m[1] ?? "",
      from: m[2] ?? "",
      to: (m[3] ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      date: m[4] ?? "",
      text: m[5] ?? "",
    });
  }
  const clientName = /^Client: (.+)$/m.exec(context)?.[1]?.trim();
  const client =
    clientName && clientName !== "(unresolved)" ? { id: "", name: clientName, domains: [] } : null;
  return { me, now, timezone, subject: subject === "" ? null : subject, messages, client };
}
