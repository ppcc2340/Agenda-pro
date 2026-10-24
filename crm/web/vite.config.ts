import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  build: { outDir: path.resolve(import.meta.dirname, "../dist/web"), emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/f": "http://localhost:3000",
      "/t": "http://localhost:3000",
      "/q": "http://localhost:3000",
      "/embed.js": "http://localhost:3000",
    },
  },
});
