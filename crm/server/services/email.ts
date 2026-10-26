import nodemailer from "nodemailer";
import type { Db } from "../db.js";
import { id, now } from "../lib/util.js";

export interface MailInput { to: string; subject: string; html: string; text?: string; contactId?: string | null; userId?: string | null; activityId?: string | null; track?: boolean; fromName?: string; attachments?: { filename: string; content: string; contentType?: string }[] }

let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;
export function emailMode(): "fake" | "smtp" {
  return process.env.EMAIL_MODE === "smtp" ? "smtp" : "fake";
}
function getTransporter() {
  if (transporter) return transporter;
  if (!process.env.SMTP_HOST) throw new Error("EMAIL_MODE=smtp requiere SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS");
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transporter;
}

export const sentLog: MailInput[] = []; // fake mode outbox (tests + dev)

/** Sends an email (or logs it in fake mode) and records it in `emails` with open/click tracking. */
export async function sendMail(db: Db, ws: string, m: MailInput): Promise<string> {
  const emailId = id();
  const base = process.env.PUBLIC_URL ?? "http://localhost:3000";
  let html = m.html;
  if (m.track !== false) {
    html = html.replace(/href="(https?:\/\/[^"]+)"/g, (_, url: string) => `href="${base}/t/c/${emailId}?u=${encodeURIComponent(url)}"`);
    html += `<img src="${base}/t/o/${emailId}.gif" width="1" height="1" alt="" />`;
  }
  db.insert("emails", { id: emailId, workspace_id: ws, activity_id: m.activityId ?? null, contact_id: m.contactId ?? null, user_id: m.userId ?? null, to_email: m.to, subject: m.subject, body: html, status: "queued", created_at: now() });
  try {
    if (emailMode() === "smtp") {
      await getTransporter().sendMail({ from: m.fromName ? `"${m.fromName}" <${process.env.SMTP_FROM}>` : process.env.SMTP_FROM, to: m.to, subject: m.subject, html, text: m.text, attachments: m.attachments });
      db.update("emails", emailId, { status: "sent", sent_at: now() });
    } else {
      sentLog.push(m);
      if (sentLog.length > 200) sentLog.shift();
      db.update("emails", emailId, { status: "logged", sent_at: now() });
    }
  } catch (e) {
    db.update("emails", emailId, { status: "failed", error: (e as Error).message });
    throw e;
  }
  return emailId;
}
