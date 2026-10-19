import type * as React from "react";
import { cn } from "@/lib/cn";

export function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mt-6", className)}>
      <h2 className="mb-2.5 text-lg">{title}</h2>
      {children}
    </section>
  );
}

export function Panel({
  title,
  desc,
  children,
  className,
}: {
  title: string;
  desc?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-4 border-b border-rule py-4 md:grid-cols-[240px_1fr] md:gap-6", className)}>
      <div>
        <h3 className="text-base">{title}</h3>
        {desc ? <p className="mt-1 text-[13.5px] text-ink2">{desc}</p> : null}
      </div>
      <div>{children}</div>
    </div>
  );
}
