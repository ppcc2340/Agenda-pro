/**
 * Especificación OpenAPI 3.1 generada a partir de los routers montados y de los esquemas zod que valida la API.
 * Se publica en /api/v1/openapi.json y se puede leer en /api/docs.
 */
import type { Router } from "express";
import { z, type ZodTypeAny } from "zod";
import { contactSchema } from "./services/contacts.js";
import { companySchema } from "./services/companies.js";
import { dealSchema } from "./services/deals.js";
import { ticketSchema } from "./services/tickets.js";
import { taskSchema } from "./services/tasks.js";
import { contractSchema } from "./services/clm.js";

type Json = Record<string, unknown>;
/** JSON Schema de un esquema zod (conversión nativa de zod 4; lo no representable se deja abierto). */
export function zodToJson(s: ZodTypeAny): Json {
  const out = z.toJSONSchema(s, { unrepresentable: "any", io: "input" }) as Json;
  delete out.$schema;
  return out;
}

const OBJECTS: Record<string, { schema: z.ZodObject; name: string; label: string }> = {
  "/contacts": { schema: contactSchema, name: "Contact", label: "Contactos" },
  "/companies": { schema: companySchema, name: "Company", label: "Empresas" },
  "/deals": { schema: dealSchema, name: "Deal", label: "Negocios" },
  "/tickets": { schema: ticketSchema, name: "Ticket", label: "Tickets" },
  "/tasks": { schema: taskSchema, name: "Task", label: "Tareas" },
  "/clm": { schema: contractSchema, name: "Contract", label: "Contratos (CLM)" },
};
const TAGS: Record<string, string> = { "/analytics": "Analítica", "/pipelines": "Pipelines", "/activities": "Actividades", "/products": "Productos", "/quotes": "Presupuestos", "/admin": "Administración", "/workflows": "Automatizaciones", "/forms": "Formularios", "/reports": "Informes", "/columns": "Columnas", "/cells": "Celdas", "": "General" };
const VERB: Record<string, string> = { get: "Leer", post: "Crear / ejecutar", put: "Actualizar", patch: "Actualizar parcialmente", delete: "Borrar" };

export function buildOpenApi(mounts: [string, Router][], version: string): Json {
  const paths: Record<string, Json> = {};
  for (const [prefix, router] of mounts) {
    const tag = OBJECTS[prefix]?.label ?? TAGS[prefix] ?? prefix.replace("/", "");
    for (const layer of (router as unknown as { stack: { route?: { path: string; methods: Record<string, boolean> } }[] }).stack) {
      if (!layer.route || typeof layer.route.path !== "string") continue;
      const p = `${prefix}${layer.route.path === "/" ? "" : layer.route.path}`.replace(/:([a-zA-Z_]+)/g, "{$1}") || "/";
      const params = Array.from(p.matchAll(/\{([a-zA-Z_]+)\}/g)).map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
      for (const m of Object.keys(layer.route.methods)) {
        const obj = OBJECTS[prefix];
        const isList = m === "get" && layer.route.path === "/" && obj;
        const isBody = ["post", "put", "patch"].includes(m);
        const op: Json = { tags: [tag], summary: `${VERB[m] ?? m.toUpperCase()} ${p}`, operationId: `${m}_${p.replace(/[{}]/g, "").replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "")}`, parameters: [...params, ...(isList ? [
          { name: "q", in: "query", schema: { type: "string" }, description: "Búsqueda de texto" },
          { name: "filters", in: "query", schema: { type: "string" }, description: 'JSON {"logic":"and","conditions":[{"field","op","value"}]}' },
          { name: "sort", in: "query", schema: { type: "string" } }, { name: "dir", in: "query", schema: { type: "string", enum: ["asc", "desc"] } },
          { name: "limit", in: "query", schema: { type: "integer", maximum: 500 } }, { name: "cursor", in: "query", schema: { type: "string" }, description: "next_cursor de la respuesta anterior" },
        ] : []), ...(["put", "patch", "delete"].includes(m) && params.length && obj ? [{ name: "If-Match", in: "header", schema: { type: "string" }, description: "ETag recibido en el GET; si el registro cambió responde 412" }] : [])],
          responses: { 200: { description: "OK" }, 400: { description: "Datos no válidos" }, 401: { description: "Sin autenticar" }, 403: { description: "Sin permiso" }, 404: { description: "No existe" }, ...(m !== "get" && obj ? { 409: { description: "Conflicto (duplicado, estado)" }, 412: { description: "If-Match no coincide" } } : {}) } };
        if (isBody && obj && (layer.route.path === "/" || layer.route.path === "/:id" || layer.route.path === "/contracts" || layer.route.path === "/contracts/:id")) op.requestBody = { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${obj.name}${m === "post" ? "" : "Patch"}` } } } };
        (paths[p] ??= {})[m] = op;
      }
    }
  }
  const schemas: Json = {};
  for (const o of Object.values(OBJECTS)) { schemas[o.name] = zodToJson(o.schema); schemas[`${o.name}Patch`] = zodToJson(o.schema.partial()); }
  schemas.CellChange = { type: "object", required: ["id", "column_id"], properties: { id: { type: "string" }, column_id: { type: "string", description: "campo o custom.<clave>" }, value: {} } };
  return {
    openapi: "3.1.0",
    info: { title: "CRM interno · API", version, description: "API REST del CRM. Autenticación con cookie de sesión (navegador) o `Authorization: Bearer <API key>` (Ajustes → API). Todas las rutas están también bajo /api/v1. Listas: paginación por cursor (`limit` + `cursor` → `next_cursor`). Concurrencia: el GET devuelve `ETag`; envía `If-Match` en PUT/PATCH/DELETE para evitar sobrescrituras (412). Webhooks salientes firmados con `x-crm-signature: sha256=HMAC(secret, body)`." },
    servers: [{ url: "/api/v1" }],
    components: { securitySchemes: { apiKey: { type: "http", scheme: "bearer" }, session: { type: "apiKey", in: "cookie", name: "crm_session" } }, schemas },
    security: [{ apiKey: [] }, { session: [] }],
    paths,
  };
}

/** Lector ligero de la especificación (sin dependencias externas, compatible con la CSP). */
export const DOCS_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>API del CRM</title>
<link rel="stylesheet" href="/api/docs.css"></head><body><main id="app"><p>Cargando…</p></main><script src="/api/docs.js"></script></body></html>`;
export const DOCS_CSS = `body{font:14px/1.5 system-ui,sans-serif;margin:0;background:#f6f7fb;color:#323338}main{max-width:980px;margin:0 auto;padding:24px 16px}h1{margin:0 0 4px}h2{margin:28px 0 8px;font-size:18px}.op{background:#fff;border-radius:8px;margin:6px 0;box-shadow:0 1px 3px rgba(0,0,0,.08)}.op summary{cursor:pointer;padding:8px 12px;display:flex;gap:10px;align-items:center}.m{font:700 11px ui-monospace,monospace;color:#fff;border-radius:4px;padding:2px 6px;min-width:52px;text-align:center}.get{background:#0073ea}.post{background:#00c875}.put,.patch{background:#fdab3d}.delete{background:#e2445c}code,pre{font-family:ui-monospace,monospace;font-size:12.5px}pre{background:#f0f2f8;padding:10px;border-radius:6px;overflow:auto;margin:0 12px 12px}.desc{color:#676879}input{width:100%;padding:8px;border:1px solid #c3c6d4;border-radius:6px;margin:8px 0;box-sizing:border-box}@media (prefers-color-scheme:dark){body{background:#181b34;color:#d5d8df}.op{background:#24284a}pre{background:#30355b}.desc{color:#9699a6}input{background:#24284a;color:#d5d8df;border-color:#4b4e69}}`;
export const DOCS_JS = `fetch('/api/v1/openapi.json').then(r=>r.json()).then(s=>{const e=(t)=>String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));const by={};for(const[p,ops]of Object.entries(s.paths))for(const[m,o]of Object.entries(ops))(by[o.tags[0]]??=[]).push([m,p,o]);const app=document.getElementById('app');const draw=(q)=>{app.innerHTML='<h1>'+e(s.info.title)+' <small>v'+e(s.info.version)+'</small></h1><p class="desc">'+e(s.info.description)+'</p><p><a href="/api/v1/openapi.json">openapi.json</a> · '+Object.values(s.paths).reduce((n,o)=>n+Object.keys(o).length,0)+' operaciones</p><input id="q" placeholder="Filtrar rutas…" value="'+e(q)+'">'+Object.entries(by).map(([t,l])=>{const f=l.filter(([m,p])=>!q||(m+' '+p).toLowerCase().includes(q.toLowerCase()));return f.length?'<h2>'+e(t)+'</h2>'+f.map(([m,p,o])=>'<details class="op"><summary><span class="m '+m+'">'+m.toUpperCase()+'</span><code>'+e(p)+'</code></summary>'+(o.parameters&&o.parameters.length?'<pre>'+e(o.parameters.map(x=>x.in+' '+x.name+(x.description?' — '+x.description:'')).join('\\n'))+'</pre>':'')+(o.requestBody?'<pre>'+e(JSON.stringify(s.components.schemas[o.requestBody.content['application/json'].schema.$ref.split('/').pop()],null,2))+'</pre>':'')+'</details>').join(''):''}).join('');const i=document.getElementById('q');i.oninput=()=>{const v=i.value;draw(v);const j=document.getElementById('q');j.focus();j.setSelectionRange(v.length,v.length)}};draw('')});`;
