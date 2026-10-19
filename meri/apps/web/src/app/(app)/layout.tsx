import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import type * as React from "react";
import { signOutAction } from "@/app/actions";
import { MobileCapture, PaletteProvider } from "@/components/capture/palette";
import { AppShell } from "@/components/shell/app-shell";
import { apiFetch, getMe } from "@/server/api";

/** Authenticated areas. Session validated against the API; incomplete onboarding is redirected. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe();
  if (!me) redirect("/login");
  if (!me.onboarded) redirect("/onboarding");
  const t = await getTranslations("app");
  const [clients, prefs, proposals] = await Promise.all([
    apiFetch<{ items: { id: string; name: string }[] }>("/v1/clients").catch(() => ({ items: [] })),
    apiFetch<{ timezone: string }>("/v1/preferences"),
    apiFetch<{ items: unknown[] }>("/v1/proposals?status=pending&limit=100").catch(() => ({ items: [] })),
  ]);
  const paletteData = { clients: clients.items, timezone: prefs.timezone };
  return (
    <PaletteProvider data={paletteData}>
      <AppShell
        badges={{ entrada: proposals.items.length }}
        footer={
          <form action={signOutAction}>
            <button type="submit" className="bg-transparent p-0 text-left text-rail-ink">
              {t("signOut")}
            </button>
          </form>
        }
      >
        {children}
      </AppShell>
      <MobileCapture data={paletteData} />
    </PaletteProvider>
  );
}
