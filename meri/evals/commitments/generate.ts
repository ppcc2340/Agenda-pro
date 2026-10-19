/**
 * Deterministic generator of the commitments golden set (docs/05 §7, F-07 AC1).
 *
 * Writes `generated.jsonl` (≥ 200 synthetic es/en messages with expected commitments) and `automated.jsonl`
 * (newsletters, no-reply, bulk… that the rule prefilter must discard, F-07 AC4). Everything is synthetic: fictional
 * people, domains reserved for documentation, and a seeded PRNG so the set is stable across runs.
 *
 * Run: `pnpm --filter @meri/ai eval:generate` (or `tsx evals/commitments/generate.ts`). No imports beyond node.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

type Lang = "es" | "en";
type Direction = "owed_by_me" | "owed_to_me";
type Kind = "explicit" | "inferred" | "suggested";

interface Expected {
  direction: Direction;
  action: string;
  kind: Kind;
  dueText: string | null;
}

interface Case {
  id: string;
  lang: Lang;
  template: string;
  message: { id: string; from: string; to: string[]; date: string; subject: string; body: string };
  me: string;
  expected: Expected[];
}

interface AutomatedCase {
  id: string;
  message: {
    from: string;
    to: string[];
    subject: string | null;
    headers: Record<string, string>;
    labels: string[];
  };
  expected: { keep: boolean };
}

/** mulberry32: tiny seeded PRNG so the golden set is reproducible. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(20261019);
const pick = <T>(xs: readonly T[]): T => {
  const x = xs[Math.floor(rand() * xs.length)];
  if (x === undefined) throw new Error("empty list");
  return x;
};

const ME: Record<Lang, { email: string; name: string }> = {
  es: { email: "yo@mifirma.example", name: "Carlos" },
  en: { email: "me@firm.example", name: "Sam" },
};
const PEOPLE: Record<Lang, { email: string; name: string }[]> = {
  es: [
    { email: "ana.ruiz@acme.example", name: "Ana" },
    { email: "marta.diaz@lunaabogados.example", name: "Marta" },
    { email: "luis.mora@betalogistica.example", name: "Luis" },
    { email: "paula.sanz@nortegestion.example", name: "Paula" },
    { email: "jorge.vila@delta.example", name: "Jorge" },
  ],
  en: [
    { email: "bob@client.example", name: "Bob" },
    { email: "alice@northwind.example", name: "Alice" },
    { email: "priya@orbit.example", name: "Priya" },
    { email: "tom@harbor.example", name: "Tom" },
    { email: "mei@lattice.example", name: "Mei" },
  ],
};

/** Objects with the content words the rules keep after stop-word removal (what the expected action must contain). */
const OBJECTS: Record<Lang, { text: string; words: string }[]> = {
  es: [
    { text: "el contrato firmado", words: "contrato firmado" },
    { text: "la propuesta revisada", words: "propuesta revisada" },
    { text: "el informe final", words: "informe final" },
    { text: "la factura de octubre", words: "factura octubre" },
    { text: "los datos de ventas", words: "datos ventas" },
    { text: "el presupuesto actualizado", words: "presupuesto actualizado" },
    { text: "las actas de la reunión", words: "actas reunion" },
    { text: "el borrador del acuerdo", words: "borrador acuerdo" },
    { text: "el poder notarial", words: "poder notarial" },
    { text: "la memoria técnica", words: "memoria tecnica" },
  ],
  en: [
    { text: "the signed contract", words: "signed contract" },
    { text: "the revised proposal", words: "revised proposal" },
    { text: "the final report", words: "final report" },
    { text: "the October invoice", words: "october invoice" },
    { text: "the sales figures", words: "sales figures" },
    { text: "the updated budget", words: "updated budget" },
    { text: "the meeting minutes", words: "meeting minutes" },
    { text: "the draft agreement", words: "draft agreement" },
    { text: "the signed NDA", words: "signed nda" },
    { text: "the technical brief", words: "technical brief" },
  ],
};

const DATES: Record<Lang, string[]> = {
  es: [
    "mañana",
    "el lunes",
    "el martes",
    "el miércoles",
    "el jueves",
    "el viernes",
    "hoy",
    "pasado mañana",
    "en dos días",
    "el 28 de octubre",
  ],
  en: [
    "tomorrow",
    "on Monday",
    "on Tuesday",
    "on Wednesday",
    "on Thursday",
    "on Friday",
    "today",
    "in two days",
    "next Monday",
  ],
};

interface Template {
  name: string;
  lang: Lang;
  /** Who writes: the counterparty ("them") or me. */
  from: "them" | "me";
  body: (o: { obj: string; date: string; name: string; myName: string }) => string;
  expected: (o: { words: string; date: string }) => Expected[];
  needsDate: boolean;
}

const V = (verb: string, words: string) => `${verb} ${words}`;
const T: Template[] = [
  // ─── explicit promises (date present) ───
  {
    name: "es.promise.envio",
    lang: "es",
    from: "them",
    needsDate: true,
    body: ({ obj, date }) => `Te envío ${obj} ${date}.`,
    expected: ({ words, date }) => [
      { direction: "owed_to_me", action: V("enviar", words), kind: "explicit", dueText: date },
    ],
  },
  {
    name: "es.promise.mando",
    lang: "es",
    from: "them",
    needsDate: true,
    body: ({ obj, date }) => `Perfecto, ${date} te mando ${obj}.`,
    expected: ({ words, date }) => [
      { direction: "owed_to_me", action: V("enviar", words), kind: "explicit", dueText: date },
    ],
  },
  {
    name: "es.promise.enviare",
    lang: "es",
    from: "them",
    needsDate: true,
    body: ({ obj, date }) => `Enviaré ${obj} ${date} sin falta.`,
    expected: ({ words, date }) => [
      { direction: "owed_to_me", action: V("enviar", words), kind: "explicit", dueText: date },
    ],
  },
  {
    name: "es.promise.paso",
    lang: "es",
    from: "them",
    needsDate: true,
    body: ({ obj, date }) => `Te paso ${obj} ${date} a primera hora.`,
    expected: ({ words, date }) => [
      { direction: "owed_to_me", action: V("enviar", words), kind: "explicit", dueText: date },
    ],
  },
  {
    name: "es.promise.llamo",
    lang: "es",
    from: "them",
    needsDate: true,
    body: ({ date }) => `Te llamo ${date} para cerrar los detalles.`,
    expected: ({ date }) => [{ direction: "owed_to_me", action: "llamar", kind: "explicit", dueText: date }],
  },
  {
    name: "es.promise.mine",
    lang: "es",
    from: "me",
    needsDate: true,
    body: ({ obj, date }) => `Te envío ${obj} ${date}.`,
    expected: ({ words, date }) => [
      { direction: "owed_by_me", action: V("enviar", words), kind: "explicit", dueText: date },
    ],
  },
  {
    name: "es.promise.mine.mando",
    lang: "es",
    from: "me",
    needsDate: true,
    body: ({ obj, date }) => `Perfecto, ${date} te mando ${obj} revisado.`,
    expected: ({ words, date }) => [
      { direction: "owed_by_me", action: V("enviar", words), kind: "explicit", dueText: date },
    ],
  },
  {
    name: "es.promise.mine.preparo",
    lang: "es",
    from: "me",
    needsDate: true,
    body: ({ obj, date }) => `Prepararé ${obj} ${date}.`,
    expected: ({ words, date }) => [
      { direction: "owed_by_me", action: V("preparar", words), kind: "explicit", dueText: date },
    ],
  },
  {
    name: "en.promise.send",
    lang: "en",
    from: "them",
    needsDate: true,
    body: ({ obj, date }) => `I'll send you ${obj} ${date}.`,
    expected: ({ words, date }) => [
      { direction: "owed_to_me", action: V("send", words), kind: "explicit", dueText: date },
    ],
  },
  {
    name: "en.promise.share",
    lang: "en",
    from: "them",
    needsDate: true,
    body: ({ obj, date }) => `I will share ${obj} ${date}, thanks for your patience.`,
    expected: ({ words, date }) => [
      { direction: "owed_to_me", action: V("share", words), kind: "explicit", dueText: date },
    ],
  },
  {
    name: "en.promise.deliver",
    lang: "en",
    from: "them",
    needsDate: true,
    body: ({ obj, date }) => `We'll deliver ${obj} ${date}.`,
    expected: ({ words, date }) => [
      { direction: "owed_to_me", action: V("deliver", words), kind: "explicit", dueText: date },
    ],
  },
  {
    name: "en.promise.review",
    lang: "en",
    from: "them",
    needsDate: true,
    body: ({ obj, date }) => `I'm going to review ${obj} ${date} and get back to you.`,
    expected: ({ words, date }) => [
      { direction: "owed_to_me", action: V("review", words), kind: "explicit", dueText: date },
    ],
  },
  {
    name: "en.promise.mine",
    lang: "en",
    from: "me",
    needsDate: true,
    body: ({ obj, date }) => `I'll send you ${obj} ${date}.`,
    expected: ({ words, date }) => [
      { direction: "owed_by_me", action: V("send", words), kind: "explicit", dueText: date },
    ],
  },
  {
    name: "en.promise.mine.prepare",
    lang: "en",
    from: "me",
    needsDate: true,
    body: ({ obj, date }) => `Sure, I will prepare ${obj} ${date}.`,
    expected: ({ words, date }) => [
      { direction: "owed_by_me", action: V("prepare", words), kind: "explicit", dueText: date },
    ],
  },
  // ─── inferred: promises without a date, requests ───
  {
    name: "es.promise.nodate",
    lang: "es",
    from: "them",
    needsDate: false,
    body: ({ obj }) => `Te envío ${obj} en cuanto lo tenga listo.`,
    expected: ({ words }) => [
      { direction: "owed_to_me", action: V("enviar", words), kind: "inferred", dueText: null },
    ],
  },
  {
    name: "es.request.podrias",
    lang: "es",
    from: "them",
    needsDate: true,
    body: ({ obj, date }) => `¿Podrías enviarme ${obj} ${date}?`,
    expected: ({ words, date }) => [
      { direction: "owed_by_me", action: V("enviar", words), kind: "inferred", dueText: date },
    ],
  },
  {
    name: "es.request.necesito",
    lang: "es",
    from: "them",
    needsDate: true,
    body: ({ obj, date }) => `Necesito que me envíes ${obj} ${date}.`,
    expected: ({ words, date }) => [
      { direction: "owed_by_me", action: V("enviar", words), kind: "inferred", dueText: date },
    ],
  },
  {
    name: "es.request.porfavor",
    lang: "es",
    from: "them",
    needsDate: false,
    body: ({ obj }) => `Por favor, revisa ${obj} cuando puedas.`,
    expected: ({ words }) => [
      { direction: "owed_by_me", action: V("revisar", words), kind: "suggested", dueText: null },
    ],
  },
  {
    name: "es.request.mine",
    lang: "es",
    from: "me",
    needsDate: true,
    body: ({ obj, date }) => `¿Podrías mandarme ${obj} ${date}?`,
    expected: ({ words, date }) => [
      { direction: "owed_to_me", action: V("enviar", words), kind: "inferred", dueText: date },
    ],
  },
  {
    name: "es.request.mine.espera",
    lang: "es",
    from: "me",
    needsDate: false,
    body: ({ obj }) => `Quedo a la espera de ${obj}.`,
    expected: ({ words }) => [
      { direction: "owed_to_me", action: V("recibir", words), kind: "inferred", dueText: null },
    ],
  },
  {
    name: "en.request.mine.waiting",
    lang: "en",
    from: "me",
    needsDate: false,
    body: ({ obj }) => `Looking forward to receiving ${obj}.`,
    expected: ({ words }) => [
      { direction: "owed_to_me", action: V("receive", words), kind: "inferred", dueText: null },
    ],
  },
  {
    name: "en.promise.nodate",
    lang: "en",
    from: "them",
    needsDate: false,
    body: ({ obj }) => `I'll send ${obj} as soon as it is ready.`,
    expected: ({ words }) => [
      { direction: "owed_to_me", action: V("send", words), kind: "inferred", dueText: null },
    ],
  },
  {
    name: "en.request.couldyou",
    lang: "en",
    from: "them",
    needsDate: true,
    body: ({ obj, date }) => `Could you send ${obj} ${date}?`,
    expected: ({ words, date }) => [
      { direction: "owed_by_me", action: V("send", words), kind: "inferred", dueText: date },
    ],
  },
  {
    name: "en.request.please",
    lang: "en",
    from: "them",
    needsDate: true,
    body: ({ obj, date }) => `Please share ${obj} ${date}.`,
    expected: ({ words, date }) => [
      { direction: "owed_by_me", action: V("share", words), kind: "inferred", dueText: date },
    ],
  },
  {
    name: "en.request.mine",
    lang: "en",
    from: "me",
    needsDate: true,
    body: ({ obj, date }) => `Can you send ${obj} ${date}?`,
    expected: ({ words, date }) => [
      { direction: "owed_to_me", action: V("send", words), kind: "inferred", dueText: date },
    ],
  },
  // ─── suggested (hedged) ───
  {
    name: "es.suggest",
    lang: "es",
    from: "them",
    needsDate: false,
    body: ({ obj }) => `Quizá podríamos revisar ${obj} la semana que viene, si te parece.`,
    expected: ({ words }) => [
      { direction: "owed_by_me", action: V("revisar", words), kind: "suggested", dueText: null },
    ],
  },
  {
    name: "en.suggest",
    lang: "en",
    from: "them",
    needsDate: false,
    body: ({ obj }) => `Maybe we could look at ${obj} sometime next month.`,
    expected: ({ words }) => [
      { direction: "owed_by_me", action: V("look", words), kind: "suggested", dueText: null },
    ],
  },
  // ─── two commitments in one message ───
  {
    name: "es.double",
    lang: "es",
    from: "them",
    needsDate: true,
    body: ({ obj, date }) => `Te envío ${obj} ${date}. ¿Podrías confirmarme la fecha de la reunión?`,
    expected: ({ words, date }) => [
      { direction: "owed_to_me", action: V("enviar", words), kind: "explicit", dueText: date },
      { direction: "owed_by_me", action: "confirmar fecha reunion", kind: "inferred", dueText: null },
    ],
  },
  {
    name: "en.double",
    lang: "en",
    from: "them",
    needsDate: true,
    body: ({ obj, date }) => `I'll send ${obj} ${date}. Could you confirm the meeting date?`,
    expected: ({ words, date }) => [
      { direction: "owed_to_me", action: V("send", words), kind: "explicit", dueText: date },
      { direction: "owed_by_me", action: "confirm meeting date", kind: "inferred", dueText: null },
    ],
  },
  // ─── negatives: no commitment ───
  {
    name: "es.none.thanks",
    lang: "es",
    from: "them",
    needsDate: false,
    body: () => `Gracias por la reunión de hoy, fue muy útil. Hablamos pronto.`,
    expected: () => [],
  },
  {
    name: "es.none.info",
    lang: "es",
    from: "them",
    needsDate: false,
    body: () => `El equipo estará de vacaciones la próxima semana. La oficina reabre el día 2.`,
    expected: () => [],
  },
  {
    name: "es.none.negated",
    lang: "es",
    from: "them",
    needsDate: true,
    body: ({ obj, date }) => `No podré enviarte ${obj} ${date}, lo siento.`,
    expected: () => [],
  },
  {
    name: "es.none.receipt",
    lang: "es",
    from: "them",
    needsDate: false,
    body: () => `Confirmamos la recepción de su pago. No es necesario responder a este mensaje.`,
    expected: () => [],
  },
  {
    name: "en.none.thanks",
    lang: "en",
    from: "them",
    needsDate: false,
    body: () => `Thanks for the call today, that was very helpful. Talk soon.`,
    expected: () => [],
  },
  {
    name: "en.none.info",
    lang: "en",
    from: "them",
    needsDate: false,
    body: () => `The office will be closed next Monday for the public holiday.`,
    expected: () => [],
  },
  {
    name: "en.none.negated",
    lang: "en",
    from: "them",
    needsDate: true,
    body: ({ obj, date }) => `I won't be able to send ${obj} ${date}, sorry about that.`,
    expected: () => [],
  },
  {
    name: "en.none.receipt",
    lang: "en",
    from: "them",
    needsDate: false,
    body: () => `We have received your payment. No reply is needed.`,
    expected: () => [],
  },
  // ─── quoted reply trap: the promise is in the quoted part (must be ignored) ───
  {
    name: "es.quoted",
    lang: "es",
    from: "them",
    needsDate: true,
    body: ({ obj, date, myName }) =>
      `Recibido, gracias.\n\nEl lun, 12 oct 2026, ${myName} escribió:\n> Te envío ${obj} ${date}.\n> Un saludo`,
    expected: () => [],
  },
  {
    name: "en.quoted",
    lang: "en",
    from: "them",
    needsDate: true,
    body: ({ obj, date, myName }) =>
      `Received, thanks!\n\nOn Mon, Oct 12, 2026, ${myName} wrote:\n> I'll send you ${obj} ${date}.\n> Best`,
    expected: () => [],
  },
];

const GREETINGS: Record<Lang, ((name: string) => string)[]> = {
  es: [(n) => `Hola ${n},\n\n`, () => `Buenos días,\n\n`, () => ``, (n) => `${n}, `],
  en: [(n) => `Hi ${n},\n\n`, () => `Hello,\n\n`, () => ``, (n) => `${n}, `],
};
const SIGNOFFS: Record<Lang, ((name: string) => string)[]> = {
  es: [(n) => `\n\nUn saludo,\n${n}`, (n) => `\n\nGracias,\n${n}\n--\n${n} · Tel. 600 000 000`, () => ``],
  en: [(n) => `\n\nBest regards,\n${n}`, (n) => `\n\nThanks,\n${n}\n--\n${n} | Mobile 555-0100`, () => ``],
};
const SUBJECTS: Record<Lang, string[]> = {
  es: ["RE: Contrato de servicios", "Documentación pendiente", "RE: Reunión de seguimiento", "Entrega"],
  en: ["RE: Services agreement", "Pending documents", "RE: Follow-up meeting", "Delivery"],
};

function buildCases(perTemplate: number): Case[] {
  const out: Case[] = [];
  let n = 0;
  for (const t of T) {
    for (let i = 0; i < perTemplate; i++) {
      n++;
      const me = ME[t.lang];
      const them = pick(PEOPLE[t.lang]);
      const obj = pick(OBJECTS[t.lang]);
      const date = t.needsDate ? pick(DATES[t.lang]) : "";
      const fromMe = t.from === "me";
      const greet = pick(GREETINGS[t.lang])(fromMe ? them.name : me.name);
      const sign = pick(SIGNOFFS[t.lang])(fromMe ? me.name : them.name);
      const core = t.body({ obj: obj.text, date, name: them.name, myName: me.name });
      const day = 5 + Math.floor(rand() * 10); // 2026-10-05 … 2026-10-14, all within the 30-day window
      const hour = 8 + Math.floor(rand() * 9);
      out.push({
        id: `g-${String(n).padStart(4, "0")}`,
        lang: t.lang,
        template: t.name,
        message: {
          id: `m-${String(n)}`,
          from: fromMe ? me.email : `${them.name} <${them.email}>`,
          to: [fromMe ? them.email : me.email],
          date: `2026-10-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00Z`,
          subject: pick(SUBJECTS[t.lang]),
          body: `${greet}${core}${sign}`,
        },
        me: me.email,
        expected: t.expected({ words: obj.words, date }),
      });
    }
  }
  return out;
}

function buildAutomated(): AutomatedCase[] {
  const me = "me@firm.example";
  const base = { to: [me], labels: ["INBOX"] as string[], headers: {} as Record<string, string> };
  const cases: AutomatedCase[] = [];
  const add = (m: Partial<AutomatedCase["message"]> & { from: string }, keep: boolean) =>
    cases.push({
      id: `a-${String(cases.length + 1).padStart(3, "0")}`,
      message: { subject: null, ...base, ...m },
      expected: { keep },
    });
  const senders = [
    "news",
    "newsletter",
    "no-reply",
    "noreply",
    "notifications",
    "alerts",
    "marketing",
    "info",
  ];
  const domains = ["shop.example", "saas.example", "bank.example", "airline.example", "social.example"];
  for (const s of senders)
    for (const d of domains) add({ from: `${s}@${d}`, subject: `Weekly update from ${d}` }, false);
  for (const d of domains) {
    add(
      {
        from: `hello@${d}`,
        subject: "Our October offers",
        headers: { "List-Unsubscribe": `<mailto:unsub@${d}>` },
      },
      false,
    );
    add({ from: `team@${d}`, subject: "Product news", headers: { Precedence: "bulk" } }, false);
    add(
      { from: `system@${d}`, subject: "Your receipt", headers: { "Auto-Submitted": "auto-generated" } },
      false,
    );
    add(
      { from: `promo@${d}`, subject: "Sale ends tonight", labels: ["INBOX", "CATEGORY_PROMOTIONS"] },
      false,
    );
    add(
      { from: `updates@${d}`, subject: "Someone mentioned you", labels: ["INBOX", "CATEGORY_SOCIAL"] },
      false,
    );
  }
  add(
    {
      from: "calendar-notification@google.example",
      subject: "Invitation: Sync @ Tue",
      headers: { "Content-Type": "text/calendar" },
    },
    false,
  );
  add({ from: "mailer-daemon@mx.example", subject: "Delivery Status Notification (Failure)" }, false);
  add({ from: "postmaster@mx.example", subject: "Undeliverable" }, false);
  // People mail must be kept, whatever the subject.
  add({ from: "Ana Ruiz <ana.ruiz@acme.example>", subject: "RE: Contrato" }, true);
  add({ from: "bob@client.example", subject: "Weekly update" }, true);
  add({ from: "marta.diaz@lunaabogados.example", subject: "Newsletter de la firma (borrador)" }, true);
  add({ from: "tom@harbor.example", subject: "Invoice question" }, true);
  add({ from: "priya@orbit.example", subject: null }, true);
  return cases;
}

function main() {
  const dir = import.meta.dirname;
  const cases = buildCases(6);
  writeFileSync(resolve(dir, "generated.jsonl"), cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
  const automated = buildAutomated();
  writeFileSync(resolve(dir, "automated.jsonl"), automated.map((c) => JSON.stringify(c)).join("\n") + "\n");
  console.warn(
    `generated ${String(cases.length)} commitment cases and ${String(automated.length)} automated-mail cases`,
  );
}

main();
