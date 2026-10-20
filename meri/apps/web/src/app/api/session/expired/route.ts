import { signOut } from "@/auth";

export const dynamic = "force-dynamic";

/**
 * A session cookie whose account no longer exists (deleted, or `pnpm demo --reset`): the API answers 401, so
 * the app layout sends it here instead of `/login`, which would bounce a signed-in cookie straight back to the
 * app (redirect loop). Signing out needs a Route Handler: only there may Auth.js clear the cookie.
 */
export async function GET(): Promise<Response> {
  await signOut({ redirectTo: "/login?manual=1" });
  // Not reached in practice (Auth.js redirects by throwing); kept as an explicit fallback for the type.
  return new Response(null, { status: 302, headers: { location: "/login?manual=1" } });
}
