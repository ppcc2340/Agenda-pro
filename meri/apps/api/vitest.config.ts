import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/index.ts", "src/main.ts", "src/openapi.ts", "src/test/**"],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
