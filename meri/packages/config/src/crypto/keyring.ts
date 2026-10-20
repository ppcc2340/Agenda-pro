import { createHash } from "node:crypto";
import { CryptoError, type KeyProvider, type WrappedKey } from "./types";

/**
 * Key ring for rotation (ADR 0007): wraps with the current key-encryption key and unwraps with any key the
 * deployment still lists (current + previous). An unlisted key id is refused (`UNKNOWN_KEY`), never "tried".
 * Several providers may answer to the same legacy id (blobs written as `local` before keys had fingerprints): they
 * are tried in order and the first that authenticates wins.
 */
export class KeyRing implements KeyProvider {
  readonly keyId: string;

  constructor(
    private readonly current: KeyProvider,
    private readonly previous: readonly KeyProvider[] = [],
    private readonly aliases: Readonly<Record<string, readonly string[]>> = {},
  ) {
    this.keyId = current.keyId;
  }

  /** Every key id this ring can unwrap (for rotation reports and health checks). */
  get knownKeyIds(): string[] {
    return [this.current, ...this.previous].map((p) => p.keyId);
  }

  wrap(dek: Uint8Array): Promise<WrappedKey> {
    return this.current.wrap(dek);
  }

  async unwrap(wrapped: WrappedKey): Promise<Uint8Array> {
    const all = [this.current, ...this.previous];
    const candidates = all.filter(
      (p) => p.keyId === wrapped.keyId || (this.aliases[p.keyId] ?? []).includes(wrapped.keyId),
    );
    if (candidates.length === 0)
      throw new CryptoError(`Key "${wrapped.keyId}" is not configured in the key ring`, "UNKNOWN_KEY");
    let last: unknown;
    for (const provider of candidates) {
      try {
        return await provider.unwrap({ keyId: provider.keyId, ciphertext: wrapped.ciphertext });
      } catch (err) {
        last = err;
      }
    }
    throw last instanceof Error ? last : new CryptoError("No key in the ring could unwrap the DEK", "TAMPERED");
  }
}

/** Stable, non-secret id of a local master key: `local:<first 8 bytes of SHA-256>` (hex). */
export function localKeyId(masterKeyBase64: string): string {
  return `local:${createHash("sha256").update(Buffer.from(masterKeyBase64, "base64")).digest("hex").slice(0, 16)}`;
}
