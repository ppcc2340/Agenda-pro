import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import en from "../../messages/en.json";
import es from "../../messages/es.json";

vi.mock("next-intl/server", () => ({
  getTranslations: (ns: string) => {
    const locale = process.env.TEST_LOCALE === "en" ? en : es;
    const table = ns
      .split(".")
      .reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], locale) as Record<string, unknown>;
    const t = (key: string) =>
      key.split(".").reduce<unknown>((acc, k) => (acc as Record<string, unknown>)[k], table) as string;
    return Promise.resolve(t);
  },
}));

import { LegalPage } from "./legal-page";

describe("LegalPage", () => {
  it("renders privacy and terms drafts from the catalogues in both languages", async () => {
    for (const locale of ["es", "en"] as const) {
      process.env.TEST_LOCALE = locale;
      const m = locale === "es" ? es : en;
      for (const kind of ["privacy", "terms"] as const) {
        const { unmount } = render(await LegalPage({ kind }));
        expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
          kind === "privacy" ? m.legal.privacyTitle : m.legal.termsTitle,
        );
        expect(screen.getByText(m.legal.draftNote)).toBeInTheDocument();
        const paragraphs = kind === "privacy" ? Object.values(m.legal.privacy) : Object.values(m.legal.terms);
        for (const p of paragraphs) expect(screen.getByText(p)).toBeInTheDocument();
        expect(document.body.textContent).not.toMatch(/legal\.(privacy|terms)\./);
        unmount();
      }
    }
  });
});
