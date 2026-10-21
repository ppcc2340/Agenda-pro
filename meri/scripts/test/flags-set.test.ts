import { createDb, DbFlagStore } from "@meri/db";
import { afterAll, describe, expect, it } from "vitest";
import { priceExperimentBlocker, setFeatureFlag } from "../flags-set";

const APP = process.env.DATABASE_URL_TEST ?? "postgres://meri_app:meri_app@localhost:5432/meri_test";
const ADMIN = process.env.DATABASE_ADMIN_URL_TEST ?? "postgres://meri:meri@localhost:5432/meri_test";

describe("pnpm flags:set (D-102)", () => {
  const app = createDb(APP, { max: 1 });
  afterAll(() => app.close());

  it("sets a known flag globally or per workspace, and the app reads it", async () => {
    const ws = "0192aaaa-0000-7000-8000-00000000f1a9";
    await setFeatureFlag(ADMIN, ["ai_briefings", "on", "--workspace", ws]);
    expect(await new DbFlagStore(app.db, 0).isEnabled("ai_briefings", ws)).toBe(true);
    await setFeatureFlag(ADMIN, ["ai_briefings", "off", "--workspace", ws]);
    expect(await new DbFlagStore(app.db, 0).isEnabled("ai_briefings", ws)).toBe(false);
    await expect(setFeatureFlag(ADMIN, ["made_up", "on"])).rejects.toThrow(/Usage/);
    await expect(setFeatureFlag(ADMIN, ["ai_briefings", "maybe"])).rejects.toThrow(/Usage/);
  });

  it("refuses to start the price experiment in live mode without cohort B prices, unless forced", async () => {
    const ws = "0192aaaa-0000-7000-8000-00000000f1aa";
    const live = { STRIPE_MODE: "live", STRIPE_PRICE_PRO_B: "price_x" };
    await expect(setFeatureFlag(ADMIN, ["price_experiment", "on", "--workspace", ws], live)).rejects.toThrow(
      /STRIPE_PRICE_PRO_ANNUAL_B, STRIPE_PRICE_PRO_PLUS_B, STRIPE_PRICE_PRO_PLUS_ANNUAL_B are not set/,
    );
    expect(await new DbFlagStore(app.db, 0).isEnabled("price_experiment", ws)).toBe(false);
    await setFeatureFlag(ADMIN, ["price_experiment", "on", "--workspace", ws, "--force"], live);
    expect(await new DbFlagStore(app.db, 0).isEnabled("price_experiment", ws)).toBe(true);
    // Turning it off never needs the prices.
    await setFeatureFlag(ADMIN, ["price_experiment", "off", "--workspace", ws], live);
    expect(await new DbFlagStore(app.db, 0).isEnabled("price_experiment", ws)).toBe(false);
  });

  it("only blocks in live mode, and only on missing ids", () => {
    expect(priceExperimentBlocker({ STRIPE_MODE: "fake" })).toBeNull();
    expect(priceExperimentBlocker({})).toBeNull();
    expect(
      priceExperimentBlocker({
        STRIPE_MODE: "live",
        STRIPE_PRICE_PRO_B: "a",
        STRIPE_PRICE_PRO_ANNUAL_B: "b",
        STRIPE_PRICE_PRO_PLUS_B: "c",
        STRIPE_PRICE_PRO_PLUS_ANNUAL_B: "d",
      }),
    ).toBeNull();
    expect(priceExperimentBlocker({ STRIPE_MODE: "live" })).toMatch(/STRIPE_PRICE_PRO_B,/);
  });
});
