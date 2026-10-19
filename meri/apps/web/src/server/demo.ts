/** Demo identity used by `pnpm demo` (PROTOTYPE.md, D-049). */
export const DEMO_USER = { email: "demo@meri.local", name: "Demo de Meri" } as const;

/** Same-origin paths only: "/x" but never "//evil" or "/\\evil" (browsers normalise backslashes). */
export function safeNext(value: string | null | undefined): string {
  return value && /^\/(?![/\\])/.test(value) ? value : "/hoy";
}
