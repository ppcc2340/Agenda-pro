import { encode } from "@auth/core/jwt";
import { createLogger, parseEnv, resolveModes, type AppConfig } from "@meri/config";
import { bootstrapAccount, createDb, ensureDevRoles, runMigrations, type AccountIdentity, type DbHandle } from "@meri/db";
import { createIntegrations } from "@meri/integrations";
import { buildApp, type App } from "../app";
import { sessionCookieName } from "../plugins/session";
import { CSRF_HEADER, CSRF_VALUE } from "../plugins/csrf";

export const TEST_ADMIN_URL = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";
export const TEST_APP_URL = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
export const AUTH_SECRET = "test-auth-secret-at-least-32-characters-long";
export const INTERNAL_SECRET = "test-internal-secret-16+";
export const NOW = new Date("2026-10-19T10:40:00Z");

export function testConfig(): AppConfig {
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: TEST_APP_URL,
    AUTH_SECRET,
    INTERNAL_API_SECRET: INTERNAL_SECRET,
    LOCAL_MASTER_KEY: Buffer.alloc(32, 3).toString("base64"),
  });
  return { env, modes: resolveModes(env), isProduction: false, isTest: true };
}

export interface TestApp {
  app: App;
  handle: DbHandle;
  close(): Promise<void>;
  /** Signs an Auth.js-compatible session cookie for the given account. */
  cookieFor(account: Pick<AccountIdentity, "userId" | "workspaceId" | "email">, overrides?: Record<string, unknown>): Promise<string>;
  createAccount(label: string): Promise<AccountIdentity>;
}

export async function migrateTestDb(): Promise<void> {
  await runMigrations(TEST_ADMIN_URL);
  await ensureDevRoles(TEST_ADMIN_URL);
}

export async function createTestApp(options: { rateLimitMax?: number } = {}): Promise<TestApp> {
  const config = testConfig();
  const handle = createDb(TEST_APP_URL, { max: 3 });
  const app = await buildApp({
    config,
    db: handle.db,
    integrations: createIntegrations(config, { now: () => NOW }),
    logger: createLogger({ name: "api-test", level: "silent" }),
    now: () => NOW,
    rateLimitMax: options.rateLimitMax ?? 1000,
  });
  const name = sessionCookieName(false);
  return {
    app,
    handle,
    close: async () => {
      await app.close();
      await handle.close();
    },
    cookieFor: async (account, overrides = {}) => {
      const token = await encode({
        token: { sub: account.userId, workspaceId: account.workspaceId, email: account.email, locale: "es", ...overrides },
        secret: AUTH_SECRET,
        salt: name,
        maxAge: 3600,
      });
      return `${name}=${token}`;
    },
    createAccount: (label) =>
      bootstrapAccount(handle.db, { email: `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@test.local`, name: label, now: NOW }),
  };
}

export const csrf = { [CSRF_HEADER]: CSRF_VALUE };
