"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import type * as React from "react";
import { cn } from "@/lib/cn";

/** ADR 0002: Radix dialog with the demo's .dlg look. */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;

export function DialogContent({
  title,
  description,
  children,
  className,
  footer,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  footer?: React.ReactNode;
}) {
  const t = useTranslations("app");
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[rgba(6,14,21,0.55)]" />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-[12vh] z-50 max-h-[78vh] w-[min(680px,92vw)] -translate-x-1/2 overflow-auto rounded-2xl border border-rule bg-raised shadow-2xl focus:outline-none",
          className,
        )}
      >
        <header className="px-5 pb-1.5 pt-4">
          <DialogPrimitive.Title className="font-head text-xl font-semibold">{title}</DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="mt-1 text-ink2">
              {description}
            </DialogPrimitive.Description>
          ) : null}
        </header>
        <div className="px-5 py-2">{children}</div>
        {footer ? (
          <footer className="flex items-center justify-end gap-2 px-5 pb-4 pt-3">{footer}</footer>
        ) : null}
        <DialogPrimitive.Close
          className="absolute right-3 top-3 rounded-md p-1 text-ink3 hover:bg-panel"
          aria-label={t("dialogClose")}
        >
          <X size={16} aria-hidden="true" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
