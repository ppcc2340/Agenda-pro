# STATE — estado vivo del proyecto

**Fase actual:** 1 — Tareas, calendario y planificador (sin empezar). Fase 0 cerrada el 2026-10-19.

## Fases
| # | Fase | Estado |
|---|---|---|
| 0 | Foundations | ✅ cerrada (2026-10-19) |
| 1 | Tareas, calendario y planificador | pendiente |
| 2 | Gmail + Radar de compromisos | pendiente |
| 3 | Clientes, tiempo y briefings | pendiente |
| 4 | Facturación, créditos de IA e informes de valor | pendiente |
| 5 | Seguridad, cumplimiento y verificación OAuth | pendiente |
| 6 | Beta cerrada e instrumentación de validación | pendiente |
| 7 | Post-MVP (Outlook, Notion, equipos, voz) | backlog |

## Decisiones
- D-001: Vertical inicial = profesionales de servicios con clientes/matters.
- D-002: Proveedor MVP = Google. Microsoft en fase 7.
- D-003: Monorepo pnpm + Turborepo; web Next.js, api Fastify, worker BullMQ.
- D-004: Postgres + Drizzle; RLS activado por `workspace_id`.
- D-005: Modelos IA por variable de entorno (`AI_MODEL_FAST`, `AI_MODEL_SMART`); no hardcodear.
- D-006: Sin `gmail.send` en el MVP.
- D-007: Nombre del producto: **Meri**.
- D-008: Toda integración externa tiene modo `fake` (por defecto) y `live`. Ver `docs/blockers/README.md`.
- D-010: Construcción autónoma por fases con `prompts/build-phase.md`, subagentes revisores y puertas de calidad. Ver `KICKOFF.md`.
- D-011: `PROTOTYPE.md` y `prompts/build-prototype.md` no venían en el kit; se redactan a partir del prompt maestro y de la demo (hito obligatorio tras la fase 3).
- D-012: El kit vive en `meri/` dentro del repositorio `Agenda-pro`; CI en `.github/` de la raíz con `working-directory: meri`.
- D-013: Auth.js v5 en `apps/web`; cookie JWT compartida con la API; arranque de usuario por ruta interna (ADR 0001).
- D-014: Versiones fijadas: Next 15, React 19, Tailwind 4, Fastify 5, Zod 3, Drizzle 0.36, BullMQ 5, Vitest 2, TypeScript 5, ESLint 9.
- D-015: Cifrado de sobre en `packages/config/src/crypto`; `KeyProvider` es la única interfaz de KMS.
- D-016: Rol `meri_app` sin `BYPASSRLS` para la aplicación; migraciones con el propietario (`DATABASE_ADMIN_URL`).
- D-017: Componentes propios con convención shadcn/ui, sin su CLI (ADR 0002).
- D-009: La demo `demo/desktop.html` y `demo/mobile.html` es la referencia visual y de textos (ver `docs/11-design-system.md`).

## Bloqueos humanos
**Estado: todos pendientes, pero listos para incorporar.** Cada uno tiene adaptador falso, guía y comando de activación. Ver `docs/blockers/README.md`.

Comprobar estado: `pnpm blockers`. Incorporar uno: `/connect-blocker <id>`.

| Id | Bloqueo | Crítico | Estado | Guía |
|---|---|:-:|---|---|
| `domain-brand` | Dominio y marca de Meri | sí | ⏳ pendiente | docs/blockers/domain-brand.md |
| `google-oauth` | Proyecto OAuth de Google (Gmail y Calendar) | sí | ⏳ pendiente | docs/blockers/google-oauth.md |
| `anthropic` | Clave de API de Anthropic | sí | ⏳ pendiente | docs/blockers/anthropic.md |
| `stripe` | Cuenta de Stripe (modo test) | no | ⏳ pendiente | docs/blockers/stripe.md |
| `observability` | Sentry y PostHog | no | ⏳ pendiente | docs/blockers/observability.md |
| `kms` | KMS de producción | no | ⏳ pendiente | docs/blockers/kms.md |

La verificación de scopes de Gmail tarda semanas: conviene empezarla en cuanto exista el dominio.

## Fase 0 — qué se construyó
- Monorepo pnpm + Turborepo con `pnpm verify` (lint, typecheck, test, build, dependency-cruiser) en verde y CI en `.github/workflows/ci.yml` (raíz del repo, `working-directory: meri`): servicios Postgres/Redis, migración sobre base limpia, verify, 6 pruebas de humo, artefacto OpenAPI, gitleaks y `pnpm audit`.
- `packages/config`: entorno Zod, modos fake/live desde `blockers.json`, logger pino con censura, flags, cifrado de sobre (`KeyProvider` + `LocalKeyProvider`), wrappers de observabilidad no-op.
- `packages/db`: 3 migraciones (esquema, RLS + rol `meri_app` + grants, `preferences.onboarded_at`), `withWorkspace` transaccional, ids UUID v7 con marca, repositorios (cuenta, preferencias, auditoría), seed de desarrollo, tests de aislamiento sobre Postgres real.
- `packages/integrations`: interfaces + `FakeCalendar`, `FakeGmail` (sin método de envío), `FakeAiClient`, `FakeBilling`, `NoopAnalytics`, `LocalKms`; `pnpm smoke <id>` ×6.
- `apps/api`: Fastify 5 + Zod, problem+json con códigos estables, sesión JWT de Auth.js, CSRF por cabecera, rate limit por usuario/IP, OpenAPI, `/v1/me`, `/v1/preferences`, `/v1/audit`, `/internal/auth/bootstrap` (ADR 0001).
- `apps/worker`: BullMQ con sobre `{workspaceId, traceId}`, backoff con jitter, cola de errores, panel `/ready`.
- `apps/web`: Next 15, tokens de `docs/11`, barra lateral y pestañas móviles con las cinco áreas (estados vacíos), login (Google en live, desarrollo en fake), onboarding, Centro de control, `/privacy`, `/terms`, `/mobile`, i18n es/en, tema claro/oscuro, manifest PWA.

Cómo ejecutarlo: `cp .env.example .env`, Postgres y Redis (`docker compose up -d` o locales), `pnpm install`, `pnpm db:migrate`, `pnpm dev` → web `http://localhost:3000`, api `:4000`, worker `:4100`.

## Deuda técnica
Hallazgos de severidad baja de los revisores de la fase 0 (los altos y medios están corregidos):
- Seguridad: `users` y `workspaces` son legibles por cualquier contexto de workspace (lo necesita el bootstrap); añadir política por usuario/membresía cuando la sesión lleve `userId` a SQL. CSP estricta con nonce en la fase 5 (P5-02); hoy `script-src 'unsafe-inline'` (+ `'unsafe-eval'` solo en desarrollo). El proveedor de acceso de desarrollo existe siempre que `GOOGLE_MODE=fake` fuera de producción: limitar a `localhost`/`DEMO_MODE` antes de un staging público. El panel de salud del worker escucha sin autenticación (ligarlo a la red interna en despliegue). Avisos de `pnpm audit` solo en herramientas de desarrollo (vitest/vite/tinypool), seguidos por Dependabot; el audit bloqueante de CI cubre dependencias de producción.
- Código: `packages/db/src/schema.ts` supera las 300 líneas (viene del kit; dividir por dominio más adelante). Metadatos y manifest con literales en español (usar `generateMetadata` + i18n). `feature_flags` es global y de solo lectura para la app; el almacén en DB llega con las flags de la fase 1.
- UX: título de «Hoy» con la fecha del día en la zona del usuario; atajo «⌘ K» en macOS; barra lateral colapsada a 76 px entre 768 y 1000 px; textos de «Editar preferencias» cuando se llega desde el Centro de control; swatches de leyenda en la línea del día (llegan con el planificador en la fase 1).
- Observabilidad: los wrappers son no-op/log; los SDK reales de Sentry, OpenTelemetry y PostHog se conectan al resolver el bloqueo `observability` (fase 4).
- `/v1/audit/:id/undo`, exportación y eliminación de cuenta: botones deshabilitados en Centro de control hasta sus fases (1 y 5).
- Cobertura: umbrales activos en `core` (90 %) y `api` (80 %) vía `vitest --coverage`; `core` aún no tiene código ejecutable (fase 1).
- La fuente tipográfica se carga desde Google Fonts en tiempo de ejecución (sin dependencia en el build); evaluar auto-hospedaje con el dominio.

## Registro de sesiones
(Claude Code: añade una línea por sesión con fecha, fase y resumen.)
- 2026-10-19 · Fase 0 · Kit sin `.claude/`, `PROTOTYPE.md` ni CI: se crearon (D-011). Construida la base completa (config, db+RLS, integraciones fake, api, worker, web, auth, onboarding, legales, CI, runbook); `pnpm verify` en verde; flujo login→onboarding→Hoy→control verificado en Chromium. Revisores code/security/test/ux: corregidos el callback JWT que fallaba en cada lectura de sesión, el bootstrap de cuenta no atómico ante carreras, la validación parcial de horario, `trustProxy` total, redirección abierta con barra invertida, secretos de ejemplo en producción, CSP/HSTS, censura de parámetros SQL en logs, vulnerabilidades de dependencias de producción (drizzle-orm 0.45, sin swagger-ui), accesibilidad (ARIA del selector de autonomía, etiquetas de días, contraste AA) y textos del Centro de control; añadidos tests de cobertura RLS, carrera de bootstrap, formulario de onboarding, páginas legales, callback de auth y `pnpm blockers`.
