import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CryptoError, type KeyProvider } from "./types";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Serialized blob: v1.<keyId>.<wrappedDek>.<iv>.<ciphertext>.<tag> (base64url parts). */
export interface EnvelopeParts {
  version: string;
  keyId: string;
  wrappedDek: string;
  iv: string;
  ciphertext: string;
  tag: string;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");
const enc = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const dec = (s: string) => Buffer.from(s, "base64url").toString("utf8");

export function parseEnvelope(blob: string): EnvelopeParts {
  const parts = blob.split(".");
  if (parts.length !== 6) throw new CryptoError("Envelope blob is malformed", "MALFORMED");
  const [version, keyId, wrappedDek, iv, ciphertext, tag] = parts as [string, string, string, string, string, string];
  if (version !== VERSION) throw new CryptoError(`Unsupported envelope version "${version}"`, "UNSUPPORTED_VERSION");
  return { version, keyId: dec(keyId), wrappedDek, iv, ciphertext, tag };
}

/**
 * Encrypt with a fresh random DEK (AES-256-GCM), wrap the DEK with the provider's KEK.
 * `aad` binds the blob to a context (e.g. the integration account id) so blobs cannot be swapped between rows.
 */
export async function encryptEnvelope(provider: KeyProvider, plaintext: Uint8Array | string, aad?: string): Promise<string> {
  const dek = randomBytes(32);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  const wrapped = await provider.wrap(dek);
  dek.fill(0);
  return [VERSION, enc(wrapped.keyId), wrapped.ciphertext, b64(iv), b64(ct), b64(tag)].join(".");
}

export async function decryptEnvelope(provider: KeyProvider, blob: string, aad?: string): Promise<Buffer> {
  const p = parseEnvelope(blob);
  const dek = Buffer.from(await provider.unwrap({ keyId: p.keyId, ciphertext: p.wrappedDek }));
  try {
    const iv = unb64(p.iv);
    const tag = unb64(p.tag);
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new CryptoError("Envelope blob is malformed", "MALFORMED");
    const decipher = createDecipheriv("aes-256-gcm", dek, iv);
    if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(unb64(p.ciphertext)), decipher.final()]);
    } catch {
      throw new CryptoError("Envelope failed authentication (tampered data, tag or AAD)", "TAMPERED");
    }
  } finally {
    dek.fill(0);
  }
}

export async function decryptEnvelopeToString(provider: KeyProvider, blob: string, aad?: string): Promise<string> {
  return (await decryptEnvelope(provider, blob, aad)).toString("utf8");
}

/**
 * Key rotation: re-wrap the DEK with a new provider (KEK rotation) without touching the data ciphertext.
 * For DEK rotation use decrypt + encrypt.
 */
export async function rewrapEnvelope(from: KeyProvider, to: KeyProvider, blob: string): Promise<string> {
  const p = parseEnvelope(blob);
  const dek = Buffer.from(await from.unwrap({ keyId: p.keyId, ciphertext: p.wrappedDek }));
  try {
    const wrapped = await to.wrap(dek);
    return [VERSION, enc(wrapped.keyId), wrapped.ciphertext, p.iv, p.ciphertext, p.tag].join(".");
  } finally {
    dek.fill(0);
  }
}
