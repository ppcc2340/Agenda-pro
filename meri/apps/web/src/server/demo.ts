export { DEMO_USER } from "@meri/config";

/** Same-origin paths only: "/x" but never "//evil" or "/\\evil" (browsers normalise backslashes). */
export function safeNext(value: string | null | undefined): string {
  return value && /^\/(?![/\\])/.test(value) ? value : "/hoy";
}
