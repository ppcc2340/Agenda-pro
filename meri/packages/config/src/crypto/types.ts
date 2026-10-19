/** Envelope encryption contract (docs/06 §2). A KeyProvider wraps/unwraps data-encryption keys (DEKs). */
export interface WrappedKey {
  /** Identifier of the key-encryption key (KEK) used, e.g. "local" or a KMS key ARN/resource name. */
  keyId: string;
  /** Base64url ciphertext of the DEK as produced by the provider. */
  ciphertext: string;
}

export interface KeyProvider {
  readonly keyId: string;
  wrap(dek: Uint8Array): Promise<WrappedKey>;
  unwrap(wrapped: WrappedKey): Promise<Uint8Array>;
}

export class CryptoError extends Error {
  override readonly name = "CryptoError";
  constructor(
    message: string,
    readonly code: "TAMPERED" | "UNKNOWN_KEY" | "MALFORMED" | "UNSUPPORTED_VERSION",
  ) {
    super(message);
  }
}
