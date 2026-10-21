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

import { SECURITY_SECTIONS, SecurityPage } from "./security-page";

describe("SecurityPage", () => {
  it("renders every section in both languages with links to the legal pages", async () => {
    for (const locale of ["es", "en"] as const) {
      process.env.TEST_LOCALE = locale;
      const m = locale === "es" ? es : en;
      const { unmount } = render(await SecurityPage());
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(m.security.title);
      expect(Object.keys(m.security.sections)).toEqual([...SECURITY_SECTIONS]);
      for (const s of SECURITY_SECTIONS) {
        expect(
          screen.getByRole("heading", { level: 2, name: m.security.sections[s].title }),
        ).toBeInTheDocument();
        expect(screen.getByText(m.security.sections[s].body)).toBeInTheDocument();
      }
      expect(screen.getByRole("link", { name: m.security.privacy })).toHaveAttribute("href", "/privacy");
      expect(screen.getByRole("link", { name: m.security.terms })).toHaveAttribute("href", "/terms");
      expect(document.body.textContent).not.toMatch(/security\./);
      unmount();
    }
  });

  it("states the product promises the code enforces: drafts only, Meri calendar only, no training", () => {
    expect(es.security.sections.never.body).toMatch(/solo preparamos borradores/);
    expect(es.security.sections.never.body).toMatch(/calendario «Meri»/);
    expect(en.security.sections.never.body).toMatch(/train general models/);
  });
});
