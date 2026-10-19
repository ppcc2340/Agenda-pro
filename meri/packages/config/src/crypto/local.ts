import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { CryptoError, type KeyProvider, type WrappedKey } from "./types";

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Development-only key provider: wraps DEKs with a local AES-256-GCM master key.
 * Forbidden in production (enforced by @meri/config resolveModes). Never logs or serialises the key.
 */
export class LocalKeyProvider implements KeyProvider {
  readonly keyId: string;
  readonly #master: Buffer;

  constructor(masterKeyBase64: string, keyId = "local") {
    const key = Buffer.from(masterKeyBase64, "base64");
    if (key.length !== 32) {
      throw new CryptoError("LOCAL_MASTER_KEY must decode to exactly 32 bytes (base64)", "MALFORMED");
    }
    this.#master = key;
    this.keyId = keyId;
  }

  wrap(dek: Uint8Array): Promise<WrappedKey> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#master, iv);
    const ct = Buffer.concat([cipher.update(dek), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Promise.resolve({ keyId: this.keyId, ciphertext: Buffer.concat([iv, ct, tag]).toString("base64url") });
  }

  unwrap(wrapped: WrappedKey): Promise<Uint8Array> {
    if (wrapped.keyId !== this.keyId) {
      throw new CryptoError(`Wrapped key belongs to "${wrapped.keyId}", provider is "${this.keyId}"`, "UNKNOWN_KEY");
    }
    const buf = Buffer.from(wrapped.ciphertext, "base64url");
    if (buf.length < IV_BYTES + TAG_BYTES + 1) throw new CryptoError("Wrapped DEK is malformed", "MALFORMED");
    const iv = buf.subarray(0, IV_BYTES);
    const tag = buf.subarray(buf.length - TAG_BYTES);
    const ct = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.#master, iv);
    decipher.setAuthTag(tag);
    try {
      return Promise.resolve(Buffer.concat([decipher.update(ct), decipher.final()]));
    } catch {
      throw new CryptoError("Wrapped DEK failed authentication (tampered or wrong master key)", "TAMPERED");
    }
  }

  toJSON(): { keyId: string } {
    return { keyId: this.keyId };
  }

  [inspect.custom](): string {
    return `LocalKeyProvider(${this.keyId})`;
  }

  static generateMasterKeyBase64(): string {
    return randomBytes(32).toString("base64");
  }
}
