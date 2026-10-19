/**
 * Rule-based commitment extraction (D-032): the always-available fallback and the fake AI handler. Pure.
 * Sentences with a commitment verb from the sender (or a request addressed to me) become candidates; the
 * evidence is the sentence itself, so it is verbatim by construction.
 */
import { findDate, normalizeText, type CaptureContext } from "../capture/parse";
import { emailAddress } from "./prefilter";

export interface MailMessageInput {
  id: string;
  from: string;
  to: string[];
  date: string; // ISO
  text: string; // sanitised body
}

export interface ExtractionContext {
  me: string;
  timezone: string;
  now: string;
}

export interface RuleCommitment {
  direction: "owed_by_me" | "owed_to_me";
  counterpartyEmail: string | null;
  action: string;
  dueAt: string | null;
  dueText: string | null;
  kind: "explicit" | "inferred" | "suggested";
  confidence: number;
  evidence: string;
  externalMessageId: string;
}

/** Conjugated form → infinitive (es) or base verb (en). Order matters: longer forms first. */
const VERB_FORMS: [RegExp, string][] = [
  [
    /\b(te|le|les|os)\s+(envio|envío|enviare|enviaré|mando|mandare|mandaré|paso|pasare|pasaré|remito|remitire|remitiré|adjunto|adjuntare|adjuntaré|hago llegar)\b/i,
    "enviar",
  ],
  [/\b(enviare|enviaré|enviaremos|mandare|mandaré|mandaremos|remitire|remitiré)\b/i, "enviar"],
  [/\b(te|le|les)\s+(llamo|llamare|llamaré)\b/i, "llamar"],
  [/\b(llamare|llamaré|llamaremos)\b/i, "llamar"],
  [/\b(preparo|preparare|prepararé|prepararemos)\b/i, "preparar"],
  [/\b(reviso|revisare|revisaré|revisaremos)\b/i, "revisar"],
  [/\b(entrego|entregare|entregaré|entregaremos)\b/i, "entregar"],
  [/\b(confirmo|confirmare|confirmaré|confirmaremos)\b/i, "confirmar"],
  [/\b(presento|presentare|presentaré|presentaremos)\b/i, "presentar"],
  [/\b(firmo|firmare|firmaré|firmaremos)\b/i, "firmar"],
  [/\b(pago|pagare|pagaré|pagaremos)\b/i, "pagar"],
  [/\b(agendo|agendare|agendaré|agendaremos)\b/i, "agendar"],
  [/\b(respondo|respondere|responderé|responderemos|contesto|contestare|contestaré)\b/i, "responder"],
  [/\b(tendras|tendrás|tendran|tendrán|tendra|tendrá)\b/i, "entregar"],
  // Hedged proposals keep their own verb ("podríamos revisar…", "maybe we could look at…").
  [
    /\b(podriamos|podríamos|podamos|podemos|we could|could we|we might|maybe we|perhaps we)\s+(\p{L}+)\b/iu,
    "$2",
  ],
  [
    /\b(i'?ll|i will|we'?ll|we will|i am going to|i'?m going to|we are going to)\s+(send|get|deliver|share|review|prepare|call|confirm|sign|pay|schedule|reply|follow up|forward|draft|book|have|finish|complete|circulate|submit|update)\b/i,
    "$2",
  ],
  [
    /\b(will|shall)\s+(send|get|deliver|share|review|prepare|call|confirm|sign|pay|schedule|reply|follow up|draft|submit|update)\b/i,
    "$2",
  ],
  [/\b(me comprometo a|quedo en|quedamos en que)\s+(\p{L}+)/iu, "$2"],
];

const REQUEST_PATTERNS: RegExp[] = [
  /\b(necesito|necesitamos|necesitaria|necesitaría)\s+que\s+(me\s+)?(\p{L}+)/iu,
  /\b(podrias|podrías|puedes|podriais|podríais|pueden|podria|podría)\s+(enviarme|mandarme|pasarme|confirmarme|revisar|enviar|mandar|preparar|llamarme|firmar|devolver|responder|compartir|adjuntar)\b/i,
  /\b(por favor|porfa)[,]?\s+(env[ií]a(me)?|manda(me)?|pasa(me)?|confirma(me)?|revisa|prepara|firma|responde|comparte|devu[eé]lve(me)?)\b/i,
  /\b(could you|can you|would you|please)\s+(send|share|confirm|review|prepare|sign|return|reply|forward|call|book|update|let me know|get back)\b/i,
  /\b(te pido|le pido|les pido|ruego)\s+(que\s+)?(me\s+)?(\p{L}+)/iu,
  /\b(quedo a la espera de|espero)\s+(tu|su|el|la|los|las)\s+(\p{L}+)/iu,
  /\b(waiting for|looking forward to receiving|awaiting)\s+(your|the)\s+(\p{L}+)/iu,
];
const SUGGESTION_WORDS =
  /\b(quiza|quizas|quizá|quizás|tal vez|a lo mejor|podriamos|podríamos|maybe|perhaps|we could|might|sometime|cuando puedas|when you get a chance|si te parece|if you like|igual)\b/i;
/** Hedged proposals ("maybe we could look at…", "podríamos vernos…") become `suggested` commitments. */
const HEDGED_ACTION =
  /\b(we could|could we|we might|maybe we|perhaps we|podriamos|podríamos|tal vez podamos|quizas podamos|quizás podamos|igual podemos|si te parece)\b.*\b(look|review|send|discuss|meet|talk|revisar|ver|enviar|hablar|reunirnos|mirar|vernos|comentar)/iu;
const NEGATION = /\b(no|nunca|jamas|jamás|not|never|won't|can't|cannot|couldn't|wouldn't|shan't)\b|n't\b/i;
const OWN_PROMISE_FROM_SENDER =
  /\b(te|le|les|os)\s+(envio|envío|enviare|enviaré|mando|mandare|mandaré|paso|pasare|pasaré|llamo|llamare|llamaré|confirmo|confirmare|confirmaré)\b|\b(enviare|enviaré|mandare|mandaré|preparare|prepararé|revisare|revisaré|entregare|entregaré|confirmare|confirmaré|llamare|llamaré|presentare|presentaré|firmare|firmaré|pagare|pagaré|respondere|responderé|contestare|contestaré|i'?ll|i will|we'?ll|we will|i'?m going to|me comprometo|quedo en)\b/i;

const splitSentences = (text: string): string[] =>
  text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);

const STOP = new Set([
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "the",
  "a",
  "an",
  "te",
  "le",
  "les",
  "os",
  "me",
  "you",
  "your",
  "tu",
  "tus",
  "su",
  "sus",
  "lo",
  "de",
  "del",
  "al",
  "con",
  "en",
  "por",
  "para",
  "que",
  "y",
  "e",
  "o",
  "to",
  "of",
  "for",
  "with",
  "on",
  "in",
  "by",
  "mi",
  "my",
  "our",
  "nuestro",
  "nuestra",
  "this",
  "that",
  "esto",
  "eso",
  "ese",
  "esa",
  "este",
  "esta",
]);

/** Turns the sentence into a short infinitive action ("enviar contrato firmado"), ≤ 12 words. */
export function deriveAction(sentence: string, ctx: CaptureContext): string {
  let s = sentence.replace(/[“”"]/g, "");
  const date = findDate(normalizeText(s), ctx);
  if (date) {
    // Remove the date phrase by position in the normalised string (same length as the original slice).
    const lower = normalizeText(s);
    const idx = lower.indexOf(date.match.text);
    if (idx >= 0) s = `${s.slice(0, idx)} ${s.slice(idx + date.match.text.length)}`;
  }
  let verb: string | null = null;
  let rest = s;
  const plain = normalizeText(s); // same length as `s` for precomposed input: indexes are shared
  for (const [re, inf] of VERB_FORMS) {
    const m = re.exec(plain);
    if (m) {
      verb = inf.startsWith("$") ? (m[Number(inf.slice(1))] ?? "").toLowerCase() : inf;
      rest = s.slice(m.index + m[0].length);
      break;
    }
  }
  if (!verb) {
    for (const re of REQUEST_PATTERNS) {
      const m = re.exec(plain);
      if (m) {
        // Last *defined* group: the requested verb, or the awaited noun for "quedo a la espera de…" forms.
        const last =
          m
            .slice(1)
            .filter((g): g is string => typeof g === "string")
            .pop() ?? "";
        const waiting = /^(quedo|espero|waiting|awaiting|looking)/i.test(m[0]);
        if (waiting) {
          verb = /^(quedo|espero)/i.test(m[0]) ? "recibir" : "receive";
          rest = s.slice(m.index + m[0].length - last.length);
        } else {
          verb = requestVerb(last.toLowerCase().replace(/(me|te|nos)$/i, ""));
          rest = s.slice(m.index + m[0].length);
        }
        break;
      }
    }
  }
  // A clause after a comma/semicolon/colon qualifies the action ("…, en cuanto lo revise legal"): drop it.
  const words = (rest.split(/[,;:(]/)[0] ?? "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0 && !STOP.has(w))
    .slice(0, 10);
  const cut = words.findIndex((w) =>
    [
      "antes",
      "before",
      "para",
      "by",
      "cuando",
      "cuanto",
      "when",
      "once",
      "porque",
      "because",
      "si",
      "if",
      "y",
      "and",
      "pero",
      "but",
    ].includes(w),
  );
  const core = (cut > 0 ? words.slice(0, cut) : words).join(" ");
  const action = `${verb ?? ""} ${core}`.trim();
  return action.length > 0 ? action.slice(0, 120) : sentence.slice(0, 120);
}

function requestVerb(requested: string): string {
  const map: Record<string, string> = {
    envie: "enviar",
    envies: "enviar",
    envia: "enviar",
    enviar: "enviar",
    envíe: "enviar",
    envíes: "enviar",
    envía: "enviar",
    manda: "enviar",
    mandes: "enviar",
    mandar: "enviar",
    pasa: "enviar",
    pases: "enviar",
    pasar: "enviar",
    adjuntar: "adjuntar",
    adjunta: "adjuntar",
    confirma: "confirmar",
    confirmes: "confirmar",
    confirmar: "confirmar",
    revisa: "revisar",
    revises: "revisar",
    revisar: "revisar",
    prepara: "preparar",
    prepares: "preparar",
    preparar: "preparar",
    firma: "firmar",
    firmes: "firmar",
    firmar: "firmar",
    responde: "responder",
    respondas: "responder",
    responder: "responder",
    comparte: "compartir",
    compartas: "compartir",
    compartir: "compartir",
    devuelve: "devolver",
    devuelvas: "devolver",
    devolver: "devolver",
    llama: "llamar",
    llames: "llamar",
    llamar: "llamar",
    send: "send",
    share: "share",
    confirm: "confirm",
    review: "review",
    prepare: "prepare",
    sign: "sign",
    return: "return",
    reply: "reply",
    forward: "forward",
    call: "call",
    book: "book",
    update: "update",
    let: "reply",
    get: "reply",
  };
  return map[requested] ?? requested;
}

/**
 * Extracts rule-based commitments from one message. `me` decides the direction: the sender's promises are owed to
 * the other party; requests addressed to me are owed by me.
 */
export function extractCommitmentsByRules(
  message: MailMessageInput,
  ctx: ExtractionContext,
): RuleCommitment[] {
  const me = emailAddress(ctx.me);
  const from = emailAddress(message.from);
  const fromMe = from === me;
  const counterparty = fromMe ? (message.to.map(emailAddress).find((a) => a !== me) ?? null) : from;
  // Relative dates ("mañana", "el viernes") are relative to when the message was written, not to when it is processed.
  const captureCtx: CaptureContext = {
    now: message.date,
    timezone: ctx.timezone,
    clients: [],
    defaultDueHour: 18,
  };
  const out: RuleCommitment[] = [];
  for (const sentence of splitSentences(message.text)) {
    // Patterns run on the accent-free text: JS `\b` treats "é" as a non-word char, so "enviaré " would not match.
    const lower = normalizeText(sentence);
    const promise = OWN_PROMISE_FROM_SENDER.test(lower);
    const request = !promise && REQUEST_PATTERNS.some((re) => re.test(lower));
    const hedged = !promise && !request && HEDGED_ACTION.test(lower);
    if (!promise && !request && !hedged) continue;
    if (NEGATION.test(lower.split(" ").slice(0, 4).join(" "))) continue;
    const direction: RuleCommitment["direction"] = promise
      ? fromMe
        ? "owed_by_me"
        : "owed_to_me"
      : fromMe
        ? "owed_to_me"
        : "owed_by_me";
    const date = findDate(lower, captureCtx);
    const suggested = SUGGESTION_WORDS.test(sentence);
    const kind: RuleCommitment["kind"] = suggested ? "suggested" : promise && date ? "explicit" : "inferred";
    const confidence = kind === "explicit" ? 0.92 : kind === "inferred" ? (date ? 0.72 : 0.62) : 0.45;
    out.push({
      direction,
      counterpartyEmail: counterparty,
      action: deriveAction(sentence, captureCtx),
      dueAt: date?.dueAt ?? null,
      dueText: date?.match.text ?? null,
      kind,
      confidence,
      evidence: sentence.slice(0, 200),
      externalMessageId: message.id,
    });
  }
  return out;
}
