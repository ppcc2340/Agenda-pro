import type { KeyRing } from "@meri/config/crypto";
import type { HealthReport } from "../errors";

/** What a wrapped DEK protects; bound into the KMS encryption context so keys cannot be reused across purposes. */
export type KmsPurpose = "integration-tokens" | "backup";

/**
 * KMS adapters (ADR 0007): `local` wraps DEKs with LOCAL_MASTER_KEY (dev only; forbidden in production by
 * @meri/config); `aws` uses AWS KMS. Each exposes a key ring per purpose: current key for new data, previous keys
 * only to read what has not been rotated yet.
 */
export interface KmsAdapter {
  readonly provider: "local" | "aws";
  readonly keys: KeyRing;
  readonly backupKeys: KeyRing;
  healthCheck(): Promise<HealthReport>;
}
