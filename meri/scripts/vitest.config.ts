import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Root pinned to this folder so `pnpm test:scripts` finds the tests whatever the cwd or vitest's root default.
export default defineConfig({
  test: { root: fileURLToPath(new URL(".", import.meta.url)), environment: "node", include: ["test/**/*.test.ts"] },
});
