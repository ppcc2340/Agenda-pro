import type { Ctx } from "../context.js";
import { id, now } from "../lib/util.js";

export function audit(ctx: Ctx, object: string, recordId: string | null, action: string, changes: Record<string, unknown> = {}) {
  ctx.db.insert("audit_log", { id: id(), workspace_id: ctx.ws, user_id: ctx.user.id, object, record_id: recordId, action, changes, ip: ctx.ip, created_at: now() });
}

/** Compute field-level diff {field: [old, new]} between two records (only keys in `next`). */
export function diff(prev: Record<string, unknown>, next: Record<string, unknown>, ignore: string[] = ["updated_at"]): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const k of Object.keys(next)) {
    if (ignore.includes(k)) continue;
    const a = prev[k], b = next[k];
    const as = typeof a === "object" ? JSON.stringify(a) : a;
    const bs = typeof b === "object" ? JSON.stringify(b) : b;
    if (as !== bs && !(a == null && (b === "" || b == null))) {
      out[k] = [a ?? null, b ?? null];
      if (k === "custom" && a && b && typeof a === "object" && typeof b === "object") {
        const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
        for (const ck of new Set([...Object.keys(ao), ...Object.keys(bo)])) { const x = ao[ck], y = bo[ck]; if (JSON.stringify(x ?? null) !== JSON.stringify(y ?? null)) out[`custom.${ck}`] = [x ?? null, y ?? null]; }
      }
    }
  }
  return out;
}
