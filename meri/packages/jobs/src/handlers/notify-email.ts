/**
 * notify.email (D-113..D-116): sends the email copy of one in-app notification. Decides inside the workspace
 * transaction (preference, owner, demo, deleted), sends after it, and records the outcome once. A permanent SMTP
 * rejection is recorded as `failed` and never retried; anything else is thrown so the queue retries.
 */
import { DEMO_USER } from "@meri/config";
import { signUnsubscribeToken } from "@meri/config/crypto";
import { emailAllowed, renderNotificationEmail, type EmailLocale } from "@meri/core";
import {
  getNotificationForEmail,
  getPreferences,
  markNotificationEmail,
  withWorkspace,
  workspaceEmailRecipient,
  type WorkspaceId,
} from "@meri/db";
import { IntegrationError } from "@meri/integrations";
import type { HandlerDeps } from "./context";

/** An email that could not go out within a day is no longer worth sending: the person has seen Meri since. */
export const EMAIL_MAX_AGE_MS = 24 * 3_600_000;
/**
 * After this age a retryable failure (SMTP down, credentials rejected) is recorded as `failed`: just before the
 * dispatcher's 2 h window closes, so an outage never leaves rows that are picked up forever.
 */
export const EMAIL_GIVE_UP_MS = 100 * 60_000;

export interface NotifyEmailDeps extends HandlerDeps {
  /** Public origin of the web app (links and unsubscribe). */
  appUrl: string;
  /** Key material for unsubscribe tokens (HKDF inside `signUnsubscribeToken`). */
  authSecret: string;
}

export type NotifyEmailResult =
  | { status: "sent" | "failed" }
  | { status: "skipped"; reason: "preference" | "no_recipient" | "demo" | "stale" }
  | { status: "done" };

export async function runNotifyEmail(
  deps: NotifyEmailDeps,
  workspaceId: WorkspaceId,
  input: { notificationId: string },
): Promise<NotifyEmailResult> {
  const now = deps.now();
  const decision = await withWorkspace(deps.db, workspaceId, async (tx) => {
    const n = await getNotificationForEmail(tx, workspaceId, input.notificationId);
    if (!n || n.emailState) return { status: "done" as const };
    const skip = async (reason: "preference" | "no_recipient" | "demo" | "stale") => {
      await markNotificationEmail(tx, workspaceId, n.id, "skipped", now);
      return { status: "skipped" as const, reason };
    };
    if (now.getTime() - n.createdAt.getTime() > EMAIL_MAX_AGE_MS) return skip("stale");
    const prefs = await getPreferences(tx, workspaceId);
    if (!prefs || !emailAllowed(prefs.emailNotifications, n.kind, n.template)) return skip("preference");
    const to = await workspaceEmailRecipient(tx, workspaceId);
    if (!to) return skip("no_recipient");
    if (to.email === DEMO_USER.email) return skip("demo");
    return { status: "send" as const, notification: n, to };
  });
  if (decision.status !== "send") return decision;

  const base = deps.appUrl.replace(/\/+$/, "");
  const token = encodeURIComponent(signUnsubscribeToken(deps.authSecret, workspaceId));
  const locale: EmailLocale = decision.to.locale === "en" ? "en" : "es";
  const rendered = renderNotificationEmail({
    kind: decision.notification.kind,
    template: decision.notification.template,
    params: decision.notification.params,
    locale,
    appUrl: base,
    unsubscribePageUrl: `${base}/correo/baja?t=${token}`,
  });
  try {
    await deps.integrations.notifier.send({
      to: decision.to.email,
      ...rendered,
      unsubscribeUrl: `${base}/api/v1/email/unsubscribe?t=${token}`,
      reference: decision.notification.id,
    });
  } catch (e) {
    const givingUp = now.getTime() - decision.notification.createdAt.getTime() > EMAIL_GIVE_UP_MS;
    if (e instanceof IntegrationError && (!e.retryable || givingUp)) {
      // Never log the address or the provider's text (it may quote it): kind and notification id only.
      deps.logger.warn(
        { notificationId: decision.notification.id, kind: e.kind },
        e.retryable ? "email not sent before the window closed" : "email rejected permanently",
      );
      await withWorkspace(deps.db, workspaceId, (tx) =>
        markNotificationEmail(tx, workspaceId, decision.notification.id, "failed", now),
      );
      return { status: "failed" };
    }
    // Our side (credentials, sender, connection): loud, so a broken SMTP configuration is noticed (review M2).
    if (e instanceof IntegrationError)
      deps.logger.error(
        { notificationId: decision.notification.id, kind: e.kind, err: e.message },
        "email not sent",
      );
    throw e;
  }
  await withWorkspace(deps.db, workspaceId, (tx) =>
    markNotificationEmail(tx, workspaceId, decision.notification.id, "sent", now),
  );
  return { status: "sent" };
}
