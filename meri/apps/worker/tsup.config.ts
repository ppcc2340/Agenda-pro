import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  // Workspace packages are consumed from source, so bundle them.
  noExternal: [/^@meri\//],
});
