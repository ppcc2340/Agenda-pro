import { NextResponse, type NextRequest } from "next/server";

const PUBLIC = ["/login", "/privacy", "/terms", "/api/auth", "/manifest.webmanifest", "/icon", "/mobile"];

/**
 * Cheap gate: app areas need a session cookie; the real validation happens server-side (auth() + /v1/me).
 * Edge-safe on purpose: no node-only imports here.
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return NextResponse.next();
  const hasSession =
    request.cookies.has("authjs.session-token") || request.cookies.has("__Secure-authjs.session-token");
  if (!hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icons/).*)"],
};
