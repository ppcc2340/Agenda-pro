import { decryptEnvelopeToString, encryptEnvelope, LocalKeyProvider, rewrapEnvelope } from "@meri/config/crypto";
import { ok, run } from "./_shared";

await run("kms", async ({ integrations }) => {
  const kms = integrations.kms;
  const health = await kms.healthCheck();
  ok(`kms health: ${health.status} (${health.detail ?? kms.provider})`);
  const blob = await encryptEnvelope(kms.keys, "smoke-token", "smoke");
  const back = await decryptEnvelopeToString(kms.keys, blob, "smoke");
  if (back !== "smoke-token") throw new Error("round-trip mismatch");
  ok("encrypt and decrypt round-trip");
  const rotated = new LocalKeyProvider(LocalKeyProvider.generateMasterKeyBase64(), "local-rotated");
  const reblob = await rewrapEnvelope(kms.keys, rotated, blob);
  if ((await decryptEnvelopeToString(rotated, reblob, "smoke")) !== "smoke-token") throw new Error("rotation failed");
  ok("key rotation keeps data readable");
});
