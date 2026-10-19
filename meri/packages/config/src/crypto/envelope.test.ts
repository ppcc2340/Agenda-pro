import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { LocalKeyProvider } from "./local";
import { decryptEnvelope, decryptEnvelopeToString, encryptEnvelope, parseEnvelope, rewrapEnvelope } from "./envelope";
import { CryptoError } from "./types";

const KEY_A = LocalKeyProvider.generateMasterKeyBase64();
const KEY_B = LocalKeyProvider.generateMasterKeyBase64();

function flipByte(blob: string, part: number): string {
  const parts = blob.split(".");
  const buf = Buffer.from(parts[part] ?? "", "base64url");
  buf[0] = ((buf[0] ?? 0) ^ 0xff) & 0xff;
  parts[part] = buf.toString("base64url");
  return parts.join(".");
}

describe("envelope encryption", () => {
  const a = new LocalKeyProvider(KEY_A, "local-a");

  it("round-trips strings and bytes, with and without AAD", async () => {
    const blob = await encryptEnvelope(a, "refresh-token-🔐", "account-1");
    expect(await decryptEnvelopeToString(a, blob, "account-1")).toBe("refresh-token-🔐");
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const blob2 = await encryptEnvelope(a, bytes);
    expect([...(await decryptEnvelope(a, blob2))]).toEqual([1, 2, 3, 250]);
  });

  it("uses a fresh DEK and IV per encryption", async () => {
    const b1 = await encryptEnvelope(a, "same");
    const b2 = await encryptEnvelope(a, "same");
    expect(b1).not.toBe(b2);
    expect(parseEnvelope(b1).wrappedDek).not.toBe(parseEnvelope(b2).wrappedDek);
  });

  it("detects tampering of ciphertext, tag, wrapped DEK and AAD mismatch", async () => {
    const blob = await encryptEnvelope(a, "secret", "ctx");
    await expect(decryptEnvelope(a, flipByte(blob, 4), "ctx")).rejects.toMatchObject({ code: "TAMPERED" });
    await expect(decryptEnvelope(a, flipByte(blob, 5), "ctx")).rejects.toMatchObject({ code: "TAMPERED" });
    await expect(decryptEnvelope(a, flipByte(blob, 2), "ctx")).rejects.toMatchObject({ code: "TAMPERED" });
    await expect(decryptEnvelope(a, blob, "other-ctx")).rejects.toMatchObject({ code: "TAMPERED" });
    await expect(decryptEnvelope(a, "v1.garbage")).rejects.toBeInstanceOf(CryptoError);
    await expect(decryptEnvelope(a, blob.replace(/^v1/, "v9"), "ctx")).rejects.toMatchObject({
      code: "UNSUPPORTED_VERSION",
    });
  });

  it("refuses to decrypt with a different master key or key id", async () => {
    const blob = await encryptEnvelope(a, "secret");
    const wrongKeySameId = new LocalKeyProvider(KEY_B, "local-a");
    await expect(decryptEnvelope(wrongKeySameId, blob)).rejects.toMatchObject({ code: "TAMPERED" });
    const otherId = new LocalKeyProvider(KEY_A, "local-z");
    await expect(decryptEnvelope(otherId, blob)).rejects.toMatchObject({ code: "UNKNOWN_KEY" });
  });

  it("rotates the key-encryption key without re-encrypting data", async () => {
    const b = new LocalKeyProvider(KEY_B, "local-b");
    const blob = await encryptEnvelope(a, "token", "acct");
    const rotated = await rewrapEnvelope(a, b, blob);
    expect(parseEnvelope(rotated).keyId).toBe("local-b");
    expect(parseEnvelope(rotated).ciphertext).toBe(parseEnvelope(blob).ciphertext);
    expect(await decryptEnvelopeToString(b, rotated, "acct")).toBe("token");
    await expect(decryptEnvelope(a, rotated, "acct")).rejects.toMatchObject({ code: "UNKNOWN_KEY" });
  });

  it("never exposes key material through JSON or inspect", () => {
    expect(JSON.stringify(a)).toBe('{"keyId":"local-a"}');
    expect(inspect(a)).toBe("LocalKeyProvider(local-a)");
    expect(inspect(a)).not.toContain(KEY_A);
    expect(() => new LocalKeyProvider("dG9vLXNob3J0")).toThrow(CryptoError);
  });
});
