import { randomBytes, randomUUID, createHash, createHmac, scryptSync, timingSafeEqual } from "node:crypto";

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export const token = (bytes = 24) => randomBytes(bytes).toString("base64url");

export function addDays(d: Date | string, days: number): string {
  return new Date(new Date(d).getTime() + days * 86400000).toISOString();
}
export function daysBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 86400000;
}
export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

export function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(pw, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [, salt, hash] = stored.split("$");
  if (!salt || !hash) return false;
  const h = scryptSync(pw, salt, 64);
  const s = Buffer.from(hash, "hex");
  return h.length === s.length && timingSafeEqual(h, s);
}
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const hmac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

export function sign(secret: string, value: string): string {
  return `${value}.${hmac(secret, value)}`;
}
export function unsign(secret: string, signed: string): string | null {
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const mac = signed.slice(i + 1);
  const expected = hmac(secret, value);
  if (mac.length !== expected.length) return null;
  return timingSafeEqual(Buffer.from(mac), Buffer.from(expected)) ? value : null;
}

// ---------- normalization (15.1) ----------
export function normalizeEmail(e: unknown): string | null {
  if (typeof e !== "string") return null;
  const v = e.trim().toLowerCase();
  return v ? v : null;
}
export function normalizePhone(p: unknown, defaultCountry = "+34"): string | null {
  if (typeof p !== "string") return null;
  let v = p.replace(/[\s().-]/g, "");
  if (!v) return null;
  if (v.startsWith("00")) v = "+" + v.slice(2);
  if (!v.startsWith("+")) v = defaultCountry + v;
  return /^\+\d{6,15}$/.test(v) ? v : p.trim();
}
export function capitalizeName(n: unknown): string {
  if (typeof n !== "string") return "";
  const t = n.trim();
  if (!t) return "";
  if (t !== t.toLowerCase() && t !== t.toUpperCase()) return t; // user already cased it
  return t
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
export function normalizeDomain(d: unknown): string | null {
  if (typeof d !== "string") return null;
  let v = d.trim().toLowerCase();
  if (!v) return null;
  v = v.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] ?? "";
  return v || null;
}
export function domainFromEmail(email: string | null): string | null {
  if (!email || !email.includes("@")) return null;
  const d = email.split("@")[1] ?? "";
  return d || null;
}
export const FREE_EMAIL_DOMAINS = new Set(["gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "yahoo.es", "icloud.com", "live.com", "protonmail.com", "proton.me"]);

// ---------- TOTP (RFC 6238) ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf: Buffer): string {
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Buffer {
  let bits = 0,
    value = 0;
  const out: number[] = [];
  for (const ch of s.toUpperCase().replace(/=+$/, "")) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export function totpCode(secret: string, time = Date.now(), step = 30): string {
  const counter = Math.floor(time / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const off = (h[h.length - 1] ?? 0) & 0xf;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
  return code;
}
export function totpVerify(secret: string, code: string, window = 1): boolean {
  const c = code.replace(/\s/g, "");
  for (let i = -window; i <= window; i++) {
    if (totpCode(secret, Date.now() + i * 30000) === c) return true;
  }
  return false;
}
export const newTotpSecret = () => base32Encode(randomBytes(20));

// ---------- CSV ----------
export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (!rows.length) return (columns ?? []).join(",") + "\n";
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

/** Render {{variable}} and {{object.field}} placeholders. */
export function renderTemplate(tpl: string, ctx: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const v = key.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), ctx);
    return v === undefined || v === null ? "" : String(v);
  });
}

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
export function round2(n: number) {
  return Math.round(n * 100) / 100;
}
