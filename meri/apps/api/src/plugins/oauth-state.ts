import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Signed OAuth state for the Google connect flow (ADR 0007). The HttpOnly cookie carries `state`, the PKCE
 * verifier, the workspace that started the flow and the requested feature, MAC'd with a key derived from
 * AUTH_SECRET by HKDF (never the raw secret). The verifier is not secret from the user; it only has to stay out of
 * the URL and out of reach of other sites, which HttpOnly + SameSite give.
 */
const Payload = z.object({
  s: z.string().min(16),
  v: z.string().min(43).max(128),
  w: z.string().uuid(),
  f: z.enum(["calendar", "gmail", "all"]),
  e: z.number().int(),
});
export type OAuthState = z.infer<typeof Payload>;

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function deriveStateKey(authSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", authSecret, "meri", "meri-oauth-state-v1", 32));
}

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

const mac = (key: Buffer, body: string) => createHmac("sha256", key).update(body).digest("base64url");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function sealState(key: Buffer, state: Omit<OAuthState, "e">, nowMs: number): string {
  const body = Buffer.from(JSON.stringify({ ...state, e: nowMs + OAUTH_STATE_TTL_MS })).toString("base64url");
  return `${body}.${mac(key, body)}`;
}

/** Returns the state only if the MAC verifies and it has not expired; never throws on malformed input. */
export function openState(key: Buffer, sealed: string | undefined, nowMs: number): OAuthState | null {
  if (!sealed) return null;
  const [body, tag, extra] = sealed.split(".");
  if (!body || !tag || extra !== undefined || !safeEqual(tag, mac(key, body))) return null;
  try {
    const parsed = Payload.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    if (!parsed.success || parsed.data.e < nowMs) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
