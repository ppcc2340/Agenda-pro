# 13 — Contrato de API y jobs

Fuente para que backend y frontend se construyan en paralelo. El OpenAPI generado (`apps/api`) debe coincidir con este documento; si hay que cambiarlo, se registra un ADR.

## Convenciones
- Base `/v1`. JSON. Fechas ISO 8601 UTC. Ids UUID.
- Sesión por cookie `HttpOnly`. Todas las rutas requieren sesión salvo `/health` y webhooks.
- El workspace se resuelve de la sesión, nunca del cuerpo.
- Errores `application/problem+json`: `{ type, title, status, code, detail, traceId }`.
- Listas con cursor: `?cursor=&limit=` → `{ items, nextCursor }`.
- `Idempotency-Key` en `POST` que crean, cobran o aplican planes.
- Códigos de error estables: `VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `ENTITLEMENT_REQUIRED`, `AI_CREDITS_EXHAUSTED`, `INTEGRATION_NEEDS_REAUTH`, `INTERNAL`.

## Rutas

### Cuenta y preferencias
| Método y ruta | Descripción |
|---|---|
| `GET /v1/me` | Usuario, workspace, plan, derechos |
| `GET /v1/preferences` · `PUT /v1/preferences` | Horario, bloques de concentración, margen, autonomía |
| `GET /v1/account/export` | Exportación completa (JSON y CSV en zip) |
| `DELETE /v1/account` | Eliminación (lógica inmediata, borrado en job) |

### Tareas y captura
| `GET/POST /v1/tasks` · `GET/PATCH/DELETE /v1/tasks/:id` | CRUD con filtros `status`, `clientId`, `dueBefore` |
|---|---|
| `PUT /v1/tasks/:id/dependencies` | Reemplaza `blockedBy`, valida ciclos |
| `POST /v1/capture` | Texto libre → `Proposal(kind=capture)` con campos sugeridos |

### Propuestas (Entrada)
| `GET /v1/proposals?status=pending` | Lista |
|---|---|
| `POST /v1/proposals/:id/confirm` | Confirma (cuerpo opcional con ediciones) y crea la entidad real |
| `POST /v1/proposals/:id/dismiss` | Descarta y guarda la señal de feedback |
| `POST /v1/proposals/confirm-batch` | Confirma varias (solo `explicit` con confianza alta) |

### Compromisos y seguimiento
| `GET /v1/commitments?direction=&clientId=&status=` | Debo / Me deben. Cada elemento lleva `counterpartyName` y `threadUrl` (enlace al hilo en Gmail); sin `status` excluye `proposed` y `dismissed` |
|---|---|
| `PATCH /v1/commitments/:id` `{ status?, dueAt?, clientId?, action? }` | Estado (`confirmed`/`fulfilled`/`at_risk`/`broken`/`dismissed`), fecha, cliente, acción. Un `proposed` se confirma desde Entrada, no aquí. Auditado (`commitment.fulfilled`, `commitment.dismissed`, `commitment.updated`) |
| `POST /v1/commitments/:id/followup-draft` `{ language? }` | Genera borrador (AI-3; plantilla si la IA está en pausa o rechaza por política). Devuelve `{ to, subject, body, source, language }`. No crea nada en Gmail. `to` y `subject` los fija el código desde el hilo |
| `POST /v1/commitments/:id/followup-draft/save` `{ body, subject?, proposalId? }` | Guarda el borrador en Gmail (`gmail.compose`) en el hilo original, destinatario = contraparte del hilo. Rechaza cuerpos con enlaces, direcciones o instrucciones (`VALIDATION_FAILED`). `INTEGRATION_NEEDS_REAUTH` sin Gmail. Auditado (`followup.draft_saved` con `draftId`). Acepta `Idempotency-Key`. **Nunca envía** |
| `POST /v1/commitments/:id/remind` `{ at?, proposalId? }` | Crea una tarea «Seguimiento: …» (mañana por defecto) ligada al compromiso. Auditado (`followup.reminder`) |

`POST /v1/proposals/:id/confirm` devuelve `{ task, commitment, client }` (los que no aplican, `null`). Propuestas `commitment` (Entrada): acepta `{ commitment: { action?, dueAt?, clientId?, createWaitingTask? } }` y devuelve `{ commitment }`; `createWaitingTask` (solo `owed_to_me`) crea una tarea `waiting_on_third_party` «Esperando a …» (auditada `task.waiting_created`). `dismiss` marca el compromiso `dismissed`. `confirm-batch` solo acepta compromisos `explicit` con confianza ≥ 0,85 (`skipped.reason = not_explicit`). Propuestas `followup` (job `followups.scan`, una por compromiso vencido o hilo sin respuesta) se resuelven desde `followup-draft/save` o `remind` con `proposalId`, con `dismiss`, o con `confirm` sin cuerpo, que crea la tarea «Esperando a …» (`task.waiting_created`). Propuestas `client_link` (job `clients.scan`, D-040, ADR 0005): `confirm { client?: { name?, color? } }` crea el cliente con el dominio propuesto (aplica `max_clients`) y vincula sus contactos, hilos y eventos sin cliente; devuelve `{ client }`. Un dominio descartado no se vuelve a proponer. `confirm-batch` nunca crea clientes.

### Contactos, silencios y exclusiones de correo
| `GET /v1/contacts` · `PATCH /v1/contacts/:id` `{ muted }` | Contactos vistos en el correo; silenciar seguimientos por contacto (F-08 AC2) |
|---|---|
| `PATCH /v1/clients/:id` `{ followupsMuted }` | Silenciar seguimientos por cliente (misma ruta que la edición de clientes; auditado `followups.muted/unmuted`) |
| `GET/POST /v1/mail/exclusions` · `DELETE /v1/mail/exclusions/:id` | `{ kind: sender|domain|label, value }`; el valor se valida según el tipo (correo, dominio, etiqueta) y se normaliza en minúsculas salvo etiquetas |

### Plan y calendario
| `GET /v1/plan?from=&to=` | Plan vigente: bloques persistidos, tareas referenciadas, riesgos/conflictos del último `plan_run`, propuesta `reschedule` pendiente. Nunca ejecuta el planificador en la petición |
|---|---|
| `POST /v1/plan/replan` | Ejecuta el planificador ahora. Diff seguro (solo añade bloques o retira los de tareas completadas) → se aplica como acción `system` auditada; cualquier movimiento de un bloque vivo → propuesta `reschedule` con `basePlanVersion` (ADR 0003) |
| `POST /v1/plan/accept` `{ proposalId }` | Aplica la propuesta y escribe solo eventos Meri en Calendar. `CONFLICT` si el plan cambió desde la propuesta. Acepta `Idempotency-Key` |
| `POST /v1/plan/blocks/:id/pin` `{ pinned }` | Ancla o suelta un bloque (auditado, deshacible) |
| `POST /v1/plan/blocks/:id/complete` `{ taskDone? }` | Marca el bloque hecho y, por defecto, la tarea (auditado, deshacible) |
| `GET /v1/calendar/events?from=&to=&clientId=` | Eventos externos y bloques Meri; los externos llevan `clientId` cuando la resolución por dominio es inequívoca |
| `PATCH /v1/calendar/events/:id` `{ clientId }` | Asigna una reunión externa a un cliente (nunca un bloque Meri). Auditado (`event.client_assigned`); dispara `time.infer` |
| `GET /v1/notifications` · `POST /v1/notifications/:id/read` | Avisos agrupados (`template` + `params` para i18n, tope `maxAlertsPerDay`) |

### Clientes, tiempo y briefings (ADR 0005)
| `GET /v1/clients?stats=&includeArchived=` · `POST /v1/clients` · `GET/PATCH/DELETE /v1/clients/:id` (`GET …/:id?stats=week|month`) | CRUD (`name`, `domains`, `color`, `notes`, `verticalTags`, `archived`, `followupsMuted`). `?stats=true` añade compromisos abiertos/vencidos, tareas en riesgo y minutos aprobados/sugeridos de la semana. `POST` y restaurar aplican `max_clients` (402 `ENTITLEMENT_REQUIRED`). `DELETE` = borrado lógico, nada se desvincula. Al crear o ampliar `domains` se vinculan los contactos, hilos y eventos externos sin cliente de esos dominios. Auditado (`client.created/updated/archived/restored/deleted`) |
|---|---|
| `GET /v1/projects?clientId=` · `POST /v1/projects` · `PATCH /v1/projects/:id` | Asuntos (matters) de un cliente: `PATCH` solo `name`, `kind`, `dueAt`, `archived` (el cliente no cambia). Auditado (`project.created/updated`) |
| `GET /v1/search?q=&clientId=` | Tareas, compromisos y clientes (`q` de 2 a 100 caracteres, `LIMIT 20` por tipo, cada resultado con `clientId`) |
| `GET /v1/clients/:id/briefing` · `POST /v1/clients/:id/briefing` `{ eventId? }` | Último briefing / genera uno con fuentes (contexto aislado del cliente, D-041/D-043). `POST` reutiliza el guardado si el `sourceHash` no cambió; en vivo, 8 s de tope y reglas como respaldo |
| `GET /v1/time-entries?week=YYYY-Www&clientId=&status=all` | Entradas de la semana ISO (lunes–domingo en la zona del usuario): sugeridas y aprobadas; `status=all` incluye rechazadas. Incluye `unassignedEvents` (eventos externos de la semana sin cliente) |
| `PATCH /v1/time-entries/:id` `{ minutes?, clientId? }` | Corrige una entrada (una aprobada sigue aprobada; auditado `time.updated`) |
| `POST /v1/time-entries/:id/approve` · `.../reject` · `POST /v1/time-entries/approve-batch { ids }` | Revisión; `time.approved` auditado y deshacible; el lote es una sola transacción |
| `GET /v1/time-entries/export.csv?week=&status=` | CSV UTF-8 con BOM, separador `,`, campos entrecomillados, celdas `= + - @` protegidas con `'`, `Content-Disposition: attachment`. Columnas `fecha,cliente,asunto,descripcion,minutos,horas,origen,estado,aprobada_el`. Solo aprobadas salvo `status=all`. Nunca cambia estados. Excel es-ES: «Datos → Desde texto/CSV» |
| `POST /v1/events/:id/agreements` `{ lines: string[] }` | Post-reunión (D-044): cada línea → propuesta `capture` o `commitment` con `sourceRef { type: "event" }`; nada se confirma automáticamente |

### Integraciones y control
| `GET /v1/integrations` | Cuentas, estado, scopes |
|---|---|
| `POST /v1/integrations/:provider/connect` | Devuelve URL de autorización |
| `GET /v1/integrations/:provider/callback` | Intercambia código y guarda tokens cifrados |
| `POST /v1/integrations/:id/pause` · `DELETE /v1/integrations/:id` | Pausar (también detiene la lectura de correo) / desconectar y purgar: hilos indexados, compromisos `proposed` y propuestas pendientes del correo se borran; los compromisos confirmados se conservan sin hilo (D-036) |
| `POST /v1/integrations/:id/mail/sync` | Sincronización manual de Gmail (202) |
| `GET /v1/audit` · `POST /v1/audit/:id/undo` | Actividad (con `undoneAt` derivado) y deshacer append-only: inserta `<acción>.undone` con `undo_of_audit_id` y aplica la compensación. Deshacibles: `plan.generated`, `plan.accepted`, `task.created`, `task.completed`, `block.pinned`, `block.completed`, `commitment.autoconfirmed` (D-034: vuelve a `proposed` y reabre la propuesta), `time.approved` (vuelve a `suggested`). `CONFLICT` si ya se deshizo o existe un plan posterior |
| `GET /v1/value-report?period=` | Informe de valor con método por cifra |
| `GET /v1/ai/usage` | `{ period, usedUsd, capUsd, paused, mode }`: gasto del mes frente al tope por workspace (docs/05 §5) |

### Facturación
| `POST /v1/billing/checkout` | Sesión de Stripe Checkout |
|---|---|
| `POST /v1/billing/portal` | Sesión del portal de cliente |
| `GET /v1/billing/subscription` | Plan y estado |

### Webhooks (sin sesión, con verificación)
| `POST /webhooks/google/gmail` | Push de Google: token de canal compartido con Calendar en el MVP (ADR 0004); el JWT de Pub/Sub llega con el bloqueo `gmail` en vivo |
|---|---|
| `POST /webhooks/google/calendar` | Canal `watch`, verificar `X-Goog-Channel-Token` |
| `POST /webhooks/stripe` | Verificar firma e idempotencia por `event.id` |
| `GET /health` · `GET /ready` | Sondas |

## Colas (BullMQ) y cargas
Todas llevan `{ workspaceId, traceId }` además de su carga.
| Cola | Carga | Efecto |
|---|---|---|
| `gmail.sync` | `{ integrationAccountId, historyId? }` | Ingesta incremental, prefiltro, encola extracción |
| `calendar.sync` | `{ integrationAccountId }` | Sincroniza eventos |
| `ai.extract_commitments` | `{ threadId, messageIds[] }` | Contexto acotado por hilo, AI-2 con política de inyección, crea compromisos `proposed` + propuestas deduplicadas; auto-confirma `explicit` ≥ 0,9 si `gmail_autoconfirm` (auditado, deshacible); tope mensual de IA → reglas |
| `ai.brief_client` | `{ clientId, eventId? }` | Genera briefing bajo demanda (nunca programado) |
| `clients.scan` | `{ date }` (diario; cada minuto fuera de producción, id por día) | Dominios vistos ≥ 3 veces entre contactos/hilos sin cliente → una propuesta `client_link` por dominio (sin correo personal, dominio propio, exclusiones ni dominios de clientes) |
| `time.infer` | `{ reason: daily|calendar_changed|block_completed|event_assigned|manual }` (diario, tras una sincronización de calendario, al completar un bloque o asignar un cliente a una reunión; un job por workspace y minuto) | Entradas `suggested` por evento externo con cliente y bloque Meri completado (D-042); idempotente, nunca aprueba |
| `briefings.prepare` | `{ date }` (diario) | Notificación `briefing.suggested` un día antes de una reunión con cliente si `briefing_before_meetings`; sin IA |
| `planner.replan` | `{ reason }` | Calcula el diff; aplica diffs seguros y crea propuesta `reschedule` para el resto (ADR 0003). Se encola con debounce de 3 s por workspace al cambiar tareas o eventos |
| `followups.scan` | `{ date }` (cada hora; cada minuto fuera de producción) | Detecta compromisos de terceros vencidos (→ `at_risk`) e hilos enviados sin respuesta tras `followup_days`; una propuesta `followup` por elemento (hash de deduplicación) y aviso agrupado `followups.due` |
| `data.retention` | `{ date }` (diario) | Purga hilos indexados más antiguos que `min(preferences.retention_days, tope del plan, 365)` con el mismo orden que la desconexión (D-036) |
| `daily.review` | `{ date }` (cron cada 15 min: workspaces que pasaron su hora de inicio en su zona) | Resumen del día (plantilla, sin IA), uno por día |
| `billing.usage_rollup` | `{ period }` (cron) | Consolida `ai_usage` y créditos |
| `data.delete_account` | `{ userId }` | Borrado completo y verificación |
| `integrations.renew_channels` | `{}` (cron) | Renueva `watch` de Gmail y Calendar |

## Eventos de dominio (internos)
`proposal.confirmed`, `commitment.fulfilled`, `commitment.overdue`, `plan.accepted`, `plan.undone`, `time.approved`, `integration.needs_reauth`. Alimentan `audit_log`, `value_events` y analítica (sin contenido).
