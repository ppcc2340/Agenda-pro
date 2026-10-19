import { clientColorVar } from "@/lib/plan";

/** Client name with its colour (docs/11: each client keeps its colour across the whole UI). */
export function ClientChip({
  clientId,
  clients,
  name,
}: {
  clientId: string | null;
  clients: { id: string; name: string }[];
  /** Fallback label when the client is not in the list (e.g. payload `clientName`). */
  name?: string | null;
}) {
  const client = clients.find((c) => c.id === clientId);
  const label = client?.name ?? name ?? null;
  if (!label) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <i
        aria-hidden="true"
        className="inline-block h-2 w-2 rounded-full"
        style={{ background: clientColorVar(client ? clientId : null, clients) }}
      />
      {label}
    </span>
  );
}
