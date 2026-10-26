/**
 * Cambios en vivo por Server-Sent Events (GET /api/events): cada evento de dominio se avisa a las sesiones
 * abiertas del mismo espacio de trabajo con {type, object, id}. El cliente vuelve a pedir los datos con sus
 * permisos, así que el canal no expone contenido. Sustituye a los sondeos periódicos del navegador.
 */
import type { Response, Router } from "express";
import { Router as makeRouter } from "express";
import { onEvent } from "./services/events.js";

const clients = new Map<string, Set<Response>>();
let wired = false;
let seq = 0;

export function publish(ws: string, data: Record<string, unknown>) {
  const set = clients.get(ws); if (!set?.size) return;
  const payload = `id: ${++seq}\nevent: change\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) { try { res.write(payload); } catch { set.delete(res); } }
}
export function liveClients(ws?: string) { return ws ? clients.get(ws)?.size ?? 0 : Array.from(clients.values()).reduce((n, s) => n + s.size, 0); }

export function liveRoutes(): Router {
  if (!wired) { wired = true; onEvent((ctx, ev) => publish(ctx.ws, { type: ev.type, object: ev.object, id: (ev.record as { id?: unknown })?.id ?? null, actor: ev.meta?.actor ?? null })); }
  const r = makeRouter();
  r.get("/events", (req, res) => {
    const ws = (req as unknown as { ctx: { ws: string; user: { id: string } } }).ctx.ws;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write(`retry: 5000\nevent: ready\ndata: {}\n\n`);
    if (!clients.has(ws)) clients.set(ws, new Set());
    clients.get(ws)!.add(res);
    const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch { /* cerrada */ } }, 25000);
    req.on("close", () => { clearInterval(ping); clients.get(ws)?.delete(res); });
  });
  return r;
}
