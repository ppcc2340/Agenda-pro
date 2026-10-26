import type { Ctx } from "../context.js";
import { parseJson, type Row } from "../db.js";
import { matches } from "../lib/filters.js";
import { FREE_EMAIL_DOMAINS, domainFromEmail } from "../lib/util.js";

/** Rule-based lead scoring (3.2). Points from scoring_rules + implicit signals, with weekly decay. */
export function computeScore(ctx: Ctx, contact: Row): number {
  const rules = ctx.db.all<{ field: string; op: string; value: string | null; points: number }>("SELECT field, op, value, points FROM scoring_rules WHERE workspace_id=? AND active=1", ctx.ws);
  const company = contact.company_id ? parseJson(ctx.db.get<Row>("SELECT * FROM companies WHERE id=?", contact.company_id), ["tags", "custom"]) : null;
  const rec = { ...contact, company };
  let score = 0;
  for (const r of rules) {
    if (matches(rec, { logic: "and", conditions: [{ field: r.field, op: r.op, value: r.value }] })) score += r.points;
  }
  const d = domainFromEmail((contact.email as string | null) ?? null);
  if (d && FREE_EMAIL_DOMAINS.has(d)) score -= 10;
  const engagement = ctx.db.get<{ n: number }>("SELECT COUNT(*) n FROM activities WHERE contact_id=? AND type IN ('email','call','meeting') AND direction='inbound'", contact.id)?.n ?? 0;
  score += Math.min(engagement * 3, 30);
  const opens = ctx.db.get<{ n: number }>("SELECT COALESCE(SUM(opens),0) n FROM emails WHERE contact_id=?", contact.id)?.n ?? 0;
  score += Math.min(opens * 2, 20);
  const last = (contact.last_activity_at as string | null) ?? (contact.created_at as string);
  const weeks = Math.floor((Date.now() - new Date(last).getTime()) / (7 * 86400000));
  score -= Math.max(0, weeks) * (ctx.settings.score_decay_per_week ?? 1);
  return Math.max(0, Math.min(100, score));
}

export function recomputeScore(ctx: Ctx, contactId: string): number {
  const c = parseJson(ctx.db.get<Row>("SELECT * FROM contacts WHERE id=?", contactId), ["tags", "custom", "utm", "qualification"]);
  if (!c) return 0;
  const score = computeScore(ctx, c);
  if (score !== c.score) ctx.db.run("UPDATE contacts SET score=? WHERE id=?", score, contactId);
  // Threshold promotion: lead -> mql -> sql (never demote automatically)
  const order = ["subscriber", "lead", "mql", "sql"];
  const cur = order.indexOf(String(c.lifecycle_stage));
  if (cur >= 0 && cur < 3) {
    let target = cur;
    if (score >= ctx.settings.sql_threshold) target = 3;
    else if (score >= ctx.settings.mql_threshold) target = Math.max(cur, 2);
    if (target > cur) ctx.db.run("UPDATE contacts SET lifecycle_stage=? WHERE id=?", order[target], contactId);
  }
  return score;
}
