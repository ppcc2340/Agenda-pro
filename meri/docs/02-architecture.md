# 02 — Arquitectura

## Stack
| Capa | Elección | Notas |
|---|---|---|
| Lenguaje | TypeScript (strict) | Todo el repo |
| Monorepo | pnpm + Turborepo | `apps/*`, `packages/*` |
| Web | Next.js (App Router) + React + Tailwind + shadcn/ui | PWA, i18n `es`/`en` (next-intl) |
| API | Fastify + Zod (type-provider) | OpenAPI generado; el web consume vía cliente tipado |
| Worker | BullMQ (Redis) | Sync, ingesta, IA, planificación, jobs programados |
| DB | PostgreSQL 16 + Drizzle ORM | RLS por `workspace_id`; `pgvector` opcional post-MVP |
| Auth | Auth.js (Google) | Sesión HTTP-only; tokens de proveedor cifrados aparte |
| IA | Anthropic SDK | Modelos por env; salidas estructuradas validadas con Zod |
| Pagos | Stripe | Checkout + Customer Portal + webhooks |
| Observabilidad | OpenTelemetry + Sentry + PostHog | Logs estructurados (pino) |
| Infra (sugerida) | Fly.io/Render/Railway + Neon/Supabase Postgres + Upstash/Redis | Contenedores Docker; migrar a cloud mayor más adelante |
| CI | GitHub Actions | `pnpm verify` obligatorio |

## Módulos (paquetes)
```
apps/
  web/        Next.js: UI, auth, rutas de producto
  api/        Fastify: REST, webhooks (Google, Stripe), políticas
  worker/     BullMQ: colas y cron
packages/
  db/         Esquema Drizzle, migraciones, helpers RLS, repositorios
  core/       Lógica pura: planificador, scoring, riesgos, tiempo, reglas, políticas
  ai/         Cliente IA, prompts, esquemas Zod, pipeline de extracción, evals
  integrations/ Conectores: google (gmail, calendar), stripe; interfaz común
  ui/         Componentes compartidos
  config/     Configuración tipada de entorno (Zod), feature flags
```

## Principio de capas
```
UI → API (validación, authz, políticas) → core (puro) → db
                      ↘ queue → worker → integrations / ai → proposals → (usuario confirma) → core → db
```
- `core` **no** importa de `db`, `ai` ni `integrations`; recibe datos y devuelve decisiones (funciones puras).
- La IA **nunca** escribe directamente en tablas de dominio; escribe en `proposals`.
- La capa de **políticas** (`core/policy`) decide si una propuesta puede auto-aplicarse, según permisos del usuario y criticidad.

## Flujos clave

### Ingesta de correo → propuestas
1. Webhook/polling de Gmail (`history.list`) → job `gmail.sync`.
2. Prefiltro por reglas (newsletters, no-reply, listas, labels de promociones).
3. Resolución de cliente (por dominio/contacto) → contexto acotado.
4. Job `ai.extract_commitments` → salida Zod-validada.
5. Persistencia como `proposals` (+ `commitments` en estado `proposed`).
6. Notificación agrupada (no una por correo).

### Planificación
1. Disparo: cambio de tarea/evento, inicio del día, acción del usuario.
2. `core.planner.plan(input)` determinista → `PlanResult` con bloques, explicaciones y conflictos.
3. Diff contra el plan vigente → propuesta de reprogramación.
4. Aceptación → escritura a Google Calendar (solo bloques Meri) + `audit_log`.

### Sincronización de calendario
Sync incremental, idempotencia por `external_id` + `etag`, resolución de conflictos "el calendario externo gana en eventos fijos; Meri gana en bloques Meri".

## Colas y jobs (BullMQ)
`gmail.sync`, `calendar.sync`, `ai.extract_commitments`, `ai.brief_client`, `planner.replan`, `followups.scan`, `daily.review`, `billing.usage_rollup`, `data.delete_account`.
Todos idempotentes, con reintentos exponenciales y *dead-letter queue* observada.

## Multi-tenancy
Un workspace por usuario en el MVP (`workspace_id` desde el día uno para escalar a equipos). RLS en Postgres + filtros explícitos en repositorios (defensa en profundidad). Ver `docs/03-data-model.md`.

## Feature flags
`config` provee flags (`gmail_autoconfirm`, `ai_briefings`, `time_inference`). Sin servicio externo en el MVP: tabla + caché.

## No funcionales
- p75 de "Hoy" < 1.5 s; p95 API < 400 ms (sin IA).
- Disponibilidad objetivo 99.5 % en beta.
- Todas las integraciones tolerantes a fallo (circuit breaker, backoff, cuotas de Google respetadas).
