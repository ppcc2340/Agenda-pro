import { createHmac, timingSafeEqual } from "node:crypto";
import { IntegrationError } from "../errors";

/** Stripe's webhook signature scheme (`Stripe-Signature: t=<unix>,v1=<hex hmac-sha256 of "t.body">`). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function signWebhook(secret: string, rawBody: string, timestampSeconds: number): string {
  const mac = createHmac("sha256", secret)
    .update(`${String(timestampSeconds)}.${rawBody}`)
    .digest("hex");
  return `t=${String(timestampSeconds)},v1=${mac}`;
}

/** Throws IntegrationError(Permanent) on a missing, malformed, wrong or stale signature. */
export function verifyWebhookSignature(input: {
  secret: string;
  rawBody: string;
  header: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): void {
  const fail = (why: string): never => {
    throw new IntegrationError("Permanent", "stripe", `invalid webhook signature: ${why}`);
  };
  const parts = new Map<string, string[]>();
  for (const piece of input.header.split(",")) {
    const [k, v] = piece.split("=", 2);
    if (!k || v === undefined) continue;
    parts.set(k.trim(), [...(parts.get(k.trim()) ?? []), v.trim()]);
  }
  const t = Number(parts.get("t")?.[0]);
  const candidates = parts.get("v1") ?? [];
  if (!Number.isInteger(t) || candidates.length === 0) fail("malformed header");
  if (Math.abs(input.nowSeconds - t) > (input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS))
    fail("timestamp outside tolerance");
  const expected = Buffer.from(
    createHmac("sha256", input.secret)
      .update(`${String(t)}.${input.rawBody}`)
      .digest("hex"),
    "utf8",
  );
  const ok = candidates.some((c) => {
    const given = Buffer.from(c, "utf8");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!ok) fail("no matching v1 signature");
}
