# Runbook: caída de un proveedor

Cómo se comporta Meri cuando falla cada dependencia externa y qué hacer. Principio: **el planificador y los datos confirmados siguen funcionando**; lo que depende del proveedor se degrada de forma visible y se recupera solo.

## Señales comunes

- Errores tipados `IntegrationError` (`RateLimited`, `Transient`, `Auth`, `Permanent`) en los registros del worker.
- `/ready` del worker: colas atrasadas o trabajos en la cola de errores (DLQ).
- Estado de las conexiones (`integration_accounts.status`): `degraded` tras fallos transitorios, `needs_reauth` tras 401.
- Los trabajos reintentan 5 veces con espera creciente y después pasan a la DLQ.

## Google (Calendar / Gmail)

| Síntoma | Comportamiento | Acción |
|---|---|---|
| 429 / 5xx | Reintentos; la conexión pasa a `degraded`; la UI lo muestra en Control | Esperar. Si dura > 1 h, comprobar el [panel de estado de Google Workspace](https://www.google.com/appsstatus) y las cuotas del proyecto |
| 401 / `invalid_grant` | La conexión pasa a `needs_reauth`; el usuario ve «Reconectar» | Normal en modo Testing (caducidad de 7 días). Masivo → posible revocación de la app o del secreto: abrir incidente |
| Push de Gmail no llega | El sondeo de respaldo sincroniza igualmente | Revisar la suscripción de Pub/Sub |

Tras la recuperación, los cursores (`sync_state`) continúan desde donde quedaron; un cursor inválido provoca una resincronización completa acotada.

## Anthropic (IA)

| Síntoma | Comportamiento |
|---|---|
| Errores o latencia > 8 s | Captura: responde el analizador de reglas. Seguimientos: plantilla sin IA. Preparaciones: resumen determinista. Compromisos: el trabajo reintenta y después espera en la DLQ |
| Coste anómalo | El tope de créditos corta las llamadas (D-061) |

Acción: dejar que actúen los respaldos (`AI_MODE=fake` está prohibido en producción). Los trabajos agotados quedan en la cola de errores (`dead-letter`, con `failedJobId` y el error); todavía no hay herramienta para reprocesarlos (deuda técnica): cuando el proveedor vuelva, inspeccionarlos en Redis y reencolar los que importen.

## Stripe

- Webhooks: Stripe reintenta hasta 3 días; la API es idempotente por id de evento (`stripe_events`). No hacer nada salvo vigilar.
- Checkout o portal caídos: el usuario ve un error y puede reintentar; los derechos existentes no cambian.

## AWS KMS

- Sin KMS no se pueden descifrar tokens: la sincronización falla con `Transient` y reintenta; la UI y el planificador siguen con los datos ya guardados.
- No se pueden hacer copias nuevas (`pnpm backup` falla al envolver la DEK): reintentar cuando vuelva; la copia principal del proveedor no depende de KMS.
- Si la causa es un permiso o una clave desactivada: revisar la política de la clave y `pnpm smoke kms`.

## Redis

- Rate limit: `skipOnError` → la API sigue sirviendo sin límite (disponibilidad sobre límite, D-082). Vigilar abuso.
- Colas: los trabajos no se encolan ni se procesan; la API responde, las sincronizaciones se retrasan. Al volver, los dispatchers vuelven a encolar.

## Postgres

Caída total = S2: ver [`disaster-recovery.md`](disaster-recovery.md).

## Comunicación

Si la degradación es visible para los usuarios más de 30 minutos: aviso a los usuarios afectados (la app ya muestra el estado de cada conexión en Control) y en la página de estado cuando exista. Al terminar, nota breve en el canal de incidentes con duración e impacto.
