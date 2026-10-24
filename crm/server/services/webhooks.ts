import type { Db } from "../db.js";
import type { Ctx } from "../context.js";
import { id, now, hmac, addDays } from "../lib/util.js";
import { onEvent } from "./events.js";

const BACKOFF_MIN = [1, 5, 30, 120, 720];

export function registerWebhookDispatcher() {
  onEvent((ctx, ev) => {
    const hooks = ctx.db.all<{ id: string; events: string; url: string; secret: string }>("SELECT * FROM webhooks WHERE workspace_id=? AND active=1", ctx.ws);
    for (const h of hooks) {
      let events: string[] = [];
      try { events = JSON.parse(h.events); } catch { /* ignore */ }
      if (!events.includes("*") && !events.includes(ev.type) && !events.includes(`${ev.object}.*`)) continue;
      const payload = JSON.stringify({ id: id(), event: ev.type, object: ev.object, occurred_at: now(), data: ev.record, changes: ev.changes ?? {}, meta: ev.meta ?? {} });
      const dId = id();
      ctx.db.insert("webhook_deliveries", { id: dId, workspace_id: ctx.ws, webhook_id: h.id, event: ev.type, payload, status: "pending", attempts: 0, created_at: now() });
      void attemptDelivery(ctx.db, dId);
    }
  });
}

export async function attemptDelivery(db: Db, deliveryId: string) {
  const d = db.get<{ id: string; webhook_id: string; payload: string; attempts: number; event: string }>("SELECT * FROM webhook_deliveries WHERE id=?", deliveryId);
  if (!d) return;
  const h = db.get<{ url: string; secret: string; active: number }>("SELECT url, secret, active FROM webhooks WHERE id=?", d.webhook_id);
  if (!h || !h.active) { db.update("webhook_deliveries", d.id, { status: "failed", error: "webhook inactivo" }); return; }
  const attempts = d.attempts + 1;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(h.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-crm-event": d.event, "x-crm-signature": `sha256=${hmac(h.secret, d.payload)}`, "x-crm-delivery": d.id },
      body: d.payload,
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (res.ok) {
      db.update("webhook_deliveries", d.id, { status: "ok", attempts, response_code: res.status, next_retry_at: null, error: null });
      return;
    }
    scheduleRetry(db, d.id, attempts, `HTTP ${res.status}`, res.status);
  } catch (e) {
    scheduleRetry(db, d.id, attempts, (e as Error).message, null);
  }
}

function scheduleRetry(db: Db, deliveryId: string, attempts: number, error: string, code: number | null) {
  const wait = BACKOFF_MIN[attempts - 1];
  if (wait === undefined) {
    db.update("webhook_deliveries", deliveryId, { status: "failed", attempts, error, response_code: code, next_retry_at: null });
    return;
  }
  db.update("webhook_deliveries", deliveryId, { status: "pending", attempts, error, response_code: code, next_retry_at: addDays(new Date(), wait / 1440) });
}

export async function retryDueDeliveries(db: Db) {
  const due = db.all<{ id: string }>("SELECT id FROM webhook_deliveries WHERE status='pending' AND next_retry_at IS NOT NULL AND next_retry_at <= ? LIMIT 50", now());
  for (const d of due) await attemptDelivery(db, d.id);
}

