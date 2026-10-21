/**
 * One-click email unsubscribe tokens (D-116, RFC 8058). The token is the only authorization of
 * `POST /v1/email/unsubscribe`, so it is an HMAC over the workspace id with a key derived from AUTH_SECRET for this
 * purpose alone. It never expires: an unsubscribe link must keep working for as long as the email exists.
 */
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const keyCache = new Map<string, Buffer>();

function keyOf(authSecret: string): Buffer {
  let key = keyCache.get(authSecret);
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", authSecret, "meri", "meri-email-unsubscribe-v1", 32));
    keyCache.set(authSecret, key);
  }
  return key;
}

const mac = (authSecret: string, workspaceId: string) =>
  createHmac("sha256", keyOf(authSecret)).update(`email-unsubscribe:v1:${workspaceId}`).digest();

/** `<workspaceId>.<base64url mac>`. */
export function signUnsubscribeToken(authSecret: string, workspaceId: string): string {
  if (!UUID.test(workspaceId)) throw new Error("workspace id must be a lowercase UUID");
  return `${workspaceId}.${mac(authSecret, workspaceId).toString("base64url")}`;
}

/** The workspace id the token was issued for, or null for anything forged, truncated or malformed. */
export function verifyUnsubscribeToken(authSecret: string, token: string): string | null {
  if (token.length > 200) return null;
  const [workspaceId, sig, extra] = token.split(".");
  if (extra !== undefined || !workspaceId || !sig || !UUID.test(workspaceId)) return null;
  const given = Buffer.from(sig, "base64url");
  const expected = mac(authSecret, workspaceId);
  if (given.length !== expected.length || given.toString("base64url") !== sig) return null;
  return timingSafeEqual(given, expected) ? workspaceId : null;
}
