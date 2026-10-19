import type * as React from "react";

/** Empty states invite to act (docs/11 "Texto de interfaz"). */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="max-w-[52ch] py-8 text-ink2">
      <h3 className="mb-1 text-lg text-ink">{title}</h3>
      {body ? <p>{body}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
