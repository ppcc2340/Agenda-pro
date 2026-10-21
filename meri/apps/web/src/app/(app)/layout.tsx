import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import type * as React from "react";
import { signOutAction } from "@/app/actions";
import { MobileCapture, PaletteProvider } from "@/components/capture/palette";
import { AppShell } from "@/components/shell/app-shell";
import { AiPausedBanner } from "@/components/billing/ai-paused-banner";
import { apiFetch, getMe } from "@/server/api";
import { isOverdue } from "@/lib/commitments";
import { getServerConfig } from "@/server/config";
import { FeedbackDialog } from "@/components/beta/feedback-dialog";

/** Authenticated areas. Session validated against the API; incomplete onboarding is redirected. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe();
  // No account behind a (signed) cookie: clear it rather than bounce between /login and the app.
  if (!me) redirect("/api/session/expired");
  if (!me.onboarded) redirect("/onboarding");
  const t = await getTranslations("app");
  const [clients, prefs, proposals, owed] = await Promise.all([
    apiFetch<{ items: { id: string; name: string; color: string | null }[] }>("/v1/clients").catch(() => ({
      items: [],
    })),
    apiFetch<{ timezone: string }>("/v1/preferences"),
    apiFetch<{ items: unknown[] }>("/v1/proposals?status=pending&limit=100").catch(() => ({ items: [] })),
    apiFetch<{ items: { status: string; dueAt: string | null }[] }>(
      "/v1/commitments?direction=owed_to_me&limit=200",
    ).catch(() => ({ items: [] })),
  ]);
  // Red badge on Proyectos / Compromisos: overdue commitments others owe me (demo: risks + overdue).
  const demoNow = getServerConfig().env.DEMO_NOW;
  const nowMs = demoNow ? Date.parse(demoNow) : Date.now();
  const overdue = owed.items.filter((c) => isOverdue(c, new Date(nowMs))).length;
  const paletteData = { clients: clients.items, timezone: prefs.timezone };
  return (
    <PaletteProvider data={paletteData}>
      <AppShell
        badges={{ entrada: proposals.items.length, proyectos: overdue }}
        footer={
          <>
            <FeedbackDialog triggerClassName="flex items-center gap-2 bg-transparent p-0 text-left text-rail-ink" />
            <form action={signOutAction}>
              <button type="submit" className="bg-transparent p-0 text-left text-rail-ink">
                {t("signOut")}
              </button>
            </form>
            {getServerConfig().env.DEMO_MODE ? <span>{t("demoNote")}</span> : null}
          </>
        }
      >
        <AiPausedBanner />
        {children}
      </AppShell>
      <MobileCapture data={paletteData} />
    </PaletteProvider>
  );
}
