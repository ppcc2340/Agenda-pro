/**
 * Content-Security-Policy for the web app (D-080). Pure so it can be tested; the middleware adds a fresh nonce per
 * request and Next stamps it on its own scripts. `'strict-dynamic'` lets those nonce'd scripts load their chunks;
 * no inline script runs without the nonce. Styles keep `'unsafe-inline'` (React style attributes; no execution).
 */
export function buildCsp(nonce: string, options: { dev: boolean }): string {
  const directives: [string, string][] = [
    ["default-src", "'self'"],
    ["script-src", `'self' 'nonce-${nonce}' 'strict-dynamic'${options.dev ? " 'unsafe-eval'" : ""}`],
    ["style-src", "'self' 'unsafe-inline' https://fonts.googleapis.com"],
    ["font-src", "'self' https://fonts.gstatic.com"],
    ["img-src", "'self' data: blob:"],
    ["connect-src", options.dev ? "'self' ws:" : "'self'"],
    // The /mobile preview frames the app itself; nothing else may frame it.
    ["frame-src", "'self'"],
    ["frame-ancestors", "'self'"],
    ["object-src", "'none'"],
    ["base-uri", "'none'"],
    ["form-action", "'self'"],
  ];
  return directives.map(([name, value]) => `${name} ${value}`).join("; ");
}

/** 128-bit nonce, base64; Web Crypto so it runs in the edge middleware. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
