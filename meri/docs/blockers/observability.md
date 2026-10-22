# Sentry y PostHog

**Variables:** `SENTRY_DSN`, `POSTHOG_KEY`, `ANALYTICS_MODE=live`; opcional `SENTRY_RELEASE` (p. ej. el sha desplegado)
**Desbloquea:** analítica de producto (Fase 4) y panel de decisión de la beta (Fase 6).
**Mientras tanto:** logs locales y analítica no-op.

## Pasos
1. Sentry: crea un proyecto (plataforma Node; API, worker y web lo comparten y se distinguen por la etiqueta `service`). Copia el DSN (`https://<clave>@<host>/<proyecto>`). En *Settings → Security & Privacy* deja activados *Data Scrubber* y *Use Default Scrubbers*, y desactiva *Store IP addresses*.
2. PostHog: crea un proyecto. Elige la región (UE si tus usuarios están en Europa). Copia la clave del proyecto.
3. Rellena `.env` y pon `ANALYTICS_MODE=live`.
4. `pnpm blockers`, luego `/connect-blocker observability`.

## Reglas de privacidad
- Ningún evento incluye contenido de correos ni nombres de clientes. Solo ids y contadores (`docs/09-metrics-validation.md`).
- Sentry recibe solo tipo, mensaje limpio y pila del error, más ids de una lista cerrada (ADR 0010). Nunca cuerpos, cabeceras, cookies ni consultas. El *scrubbing* del servidor de Sentry es una segunda barrera, no la primera.
- No hay SDK en el navegador: la CSP sigue con `connect-src 'self'`.

## Verificación de humo
`pnpm smoke observability` envía un evento a PostHog y un error de prueba a Sentry, y falla si Sentry no responde 2xx. Confirma en Sentry que el error (`service:smoke`) llega sin datos personales.
