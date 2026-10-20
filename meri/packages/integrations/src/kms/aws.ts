import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { CryptoError, KeyRing, type KeyProvider, type WrappedKey } from "@meri/config/crypto";
import { IntegrationError, type HealthReport } from "../errors";
import type { KmsAdapter, KmsPurpose } from "./types";

/** The slice of the AWS SDK client the adapter uses (injected in tests). */
export interface KmsSend {
  send(command: EncryptCommand | DecryptCommand): Promise<{ CiphertextBlob?: Uint8Array; Plaintext?: Uint8Array }>;
}

/** Maps AWS SDK failures to connector error kinds (docs/12 §6); never includes key material in messages. */
export function toIntegrationError(err: unknown): IntegrationError | CryptoError {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  const name = e.name ?? "Error";
  const status = e.$metadata?.httpStatusCode ?? 0;
  if (name === "InvalidCiphertextException" || name === "IncorrectKeyException")
    return new CryptoError(`KMS refused the wrapped key (${name})`, "TAMPERED");
  if (name === "ThrottlingException" || status === 429)
    return new IntegrationError("RateLimited", "kms", `KMS throttled the request (${name})`, { cause: err });
  if (status >= 500 || name === "TimeoutError" || name === "KMSInternalException" || name === "DependencyTimeoutException")
    return new IntegrationError("Transient", "kms", `KMS is unavailable (${name})`, { cause: err });
  return new IntegrationError("Permanent", "kms", `KMS rejected the request (${name})`, { cause: err });
}

/**
 * One AWS KMS key for one purpose (ADR 0007): the DEK is wrapped with `Encrypt` under an encryption context
 * `{ purpose }`, so a token DEK can never be unwrapped as a backup DEK (and the key policy can require it).
 * `Decrypt` names the expected key explicitly.
 */
export class AwsKeyProvider implements KeyProvider {
  constructor(
    private readonly client: KmsSend,
    readonly keyId: string,
    private readonly purpose: KmsPurpose,
  ) {}

  async wrap(dek: Uint8Array): Promise<WrappedKey> {
    try {
      const out = await this.client.send(
        new EncryptCommand({ KeyId: this.keyId, Plaintext: dek, EncryptionContext: { purpose: this.purpose } }),
      );
      if (!out.CiphertextBlob) throw new IntegrationError("Permanent", "kms", "KMS returned no ciphertext");
      return { keyId: this.keyId, ciphertext: Buffer.from(out.CiphertextBlob).toString("base64url") };
    } catch (err) {
      throw err instanceof IntegrationError ? err : toIntegrationError(err);
    }
  }

  async unwrap(wrapped: WrappedKey): Promise<Uint8Array> {
    if (wrapped.keyId !== this.keyId)
      throw new CryptoError(`Wrapped key belongs to "${wrapped.keyId}"`, "UNKNOWN_KEY");
    try {
      const out = await this.client.send(
        new DecryptCommand({
          KeyId: this.keyId,
          CiphertextBlob: Buffer.from(wrapped.ciphertext, "base64url"),
          EncryptionContext: { purpose: this.purpose },
        }),
      );
      if (!out.Plaintext) throw new IntegrationError("Permanent", "kms", "KMS returned no plaintext");
      return out.Plaintext;
    } catch (err) {
      throw err instanceof IntegrationError || err instanceof CryptoError ? err : toIntegrationError(err);
    }
  }
}

export interface AwsKmsOptions {
  keyId: string;
  previousKeyIds: string[];
  region: string;
  /** Injected in tests; production builds the SDK client with the default credential chain (roles first). */
  client?: KmsSend;
}

/** AWS KMS adapter: a key ring per purpose over the current and previous keys. */
export class AwsKms implements KmsAdapter {
  readonly provider = "aws" as const;
  readonly keys: KeyRing;
  readonly backupKeys: KeyRing;

  constructor(options: AwsKmsOptions) {
    const client =
      options.client ??
      new KMSClient({
        region: options.region,
        maxAttempts: 3,
        requestHandler: { connectionTimeout: 2_000, requestTimeout: 5_000 },
      });
    const ring = (purpose: KmsPurpose) =>
      new KeyRing(
        new AwsKeyProvider(client, options.keyId, purpose),
        options.previousKeyIds.map((id) => new AwsKeyProvider(client, id, purpose)),
      );
    this.keys = ring("integration-tokens");
    this.backupKeys = ring("backup");
  }

  async healthCheck(): Promise<HealthReport> {
    try {
      const probe = new Uint8Array(32).fill(7);
      const back = await this.keys.unwrap(await this.keys.wrap(probe));
      const ok = Buffer.from(back).equals(Buffer.from(probe));
      return { provider: "kms", mode: "live", status: ok ? "healthy" : "degraded", detail: `AWS KMS ${this.keys.keyId}` };
    } catch (err) {
      const kind = err instanceof IntegrationError ? err.kind : "Permanent";
      return { provider: "kms", mode: "live", status: kind === "Permanent" ? "needs_reauth" : "degraded", detail: kind };
    }
  }
}
