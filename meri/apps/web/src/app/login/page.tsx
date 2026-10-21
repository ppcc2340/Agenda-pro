import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { WaitlistForm } from "@/components/beta/waitlist-form";
import { Logo } from "@/components/shell/logo";
import { Button } from "@/components/ui/button";
import { getServerConfig } from "@/server/config";
import { safeNext } from "@/server/demo";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; manual?: string; beta?: string }>;
}) {
  const session = await auth();
  const params = await searchParams;
  const next = safeNext(params.next);
  if (session?.user) redirect(next);
  const t = await getTranslations("login");
  const tApp = await getTranslations("app");
  const tSecurity = await getTranslations("security");
  const { modes, env } = getServerConfig();
  // DEMO_MODE (PROTOTYPE.md, D-049/D-053): sign in as the demo user without a form, through the route handler
  // that may set cookies. `?manual=1` (sign-out, E2E of other accounts) and `?error` keep the form.
  if (env.DEMO_MODE && modes.google !== "live" && params.manual !== "1" && !params.error)
    redirect(`/api/demo/sign-in?next=${encodeURIComponent(next)}`);

  async function devSignIn(formData: FormData): Promise<void> {
    "use server";
    const field = (k: string) => {
      const v = formData.get(k);
      return typeof v === "string" ? v : "";
    };
    await signIn("dev", { email: field("email"), name: field("name"), redirectTo: next });
  }
  async function googleSignIn(): Promise<void> {
    "use server";
    await signIn("google", { redirectTo: next });
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-[420px] rounded-2xl border border-rule bg-raised p-7 shadow-sm">
        <div className="mb-5 flex items-center gap-2.5 font-head text-2xl font-bold tracking-tight">
          <Logo size={30} />
          <span>{tApp("name")}</span>
        </div>
        <h1 className="text-2xl">{t("title")}</h1>
        <p className="mt-2 text-ink2">{t("body")}</p>
        {params.beta === "invite" ? (
          <p role="alert" className="mt-4 rounded-lg bg-risk-soft px-3 py-2 text-risk">
            {t("betaRequired")}
          </p>
        ) : null}
        {params.error ? (
          <p role="alert" className="mt-4 rounded-lg bg-risk-soft px-3 py-2 text-risk">
            {t("error")}
          </p>
        ) : null}
        {modes.google === "live" ? (
          <form action={googleSignIn} className="mt-6">
            <Button type="submit" variant="primary" size="block">
              {t("google")}
            </Button>
          </form>
        ) : (
          <form action={devSignIn} className="mt-6 flex flex-col gap-3">
            <h2 className="text-base">{t("devTitle")}</h2>
            <p className="text-[13.5px] text-ink2">{t("devBody")}</p>
            <label className="flex flex-col gap-1 text-[13px] font-semibold">
              {t("email")}
              <input
                name="email"
                type="email"
                required
                autoComplete="email"
                defaultValue="dev@meri.local"
                className="rounded-lg border border-rule bg-panel px-3 py-2 font-normal text-ink"
              />
            </label>
            <label className="flex flex-col gap-1 text-[13px] font-semibold">
              {t("name")}
              <input
                name="name"
                type="text"
                autoComplete="name"
                className="rounded-lg border border-rule bg-panel px-3 py-2 font-normal text-ink"
              />
            </label>
            <Button type="submit" variant="primary" size="block">
              {t("devSubmit")}
            </Button>
          </form>
        )}
        {env.BETA_INVITE_REQUIRED || params.beta === "invite" ? (
          <section className="mt-6 border-t border-rule pt-5" aria-labelledby="beta-title">
            <h2 id="beta-title" className="text-base">
              {t("betaTitle")}
            </h2>
            <p className="mt-1 text-[13.5px] text-ink2">{t("betaBody")}</p>
            <WaitlistForm />
          </section>
        ) : null}
        <p className="mt-5 text-[12.5px] text-ink3">
          {t.rich("legal", {
            terms: (chunks) => (
              <Link href="/terms" className="underline">
                {chunks}
              </Link>
            ),
            privacy: (chunks) => (
              <Link href="/privacy" className="underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
        <p className="mt-2 text-[12.5px] text-ink3">
          <Link href="/seguridad" className="underline">
            {tSecurity("link")}
          </Link>
        </p>
      </div>
    </main>
  );
}
