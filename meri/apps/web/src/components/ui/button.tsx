import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "@/lib/cn";

/** ADR 0002: shadcn/ui convention, tokens from docs/11 (demo .btn). */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-[9px] border font-semibold leading-tight transition-colors disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "border-rule bg-raised text-ink hover:border-ink3",
        primary: "border-sea bg-sea text-on-sea hover:brightness-110",
        quiet: "border-transparent bg-transparent text-ink2 hover:bg-sea-soft hover:text-ink",
        risk: "border-risk bg-raised text-risk",
      },
      size: {
        default: "px-3.5 py-2 text-[13.5px]",
        sm: "rounded-lg px-2.5 py-1.5 text-[12.5px]",
        block: "w-full rounded-xl px-3.5 py-3 text-[15px]",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : (type ?? "button")}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
