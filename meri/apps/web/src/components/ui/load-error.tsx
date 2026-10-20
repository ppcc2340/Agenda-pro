"use client";

import { useTranslations } from "next-intl";
import { Button } from "./button";

/** A section that failed to load: what happened and a way to try again (never a dead end). */
export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const tApp = useTranslations("app");
  return (
    <p role="alert" className="flex flex-wrap items-center gap-3 text-risk">
      {message}
      <Button size="sm" onClick={onRetry}>
        {tApp("retry")}
      </Button>
    </p>
  );
}
