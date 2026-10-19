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
| `GET /v1/commitments?direction=&clientId=&status=` | Debo / Me deben |
|---|---|
| `PATCH /v1/commitments/:id` | Estado, fecha, cliente |
| `POST /v1/commitments/:id/followup-draft` | Genera borrador (IA). Devuelve texto. No crea nada en Gmail |
| `POST /v1/commitments/:id/followup-draft/save` | Guarda el borrador en Gmail (`gmail.compose`). **Nunca envía** |
| `POST /v1/commitments/:id/remind` | Crea un recordatorio |

### Plan y calendario
| `GET /v1/plan?from=&to=` | Plan vigente: bloques, riesgos, conflictos |
|---|---|
| `POST /v1/plan/replan` | Calcula una propuesta de reprogramación (diff). No aplica |
| `POST /v1/plan/accept` | Aplica un diff (por id) y escribe bloques en Calendar |
| `POST /v1/plan/blocks/:id/pin` | Ancla o suelta un bloque |
| `GET /v1/calendar/events?from=&to=` | Eventos externos y bloques Meri |

### Clientes, tiempo y briefings
| `GET/POST /v1/clients` · `PATCH/DELETE /v1/clients/:id` | CRUD. Dominios para resolución automática |
|---|---|
| `POST /v1/clients/:id/briefing` | Genera briefing con fuentes (contexto aislado) |
| `GET /v1/time-entries?week=` | Entradas sugeridas y aprobadas |
| `POST /v1/time-entries/:id/approve` · `.../reject` · `POST /v1/time-entries/approve-batch` | Revisión |
| `GET /v1/time-entries/export.csv` | CSV de entradas aprobadas |

### Integraciones y control
| `GET /v1/integrations` | Cuentas, estado, scopes |
|---|---|
| `POST /v1/integrations/:provider/connect` | Devuelve URL de autorización |
| `GET /v1/integrations/:provider/callback` | Intercambia código y guarda tokens cifrados |
| `POST /v1/integrations/:id/pause` · `DELETE /v1/integrations/:id` | Pausar / desconectar y purgar |
| `GET /v1/audit` · `POST /v1/audit/:id/undo` | Actividad y deshacer |
| `GET /v1/value-report?period=` | Informe de valor con método por cifra |
| `GET /v1/ai/usage` | Créditos usados y límite |

### Facturación
| `POST /v1/billing/checkout` | Sesión de Stripe Checkout |
|---|---|
| `POST /v1/billing/portal` | Sesión del portal de cliente |
| `GET /v1/billing/subscription` | Plan y estado |

### Webhooks (sin sesión, con verificación)
| `POST /webhooks/google/gmail` | Pub/Sub push, verificar token JWT |
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
| `ai.extract_commitments` | `{ threadId, messageIds[] }` | Crea propuestas y compromisos `proposed` |
| `ai.brief_client` | `{ clientId, eventId? }` | Genera briefing |
| `planner.replan` | `{ reason }` | Calcula diff y crea propuesta `reschedule` |
| `followups.scan` | `{}` (cron) | Detecta vencidos y sin respuesta |
| `daily.review` | `{ date }` (cron) | Resumen del día |
| `billing.usage_rollup` | `{ period }` (cron) | Consolida `ai_usage` y créditos |
| `data.delete_account` | `{ userId }` | Borrado completo y verificación |
| `integrations.renew_channels` | `{}` (cron) | Renueva `watch` de Gmail y Calendar |

## Eventos de dominio (internos)
`proposal.confirmed`, `commitment.fulfilled`, `commitment.overdue`, `plan.accepted`, `plan.undone`, `time.approved`, `integration.needs_reauth`. Alimentan `audit_log`, `value_events` y analítica (sin contenido).
