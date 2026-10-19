# 0005. Clientes, tiempo inferido y briefings: ampliación del contrato

- Estado: aceptada
- Fecha: 2026-10-19

## Contexto
La fase 3 (F-09, F-10, F-11) necesita rutas y colas que `docs/13` no recogía: asuntos, búsqueda, edición y filtros de tiempo, briefing por lectura, acuerdos post-reunión y tres jobs programados. Además la propuesta `client_link` (D-040) y los compromisos nacidos de una reunión (D-044) no encajaban en los contratos de confirmación de la fase 2, que presuponían un hilo de correo. El plan de la fase (`phases/03-clients-time-briefings/PLAN.md`) recoge la revisión que motivó estos cambios.

## Decisión
1. **Rutas nuevas** (`docs/13`): `GET /v1/clients/:id`, `GET/POST /v1/projects`, `PATCH /v1/projects/:id` (`name|kind|archived`), `GET /v1/search?q=&clientId=`, `PATCH /v1/time-entries/:id` (`minutes`, `clientId`), `GET /v1/time-entries?week=&clientId=&status=all`, `GET /v1/clients/:id/briefing`, `POST /v1/events/:id/agreements`, filtro `clientId` en `GET /v1/calendar/events`, `PATCH /v1/calendar/events/:id { clientId }` (solo eventos externos, auditado). No existe `POST /v1/time-entries` manual en el MVP (el tiempo nace de fuentes y se corrige con `PATCH`). Todas las creaciones aceptan `Idempotency-Key`.
2. **Propuestas**: `client_link` (payload `{ domain, suggestedName, contacts, threads }`, hash `client_link:<dominio>` en cualquier estado) se confirma con `POST /v1/proposals/:id/confirm { client?: { name?, color? } }` → `{ client }`; aplica `max_clients`. `followup` confirmada sin cuerpo crea la tarea «Esperando a …» (`task.waiting_created`). Los compromisos de evento llevan `threadId/externalThreadId/externalMessageId = null`, `eventId` y `dedupe_hash = sha256('event:' + eventId + ':' + direction + ':' + acción)`; `confirm-batch` los omite salvo `explicit`. La respuesta de `confirm` pasa a `{ task, commitment, client }`.
3. **Borrado de clientes**: `DELETE /v1/clients/:id` es solo lógico; ningún elemento se desvincula (histórico y tiempo aprobado intactos). Al crear o ampliar dominios se vinculan contactos, hilos y eventos externos sin cliente que pertenecen a esos dominios (nunca si también implican a otro cliente).
4. **Colas nuevas** (`QUEUE_NAMES`, `definitions.ts`, dispatcher D-025 con contexto admin de lectura): `clients.scan { date }` (diario por workspace con contactos sin cliente), `time.infer { date }` (diario y al completar bloque/tarea), `briefings.prepare { date }` (diario: notificación `briefing.suggested` un día antes de una reunión con cliente, sin IA). `ai.brief_client` se ejecuta solo bajo demanda del usuario.
5. **Deshacer**: `time.approved` entra en `UNDOABLE_ACTIONS` (compensación `status → suggested`, `approved_at → null`).
6. **Esquema `Briefing`** (AI-4): `{ items: [{ claim, kind, sourceType, sourceId }] }` con `kind ∈ pending|commitment|communication|decision|risk`, `sourceType ∈ task|commitment|thread|event`, ≤ 30 items, `claim ≤ 300`; sustituye al borrador de la fase 2 (sin `document`). Las `url` las construye el código.
7. **Vertical**: `preferences.vertical` es la fuente de verdad; `workspaces.vertical` queda obsoleto y `GET /v1/me` devuelve el de preferencias.

## Consecuencias
- Migración `0014` (y siguientes de la fase) con índices por cliente en `time_entries`, `calendar_events` y `threads_index`.
- `routes/proposals.ts` se separa de `routes/capture.ts`; `gmailThreadUrl` vive solo en `@meri/core`.
- El CSV de tiempo (D-046) documenta el paso de importación en Excel es-ES.
