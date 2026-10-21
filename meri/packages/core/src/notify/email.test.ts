import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EMAIL_PREFERENCES,
  emailAllowed,
  renderNotificationEmail,
  type EmailLocale,
  type NotificationKind,
} from "./email";

const KINDS: NotificationKind[] = ["digest", "risk", "proposals", "plan", "integration", "billing"];
const base = {
  appUrl: "https://app.example.com/",
  unsubscribePageUrl: "https://app.example.com/correo/baja?t=tok",
};

describe("emailAllowed (D-114)", () => {
  it("off sends nothing; all sends everything", () => {
    for (const kind of KINDS) {
      expect(emailAllowed("off", kind, "daily.digest")).toBe(false);
      expect(emailAllowed("all", kind, "anything")).toBe(true);
    }
  });

  it("digest sends the morning summary and account notices, not the close, risks or proposals", () => {
    expect(emailAllowed("digest", "digest", "daily.digest")).toBe(true);
    expect(emailAllowed("digest", "digest", "daily.close")).toBe(false);
    expect(emailAllowed("digest", "billing", "billing.payment_failed")).toBe(true);
    expect(emailAllowed("digest", "integration", "integration.needs_reauth")).toBe(true);
    expect(emailAllowed("digest", "risk", "risk.grouped")).toBe(false);
    expect(emailAllowed("digest", "proposals", "proposals.new")).toBe(false);
    expect(emailAllowed("digest", "plan", "plan.applied")).toBe(false);
  });

  it("preferences are exactly off, digest and all", () => {
    expect(EMAIL_PREFERENCES).toEqual(["off", "digest", "all"]);
  });
});

describe("renderNotificationEmail (D-114)", () => {
  it("renders the digest with counts and links, in Spanish and English", () => {
    const es = renderNotificationEmail({
      ...base,
      kind: "digest",
      template: "daily.digest",
      params: { blocks: 4, risks: 1, proposals: 2 },
      locale: "es",
    });
    expect(es.subject).toBe("Tu día en Meri: 4 bloques planificados");
    expect(es.text).toContain("Riesgos y conflictos: 1.");
    expect(es.text).toContain("Abrir Hoy: https://app.example.com/hoy");
    expect(es.text).toContain("Dejar de recibir correos de Meri: https://app.example.com/correo/baja?t=tok");
    expect(es.html).toContain('href="https://app.example.com/hoy"');
    const en = renderNotificationEmail({
      ...base,
      kind: "digest",
      template: "daily.digest",
      params: { blocks: 4, risks: 1, proposals: 2 },
      locale: "en",
    });
    expect(en.subject).toBe("Your day in Meri: 4 blocks planned");
    expect(en.html).toContain('<html lang="en">');
  });

  it("falls back per kind for unknown templates and links billing to the plan panel", () => {
    expect(
      renderNotificationEmail({ ...base, kind: "integration", template: "x.y", params: {}, locale: "es" })
        .subject,
    ).toBe("Tu conexión con Google necesita atención");
    expect(
      renderNotificationEmail({
        ...base,
        kind: "billing",
        template: "billing.payment_failed",
        params: {},
        locale: "en",
      }).text,
    ).toContain("https://app.example.com/control#plan");
  });

  it("property: never carries notification params other than counts, and escapes everything", () => {
    const locales: EmailLocale[] = ["es", "en"];
    fc.assert(
      fc.property(
        fc.constantFrom(...KINDS),
        fc.constantFrom("daily.digest", "risk.grouped", "proposals.new", "unknown.template"),
        fc.constantFrom(...locales),
        fc.string({ minLength: 3, maxLength: 40 }).map((s) => `SECRET${s}<script>`),
        (kind, template, locale, secret) => {
          const out = renderNotificationEmail({
            ...base,
            kind,
            template,
            locale,
            params: { blocks: secret, title: secret, client: secret, risks: 2 },
          });
          return (
            !out.text.includes("SECRET") &&
            !out.html.includes("SECRET") &&
            !out.subject.includes("SECRET") &&
            !out.html.includes("<script>")
          );
        },
      ),
      { numRuns: 500, seed: 7 },
    );
  });

  it("the digest subject agrees in number", () => {
    const subject = (blocks: number, locale: EmailLocale) =>
      renderNotificationEmail({
        ...base,
        kind: "digest",
        template: "daily.digest",
        params: { blocks, risks: 0, proposals: 0 },
        locale,
      }).subject;
    expect(subject(1, "es")).toBe("Tu día en Meri: 1 bloque planificado");
    expect(subject(2, "es")).toBe("Tu día en Meri: 2 bloques planificados");
    expect(subject(0, "en")).toBe("Your day in Meri: no blocks planned");
    expect(subject(1, "en")).toBe("Your day in Meri: 1 block planned");
  });

  it("escapes the links it is given", () => {
    const out = renderNotificationEmail({
      kind: "digest",
      template: "daily.digest",
      params: {},
      locale: "es",
      appUrl: 'https://app.example.com/"><script>',
      unsubscribePageUrl: 'https://app.example.com/x?t="><script>',
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("non-numeric or negative counts render as 0", () => {
    const out = renderNotificationEmail({
      ...base,
      kind: "digest",
      template: "daily.digest",
      params: { blocks: -3, risks: "9", proposals: Number.NaN },
      locale: "es",
    });
    expect(out.subject).toBe("Tu día en Meri: sin bloques planificados");
    expect(out.text).toContain("Riesgos y conflictos: 0.");
  });
});
