import {
  decryptEnvelopeToString,
  encryptEnvelope,
  KeyRing,
  LocalKeyProvider,
  rewrapEnvelope,
} from "@meri/config/crypto";
import { ok, run } from "./_shared";

await run("kms", async ({ integrations }) => {
  const kms = integrations.kms;
  const health = await kms.healthCheck();
  ok(`kms health: ${health.status} (${health.detail ?? kms.provider})`);
  for (const [purpose, ring] of [
    ["integration-tokens", kms.keys],
    ["backup", kms.backupKeys],
  ] as const) {
    const blob = await encryptEnvelope(ring, "smoke-token", "smoke");
    if ((await decryptEnvelopeToString(ring, blob, "smoke")) !== "smoke-token") throw new Error("round-trip mismatch");
    ok(`encrypt and decrypt round-trip (${purpose}, key ${ring.keyId})`);
  }
  ok(`keys accepted for decryption: ${kms.keys.knownKeyIds.length}`);
  if (kms.provider === "local") {
    // Rotation drill: a new current key reads the old blob, and after a rewrap the old key can be retired.
    const blob = await encryptEnvelope(kms.keys, "smoke-token", "smoke");
    const next = new LocalKeyProvider(LocalKeyProvider.generateMasterKeyBase64(), "local:rotated");
    const ring = new KeyRing(next, [kms.keys]);
    const reblob = await rewrapEnvelope(ring, ring, blob);
    if ((await decryptEnvelopeToString(new KeyRing(next), reblob, "smoke")) !== "smoke-token")
      throw new Error("rotation failed");
    ok("key rotation keeps data readable after the old key is retired");
  }
});
