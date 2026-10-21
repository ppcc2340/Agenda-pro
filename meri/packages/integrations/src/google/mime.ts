/**
 * MIME helpers for the live Gmail adapter (ADR 0008). Mail content is untrusted: decoding is bounded (depth, size),
 * attachments are never read, and the draft builder cannot produce extra headers or recipients whatever the input.
 */

export interface GmailPart {
  mimeType?: string | undefined;
  filename?: string | undefined;
  headers?: { name: string; value: string }[] | undefined;
  body?:
    { data?: string | undefined; attachmentId?: string | undefined; size?: number | undefined } | undefined;
  parts?: GmailPart[] | undefined;
}

const MAX_DEPTH = 8;
/** Bodies beyond this are cut: the AI pipeline only reads the first few thousand characters anyway. */
export const MAX_BODY_CHARS = 200_000;

const charsetOf = (part: GmailPart): string => {
  const ct = part.headers?.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
  return /charset="?([\w-]+)"?/i.exec(ct)?.[1]?.toLowerCase() ?? "utf-8";
};

/** base64url → text in the declared charset; an unknown charset falls back to UTF-8 (lossy, never throws). */
export function decodeBody(data: string, charset = "utf-8"): string {
  const bytes = Buffer.from(data, "base64url");
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }
}

/**
 * The readable body of a message: the first `text/plain` part, else the first `text/html` part (sanitised later
 * by the pipeline), never attachments; bounded nesting and length.
 */
export function extractBody(payload: GmailPart): string {
  const found: { plain?: string; html?: string } = {};
  const walk = (part: GmailPart, depth: number): void => {
    if (depth > MAX_DEPTH || (found.plain !== undefined && found.html !== undefined)) return;
    const type = (part.mimeType ?? "").toLowerCase();
    const isAttachment = Boolean(part.filename) || Boolean(part.body?.attachmentId);
    if (!isAttachment && part.body?.data) {
      if (type === "text/plain" && found.plain === undefined)
        found.plain = decodeBody(part.body.data, charsetOf(part));
      else if (type === "text/html" && found.html === undefined)
        found.html = decodeBody(part.body.data, charsetOf(part));
    }
    for (const child of part.parts ?? []) walk(child, depth + 1);
  };
  walk(payload, 0);
  return (found.plain ?? found.html ?? "").slice(0, MAX_BODY_CHARS);
}

const ADDRESS = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/;

/** True for a bare, plain email address (no display name, no comma, no quotes, no line breaks). */
export const isPlainAddress = (value: string): boolean => value.length <= 254 && ADDRESS.test(value);

/**
 * Addresses of a header such as `To` or `Cc`: only the address part of each entry, lowercased; display names,
 * quoted commas and anything that is not an address are dropped.
 */
export function parseAddresses(header: string | undefined): string[] {
  if (!header) return [];
  const out: string[] = [];
  // Angle-bracketed addresses first (display names may contain commas or fake addresses in quotes).
  const angled = [...header.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1] ?? "");
  const candidates = angled.length > 0 ? angled : header.split(",").map((s) => s.trim());
  for (const c of candidates) {
    const address = c.toLowerCase();
    if (isPlainAddress(address) && !out.includes(address)) out.push(address);
  }
  return out;
}

const MESSAGE_ID = /^<[^<>\s]{1,250}>$/;

/** Message-ID / References tokens, validated; the chain is capped to its last 10 entries. */
export function messageIds(header: string | undefined, max = 10): string[] {
  if (!header) return [];
  return header
    .split(/\s+/)
    .filter((t) => MESSAGE_ID.test(t))
    .slice(-max);
}

const noBreaks = (value: string): string => value.replace(/[\r\n\u2028\u2029]+/g, " ").trim();

/** RFC 2047 encoded-word for non-ASCII subjects, split so each encoded line stays short. */
export function encodeSubject(subject: string): string {
  const clean = noBreaks(subject).slice(0, 250);
  // eslint-disable-next-line no-control-regex -- ASCII printable range check
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const chunks: string[] = [];
  let current = "";
  for (const ch of clean) {
    if (Buffer.byteLength(current + ch) > 45) {
      chunks.push(current);
      current = ch;
    } else current += ch;
  }
  if (current) chunks.push(current);
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c).toString("base64")}?=`).join("\r\n ");
}

export interface DraftMessage {
  to: string;
  subject: string;
  bodyText: string;
  inReplyTo: string | null;
  references: string[];
}

/**
 * RFC 2822 reply as base64url (Gmail `drafts.create` raw). One recipient, validated; header values cannot contain
 * line breaks; the body travels base64-encoded so no body line can be read as a header or a MIME boundary.
 */
export function buildDraftRaw(message: DraftMessage): string {
  if (!isPlainAddress(message.to)) throw new Error("draft recipient must be one plain email address");
  const headers = [
    `To: ${message.to}`,
    `Subject: ${encodeSubject(message.subject)}`,
    ...(message.inReplyTo && MESSAGE_ID.test(message.inReplyTo) ? [`In-Reply-To: ${message.inReplyTo}`] : []),
    ...(message.references.length
      ? [`References: ${messageIds(message.references.join(" ")).join(" ")}`]
      : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const body = (
    Buffer.from(message.bodyText, "utf8")
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}\r\n`, "utf8").toString("base64url");
}
