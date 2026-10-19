# Pruebas de humo de los bloqueos

Una por servicio. Las crea Claude Code cuando se resuelve un bloqueo (o antes, contra el adaptador falso). Deben ser **rápidas, baratas, sin efectos permanentes** y no imprimir secretos.

| Archivo | Qué comprueba |
|---|---|
| `google-oauth.ts` | Calendar: crear y borrar un evento de prueba en el calendario «Meri». Gmail: perfil y 1 mensaje solo con metadatos. Nada de crear borradores ni enviar. |
| `anthropic.ts` | Una llamada mínima con salida estructurada validada con Zod. Registra tokens y coste. |
| `stripe.ts` | Recuperar los dos precios y verificar que el webhook firma correctamente un evento de ejemplo. |
| `observability.ts` | Un evento a PostHog y un error de prueba a Sentry, sin datos personales. |
| `domain-brand.ts` | `https://$PUBLIC_DOMAIN/privacy` y `/terms` responden 200. |
| `kms.ts` | Cifrar, descifrar y rotar con la clave configurada. |

Se ejecutan con `pnpm smoke <id>` (script que crea la Fase 0). Contra `fake` deben pasar siempre.
