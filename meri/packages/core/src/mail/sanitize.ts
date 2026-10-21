/**
 * Mail body sanitiser (docs/05 §6.7 and §9): strips HTML, URLs, quoted replies and signatures before any text is
 * shown to the model. Pure. The sanitised text is also the reference for evidence verification.
 */
export const MAX_BODY_CHARS = 6_000;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  aacute: "á",
  eacute: "é",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  uuml: "ü",
  ccedil: "ç",
  Aacute: "Á",
  Eacute: "É",
  Iacute: "Í",
  Oacute: "Ó",
  Uacute: "Ú",
  Ntilde: "Ñ",
  Uuml: "Ü",
  Ccedil: "Ç",
  iquest: "¿",
  iexcl: "¡",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  euro: "€",
};

/** Decodes entities; a numeric entity outside Unicode (or a lone surrogate) becomes a space instead of throwing. */
function decodeEntities(text: string): string {
  return text.replace(/&(#\d{1,8}|#x[0-9a-f]{1,8}|[a-z]+);/gi, (m, code: string) => {
    if (code.startsWith("#")) {
      const cp = code.startsWith("#x") || code.startsWith("#X") ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      const valid = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
      return valid ? String.fromCodePoint(cp) : " ";
    }
    return ENTITIES[code] ?? ENTITIES[code.toLowerCase()] ?? m;
  });
}

const stripTags = (text: string) => text.replace(/<[^>]+>/g, " ");
/** Second pass after decoding: only tag-shaped text (`<a`, `</a`, `<!--`, `<?`) — "a < b y c > d" is prose. */
const stripDecodedTags = (text: string) => text.replace(/<[a-z/!?][^<>]*>/gi, " ");

export function stripHtml(input: string): string {
  const withoutMarkup = stripTags(
    input
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n"),
  );
  // Second pass: encoded markup ("&lt;script&gt;") must not come back as a tag after decoding (fuzzing, P5-06).
  return stripDecodedTags(decodeEntities(withoutMarkup));
}

const QUOTE_HEADERS = [
  /^El .{3,80} escribi[oó]:\s*$/i,
  /^On .{3,80} wrote:\s*$/i,
  /^-{2,}\s*(Original Message|Mensaje original|Forwarded message|Mensaje reenviado)\s*-{2,}$/i,
  /^De:\s.+$/i,
  /^From:\s.+$/i,
];
const SIGNATURE_STARTS = [
  /^--\s*$/,
  /^(un saludo|saludos|saludos cordiales|atentamente|cordialmente|gracias de antemano|gracias)[,.!]?\s*$/i,
  /^(best regards|kind regards|regards|best|thanks|thank you|cheers|sincerely)[,.!]?\s*$/i,
  /^enviado desde mi .+$/i,
  /^sent from my .+$/i,
];

/** Removes quoted history (keeps only the newest part) and trailing signatures. */
export function stripQuotesAndSignature(text: string): string {
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith(">")) break;
    if (QUOTE_HEADERS.some((re) => re.test(line.trim()))) break;
    if (SIGNATURE_STARTS.some((re) => re.test(line.trim()))) break;
    kept.push(line);
  }
  return kept.join("\n");
}

export const URL_PLACEHOLDER = "[enlace]";

export function stripUrls(text: string): string {
  return text.replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi, URL_PLACEHOLDER);
}

/** Full pipeline: HTML → text, quotes/signature removed, URLs replaced, whitespace collapsed, length capped. */
export function sanitizeMailBody(body: string, maxChars = MAX_BODY_CHARS): string {
  const text = stripUrls(stripQuotesAndSignature(stripHtml(body)))
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

/** Normalisation used to verify that an evidence quote appears verbatim in the sanitised source. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[“”«»"'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function evidenceAppearsIn(evidence: string, source: string): boolean {
  const e = normalizeForMatch(evidence);
  return e.length >= 3 && normalizeForMatch(source).includes(e);
}
