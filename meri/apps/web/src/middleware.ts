import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, newNonce } from "./server/csp";

// Public API paths: the waitlist (D-099; the API checks CSRF, Origin and limits) and the signed one-click
// unsubscribe (D-116; the token is the authorization). `/correo/baja` is the page behind every email's link.
const PUBLIC = [
  "/login",
  "/privacy",
  "/terms",
  "/precios",
  "/seguridad",
  "/api/auth",
  "/api/demo",
  "/api/session",
  "/api/v1/waitlist",
  "/api/v1/email/unsubscribe",
  "/correo/baja",
  "/manifest.webmanifest",
  "/icon",
  "/mobile",
];

/**
 * Per-request CSP nonce (D-080): Next reads the policy from the request headers and stamps the nonce on its own
 * scripts; the layout reads `x-nonce` for the theme bootstrap. The same policy goes on the response.
 */
function withCsp(request: NextRequest): NextResponse {
  const nonce = newNonce();
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV !== "production" });
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", csp);
  return response;
}

/**
 * Cheap gate: app areas need a session cookie; the real validation happens server-side (auth() + /v1/me).
 * Edge-safe on purpose: no node-only imports here.
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return withCsp(request);
  const hasSession =
    request.cookies.has("authjs.session-token") || request.cookies.has("__Secure-authjs.session-token");
  if (!hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  return withCsp(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icons/).*)"],
};
