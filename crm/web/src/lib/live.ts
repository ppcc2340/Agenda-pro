/** Cambios en vivo (Server-Sent Events): una conexión por pestaña compartida por todos los tableros. */
export interface LiveEvent { type: string; object: string; id: string | null; actor: string | null }
type Fn = (e: LiveEvent) => void;
const subs = new Set<Fn>();
let es: EventSource | null = null;
function ensure() {
  if (es || typeof EventSource === "undefined") return;
  es = new EventSource("/api/events", { withCredentials: true });
  es.addEventListener("change", (m) => { try { const e = JSON.parse((m as MessageEvent).data) as LiveEvent; subs.forEach((f) => f(e)); } catch { /* ignorar */ } });
  es.onerror = () => { if (es && es.readyState === EventSource.CLOSED) { es = null; setTimeout(() => subs.size && ensure(), 5000); } };
}
/** Suscribe una función; devuelve la baja. */
export function onLive(fn: Fn): () => void {
  subs.add(fn); ensure();
  return () => { subs.delete(fn); if (!subs.size && es) { es.close(); es = null; } };
}
