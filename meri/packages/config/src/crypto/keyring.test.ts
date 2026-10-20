import { describe, expect, it } from "vitest";
import { decryptEnvelopeToString, encryptEnvelope, rewrapEnvelope } from "./envelope";
import { KeyRing, localKeyId } from "./keyring";
import { LocalKeyProvider } from "./local";
import { CryptoError } from "./types";

const k1 = Buffer.alloc(32, 1).toString("base64");
const k2 = Buffer.alloc(32, 2).toString("base64");
const k3 = Buffer.alloc(32, 3).toString("base64");
const local = (key: string) => new LocalKeyProvider(key, localKeyId(key));

describe("KeyRing (ADR 0007)", () => {
  it("encrypts with the current key and still decrypts data written with a previous one", async () => {
    const before = new KeyRing(local(k1));
    const blob = await encryptEnvelope(before, "refresh-token", "aad");
    const after = new KeyRing(local(k2), [local(k1)]);
    expect(await decryptEnvelopeToString(after, blob, "aad")).toBe("refresh-token");
    const fresh = await encryptEnvelope(after, "new", "aad");
    expect(fresh.split(".")[1]).toBe(Buffer.from(localKeyId(k2)).toString("base64url"));
  });

  it("rotation re-wraps old blobs so the previous key can be retired", async () => {
    const old = new KeyRing(local(k1));
    const blob = await encryptEnvelope(old, "secret", "row-1");
    const ring = new KeyRing(local(k2), [local(k1)]);
    const rewrapped = await rewrapEnvelope(ring, ring, blob);
    const retired = new KeyRing(local(k2));
    expect(await decryptEnvelopeToString(retired, rewrapped, "row-1")).toBe("secret");
    await expect(decryptEnvelopeToString(retired, blob, "row-1")).rejects.toMatchObject({ code: "UNKNOWN_KEY" });
  });

  it("refuses unlisted key ids and keeps legacy ids working through explicit aliases only", async () => {
    const legacy = new LocalKeyProvider(k1, "local");
    const blob = await encryptEnvelope(legacy, "legacy");
    const withAlias = new KeyRing(local(k2), [local(k1)], { [localKeyId(k1)]: ["local"], [localKeyId(k2)]: ["local"] });
    expect(await decryptEnvelopeToString(withAlias, blob)).toBe("legacy");
    const withoutAlias = new KeyRing(local(k2), [local(k1)]);
    await expect(decryptEnvelopeToString(withoutAlias, blob)).rejects.toBeInstanceOf(CryptoError);
    const wrongKeys = new KeyRing(local(k3), [], { [localKeyId(k3)]: ["local"] });
    await expect(decryptEnvelopeToString(wrongKeys, blob)).rejects.toMatchObject({ code: "TAMPERED" });
  });

  it("key ids are fingerprints, never the key", () => {
    expect(localKeyId(k1)).toMatch(/^local:[0-9a-f]{16}$/);
    expect(localKeyId(k1)).not.toEqual(localKeyId(k2));
    expect(new KeyRing(local(k2), [local(k1)]).knownKeyIds).toEqual([localKeyId(k2), localKeyId(k1)]);
  });
});
