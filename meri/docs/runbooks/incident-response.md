# Runbook: respuesta a incidentes (esqueleto, fase 0)

Objetivo: detectar, contener, notificar y aprender (docs/06 §10). Se completa en la fase 5.

## 1. Detección
- Fuentes: alertas de Sentry (errores), colas atrasadas o cola de errores (`/ready` del worker), tasa de error de la API > 2 %, revocaciones masivas de tokens, coste de IA diario por encima del umbral.
- Quién: la persona de guardia revisa el canal de alertas y abre un incidente con hora, síntoma y alcance estimado.

## 2. Clasificación
| Nivel | Ejemplo | Respuesta |
|---|---|---|
| S1 | Posible acceso a datos de un cliente por otro; fuga de tokens | Contención inmediata, notificación en ≤ 72 h si hay datos personales |
| S2 | Caída total de API o worker | Restaurar servicio; comunicar estado |
| S3 | Conector degradado (Google 429/401 masivo) | Pausar sincronización afectada; reintentos automáticos |

## 3. Contención
- Revocar tokens afectados: pausar `integration_accounts` (`status = paused`) y llamar a la revocación del proveedor.
- Rotar claves: `INTERNAL_API_SECRET`, `AUTH_SECRET` (invalida sesiones), clave KMS (`rewrapEnvelope` sobre `integration_accounts.encrypted_tokens`).
- Desactivar la IA: `AI_MODE=fake` o tope de créditos a 0; el planificador sigue funcionando.
- Aislar: si hay sospecha de fallo de RLS, poner la API en modo solo lectura y verificar `pg_roles` (`rolbypassrls = false`) y las políticas `ws_isolation`.

## 4. Notificación
- Interna: canal de incidentes con línea de tiempo.
- Usuarios afectados: correo desde `seguridad@` (ver `docs/blockers/domain-brand.md`) con qué pasó, qué datos, qué hicimos y qué deben hacer.
- Autoridades: ≤ 72 h (GDPR) cuando aplique.

## 5. Recuperación
- Restaurar desde copia de seguridad cifrada (procedimiento y tiempos en la fase 5).
- Verificar con `pnpm smoke <id>` y `pnpm verify` antes de reabrir.

## 6. Post-mortem (sin culpables)
- En ≤ 5 días laborables: cronología, causa raíz, qué funcionó, acciones con responsable y fecha. Se guarda en `docs/postmortems/`.
