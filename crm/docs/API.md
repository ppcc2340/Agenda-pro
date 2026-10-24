# API REST

Base: `http(s)://<host>/api/v1/` (alias de `/api/`). Todas las respuestas son JSON.

## Autenticación

- **Sesión** (la usa la web): cookie `crm_session` tras `POST /api/auth/login`.
- **API key** (integraciones): cabecera `Authorization: Bearer crm_…`. Se crean en Ajustes → API keys con permisos `read` o `read,write`. Las peticiones heredan el rol y visibilidad del usuario que creó la clave.

Errores: `{"error": "mensaje", "details": …}` con códigos 400 (validación), 401, 403, 404, 409 (duplicado), 429 (límite).

## Listados

`GET /contacts`, `/companies`, `/deals`, `/tickets` aceptan:

| Parámetro | Descripción |
|---|---|
| `q` | búsqueda de texto |
| `filters` | JSON `{"logic":"and"|"or","conditions":[{"field","op","value"}]}`. Operadores: `eq neq contains not_contains starts gt gte lt lte empty not_empty in not_in last_days next_days before after today is_true is_false`. Campos personalizados: `custom.<clave>`. |
| `sort`, `dir` | campo y `asc`/`desc` |
| `page`, `page_size` | paginación (máx. 500) |

Respuesta: `{ items, total, page, page_size }`. Los metadatos de campos filtrables están en `GET /filter-meta`.

## Objetos

| Recurso | Endpoints principales |
|---|---|
| Contactos | `GET/POST /contacts`, `GET/PUT/PATCH/DELETE /contacts/:id`, `/contacts/:id/timeline`, `/history`, `POST /contacts/:id/convert`, `/anonymize`, `GET /contacts/:id/gdpr-export`, `GET /contacts/export` (CSV), `GET /contacts/duplicates`, `POST /contacts/merge`, `POST /contacts/bulk`, `POST /contacts/:id/restore`. `POST` devuelve 409 con `details.duplicates` si hay posible duplicado; añade `?force=1` para crear igualmente. Campo `company_name` crea/vincula la empresa. |
| Empresas | `GET/POST /companies`, `GET/PUT/DELETE /companies/:id`, `/timeline`, `/history`, `/tree`, `/export`, `/bulk` |
| Negocios | `GET/POST /deals`, `GET/PUT/DELETE /deals/:id`, `POST /deals/:id/stage {stage_id}`, `POST /deals/:id/close {status: won|lost, loss_reason, competitor, note}`, `POST /deals/:id/reopen`, `PUT /deals/:id/products [líneas]`, `GET /deals/board/:pipelineId`, `GET /deals/forecast`, `/export` |
| Pipelines | `GET /pipelines`, `POST /pipelines`, `PUT /pipelines/:id`, `POST /pipelines/:id/stages`, `PUT /pipelines/:id/stages/:sid`, `PUT /pipelines/:id/stages-order` |
| Tareas | `GET /tasks?status=open|overdue|done&assignee_id&deal_id&contact_id`, `POST /tasks`, `PUT /tasks/:id`, `POST /tasks/:id/complete {outcome, note}`, `/reopen`, `GET /tasks/my-day` |
| Actividades | `POST /activities {type: note|call|meeting|email|…, subject, body, contact_id|company_id|deal_id|ticket_id, direction, outcome, duration_min, occurred_at}`, `PUT/DELETE /activities/:id`, `POST /activities/send-email {contact_id, subject, body}` |
| Tickets | `GET/POST /tickets`, `GET/PUT/DELETE /tickets/:id`, `POST /tickets/:id/reply {body, internal}`, `/timeline` |
| Productos y presupuestos | `GET/POST/PUT /products`, `GET/POST /quotes`, `GET /quotes/:id`, `POST /quotes/:id/send {to}`, `POST /quotes/:id/status {status}` |
| Listas | `GET/POST/PUT/DELETE /lists`, `GET /lists/:id/members`, `POST /lists/:id/members {ids}` |
| Vistas guardadas | `GET/POST/PUT/DELETE /views` |
| Plantillas | `GET/POST/PUT/DELETE /email-templates` |
| Workflows | `GET/POST/PUT/DELETE /workflows`, `GET /workflows/:id/runs`, `POST /workflows/simulate`, `POST /workflows/:id/run`, `GET /workflows/meta` |
| Formularios | `GET/POST/PUT/DELETE /forms`, `GET /forms/:id/submissions`. Público: `GET /f/:slug` (página), `GET /f/:slug.json`, `POST /f/:slug` (envío), `/embed.js?` script `data-form="slug"` |
| Importación | `POST /import {object, mapping, rows, dedupe: skip|update|create, owner_id, tags, dry_run}`, `GET /imports`, `POST /imports/:id/revert` |
| Búsqueda / notificaciones | `GET /search?q=`, `GET /notifications`, `POST /notifications/read` |
| Informes | `GET /reports/dashboard|pipeline|sales|funnel|activity|leads|emails|tickets|data-quality?from&to&owner_id&team_id` |
| Administración (admin) | `/admin/users`, `/admin/roles`, `/admin/teams`, `/admin/custom-fields`, `/admin/settings`, `/admin/api-keys`, `/admin/webhooks` (+ `/deliveries`), `/admin/audit`, `/admin/scoring-rules`, `/admin/recycle-bin`, `/admin/outbox`, `/admin/usage`, `/admin/gdpr-requests` |

## Webhooks salientes

Se configuran en Ajustes → Webhooks con la lista de eventos (`*`, `contact.created`, `deal.stage_changed`, `deal.won`, `form.submitted`, `quote.accepted`, …). Cada entrega es un `POST` JSON:

```json
{ "id": "…", "event": "deal.won", "object": "deal", "occurred_at": "…", "data": { …registro… }, "changes": { "campo": [antes, después] }, "meta": {} }
```

Cabeceras: `X-CRM-Event`, `X-CRM-Delivery`, `X-CRM-Signature: sha256=<HMAC-SHA256 hex del cuerpo con el secreto>`. Reintentos automáticos ante fallo (1 min, 5 min, 30 min, 2 h, 12 h). Historial y reintento manual en la misma pantalla.

## Webhook entrante

Un workflow con disparador «Webhook externo recibido» expone `POST /hooks/<workflow_id>` con cuerpo `{"object":"contact","record_id":"…", …}`; el resto del cuerpo queda disponible en `meta`.

## Ejemplo completo

```bash
KEY=crm_xxx; H="Authorization: Bearer $KEY"; J="content-type: application/json"
# 1. crear contacto + empresa
curl -s -X POST -H "$H" -H "$J" localhost:3000/api/v1/contacts -d '{"first_name":"Ana","last_name":"Pérez","email":"ana@acme.com","company_name":"Acme","source":"api"}'
# 2. crear negocio vinculado
curl -s -X POST -H "$H" -H "$J" localhost:3000/api/v1/deals -d '{"name":"Acme · Licencias","amount":9000,"company_id":"<company_id>","contact_ids":["<contact_id>"],"expected_close_date":"2027-01-31"}'
# 3. registrar una llamada
curl -s -X POST -H "$H" -H "$J" localhost:3000/api/v1/activities -d '{"type":"call","subject":"Primera llamada","direction":"outbound","outcome":"Contactado","contact_id":"<contact_id>","deal_id":"<deal_id>"}'
# 4. mover de etapa
curl -s -X POST -H "$H" -H "$J" localhost:3000/api/v1/deals/<deal_id>/stage -d '{"stage_id":"<stage_id>"}'
```
