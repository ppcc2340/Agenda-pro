import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { UnsubscribeForm } from "@/components/beta/unsubscribe-form";
import { Logo } from "@/components/shell/logo";

export async function generateMetadata() {
  const t = await getTranslations("unsubscribe");
  return { title: t("title"), robots: { index: false } };
}

/**
 * Public unsubscribe page (D-116): the link in every email lands here. Opening it changes nothing (link scanners
 * open URLs); the button sends the one-click request. No session needed: the token is the authorization.
 */
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const t = await getTranslations("unsubscribe");
  const tApp = await getTranslations("app");
  const { t: token } = await searchParams;
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-[420px] rounded-2xl border border-rule bg-raised p-7 shadow-sm">
        <div className="mb-5 flex items-center gap-2.5 font-head text-2xl font-bold tracking-tight">
          <Logo size={30} />
          <span>{tApp("name")}</span>
        </div>
        <h1 className="text-2xl">{t("title")}</h1>
        {token ? (
          <UnsubscribeForm token={token} />
        ) : (
          <p role="alert" className="mt-4 rounded-lg bg-risk-soft px-3 py-2 text-risk">
            {t("invalid")}
          </p>
        )}
        <p className="mt-5 text-[13px] text-ink2">
          {t.rich("manage", {
            link: (chunks) => (
              <Link href="/control#correo" className="underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </div>
    </main>
  );
}
