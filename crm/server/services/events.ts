import type { Ctx } from "../context.js";

export interface CrmEvent {
  /** e.g. contact.created, deal.stage_changed, deal.won, form.submitted, task.overdue */
  type: string;
  object: "contact" | "company" | "deal" | "task" | "ticket" | "quote" | "email";
  record: Record<string, unknown>;
  previous?: Record<string, unknown>;
  changes?: Record<string, [unknown, unknown]>;
  meta?: Record<string, unknown>;
  depth?: number;
}

type Handler = (ctx: Ctx, ev: CrmEvent) => void | Promise<void>;
const handlers: Handler[] = [];

export function onEvent(h: Handler) {
  handlers.push(h);
}

/** Emit a domain event. Handlers (workflows, webhooks) run synchronously in order; errors are logged, never thrown. */
export function emit(ctx: Ctx, ev: CrmEvent) {
  const depth = ev.depth ?? 0;
  if (depth > 6) {
    console.warn(`[events] bucle detectado, se detiene ${ev.type}`);
    return;
  }
  for (const h of handlers) {
    try {
      const r = h(ctx, { ...ev, depth });
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch((e) => console.error("[events]", ev.type, e));
    } catch (e) {
      console.error("[events]", ev.type, e);
    }
  }
}
