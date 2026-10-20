import { signIn } from "@/auth";
import { getServerConfig } from "@/server/config";
import { DEMO_USER, safeNext } from "@/server/demo";

export const dynamic = "force-dynamic";

/**
 * DEMO_MODE (PROTOTYPE.md, D-049/D-053): signs in as the demo user and redirects. Cookies can only be set from a
 * Route Handler or Server Action, hence this endpoint instead of signing in while rendering `/login`. It only
 * exists with the dev provider (GOOGLE_MODE=fake outside production; loadConfig rejects DEMO_MODE in production).
 */
export async function GET(request: Request): Promise<Response> {
  const { env, modes } = getServerConfig();
  if (!env.DEMO_MODE || modes.google === "live") return new Response("Not found", { status: 404 });
  const next = safeNext(new URL(request.url).searchParams.get("next"));
  await signIn("dev", { ...DEMO_USER, redirectTo: next });
  // Not reached in practice (Auth.js redirects by throwing); kept as an explicit fallback for the type.
  return new Response(null, { status: 302, headers: { location: next } });
}
