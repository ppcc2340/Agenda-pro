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
  subject: string;
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
        // Identity only (docs/06 §1): no refresh token for sign-in. Calendar/Gmail are connected separately with
        // offline access and incremental scopes (ADR 0007).
        authorization: { params: { scope: "openid email profile" } },
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

/** Absolute session lifetime from sign-in; the API guard enforces the same limit (ADR 0007). */
export const SESSION_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

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
      // Only addresses Google has verified may sign in (a recycled or unverified address never inherits an account).
      signIn({ account, profile }) {
        if (account?.provider === "google") return profile?.email_verified === true;
        return true;
      },
      async jwt({ token, user, account: provider }) {
        // `user` is only present at sign-in; later session reads call this callback without it (typed as required).
        const signingIn = user as User | undefined;
        if (signingIn?.email) {
          const subject =
            provider?.provider === "google"
              ? `google:${provider.providerAccountId}`
              : `dev:${signingIn.email.trim().toLowerCase()}`;
          const account = await bootstrapAccount({
            email: signingIn.email,
            subject,
            name: signingIn.name ?? null,
            image: signingIn.image ?? null,
          });
          token.sub = account.userId;
          token.workspaceId = account.workspaceId;
          token.email = account.email;
          token.locale = account.locale;
          // The sign-in instant survives every re-issue of the JWT (iat does not): revocation and the absolute
          // lifetime are measured from it (ADR 0007).
          token.authTime = Date.now();
          return token;
        }
        if (typeof token.authTime !== "number" || Date.now() - token.authTime > SESSION_MAX_AGE_MS) return null;
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
