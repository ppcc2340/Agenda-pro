import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { EncryptCommand, type DecryptCommand } from "@aws-sdk/client-kms";
import { decryptEnvelopeToString, encryptEnvelope } from "@meri/config/crypto";
import { describe, expect, it } from "vitest";
import { IntegrationError } from "../errors";
import { AwsKms, toIntegrationError, type KmsSend } from "./aws";

/**
 * A KMS stand-in with AWS semantics: ciphertext bound to the key and the encryption context (as AAD), Decrypt
 * fails on any mismatch, and every call is recorded so the test can check what the adapter sends.
 */
class FakeAwsKms implements KmsSend {
  readonly calls: { name: string; keyId?: string; context?: Record<string, string> }[] = [];
  private readonly keys = new Map<string, Buffer>();
  constructor(keyIds: string[]) {
    for (const id of keyIds) this.keys.set(id, randomBytes(32));
  }
  send(command: EncryptCommand | DecryptCommand) {
    const input = command.input as {
      KeyId?: string;
      Plaintext?: Uint8Array;
      CiphertextBlob?: Uint8Array;
      EncryptionContext?: Record<string, string>;
    };
    const name = command instanceof EncryptCommand ? "Encrypt" : "Decrypt";
    this.calls.push({ name, keyId: input.KeyId, context: input.EncryptionContext });
    const key = this.keys.get(input.KeyId ?? "");
    if (!key) return Promise.reject(Object.assign(new Error("not found"), { name: "NotFoundException" }));
    const aad = Buffer.from(JSON.stringify(input.EncryptionContext ?? {}));
    if (name === "Encrypt") {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv).setAAD(aad);
      const ct = Buffer.concat([c.update(input.Plaintext ?? new Uint8Array()), c.final()]);
      return Promise.resolve({ CiphertextBlob: Buffer.concat([iv, ct, c.getAuthTag()]) });
    }
    const blob = Buffer.from(input.CiphertextBlob ?? new Uint8Array());
    try {
      const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12)).setAAD(aad);
      d.setAuthTag(blob.subarray(blob.length - 16));
      return Promise.resolve({ Plaintext: Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]) });
    } catch {
      return Promise.reject(Object.assign(new Error("bad"), { name: "InvalidCiphertextException" }));
    }
  }
}

const KEY_A = "arn:aws:kms:eu-west-1:111122223333:key/a";
const KEY_B = "arn:aws:kms:eu-west-1:111122223333:key/b";

describe("AwsKms (ADR 0007)", () => {
  it("wraps with the current key under the purpose context and unwraps naming the key", async () => {
    const client = new FakeAwsKms([KEY_A]);
    const kms = new AwsKms({ keyId: KEY_A, previousKeyIds: [], region: "eu-west-1", client });
    const blob = await encryptEnvelope(kms.keys, "refresh-token", "integration_account:ws:acc");
    expect(await decryptEnvelopeToString(kms.keys, blob, "integration_account:ws:acc")).toBe("refresh-token");
    expect(client.calls).toEqual([
      { name: "Encrypt", keyId: KEY_A, context: { purpose: "integration-tokens" } },
      { name: "Decrypt", keyId: KEY_A, context: { purpose: "integration-tokens" } },
    ]);
  });

  it("a token DEK can never be unwrapped as a backup DEK (purpose-bound context)", async () => {
    const client = new FakeAwsKms([KEY_A]);
    const kms = new AwsKms({ keyId: KEY_A, previousKeyIds: [], region: "eu-west-1", client });
    const wrapped = await kms.keys.wrap(randomBytes(32));
    await expect(kms.backupKeys.unwrap(wrapped)).rejects.toMatchObject({ code: "TAMPERED" });
  });

  it("rotation: the previous key still decrypts until retired; unlisted keys are refused without calling KMS", async () => {
    const client = new FakeAwsKms([KEY_A, KEY_B]);
    const before = new AwsKms({ keyId: KEY_A, previousKeyIds: [], region: "eu-west-1", client });
    const blob = await encryptEnvelope(before.keys, "old");
    const after = new AwsKms({ keyId: KEY_B, previousKeyIds: [KEY_A], region: "eu-west-1", client });
    expect(await decryptEnvelopeToString(after.keys, blob)).toBe("old");
    const retired = new AwsKms({ keyId: KEY_B, previousKeyIds: [], region: "eu-west-1", client });
    const calls = client.calls.length;
    await expect(decryptEnvelopeToString(retired.keys, blob)).rejects.toMatchObject({ code: "UNKNOWN_KEY" });
    expect(client.calls.length).toBe(calls);
  });

  it("maps SDK failures to connector error kinds and reports health", async () => {
    const throttled = toIntegrationError(Object.assign(new Error("x"), { name: "ThrottlingException" }));
    expect(throttled).toBeInstanceOf(IntegrationError);
    expect((throttled as IntegrationError).kind).toBe("RateLimited");
    const down = toIntegrationError(Object.assign(new Error("x"), { name: "X", $metadata: { httpStatusCode: 503 } }));
    expect((down as IntegrationError).kind).toBe("Transient");
    const denied = toIntegrationError(Object.assign(new Error("x"), { name: "AccessDeniedException" }));
    expect((denied as IntegrationError).kind).toBe("Permanent");
    const ok = new AwsKms({ keyId: KEY_A, previousKeyIds: [], region: "eu-west-1", client: new FakeAwsKms([KEY_A]) });
    expect(await ok.healthCheck()).toMatchObject({ status: "healthy", mode: "live" });
    const missing = new AwsKms({ keyId: KEY_B, previousKeyIds: [], region: "eu-west-1", client: new FakeAwsKms([KEY_A]) });
    expect(await missing.healthCheck()).toMatchObject({ status: "needs_reauth" });
  });
});
