import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import es from "../../../messages/es.json";
import { AppShell } from "./app-shell";

vi.mock("next/navigation", () => ({
  usePathname: () => "/entrada",
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

describe("AppShell", () => {
  it("renders the five desktop areas, the five mobile tabs and marks the current one", () => {
    render(
      <NextIntlClientProvider locale="es" messages={es}>
        <AppShell badges={{ entrada: 3 }}>
          <p>content</p>
        </AppShell>
      </NextIntlClientProvider>,
    );
    const navs = screen.getAllByRole("navigation", { name: "Áreas" });
    expect(navs).toHaveLength(2);
    const [desktopNav, mobileNav] = navs as [HTMLElement, HTMLElement];
    const desktopLinks = desktopNav.querySelectorAll("a");
    expect([...desktopLinks].map((a) => a.textContent.replace("3", ""))).toEqual([
      "Hoy",
      "Entrada",
      "Proyectos y compromisos",
      "Calendario",
      "Centro de control",
    ]);
    const mobileLinks = mobileNav.querySelectorAll("a");
    expect([...mobileLinks].map((a) => a.textContent.replace("3", ""))).toEqual([
      "Hoy",
      "Entrada",
      "Agenda",
      "Compromisos",
      "Más",
    ]);
    expect(screen.getAllByRole("link", { current: "page" }).map((l) => l.getAttribute("href"))).toEqual([
      "/entrada",
      "/entrada",
    ]);
    expect(screen.getAllByText("3")).toHaveLength(2);
    expect(screen.getByRole("main")).toHaveTextContent("content");
  });
});
