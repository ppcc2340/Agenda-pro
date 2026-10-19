import { LocalKeyProvider, type KeyProvider } from "@meri/config/crypto";
import type { HealthReport } from "../errors";

/**
 * KMS adapters. `local` wraps DEKs with LOCAL_MASTER_KEY (dev only; forbidden in production by @meri/config).
 * aws/gcp adapters arrive in phase 5 behind the same KeyProvider interface.
 */
export interface KmsAdapter {
  readonly provider: "local" | "aws" | "gcp";
  readonly keys: KeyProvider;
  healthCheck(): Promise<HealthReport>;
}

export class LocalKms implements KmsAdapter {
  readonly provider = "local" as const;
  readonly keys: KeyProvider;
  constructor(masterKeyBase64: string) {
    this.keys = new LocalKeyProvider(masterKeyBase64, "local");
  }
  healthCheck(): Promise<HealthReport> {
    return Promise.resolve({
      provider: "kms",
      mode: "fake",
      status: "healthy",
      detail: "LocalKeyProvider (dev only)",
    });
  }
}
