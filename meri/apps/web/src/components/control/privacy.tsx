"use client";

import { Download, Trash2 } from "lucide-react";
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
 * signs out after the logical deletion (D-054). In DEMO_MODE nothing is deleted (D-049).
 */
export function PrivacyPanel({ demoMode }: { demoMode: boolean }) {
  const t = useTranslations("control.privacy");
  const { toast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const remove = useApiMutation(() => clientApi<null>("/v1/account", { method: "DELETE" }), [], {
    onSuccess: async () => {
      toast(t("deleted"));
      await signOutAction();
    },
  });
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <a href="/api/v1/account/export" download onClick={() => toast(t("exportedToast"))}>
            <Download size={14} aria-hidden="true" />
            {t("export")}
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
            <span className="sr-only">{t("confirmBody")}</span>
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
