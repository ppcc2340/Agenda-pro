import { describe, expect, it } from "vitest";
import { ConfigError, parseEnv } from "./env";
import { resolveModes } from "./modes";
import { loadConfig } from "./load";

const BASE = {
  DATABASE_URL: "postgres://meri:meri@localhost:5432/meri",
  AUTH_SECRET: "x".repeat(40),
  INTERNAL_API_SECRET: "y".repeat(20),
  LOCAL_MASTER_KEY: Buffer.alloc(32, 7).toString("base64"),
};

describe("parseEnv", () => {
  it("applies defaults and treats empty strings as absent", () => {
    const env = parseEnv({ ...BASE, GOOGLE_CLIENT_ID: "", DEMO_MODE: "", PORT: "", RATE_LIMIT_PER_MINUTE: "" });
    expect(env.NODE_ENV).toBe("development");
    expect(env.GOOGLE_MODE).toBe("fake");
    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(env.DEMO_MODE).toBe(false);
    expect(env.PORT).toBeUndefined();
    expect(env.AI_MONTHLY_COST_CAP_USD_PER_USER).toBe(6);
    expect(env.RATE_LIMIT_PER_MINUTE).toBe(300);
    expect(parseEnv({ ...BASE, RATE_LIMIT_PER_MINUTE: "3000" }).RATE_LIMIT_PER_MINUTE).toBe(3000);
    expect(() => parseEnv({ ...BASE, RATE_LIMIT_PER_MINUTE: "0" })).toThrow(ConfigError);
  });

  it("fails with a readable message when required variables are missing", () => {
    expect(() => parseEnv({})).toThrow(ConfigError);
    try {
      parseEnv({ AUTH_SECRET: "short" });
    } catch (e) {
      const err = e as ConfigError;
      expect(err.issues.join("\n")).toMatch(/DATABASE_URL/);
      expect(err.issues.join("\n")).toMatch(/AUTH_SECRET/);
      expect(err.message).not.toContain("short");
    }
  });

  it("parses DEMO_NOW as an ISO datetime with offset", () => {
    expect(parseEnv({ ...BASE, DEMO_NOW: "2026-10-19T10:40:00-03:00" }).DEMO_NOW).toBe(
      "2026-10-19T10:40:00-03:00",
    );
    expect(() => parseEnv({ ...BASE, DEMO_NOW: "yesterday" })).toThrow(ConfigError);
  });
});

describe("resolveModes", () => {
  it("defaults every integration to fake", () => {
    expect(resolveModes(parseEnv(BASE))).toEqual({
      google: "fake",
      ai: "fake",
      stripe: "fake",
      analytics: "fake",
      kms: "fake",
      notify: "fake",
    });
  });

  it("live without credentials fails citing the variable and the guide", () => {
    expect(() => resolveModes(parseEnv({ ...BASE, GOOGLE_MODE: "live" }))).toThrow(
      /GOOGLE_MODE=live requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET\. See docs\/blockers\/google-oauth\.md/,
    );
    expect(() => resolveModes(parseEnv({ ...BASE, KMS_PROVIDER: "aws" }))).toThrow(
      /KMS_KEY_ID, AWS_REGION.*docs\/blockers\/kms\.md/,
    );
    expect(() => resolveModes(parseEnv({ ...BASE, NOTIFY_MODE: "live", SMTP_URL: "smtp://h" }))).toThrow(
      /NOTIFY_MODE=live requires MAIL_FROM\. See docs\/blockers\/email\.md/,
    );
    expect(
      resolveModes(parseEnv({ ...BASE, NOTIFY_MODE: "live", SMTP_URL: "smtp://h", MAIL_FROM: "Meri <a@b.c>" })).notify,
    ).toBe("live");
    // ADR 0007 chose AWS KMS: GCP is refused with a pointer, never a half-working adapter.
    expect(() => resolveModes(parseEnv({ ...BASE, KMS_PROVIDER: "gcp", KMS_KEY_ID: "k" }))).toThrow(
      /KMS_PROVIDER=gcp is not available yet \(ADR 0007/,
    );
    expect(resolveModes(parseEnv({ ...BASE, KMS_PROVIDER: "aws", KMS_KEY_ID: "arn", AWS_REGION: "eu-west-1" })).kms).toBe(
      "live",
    );
  });

  it("live with credentials resolves to live", () => {
    const modes = resolveModes(parseEnv({ ...BASE, AI_MODE: "live", ANTHROPIC_API_KEY: "sk-test" }));
    expect(modes.ai).toBe("live");
    expect(modes.google).toBe("fake");
  });

  it("production forbids fake modes and local KMS", () => {
    expect(() => loadConfig({ ...BASE, NODE_ENV: "production" })).toThrow(ConfigError);
    try {
      loadConfig({ ...BASE, NODE_ENV: "production" });
    } catch (e) {
      const issues = (e as ConfigError).issues.join("\n");
      expect(issues).toMatch(/GOOGLE_MODE=fake is forbidden in production/);
      expect(issues).toMatch(/KMS_PROVIDER=local is forbidden in production/);
    }
  });

  it("DEMO_MODE=1 is forbidden on a production configuration (PROTOTYPE.md, D-049)", () => {
    expect(() => loadConfig({ ...BASE, NODE_ENV: "production", DEMO_MODE: "1" })).toThrow(/DEMO_MODE=1 is forbidden/);
    expect(loadConfig({ ...BASE, NODE_ENV: "development", DEMO_MODE: "1" }).env.DEMO_MODE).toBe(true);
    expect(loadConfig({ ...BASE, NODE_ENV: "production", APP_ENV: "development", ALLOW_FAKES_ON_PRODUCTION_BUILD: "1", DEMO_MODE: "1" }).env.DEMO_MODE).toBe(true);
  });

  it("APP_ENV=development lets an optimized build (NODE_ENV=production) run against fakes (D-029)", () => {
    expect(() => loadConfig({ ...BASE, NODE_ENV: "production", APP_ENV: "development" })).toThrow(
      /ALLOW_FAKES_ON_PRODUCTION_BUILD/,
    );
    const config = loadConfig({
      ...BASE,
      NODE_ENV: "production",
      APP_ENV: "development",
      ALLOW_FAKES_ON_PRODUCTION_BUILD: "1",
    });
    expect(config.isProduction).toBe(false);
    expect(config.fakesOnProductionBuild).toBe(true);
    expect(config.modes.google).toBe("fake");
    expect(() => loadConfig({ ...BASE, NODE_ENV: "development", APP_ENV: "production" })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...BASE, NODE_ENV: "development", APP_ENV: "staging" })).toThrow(
      /forbidden in production/,
    );
  });

  it("local KMS requires LOCAL_MASTER_KEY", () => {
    expect(() => resolveModes(parseEnv({ ...BASE, LOCAL_MASTER_KEY: "" }))).toThrow(/LOCAL_MASTER_KEY/);
  });
});

describe("production secrets", () => {
  it("rejects .env.example placeholders and requires AUTH_URL in production", () => {
    const prod = {
      ...BASE,
      NODE_ENV: "production",
      GOOGLE_MODE: "live",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "s",
      AI_MODE: "live",
      ANTHROPIC_API_KEY: "k",
      STRIPE_MODE: "live",
      STRIPE_SECRET_KEY: "k",
      STRIPE_WEBHOOK_SECRET: "w",
      STRIPE_PRICE_PRO: "p",
      STRIPE_PRICE_PRO_ANNUAL: "p2",
      STRIPE_PRICE_PRO_PLUS: "p3",
      STRIPE_PRICE_PRO_PLUS_ANNUAL: "p4",
      STRIPE_PRICE_CREDITS_500: "p5",
      STRIPE_PRICE_CREDITS_2000: "p6",
      ANALYTICS_MODE: "live",
      SENTRY_DSN: "d",
      POSTHOG_KEY: "p",
      KMS_PROVIDER: "aws",
      KMS_KEY_ID: "arn",
      AWS_REGION: "eu-west-1",
      NOTIFY_MODE: "live",
      SMTP_URL: "smtps://u:p@smtp.example.com:465",
      MAIL_FROM: "Meri <avisos@example.com>",
      AUTH_SECRET: "change-me-dev-only-secret-32-bytes-minimum",
    };
    expect(() => loadConfig(prod)).toThrow(/AUTH_SECRET still hold the \.env\.example placeholder/);
    expect(() => loadConfig(prod)).toThrow(/AUTH_URL is required in production/);
    expect(() =>
      loadConfig({ ...prod, AUTH_SECRET: "r".repeat(40), AUTH_URL: "https://app.meri.test" }),
    ).toThrow(/GOOGLE_CALENDAR_CHANNEL_TOKEN/);
    expect(() =>
      loadConfig({
        ...prod,
        AUTH_SECRET: "r".repeat(40),
        AUTH_URL: "https://app.meri.test",
        GOOGLE_CALENDAR_CHANNEL_TOKEN: "t".repeat(24),
      }),
    ).not.toThrow();
  });
});
