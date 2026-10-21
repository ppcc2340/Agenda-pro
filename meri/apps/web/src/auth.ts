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
  if (res.status === 403) {
    const problem = (await res.json().catch(() => ({}))) as { code?: string };
    if (problem.code === "BETA_INVITE_REQUIRED") throw new BetaInviteRequired();
  }
  if (!res.ok) throw new Error(`bootstrap failed with status ${String(res.status)}`);
  return BootstrapResponse.parse(await res.json());
}

/** The API refused a first sign-in during the closed beta (D-099): the login page shows the waitlist. */
export class BetaInviteRequired extends Error {
  constructor() {
    super("BETA_INVITE_REQUIRED");
  }
}

/** Where a refused sign-in lands: the login page with the waitlist (no address in the URL). */
export const BETA_WAITLIST_URL = "/login?beta=invite";

type BootstrapResult = Awaited<ReturnType<typeof bootstrapAccount>>;
/** The bootstrap done in `signIn`, handed to `jwt` for the same sign-in (same user object) to avoid a second call. */
const bootstrapped = new WeakMap<object, BootstrapResult>();

const subjectOf = (email: string, provider?: { provider: string; providerAccountId: string } | null) =>
  provider?.provider === "google"
    ? `google:${provider.providerAccountId}`
    : `dev:${email.trim().toLowerCase()}`;

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
      async signIn({ user, account, profile }) {
        if (account?.provider === "google" && profile?.email_verified !== true) return false;
        if (!user.email) return false;
        // The account is created (or found) here so a closed beta can send the person to the waitlist (D-099).
        try {
          const result = await bootstrapAccount({
            email: user.email,
            subject: subjectOf(user.email, account),
            name: user.name ?? null,
            image: user.image ?? null,
          });
          bootstrapped.set(user, result);
          return true;
        } catch (err) {
          if (err instanceof BetaInviteRequired) return BETA_WAITLIST_URL;
          throw err;
        }
      },
      async jwt({ token, user, account: provider }) {
        // `user` is only present at sign-in; later session reads call this callback without it (typed as required).
        const signingIn = user as User | undefined;
        if (signingIn?.email) {
          const account =
            bootstrapped.get(signingIn) ??
            (await bootstrapAccount({
              email: signingIn.email,
              subject: subjectOf(signingIn.email, provider),
              name: signingIn.name ?? null,
              image: signingIn.image ?? null,
            }));
          token.sub = account.userId;
          token.workspaceId = account.workspaceId;
          token.email = account.email;
          token.locale = account.locale;
          // The sign-in instant survives every re-issue of the JWT (iat does not): revocation and the absolute
          // lifetime are measured from it (ADR 0007).
          token.authTime = Date.now();
          return token;
        }
        if (typeof token.authTime !== "number" || Date.now() - token.authTime > SESSION_MAX_AGE_MS)
          return null;
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
