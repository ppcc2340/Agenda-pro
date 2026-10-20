"use client";

import { cn } from "@/lib/cn";

/**
 * Segmented control: a labelled group of toggle buttons (`aria-pressed`), one pressed at a time. Used for view
 * filters such as the billing interval or the report period (UX review: not a radio group without arrow keys).
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("inline-flex rounded-xl border border-rule p-1", className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-lg px-3 py-1.5 text-[13px] font-semibold",
            value === o.value ? "bg-sea text-on-sea" : "text-ink2",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
