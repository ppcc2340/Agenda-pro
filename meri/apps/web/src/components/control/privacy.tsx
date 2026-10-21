"use client";

import { Download, LogOut, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { signOutAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { clientApi } from "@/lib/client-api";
import { useApiMutation } from "@/lib/hooks/use-api";

/**
 * «Privacidad» (demo): export downloads the JSON through the API rewrite (D-050); delete asks for confirmation and
 * signs out after the logical deletion (D-054). In DEMO_MODE nothing is deleted (D-049). «Sign out on all
 * devices» ends every session, this one included (ADR 0007).
 */
export function PrivacyPanel({ demoMode }: { demoMode: boolean }) {
  const t = useTranslations("control.privacy");
  const tApp = useTranslations("app");
  const { toast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const remove = useApiMutation(() => clientApi<null>("/v1/account", { method: "DELETE" }), [], {
    onError: () => toast(tApp("errorBody")),
    onSuccess: async () => {
      toast(t("deleted"));
      await signOutAction();
    },
  });
  // Not a useApiMutation: its router.refresh() would re-render this page with a session the API now refuses.
  const [revoking, setRevoking] = useState(false);
  const revokeEverywhere = async () => {
    setRevoking(true);
    try {
      await clientApi<null>("/v1/account/sessions/revoke", { method: "POST" });
      toast(t("signedOutEverywhere"));
      // This session is already refused by the API; the route handler clears the cookie and goes to /login.
      window.location.assign("/api/session/expired");
    } catch {
      toast(tApp("errorBody"));
      setRevoking(false);
    }
  };
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <a href="/api/v1/account/export" download onClick={() => toast(t("exportedToast"))}>
            <Download size={14} aria-hidden="true" />
            {t("export")}
          </a>
        </Button>
        <Button asChild>
          <a href="/api/v1/account/export?format=zip" download onClick={() => toast(t("exportedToast"))}>
            <Download size={14} aria-hidden="true" />
            {t("exportZip")}
          </a>
        </Button>
        <Button
          variant="risk"
          onClick={() => {
            if (demoMode) toast(t("demoDelete"));
            else setConfirm(true);
          }}
        >
          <Trash2 size={14} aria-hidden="true" />
          {t("delete")}
        </Button>
        <Button variant="quiet" disabled={revoking} onClick={() => void revokeEverywhere()}>
          <LogOut size={14} aria-hidden="true" />
          {t("signOutEverywhere")}
        </Button>
      </div>
      <p className="mt-2 max-w-[60ch] text-[12.5px] text-ink3">{t("body")}</p>
      <Dialog open={confirm} onOpenChange={setConfirm}>
        {confirm ? (
          <DialogContent
            title={t("confirmTitle")}
            description={t("confirmBody")}
            footer={
              <>
                <Button variant="quiet" onClick={() => setConfirm(false)}>
                  {t("cancel")}
                </Button>
                <Button variant="risk" disabled={remove.isPending} onClick={() => remove.mutate(undefined)}>
                  {t("delete")}
                </Button>
              </>
            }
          >
            {null}
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
