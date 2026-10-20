/** Overdue = flagged at risk by the follow-up rules, or confirmed and past its due date (F-08). Pure: safe on server and client. */
export function isOverdue(c: { status: string; dueAt: string | null }, now: Date): boolean {
  return c.status === "at_risk" || (c.status === "confirmed" && c.dueAt !== null && new Date(c.dueAt).getTime() < now.getTime());
}
