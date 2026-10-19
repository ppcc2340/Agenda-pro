import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { loadDotenv } from "@meri/config";

// One shared .env at the repo root (docs/blockers/README.md). Existing process variables win.
loadDotenv(".env");
loadDotenv("../../.env");

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const apiUrl = process.env.API_URL ?? "http://localhost:4000";
// Next dev evaluates source maps with eval; production never gets 'unsafe-eval'.
const isDev = process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `pnpm dev` writes to .next-dev so a concurrent `next build` (pnpm verify) never clobbers the running dev server.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  transpilePackages: ["@meri/config", "@meri/core"],
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
          // Phase 0 CSP: self + Google Fonts; inline scripts/styles still needed (theme bootstrap, Next dev).
          // A nonce-based strict CSP is scheduled in phase 5 (P5-02).
          {
            key: "Content-Security-Policy",
            value: `default-src 'self'; script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'`,
          },
          ...(process.env.NODE_ENV === "production"
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
            : []),
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
