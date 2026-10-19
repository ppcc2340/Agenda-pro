# Fase 0 — Foundations

**Objetivo:** base sólida y desplegable: monorepo, apps vacías pero funcionales, auth con Google, base de datos con RLS, CI y observabilidad.
**Lee:** `docs/02-architecture.md`, `docs/03-data-model.md`, `docs/06-security-privacy.md` §1–4, §7.

## Tareas
- [x] P0-01 **Monorepo:** verificar `pnpm install` y **commitear `pnpm-lock.yaml`** (el CI usa `--frozen-lockfile`), Turborepo, ESLint (flat config en `eslint.config.js`, ya incluido) + Prettier, dependency-cruiser que impida ciclos y que `core` importe de otros paquetes, tsconfig por paquete extendiendo `tsconfig.base.json`, Vitest.
- [x] P0-02 **`packages/config`:** carga de entorno con Zod, feature flags y **resolución de modos fake/live** según `docs/blockers/README.md`: en `live` con credenciales ausentes falla al arrancar citando variable y guía; en producción prohíbe `fake` y `KMS_PROVIDER=local`.
- [x] P0-03 **`packages/db`:** completar migraciones a partir de `src/schema.ts`; script `migrate`; SQL de **RLS** para todas las tablas con `workspace_id`; helper `withWorkspace(db, workspaceId, fn)` que hace `SET LOCAL app.workspace_id`. Seed de desarrollo.
- [x] P0-04 **`apps/api` (Fastify):** healthcheck, logger pino, manejo de errores, plugin de auth (sesión), plugin `withWorkspace`, rate limiting, OpenAPI.
- [x] P0-05 **`apps/web` (Next.js):** layout con las 5 áreas (vacías), i18n es/en, Tailwind + shadcn/ui, tema claro/oscuro, PWA manifest.
- [x] P0-06 **Auth:** Auth.js con Google (solo identidad en esta fase: scopes `openid email profile`); creación automática de `user` + `workspace` + `membership` + `preferences` por defecto.
- [x] P0-07 **Onboarding mínimo:** zona horaria, horario laboral, margen de imprevistos (guarda en `preferences`).
- [x] P0-08 **`apps/worker`:** BullMQ con una cola de ejemplo, panel de salud, reintentos y DLQ.
- [x] P0-09 **`audit_log`:** helper `audit(ctx, {actor, action, before, after, reason})`.
- [x] P0-10 **Observabilidad:** Sentry, OpenTelemetry básico, PostHog (envuelto en un wrapper con *no-op* sin clave).
- [x] P0-11 **CI:** el workflow existente debe pasar; añadir gitleaks y `pnpm audit`.
- [x] P0-12 **Cifrado de sobre:** módulo `crypto` en `packages/config` o `packages/db` con proveedor `local` (dev) e interfaz para KMS; tests (round-trip, rotación, tamper-detection).
- [x] P0-13 **Documentos legales stub:** páginas públicas `/privacy` y `/terms` (borrador) — necesarias para la verificación de Google.
- [x] P0-14 **Adaptadores falsos y `pnpm smoke <id>`:** una interfaz + `Fake*` por integración (Calendar, Gmail, IA, Stripe, analítica, KMS) y el script `pnpm smoke` que ejecuta `scripts/smoke/<id>.ts`. Debe pasar siempre contra `fake`. `pnpm blockers` ya existe (`scripts/check-blockers.mjs`).
- [x] P0-15 **Runbooks:** `docs/runbooks/incident-response.md` (esqueleto).

## Fuera de alcance
Gmail, Calendar, planificador, IA, Stripe.
