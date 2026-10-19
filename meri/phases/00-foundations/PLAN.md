# Plan — Fase 0 (Foundations)

## Análisis
El kit trae el esquema Drizzle, el SQL de RLS, los contratos de `core` y `ai`, la demo y los scripts de bloqueos. Falta todo lo ejecutable: tooling del monorepo, `config`, migraciones, API, web, worker, auth, observabilidad, cifrado, adaptadores falsos, CI y runbook. Este plan construye la base en el orden de dependencias (`config` → `db` → `integrations` → `api` → `web`/`worker`) para que `pnpm verify` esté en verde en cada commit.

Entorno de esta sesión: sin demonio Docker; Postgres 16 y Redis 7 locales (`meri`/`meri`, bases `meri` y `meri_test`). CI usa servicios de GitHub Actions.

Decisiones de esta fase (registradas en `STATE.md`):
- D-011 `PROTOTYPE.md` y `prompts/build-prototype.md` no venían en el kit; se redactan a partir del prompt maestro y la demo.
- D-012 El kit vive en `meri/` dentro del repositorio `Agenda-pro`; el workflow de CI va en `.github/` de la raíz con `working-directory: meri`.
- D-013 Auth: Auth.js v5 en `apps/web` (Google en `live`, proveedor de desarrollo en `fake`); cookie de sesión JWT compartida con la API (misma `AUTH_SECRET`); al iniciar sesión la web llama a la ruta interna `POST /internal/auth/bootstrap` (secreto compartido) que crea `user + workspace + membership + preferences`. La web llega a la API vía rewrite `/api/v1/*` (mismo origen, sin CORS).
- D-014 Versiones: Next 15, React 19, Tailwind 4 (sin CLI de shadcn: componentes propios con la misma convención), Fastify 5 + `fastify-type-provider-zod@4`, Zod 3, Drizzle 0.36, BullMQ 5, Vitest 2, TypeScript 5, ESLint 9.
- D-015 Cifrado de sobre en `packages/config/src/crypto` (DEK AES-256-GCM por registro, envuelta por un `KeyProvider`; `local` en dev). `KeyProvider` y `LocalKeyProvider` viven solo en `config` (paquete hoja); `integrations` implementa `FakeKms` sobre esa interfaz. Los proveedores KMS reales llegan en la fase 5.
- D-016 Roles de base de datos: las migraciones corren con el propietario (`meri`); la aplicación, el worker y los tests de aislamiento se conectan con `meri_app` (LOGIN, sin `SUPERUSER` ni `BYPASSRLS`, solo permisos de tabla) para que RLS y el `REVOKE` de `audit_log` sean efectivos. `DATABASE_URL` apunta a `meri_app`; `DATABASE_ADMIN_URL` al propietario.
- D-017 (ADR 0001) Ruta interna `POST /internal/auth/bootstrap` fuera de `/v1`: autenticada con `INTERNAL_API_SECRET`, excluida de OpenAPI, transaccional, idempotente por `email` y ejecutada dentro de `withWorkspace(newWorkspaceId)`.
- D-018 (ADR 0002) Sin CLI de shadcn/ui: componentes propios con la misma convención (cva + Radix). Estado de servidor con TanStack Query. Literales en JSX prohibidos con `react/jsx-no-literals`.

Hallazgos del `code-reviewer` sobre este plan incorporados: rol de aplicación sin BYPASSRLS (D-016), `withWorkspace` siempre en transacción con `set_config(..., true)` y test de que fuera del helper no hay filas, ADR para la ruta interna (D-017), `JobEnvelope` Zod `{ workspaceId, traceId }` obligatorio en el worker, rate limit por usuario e IP + `bodyLimit` + timeouts + comprobación de `Origin`/`Sec-Fetch-Site` en mutaciones, paginación por cursor en `GET /v1/audit`, `GET /v1/me` con plan y derechos por defecto, modos resueltos desde `blockers.json` (`noop|live`, `local|aws|gcp`), smoke `domain-brand` contra `/privacy` y `/terms` locales, proveedor de desarrollo de auth solo con `NODE_ENV !== "production"`, `feature_flags` filtrada explícitamente, `traceId` compartido entre pino, Fastify y BullMQ, OpenAPI publicado como artefacto de CI.

## Pasos
1. **P0-01 Tooling.** `package.json` raíz (devDeps fijadas), `pnpm-lock.yaml`, `.dependency-cruiser.cjs` (sin ciclos; `core` solo importa `zod`), `prettier.config`, `vitest.workspace.ts`, tsconfig por paquete, scripts `lint/typecheck/test/build` reales en todos los paquetes. Verificar: `pnpm verify` en verde con tests vacíos permitidos solo en paquetes sin código.
2. **P0-02 `packages/config`.** `env.ts` (Zod, `loadEnv(process.env)` puro y testeable), `modes.ts` (resolución fake/live por bloqueo leyendo `blockers.json`; errores que citan variable y guía; producción prohíbe `fake` y `local`), `flags.ts` (flags en memoria + interfaz de almacén), `logger.ts` (pino con campos censurados). Tests: config válida, variable ausente en `live`, producción con `fake`, censura de secretos.
3. **P0-12 Cifrado.** `crypto/envelope.ts` (`encrypt`, `decrypt`, `rotate`), `crypto/providers/local.ts`. Tests: round-trip, manipulación detectada, rotación mantiene lectura, claves nunca en `toString`/logs.
4. **P0-03 `packages/db`.** Migraciones generadas (`drizzle/0000_*.sql`) + migración custom con `001_rls.sql`; `migrate.ts` (sin drizzle-kit en runtime), `client.ts`, `withWorkspace(db, workspaceId, fn)`, repositorios mínimos (`users`, `workspaces`, `preferences`, `audit`), `seed/dev.ts`. Tests de integración (Postgres real): migración sobre base limpia, aislamiento SQL A/B lectura y escritura, `audit_log` append-only.
5. **P0-14 `packages/integrations`.** `types.ts` (errores tipados), interfaces `CalendarProvider`, `MailProvider`, `AiClient`, `BillingProvider`, `Analytics`, `KeyProvider`; `fakes/*` deterministas con datos de ejemplo; `factory.ts` por modo. `scripts/smoke/<id>.ts` ×6 y `tsx` como dependencia. Verificar: `pnpm smoke <id>` para los seis ids.
6. **P0-04 `apps/api`.** Fastify + Zod provider, `/health`, `/ready`, pino con `traceId`, errores problem+json con códigos estables, `@fastify/cookie` + auth plugin (decodifica JWT de Auth.js), plugin `withWorkspace`, rate limit, helmet, OpenAPI (`/docs/json`), rutas `GET /v1/me`, `GET/PUT /v1/preferences`, `GET /v1/audit`, ruta interna `POST /internal/auth/bootstrap`. **P0-09** `audit(ctx, …)` usado por `PUT /v1/preferences`. Tests: cada ruta, 401 sin sesión, aislamiento multi-tenant (A no ve B), rate limit, problem+json.
7. **P0-06 Auth (web).** `auth.ts` con Auth.js v5: Google (live) o proveedor `credentials` de desarrollo (fake, solo si `GOOGLE_MODE=fake`), callbacks `signIn` → bootstrap, `jwt`/`session` con `userId`, `workspaceId`, `onboarded`. Páginas `/login`, logout. Middleware que protege las áreas.
8. **P0-05 `apps/web`.** Next 15 App Router, Tailwind 4 con tokens de `docs/11`, fuentes, tema claro/oscuro (`data-theme`), next-intl `es`/`en` (`messages/*.json`), layout de ordenador (barra lateral) y móvil (pestañas), cinco áreas con estados vacíos, `manifest.webmanifest`, rewrite a la API. Verificar: lint (regla sin literales), typecheck, build, test de render del shell.
9. **P0-07 Onboarding.** `/onboarding` (zona horaria, horario, días, margen) con RHF + Zod → `PUT /v1/preferences`; redirección hasta completar; preferencias visibles en Centro de control.
10. **P0-13 Legal.** `/privacy` y `/terms` públicas (borrador) accesibles sin sesión.
11. **P0-08 `apps/worker`.** BullMQ: registro de colas (`example.ping`), backoff exponencial con jitter, DLQ (`dead-letter`), contexto de workspace por job, `GET /health` del worker. Tests con Redis real (`REDIS_URL`).
12. **P0-10 Observabilidad.** `packages/config/src/observability` o módulo en cada app: Sentry, OTel y PostHog como wrappers no-op sin clave; test de no-op.
13. **P0-11 CI.** `.github/workflows/ci.yml` (raíz): servicios Postgres/Redis, `pnpm install --frozen-lockfile`, `pnpm verify`, `pnpm smoke` ×6, gitleaks, `pnpm audit --audit-level=high`, migración sobre base limpia.
14. **P0-15 Runbook.** `docs/runbooks/incident-response.md`.
15. **Cierre.** Subagentes, `ACCEPTANCE.md` con evidencia, `STATE.md`, commit `chore(phase-0): close phase`.

## Riesgos
- Versiones de librerías más nuevas que mi conocimiento: fijar majors conocidos (D-014) y validar con `pnpm verify` tras cada paso.
- Auth.js v5 beta y cookies entre web y API: cubrir con test de decodificación del JWT en la API y E2E en fase 1.
- RLS exige rol sin `BYPASSRLS` y `FORCE`: los tests de aislamiento corren con el rol `meri` (no superusuario).
