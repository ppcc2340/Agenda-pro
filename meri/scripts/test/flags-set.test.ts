import { createDb, DbFlagStore } from "@meri/db";
import { afterAll, describe, expect, it } from "vitest";
import { setFeatureFlag } from "../flags-set";

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
});
