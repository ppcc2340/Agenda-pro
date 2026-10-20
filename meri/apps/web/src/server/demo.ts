export { DEMO_USER } from "@meri/config";

/**
 * Same-origin paths only: "/x" but never "//evil" or "/\\evil" (browsers normalise backslashes), and no control
 * characters anywhere ("/\t/evil" becomes "//evil" once a browser strips tabs and newlines from the URL).
 */
export function safeNext(value: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point of this check.
  return value && /^\/(?![/\\])/.test(value) && !/[\u0000-\u001f\u007f\\]/.test(value) ? value : "/hoy";
}
