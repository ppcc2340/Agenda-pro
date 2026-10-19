import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import type * as React from "react";
import { signOutAction } from "@/app/actions";
import { AppShell } from "@/components/shell/app-shell";
import { getMe } from "@/server/api";

/** Authenticated areas. Session validated against the API; incomplete onboarding is redirected. */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe();
  if (!me) redirect("/login");
  if (!me.onboarded) redirect("/onboarding");
  const t = await getTranslations("app");
  return (
    <AppShell
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
  );
}
