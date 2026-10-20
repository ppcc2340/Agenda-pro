import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeyRing, LocalKeyProvider, localKeyId, parseEnvelope } from "@meri/config/crypto";
import {
  bootstrapAccount,
  createDb,
  getEncryptedTokens,
  listAudit,
  setIntegrationStatus,
  upsertIntegrationAccount,
  withWorkspace,
  type DbHandle,
  type WorkspaceId,
} from "@meri/db";
import { encryptTokens, readTokens } from "../handlers/calendar-sync";
import { rotateIntegrationKeys } from "./rotate-keys";

// The application role: rotation must work under FORCE RLS, never with a superuser (plan review CR-H2).
const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const NOW = new Date("2026-10-19T10:40:00Z");
const key = (n: number) => Buffer.alloc(32, n).toString("base64");
const local = (n: number) => new LocalKeyProvider(key(n), localKeyId(key(n)));
const tokens = (refreshToken: string) => ({
  accessToken: "a",
  refreshToken,
  expiresAt: NOW.toISOString(),
  scopes: ["calendar"],
  externalAccountId: "sub",
  email: "x@test.local",
});

describe("rotateIntegrationKeys (ADR 0007)", () => {
  let handle: DbHandle;
  let ws: WorkspaceId;
  const accounts: string[] = [];
  const oldRing = new KeyRing(local(41));
  const newRing = new KeyRing(local(42), [local(41)]);

  beforeAll(async () => {
    handle = createDb(TEST_APP_URL, { max: 2 });
    ws = (await bootstrapAccount(handle.db, { email: `rot-${Date.now().toString(36)}@test.local`, now: NOW }))
      .workspaceId;
    for (const n of [1, 2]) {
      const id = await withWorkspace(handle.db, ws, async (tx) => {
        const row = await upsertIntegrationAccount(
          tx,
          ws,
          {
            provider: "google",
            externalAccountId: `ext-${String(n)}-${Date.now().toString(36)}`,
            email: `acc${String(n)}@test.local`,
            scopes: ["calendar"],
            encryptedTokens: "pending",
            keyId: oldRing.keyId,
          },
          NOW,
        );
        const blob = await encryptTokens({ keys: oldRing }, ws, row.id, tokens(`refresh-${String(n)}`));
        await setIntegrationStatus(tx, ws, row.id, { encryptedTokens: blob, keyId: oldRing.keyId, status: "healthy" });
        return row.id;
      });
      accounts.push(id);
    }
  });
  afterAll(() => handle.close());

  const targets = () => accounts.map((id) => ({ id, workspaceId: ws }));

  it("re-wraps every token under the new key, then the old key can be retired; a second run is a no-op", async () => {
    const report = await rotateIntegrationKeys({ db: handle.db, keys: newRing }, targets(), { reencrypt: false });
    expect(report).toMatchObject({ scanned: 2, rotated: 2, alreadyCurrent: 0, failed: [] });
    const retired = new KeyRing(local(42));
    for (const [i, id] of accounts.entries()) {
      const back = await readTokens({ db: handle.db, keys: retired }, ws, id);
      expect(back?.refreshToken).toBe(`refresh-${String(i + 1)}`);
      const row = await withWorkspace(handle.db, ws, (tx) => getEncryptedTokens(tx, ws, id));
      expect(row?.keyId).toBe(retired.keyId);
    }
    const again = await rotateIntegrationKeys({ db: handle.db, keys: newRing }, targets(), { reencrypt: false });
    expect(again).toMatchObject({ rotated: 0, alreadyCurrent: 2 });
    const audits = await withWorkspace(handle.db, ws, (tx) => listAudit(tx, ws, 20));
    expect(audits.items.filter((a) => a.action === "security.keys_rotated")).toHaveLength(1);
  });

  it("--reencrypt gives each token a brand-new data key", async () => {
    const before = await withWorkspace(handle.db, ws, (tx) => getEncryptedTokens(tx, ws, accounts[0] ?? ""));
    const report = await rotateIntegrationKeys({ db: handle.db, keys: newRing }, targets().slice(0, 1), {
      reencrypt: true,
    });
    expect(report.rotated).toBe(1);
    const after = await withWorkspace(handle.db, ws, (tx) => getEncryptedTokens(tx, ws, accounts[0] ?? ""));
    expect(parseEnvelope(after?.encryptedTokens ?? "").ciphertext).not.toBe(
      parseEnvelope(before?.encryptedTokens ?? "").ciphertext,
    );
    expect((await readTokens({ db: handle.db, keys: newRing }, ws, accounts[0] ?? ""))?.refreshToken).toBe("refresh-1");
  });

  it("never overwrites a token refreshed during the rotation (compare-and-swap) and reports unreadable blobs", async () => {
    const id = accounts[1] ?? "";
    const third = new KeyRing(local(43), [local(42)]);
    // A refresh lands between the rotation's read and write: simulate by swapping the blob from a wrapping key ring.
    let raced = false;
    const racingKeys = {
      keyId: third.keyId,
      wrap: async (dek: Uint8Array) => {
        if (!raced) {
          raced = true;
          await withWorkspace(handle.db, ws, async (tx) => {
            const fresh = await encryptTokens({ keys: newRing }, ws, id, tokens("refreshed-meanwhile"));
            await setIntegrationStatus(tx, ws, id, { encryptedTokens: fresh, keyId: newRing.keyId });
          });
        }
        return third.wrap(dek);
      },
      unwrap: (w: Parameters<typeof third.unwrap>[0]) => third.unwrap(w),
    };
    const report = await rotateIntegrationKeys({ db: handle.db, keys: racingKeys }, [{ id, workspaceId: ws }], {
      reencrypt: false,
    });
    expect(report).toMatchObject({ rotated: 1, retried: 1, failed: [] });
    expect((await readTokens({ db: handle.db, keys: third }, ws, id))?.refreshToken).toBe("refreshed-meanwhile");

    const unknown = new KeyRing(local(44));
    const failed = await rotateIntegrationKeys({ db: handle.db, keys: unknown }, [{ id, workspaceId: ws }], {
      reencrypt: false,
    });
    expect(failed.failed).toEqual([{ workspaceId: ws, accountId: id, reason: "UNKNOWN_KEY" }]);
  });
});
