import { join } from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { loadDotenv } from "@meri/config";

// One shared .env at the repo root (docs/blockers/README.md). Existing process variables win.
loadDotenv(".env");
loadDotenv("../../.env");

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const apiUrl = process.env.API_URL ?? "http://localhost:4000";
const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `pnpm dev` writes to .next-dev so a concurrent `next build` (pnpm verify) never clobbers the running dev server.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  transpilePackages: ["@meri/config", "@meri/core"],
  // Container images (Dockerfile, D-098) ship the self-contained server; local runs keep `next start`.
  ...(process.env.NEXT_OUTPUT === "standalone"
    ? { output: "standalone" as const, outputFileTracingRoot: join(process.cwd(), "..", "..") }
    : {}),
  poweredByHeader: false,
  // `pnpm lint` runs the repo-wide flat config (incl. react/jsx-no-literals); Next's own pass would be redundant.
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    // Same-origin access to the API: cookies travel, no CORS (ADR 0001).
    return [{ source: "/api/v1/:path*", destination: `${apiUrl}/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // The Content-Security-Policy is set per request by the middleware (nonce, D-080).
          ...(process.env.NODE_ENV === "production"
            ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
            : []),
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
