import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/cn";

/** "Sólido es confirmado, punteado es sugerido" (docs/11): the `sug` variant is always dashed. */
const pillVariants = cva("inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold", {
  variants: {
    variant: {
      sea: "bg-sea-soft text-sea",
      risk: "bg-risk-soft text-risk",
      sug: "border border-dashed border-sug bg-sug-soft text-sug",
      ok: "bg-ok-soft text-ok",
      plain: "border border-rule bg-transparent text-ink2",
    },
  },
  defaultVariants: { variant: "sea" },
});

export function Pill({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof pillVariants>) {
  return <span className={cn(pillVariants({ variant }), className)} {...props} />;
}
