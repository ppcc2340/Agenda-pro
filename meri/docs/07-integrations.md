# 07 — Integraciones

## Interfaz común (`packages/integrations/src/types.ts`)
Cada conector implementa: `connect`, `disconnect`, `healthCheck`, `sync(cursor)`, `normalize(raw)` → entidades de dominio; errores tipados (`AuthExpired`, `RateLimited`, `Transient`, `Permanent`).

## MVP: Google
### Gmail
- OAuth con `access_type=offline`, `prompt=consent` (primera vez).
- Sync: `users.history.list` desde `historyId`; carga inicial limitada (últimos 30 días, configurable).
- Notificaciones push vía Pub/Sub (`users.watch`) + polling de respaldo cada 5 min; renovar `watch` cada < 7 días.
- Lectura: `users.messages.get` formato `metadata` + `full` solo para mensajes que pasan el prefiltro; no persistir el cuerpo.
- Borradores: `users.drafts.create` con `In-Reply-To`/`References` correctos.
- Cuotas: respetar límites; backoff exponencial con jitter; colas con concurrencia limitada por cuenta.

### Google Calendar
- `events.list` con `syncToken`; si `410 Gone` → resincronización completa.
- `events.watch` (canales con expiración; renovar) + polling de respaldo.
- Escritura: crear/actualizar/borrar **solo** eventos creados por Meri (marcados con `extendedProperties.private.meri=1`).
- Idempotencia: `iCalUID` + `etag`; manejar `412 Precondition Failed`.
- Zonas horarias y eventos recurrentes (expandir con `singleEvents=true` dentro de la ventana).

## Stripe
Checkout, Customer Portal, webhooks (`checkout.session.completed`, `customer.subscription.*`, `invoice.*`) con verificación de firma e idempotencia por `event.id`.

## Post-MVP (orden sugerido)
1. Microsoft Graph (Outlook correo + calendario), mismo contrato que Google.
2. Notion (páginas/bases autorizadas).
3. Slack/Teams.
4. CRM (HubSpot, luego Salesforce).
5. QuickBooks/Xero (exportación de tiempo).
6. Automatizadores (Make/Zapier/n8n) vía API pública y webhooks.

## Resiliencia
Estados de conexión visibles (`healthy`, `needs_reauth`, `degraded`). Un fallo de un conector nunca bloquea el resto del producto. Panel interno de salud de sincronización.

## Adaptadores *fake*
Cada conector tiene un `Fake*` para tests y desarrollo sin credenciales (`packages/integrations/src/fakes/`).
