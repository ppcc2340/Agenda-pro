import NextAuth, { type NextAuthConfig, type User } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { z } from "zod";
import { getServerConfig } from "./server/config";

const BootstrapResponse = z.object({
  userId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  email: z.string().email(),
  name: z.string().nullable(),
  locale: z.string(),
  created: z.boolean(),
});

/** ADR 0001: ask the API to create or fetch the account for this identity. */
export async function bootstrapAccount(input: {
  email: string;
  name?: string | null;
  image?: string | null;
}) {
  const { env } = getServerConfig();
  const res = await fetch(`${env.API_URL}/internal/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": env.INTERNAL_API_SECRET },
    body: JSON.stringify(input),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`bootstrap failed with status ${String(res.status)}`);
  return BootstrapResponse.parse(await res.json());
}

function providers(): NextAuthConfig["providers"] {
  const { env, modes, isProduction } = getServerConfig();
  if (modes.google === "live") {
    return [
      Google({
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // Identity only in phase 0 (docs/06 §1). Calendar/Gmail scopes are requested incrementally later.
        authorization: {
          params: { scope: "openid email profile", access_type: "offline", prompt: "consent" },
        },
      }),
    ];
  }
  if (isProduction)
    throw new Error("GOOGLE_MODE=fake is forbidden in production (docs/blockers/google-oauth.md)");
  // Development sign-in: any email, no password. Only exists when GOOGLE_MODE=fake and not in production.
  return [
    Credentials({
      id: "dev",
      name: "Development sign-in",
      credentials: { email: { label: "Email", type: "email" }, name: { label: "Name", type: "text" } },
      authorize(credentials) {
        const parsed = z
          .object({ email: z.string().email(), name: z.string().max(200).optional() })
          .safeParse(credentials);
        if (!parsed.success) return null;
        return { id: parsed.data.email, email: parsed.data.email, name: parsed.data.name ?? null };
      },
    }),
  ];
}

/** Auth.js configuration, built lazily so it is never evaluated at build time. Exported for tests. */
export function buildAuthConfig(): NextAuthConfig {
  const { isProduction } = getServerConfig();
  return {
    trustHost: true,
    session: { strategy: "jwt", maxAge: 14 * 24 * 3600 },
    pages: { signIn: "/login" },
    providers: providers(),
    useSecureCookies: isProduction,
    callbacks: {
      async jwt({ token, user }) {
        // `user` is only present at sign-in; later session reads call this callback without it.
        // `user` is only present at sign-in; later session reads call this callback without it (typed as required).
        const signingIn = user as User | undefined;
        if (signingIn?.email) {
          const account = await bootstrapAccount({
            email: signingIn.email,
            name: signingIn.name ?? null,
            image: signingIn.image ?? null,
          });
          token.sub = account.userId;
          token.workspaceId = account.workspaceId;
          token.email = account.email;
          token.locale = account.locale;
        }
        return token;
      },
      session({ session, token }) {
        session.user.id = token.sub ?? "";
        session.workspaceId = typeof token.workspaceId === "string" ? token.workspaceId : "";
        return session;
      },
    },
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth(buildAuthConfig);

declare module "next-auth" {
  interface Session {
    workspaceId: string;
  }
}
