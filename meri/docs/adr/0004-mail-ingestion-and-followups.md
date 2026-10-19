# 0004. Ingesta de correo minimizada, propuestas deduplicadas y seguimiento sin envío

- Estado: aceptada
- Fecha: 2026-10-19

## Contexto
La fase 2 añade Gmail (F-07, F-08) sobre el conector Google de la fase 1. `docs/13` no cubre la sincronización manual de correo, las exclusiones de remitentes, el silencio por contacto/cliente, la retención ni cómo se evita que un cron de seguimiento repita la misma alerta cada día (F-08 AC1 exige una única alerta).

## Decisión
1. **Misma cuenta Google, autorización incremental.** `POST /v1/integrations/google/connect?feature=calendar|gmail|all` pide solo los scopes de la función; `integration_accounts.scopes` acumula. `gmail.sync` corre si la cuenta tiene `gmail.readonly`. En el MVP el `watch` de Gmail (Pub/Sub) queda diferido: polling cada 5 min y `POST /webhooks/google/gmail` con el mismo token de canal que Calendar; `integrations.renew_channels` se activa con el modo `live`.
2. **Minimización.** `threads_index` guarda ids, asunto, participantes, fechas y el id del último mensaje (para el threading de borradores). El cuerpo se lee bajo demanda, se sanea (HTML, URLs, citas, firmas) y se descarta; solo persiste la evidencia (≤ 200 caracteres) verificada literalmente contra el texto saneado.
3. **Propuestas deduplicadas.** `proposals.dedupe_hash` con índice único parcial sobre las pendientes. Extracción: hash(hilo, dirección, acción normalizada, fecha); seguimiento: hash(compromiso o hilo, motivo). El job de extracción inserta primero el compromiso (`commitments_dedupe_uq`) y después la propuesta, en una transacción; `processed_at` solo se marca al terminar.
4. **Contrato ampliado** (`docs/13`): `POST /v1/integrations/:id/mail/sync`, `GET/POST/DELETE /v1/mail/exclusions`, `PATCH /v1/contacts/:id` (`muted`), `PATCH /v1/clients/:id` (`followupsMuted`), `GET /v1/ai/usage`, confirmación de propuestas `commitment` (`{ commitment, task? }`), `followup` (recordatorio o borrador), acción auditada `commitment.autoconfirmed` deshacible, cola `data.retention` (cron diario, D-025).
5. **Coste de IA por workspace** (= por usuario en el MVP): `AI_MONTHLY_COST_CAP_USD_PER_USER` se compara con `ai_usage` del mes del workspace; al superarlo la IA se pausa (`AI_CREDITS_EXHAUSTED`), el prefiltro y las reglas siguen funcionando y se avisa una vez. La retención efectiva es `min(preferences.retention_days, entitlements.retention_days)`.
6. **Borradores.** `POST /v1/commitments/:id/followup-draft/save` crea el borrador en Gmail con `to` = contraparte del compromiso (código, nunca el modelo) y `inReplyToMessageId` = último mensaje del hilo; acepta `Idempotency-Key` y audita `draftId`. No existe ruta de envío (CI lo comprueba).

## Consecuencias
- Nueva migración (`mail_exclusions`, columnas en `preferences`, `clients`, `threads_index`, `proposals`).
- El runner de evals mide el mismo pipeline en `fake` y en `live`.
- La verificación de scopes restringidos de Gmail (CASA) sigue siendo un bloqueo humano (`docs/blockers/google-oauth.md`).
