import type { FakeGmail } from "./mail";

/**
 * Demo mailbox (PROTOTYPE.md, D-052): the threads behind the seeded radar, shared by the `demo@meri.local`
 * FakeGmail (so follow-up drafts reply to real messages, like Gmail) and by `scripts/demo-seed.ts` (same
 * thread and message ids in `threads_index`). The seed pins the history cursor past these messages, so the
 * worker's sync never re-extracts them: the seeded commitments and proposals stay the source of truth.
 */
export interface DemoMailThread {
  key: string;
  subject: string;
  /** Counterparty of the thread. */
  from: { email: string; name: string };
  /** Seed client key the thread belongs to. */
  clientKey: string;
  /** Days before `now` of the latest message. */
  daysAgo: number;
  /** Whether the latest message is ours (an unanswered thread feeds the follow-up rules). */
  fromMe: boolean;
  /** Messages in chronological order; `demo-<key>-m<n>` ids. */
  messages: { from: "them" | "me"; daysAgo: number; bodyText: string }[];
}

export const DEMO_MAIL_THREADS: readonly DemoMailThread[] = [
  {
    key: "contrato",
    subject: "RE: Contrato de servicios 2026",
    from: { email: "ana@acme.com", name: "Ana Ruiz" },
    clientKey: "acme",
    daysAgo: 1,
    fromMe: false,
    messages: [
      {
        from: "them",
        daysAgo: 1,
        bodyText:
          "Hola,\n\nGracias por la llamada de ayer. Te envío el contrato firmado el miércoles, en cuanto lo revise legal.\n\nUn saludo,\nAna Ruiz\nAcme Corp",
      },
    ],
  },
  {
    key: "presupuesto",
    subject: "Presupuesto transporte Q4",
    from: { email: "pablo@betalogistica.com", name: "Pablo Soto" },
    clientKey: "beta",
    daysAgo: 2,
    fromMe: false,
    messages: [
      {
        from: "them",
        daysAgo: 2,
        bodyText:
          "Hola,\n\n¿Podrías mirar el presupuesto cuando puedas? Por mi parte, apruebo el presupuesto el viernes si no hay cambios.\n\nSaludos,\nPablo Soto\nBeta Logística",
      },
    ],
  },
  {
    key: "cierre",
    subject: "Cierre de proyecto",
    from: { email: "laura@estudionorte.cl", name: "Laura Vidal" },
    clientKey: "norte",
    daysAgo: 2,
    fromMe: false,
    messages: [
      {
        from: "them",
        daysAgo: 2,
        bodyText:
          "Hola,\n\nQuizá podríamos vernos a fin de mes para cerrar el proyecto con el equipo.\n\nLaura Vidal\nEstudio Norte",
      },
    ],
  },
  {
    key: "ventas",
    subject: "Datos de ventas Q3",
    from: { email: "carlos@acme.com", name: "Carlos Ibáñez" },
    clientKey: "acme",
    daysAgo: 8,
    fromMe: true,
    messages: [
      {
        from: "them",
        daysAgo: 9,
        bodyText:
          "Hola,\n\nte paso los datos de ventas del tercer trimestre mañana, en cuanto cierre finanzas.\n\nCarlos Ibáñez\nAcme Corp",
      },
      { from: "me", daysAgo: 8, bodyText: "Gracias, Carlos. Quedo atento a los datos.\n" },
    ],
  },
  {
    key: "poder",
    subject: "Poder notarial",
    from: { email: "marta@lunalegal.es", name: "Marta Díaz" },
    clientKey: "luna",
    daysAgo: 5,
    fromMe: false,
    messages: [
      {
        from: "them",
        daysAgo: 5,
        bodyText:
          "Buenos días,\n\nte envío el poder notarial firmado el miércoles. ¿Puedes confirmar la fecha de audiencia?\n\nGracias,\nMarta Díaz\nLuna Legal",
      },
    ],
  },
];

/** Number of messages the demo mailbox holds: the history cursor the seed pins (FakeGmail counts messages). */
export const DEMO_MAIL_MESSAGE_COUNT = DEMO_MAIL_THREADS.reduce((n, t) => n + t.messages.length, 0);

/** 10:00 Madrid-ish (08:00Z) `daysAgo` days before `now`, in UTC days so the seed and the fake agree. */
export function demoMailDate(now: Date, daysAgo: number): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(8, 0, 0, 0);
  return d.toISOString();
}

export const demoMessageId = (key: string, index: number): string => `demo-${key}-m${String(index + 1)}`;
export const demoThreadId = (key: string): string => `demo-${key}`;

export function seedDemoMail(mail: FakeGmail, me: string, now: Date): void {
  const all = DEMO_MAIL_THREADS.flatMap((t) =>
    t.messages.map((m, i) => ({
      id: demoMessageId(t.key, i),
      threadId: demoThreadId(t.key),
      from: m.from === "me" ? me : `${t.from.name} <${t.from.email}>`,
      to: [m.from === "me" ? t.from.email : me],
      headers: {},
      labels: [m.from === "me" ? "SENT" : "INBOX"],
      subject: t.subject,
      date: demoMailDate(now, m.daysAgo),
      snippet:
        m.bodyText.split("\n").find((line) => line.trim().length > 0 && !/^(hola|buenos días)/i.test(line)) ??
        "",
      bodyText: m.bodyText,
    })),
  );
  all.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  for (const m of all) mail.addMessage(m);
}
