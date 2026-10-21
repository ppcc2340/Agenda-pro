import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  // Workspace packages are consumed from source, so bundle them; every third-party package stays external and is
  // installed flat next to the bundle (Dockerfile: `pnpm deploy` with a hoisted linker). Bundling them breaks
  // packages that rely on Node's CommonJS resolution (bullmq imports `ioredis/built/utils`, a directory).
  noExternal: [/^@meri\//],
  external: [/^(?!@meri\/)[^./]/],
});
