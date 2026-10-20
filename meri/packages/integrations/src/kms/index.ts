import { KeyRing, LocalKeyProvider, localKeyId } from "@meri/config/crypto";
import type { HealthReport } from "../errors";
import type { KmsAdapter } from "./types";

const splitList = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

export class LocalKms implements KmsAdapter {
  readonly provider = "local" as const;
  readonly keys: KeyRing;
  readonly backupKeys: KeyRing;
  constructor(masterKeyBase64: string, previousMasterKeys?: string) {
    const current = new LocalKeyProvider(masterKeyBase64, localKeyId(masterKeyBase64));
    const previous = splitList(previousMasterKeys).map((k) => new LocalKeyProvider(k, localKeyId(k)));
    // Blobs written before key fingerprints (keyId "local") stay readable by whichever local key wrote them.
    const aliases = Object.fromEntries([current, ...previous].map((p) => [p.keyId, ["local"]]));
    this.keys = new KeyRing(current, previous, aliases);
    this.backupKeys = this.keys;
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

export { AwsKms, AwsKeyProvider, toIntegrationError, type AwsKmsOptions, type KmsSend } from "./aws";
export type { KmsAdapter, KmsPurpose } from "./types";
