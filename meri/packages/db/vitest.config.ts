import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/test/global-setup.ts"],
    // Integration tests share one Postgres database; run files sequentially to keep them deterministic.
    fileParallelism: false,
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/index.ts", "src/seed/**", "src/test/**", "src/migrate.ts"],
      thresholds: { lines: 0, functions: 0, branches: 0, statements: 0 },
    },
  },
});
