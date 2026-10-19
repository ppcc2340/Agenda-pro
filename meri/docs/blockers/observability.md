# Sentry y PostHog

**Variables:** `SENTRY_DSN`, `POSTHOG_KEY`, `ANALYTICS_MODE=live`
**Desbloquea:** analítica de producto (Fase 4) y panel de decisión de la beta (Fase 6).
**Mientras tanto:** logs locales y analítica no-op.

## Pasos
1. Sentry: crea un proyecto para Node y otro para Next.js, o uno compartido. Copia el DSN.
2. PostHog: crea un proyecto. Elige la región (UE si tus usuarios están en Europa). Copia la clave del proyecto.
3. Rellena `.env` y pon `ANALYTICS_MODE=live`.
4. `pnpm blockers`, luego `/connect-blocker observability`.

## Reglas de privacidad
- Ningún evento incluye contenido de correos ni nombres de clientes. Solo ids y contadores (`docs/09-metrics-validation.md`).
- Sentry con *scrubbing* activado: sin cuerpos de petición ni tokens.

## Verificación de humo
Enviar un evento de prueba a PostHog y un error de prueba a Sentry; confirmar que ambos llegan sin datos personales.
