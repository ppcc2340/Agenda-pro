import { KeyRing, LocalKeyProvider, localKeyId } from "@meri/config/crypto";
import {
  bootstrapAccount,
  createDb,
  setIntegrationStatus,
  upsertIntegrationAccount,
  withWorkspace,
  type WorkspaceId,
} from "@meri/db";
import { encryptTokens, readTokens } from "@meri/jobs";
import { describe, expect, it } from "vitest";
import { rotateKeys } from "../keys-rotate";

const APP = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const ADMIN = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";
const NOW = new Date("2026-10-19T10:40:00Z");
const k = (n: number) => Buffer.alloc(32, n).toString("base64");
const local = (n: number) => new LocalKeyProvider(k(n), localKeyId(k(n)));

describe("pnpm keys:rotate (ADR 0007)", () => {
  it("finds every connection across workspaces and rotates it with the application role", async () => {
    const app = createDb(APP, { max: 1 });
    const old = new KeyRing(local(61));
    const made: { ws: WorkspaceId; id: string }[] = [];
    try {
      for (const label of ["a", "b"]) {
        const ws = (await bootstrapAccount(app.db, { email: `kr-${label}-${Date.now().toString(36)}@test.local`, now: NOW }))
          .workspaceId;
        const id = await withWorkspace(app.db, ws, async (tx) => {
          const row = await upsertIntegrationAccount(
            tx,
            ws,
            {
              provider: "google",
              externalAccountId: `kr-${label}-${Date.now().toString(36)}`,
              email: `kr-${label}@test.local`,
              scopes: [],
              encryptedTokens: "pending",
              keyId: old.keyId,
            },
            NOW,
          );
          const blob = await encryptTokens({ keys: old }, ws, row.id, {
            accessToken: "a",
            refreshToken: `r-${label}`,
            expiresAt: NOW.toISOString(),
            scopes: [],
            externalAccountId: "s",
            email: "e@test.local",
          });
          await setIntegrationStatus(tx, ws, row.id, { encryptedTokens: blob, keyId: old.keyId, status: "healthy" });
          return row.id;
        });
        made.push({ ws, id });
      }
      const next = new KeyRing(local(62), [local(61)]);
      const report = await rotateKeys({ appUrl: APP, adminUrl: ADMIN, keys: next, reencrypt: false });
      // The shared test database holds other suites' connections under other keys: those are reported, not
      // touched (UNKNOWN_KEY), which is exactly what an operator must see for keys missing from the ring.
      const ours = new Set(made.map((m) => m.id));
      expect(report.failed.filter((f) => ours.has(f.accountId))).toEqual([]);
      expect(report.failed.every((f) => f.reason === "UNKNOWN_KEY" || f.reason === "TAMPERED")).toBe(true);
      expect(report.rotated).toBeGreaterThanOrEqual(2);
      const retired = new KeyRing(local(62));
      for (const m of made) expect((await readTokens({ db: app.db, keys: retired }, m.ws, m.id))?.refreshToken).toMatch(/^r-/);
    } finally {
      await app.close();
    }
  });
});
