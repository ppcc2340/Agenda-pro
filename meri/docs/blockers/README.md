# Bloqueos humanos: pendientes, pero listos para incorporar

Son cosas que solo una persona puede hacer (crear cuentas, claves, dominio). **Ninguna bloquea el desarrollo**: cada una tiene un adaptador falso que se usa por defecto, y un camino de un solo paso para pasar a real cuando la tengas.

## Estado actual: todo pendiente

```bash
pnpm blockers            # informe de estado
pnpm blockers -- --id stripe    # un solo bloqueo
```

| Bloqueo | Crítico | Mientras tanto | Guía |
|---|:-:|---|---|
| Proyecto OAuth de Google | sí | `FakeCalendar` y `FakeGmail` | [google-oauth.md](google-oauth.md) |
| Clave de Anthropic | sí | IA falsa + parser por reglas | [anthropic.md](anthropic.md) |
| Dominio y marca de Meri | sí | `localhost` | [domain-brand.md](domain-brand.md) |
| Stripe (modo test) | no | Facturación simulada | [stripe.md](stripe.md) |
| Sentry y PostHog | no | Logs locales, analítica no-op | [observability.md](observability.md) |
| KMS de producción | no | Clave local (solo dev) | [kms.md](kms.md) |

Orden recomendado: **dominio, Google, Anthropic, Stripe, observabilidad, KMS**. Google y el dominio van primero porque la verificación de Gmail tarda semanas.

## Cómo incorporar uno (cuando lo tengas)

1. Sigue su guía y copia las credenciales a `.env` (nunca al repositorio).
2. Ejecuta `pnpm blockers`. Debe mostrar 🟡 *listo para activar*.
3. En Claude Code ejecuta `/connect-blocker <id>` (por ejemplo `/connect-blocker stripe`). Claude Code:
   - cambia el modo a `live` en `.env`,
   - ejecuta la prueba de humo del servicio (`scripts/smoke/`),
   - corre `pnpm verify`,
   - marca el bloqueo como resuelto en `STATE.md`.
4. `pnpm blockers` debe mostrar ✅ *conectado*.

## Cómo funcionan los modos

Cada integración tiene una variable de modo en `.env`:

| Variable | Valores | Por defecto |
|---|---|---|
| `GOOGLE_MODE` | `fake` o `live` | `fake` |
| `AI_MODE` | `fake` o `live` | `fake` |
| `STRIPE_MODE` | `fake` o `live` | `fake` |
| `ANALYTICS_MODE` | `noop` o `live` | `noop` |
| `KMS_PROVIDER` | `local`, `aws` o `gcp` | `local` |

Reglas (las implementa `packages/config` en la Fase 0):
- En `fake`, la app usa los adaptadores falsos y **nunca** llama a servicios externos.
- En `live`, si falta una credencial la app **no arranca** y el error indica qué variable falta y qué guía seguir.
- Pasar de `fake` a `live` no cambia código: solo la configuración.
- En producción (`APP_ENV=production`, o `NODE_ENV=production` si `APP_ENV` no está definido) está prohibido `fake` y `KMS_PROVIDER=local`. La app se niega a arrancar. `staging` cuenta como producción. Para ejecutar un build optimizado contra adaptadores `fake` (E2E, `pnpm demo`) hacen falta `APP_ENV=development` **y** `ALLOW_FAKES_ON_PRODUCTION_BUILD=1`; la app lo avisa en el arranque.

## Seguridad de las credenciales
- `.env` está en `.gitignore`. Claude Code tiene denegada su lectura (`.claude/settings.json`).
- Para que Claude Code verifique algo, ejecuta tú `pnpm blockers`; el informe no imprime valores, solo qué falta.
- Usa claves de **desarrollo** con límite de gasto. Las de producción van en un gestor de secretos, no en `.env`.
