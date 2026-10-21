/**
 * Transactional email copies of in-app notifications (D-113, D-114). Pure: which notifications may be emailed under
 * the workspace's preference, and their text. An email carries **counts and a link, never content** (task titles,
 * client names, mail text), so the email provider never receives client data.
 */

export const EMAIL_PREFERENCES = ["off", "digest", "all"] as const;
export type EmailPreference = (typeof EMAIL_PREFERENCES)[number];
export type NotificationKind = "digest" | "risk" | "proposals" | "plan" | "integration" | "billing";
export type EmailLocale = "es" | "en";

/**
 * `digest` (default): the morning summary and what keeps the account working (billing, connections).
 * `all`: also risks, proposals, plan changes and the end-of-day close. `off`: nothing.
 */
export function emailAllowed(pref: EmailPreference, kind: NotificationKind, template: string): boolean {
  if (pref === "off") return false;
  if (pref === "all") return true;
  return kind === "billing" || kind === "integration" || template === "daily.digest";
}

interface Copy {
  subject: string;
  lines: string[];
  cta: string;
  path: string;
}

const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;

const blocksEs = (b: number) =>
  b === 0
    ? "sin bloques planificados"
    : b === 1
      ? "1 bloque planificado"
      : `${String(b)} bloques planificados`;
const blocksEn = (b: number) =>
  b === 0 ? "no blocks planned" : b === 1 ? "1 block planned" : `${String(b)} blocks planned`;

type CopyFn = (p: Record<string, unknown>) => Copy;

const ES: Record<string, CopyFn> = {
  "daily.digest": (p) => ({
    subject: `Tu día en Meri: ${blocksEs(num(p.blocks))}`,
    lines: [
      `Bloques planificados para hoy: ${String(num(p.blocks))}.`,
      `Riesgos y conflictos: ${String(num(p.risks))}.`,
      `Propuestas por revisar: ${String(num(p.proposals))}.`,
    ],
    cta: "Abrir Hoy",
    path: "/hoy",
  }),
  "daily.close": () => ({
    subject: "Tu cierre del día está listo",
    lines: ["Meri preparó el resumen de lo que hiciste hoy y lo que queda para mañana."],
    cta: "Ver el cierre",
    path: "/hoy",
  }),
  "risk.grouped": () => ({
    subject: "Meri detectó riesgos en tu plan",
    lines: ["Hay trabajo que podría no llegar a tiempo. Revisa las alternativas antes de decidir."],
    cta: "Ver riesgos",
    path: "/hoy",
  }),
  "conflict.grouped": () => ({
    subject: "Hay conflictos en tu calendario",
    lines: ["Algunos bloques de trabajo no caben con tus reuniones. Meri propone alternativas."],
    cta: "Ver conflictos",
    path: "/hoy",
  }),
  "plan.applied": () => ({
    subject: "Meri ajustó tu plan",
    lines: [
      "Se aplicaron cambios seguros a tu plan. Puedes deshacerlos desde Actividad, en el Centro de control.",
    ],
    cta: "Ver el plan",
    path: "/hoy",
  }),
  "plan.proposed": () => ({
    subject: "Meri propone reorganizar tu plan",
    lines: ["Nada se mueve hasta que lo confirmes."],
    cta: "Revisar la propuesta",
    path: "/hoy",
  }),
  "billing.payment_failed": () => ({
    subject: "No pudimos cobrar tu suscripción de Meri",
    lines: ["Actualiza el método de pago para seguir usando las funciones de pago. No se borra nada."],
    cta: "Revisar el pago",
    path: "/control#plan",
  }),
  "credits.warning": () => ({
    subject: "Usaste la mayor parte de tus créditos de IA",
    lines: ["Cuando se agoten, Meri seguirá funcionando con reglas hasta el próximo ciclo."],
    cta: "Ver créditos",
    path: "/control#plan",
  }),
  "credits.exhausted": () => ({
    subject: "Se agotaron tus créditos de IA",
    lines: ["Meri sigue funcionando con reglas. Puedes comprar créditos o esperar al próximo ciclo."],
    cta: "Ver créditos",
    path: "/control#plan",
  }),
  "proposals.new": () => ({
    subject: "Tienes propuestas nuevas por revisar",
    lines: ["Revísalas en Entrada. Nada se confirma sin ti."],
    cta: "Abrir Entrada",
    path: "/entrada",
  }),
  "followups.due": () => ({
    subject: "Hay seguimientos sugeridos",
    lines: [
      "Meri preparó seguimientos para compromisos sin respuesta. Revísalos en Entrada: nada se envía solo.",
    ],
    cta: "Abrir Entrada",
    path: "/entrada",
  }),
  "integration.needs_reauth": () => ({
    subject: "Vuelve a conectar Google en Meri",
    lines: [
      "Google dejó de dar acceso a Meri, así que no podemos leer tu calendario ni tu correo.",
      "Vuelve a conectarlo desde el Centro de control; tarda un minuto.",
    ],
    cta: "Revisar conexiones",
    path: "/control",
  }),
  "trial.ending": () => ({
    subject: "Tu prueba de Meri termina pronto",
    lines: ["Elige un plan para seguir usando todas las funciones. Si no lo haces, no se borra nada."],
    cta: "Elegir plan",
    path: "/control#plan",
  }),
};

const EN: Record<string, CopyFn> = {
  "daily.digest": (p) => ({
    subject: `Your day in Meri: ${blocksEn(num(p.blocks))}`,
    lines: [
      `Blocks planned for today: ${String(num(p.blocks))}.`,
      `Risks and conflicts: ${String(num(p.risks))}.`,
      `Proposals to review: ${String(num(p.proposals))}.`,
    ],
    cta: "Open Today",
    path: "/hoy",
  }),
  "daily.close": () => ({
    subject: "Your end-of-day close is ready",
    lines: ["Meri summarized what you did today and what is left for tomorrow."],
    cta: "See the close",
    path: "/hoy",
  }),
  "risk.grouped": () => ({
    subject: "Meri found risks in your plan",
    lines: ["Some work may not make it on time. Review the alternatives before deciding."],
    cta: "See risks",
    path: "/hoy",
  }),
  "conflict.grouped": () => ({
    subject: "There are conflicts in your calendar",
    lines: ["Some work blocks do not fit around your meetings. Meri suggests alternatives."],
    cta: "See conflicts",
    path: "/hoy",
  }),
  "plan.applied": () => ({
    subject: "Meri adjusted your plan",
    lines: ["Safe changes were applied to your plan. You can undo them from Activity in the Control centre."],
    cta: "See the plan",
    path: "/hoy",
  }),
  "plan.proposed": () => ({
    subject: "Meri suggests rearranging your plan",
    lines: ["Nothing moves until you confirm."],
    cta: "Review the proposal",
    path: "/hoy",
  }),
  "billing.payment_failed": () => ({
    subject: "We could not charge your Meri subscription",
    lines: ["Update your payment method to keep the paid features. Nothing is deleted."],
    cta: "Review payment",
    path: "/control#plan",
  }),
  "credits.warning": () => ({
    subject: "You have used most of your AI credits",
    lines: ["When they run out, Meri keeps working with rules until the next cycle."],
    cta: "See credits",
    path: "/control#plan",
  }),
  "credits.exhausted": () => ({
    subject: "Your AI credits ran out",
    lines: ["Meri keeps working with rules. You can buy credits or wait for the next cycle."],
    cta: "See credits",
    path: "/control#plan",
  }),
  "proposals.new": () => ({
    subject: "You have new proposals to review",
    lines: ["Review them in Inbox. Nothing is confirmed without you."],
    cta: "Open Inbox",
    path: "/entrada",
  }),
  "followups.due": () => ({
    subject: "There are suggested follow-ups",
    lines: [
      "Meri prepared follow-ups for commitments without a reply. Review them in Inbox: nothing is sent on its own.",
    ],
    cta: "Open Inbox",
    path: "/entrada",
  }),
  "integration.needs_reauth": () => ({
    subject: "Reconnect Google in Meri",
    lines: [
      "Google stopped giving Meri access, so we cannot read your calendar or mail.",
      "Reconnect it from the Control centre; it takes a minute.",
    ],
    cta: "Review connections",
    path: "/control",
  }),
  "trial.ending": () => ({
    subject: "Your Meri trial ends soon",
    lines: ["Choose a plan to keep every feature. If you do not, nothing is deleted."],
    cta: "Choose a plan",
    path: "/control#plan",
  }),
};

/** One sentence per kind when the template has no copy of its own (new templates degrade safely). */
const FALLBACK: Record<EmailLocale, Record<NotificationKind, Copy>> = {
  es: {
    digest: { subject: "Tienes un resumen nuevo en Meri", lines: [], cta: "Abrir Meri", path: "/hoy" },
    risk: { subject: "Meri detectó un riesgo en tu plan", lines: [], cta: "Ver riesgos", path: "/hoy" },
    proposals: {
      subject: "Tienes propuestas nuevas por revisar",
      lines: ["Revísalas en Entrada. Nada se confirma sin ti."],
      cta: "Abrir Entrada",
      path: "/entrada",
    },
    plan: { subject: "Hay cambios en tu plan", lines: [], cta: "Ver el plan", path: "/hoy" },
    integration: {
      subject: "Tu conexión con Google necesita atención",
      lines: ["Mientras tanto, Meri no puede leer tu calendario ni tu correo."],
      cta: "Revisar conexiones",
      path: "/control",
    },
    billing: { subject: "Aviso sobre tu plan de Meri", lines: [], cta: "Ver el plan", path: "/control#plan" },
  },
  en: {
    digest: { subject: "You have a new summary in Meri", lines: [], cta: "Open Meri", path: "/hoy" },
    risk: { subject: "Meri found a risk in your plan", lines: [], cta: "See risks", path: "/hoy" },
    proposals: {
      subject: "You have new proposals to review",
      lines: ["Review them in Inbox. Nothing is confirmed without you."],
      cta: "Open Inbox",
      path: "/entrada",
    },
    plan: { subject: "There are changes to your plan", lines: [], cta: "See the plan", path: "/hoy" },
    integration: {
      subject: "Your Google connection needs attention",
      lines: ["Until then, Meri cannot read your calendar or mail."],
      cta: "Review connections",
      path: "/control",
    },
    billing: {
      subject: "A notice about your Meri plan",
      lines: [],
      cta: "See the plan",
      path: "/control#plan",
    },
  },
};

const FOOTER: Record<EmailLocale, { why: string; manage: string; unsubscribe: string }> = {
  es: {
    why: "Recibes este correo porque tienes una cuenta en Meri. Nunca incluimos el contenido de tus tareas, clientes ni correos.",
    manage: "Elegir qué correos recibir",
    unsubscribe: "Dejar de recibir correos de Meri",
  },
  en: {
    why: "You get this email because you have a Meri account. We never include the content of your tasks, clients or mail.",
    manage: "Choose which emails you get",
    unsubscribe: "Stop getting emails from Meri",
  },
};

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export interface EmailRenderInput {
  kind: NotificationKind;
  template: string;
  params: Record<string, unknown>;
  locale: EmailLocale;
  /** Origin of the web app, e.g. https://app.example.com (no trailing slash). */
  appUrl: string;
  /** Web page that confirms the unsubscribe (a GET never unsubscribes). */
  unsubscribePageUrl: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function renderNotificationEmail(input: EmailRenderInput): RenderedEmail {
  const table = input.locale === "en" ? EN : ES;
  const copy = table[input.template]?.(input.params) ?? FALLBACK[input.locale][input.kind];
  const footer = FOOTER[input.locale];
  const base = input.appUrl.replace(/\/+$/, "");
  const link = `${base}${copy.path}`;
  const manage = `${base}/control#correo`;
  const text = [
    ...copy.lines,
    "",
    `${copy.cta}: ${link}`,
    "",
    "—",
    footer.why,
    `${footer.manage}: ${manage}`,
    `${footer.unsubscribe}: ${input.unsubscribePageUrl}`,
    "",
  ].join("\n");
  const html = [
    `<!doctype html><html lang="${input.locale}"><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#13202e;line-height:1.5">`,
    ...copy.lines.map((l) => `<p>${escapeHtml(l)}</p>`),
    `<p><a href="${escapeHtml(link)}" style="color:#0e6b74;font-weight:600">${escapeHtml(copy.cta)}</a></p>`,
    `<hr style="border:none;border-top:1px solid #d9dee3">`,
    `<p style="font-size:12px;color:#55606b">${escapeHtml(footer.why)}<br>`,
    `<a href="${escapeHtml(manage)}" style="color:#55606b">${escapeHtml(footer.manage)}</a> · `,
    `<a href="${escapeHtml(input.unsubscribePageUrl)}" style="color:#55606b">${escapeHtml(footer.unsubscribe)}</a></p>`,
    `</body></html>`,
  ].join("");
  return { subject: copy.subject, text, html };
}
