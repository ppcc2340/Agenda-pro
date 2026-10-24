import type { Db } from "../db.js";
import { id, now } from "../lib/util.js";
import { sendMail } from "./email.js";

export interface NotifyInput { type: string; title: string; body?: string; link?: string }

export function notify(db: Db, ws: string, userId: string | null | undefined, n: NotifyInput) {
  if (!userId) return;
  db.insert("notifications", { id: id(), workspace_id: ws, user_id: userId, type: n.type, title: n.title, body: n.body ?? null, link: n.link ?? null, created_at: now() });
  const u = db.get<{ email: string; notification_prefs: string }>("SELECT email, notification_prefs FROM users WHERE id=?", userId);
  if (u) {
    let prefs: Record<string, unknown> = {};
    try { prefs = JSON.parse(u.notification_prefs || "{}"); } catch { /* ignore */ }
    if (prefs.email_all === true || (Array.isArray(prefs.email_types) && prefs.email_types.includes(n.type))) {
      void sendMail(db, ws, { to: u.email, subject: `[CRM] ${n.title}`, html: `<p>${n.body ?? n.title}</p>${n.link ? `<p><a href="${process.env.PUBLIC_URL ?? ""}${n.link}">Abrir en el CRM</a></p>` : ""}` }).catch(() => undefined);
    }
  }
}
